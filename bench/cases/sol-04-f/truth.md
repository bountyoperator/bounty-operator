# sol-04-f — Cinderloom (fixed twin)

**Protocol.** Cinderloom is a fictional distributor: accounts lock an ERC-20 ("filaments") with `weave()` and earn native ETH ("embers") streamed over a funded period ("burn") that the `firekeeper` starts with `kindle()`. A per-filament accumulator (`emberIndex`) is settled into each account's `bankedEmbers` by `_inscribe()`.

Files: `src/Cinderloom.sol` (304 lines), `src/LoomPrimitives.sol` (48 lines). `LoomPrimitives.sol` is byte-identical to the vulnerable variant; `Cinderloom.sol` differs on three lines only.

## There is no planted bug in this variant

The vulnerable twin (sol-04-v) pays in `drawEmbers()` before clearing `bankedEmbers` and leaves `unweave()` without the latch, so a receiver can re-enter `unweave()` and be paid twice. This twin closes both halves.

### Patched region — `src/Cinderloom.sol`

| Line | This file | Vulnerable twin |
|---|---|---|
| 200 | `weaves[msg.sender].bankedEmbers = 0;` | `_sendEmbers(msg.sender, quantity);` |
| 201 | `_sendEmbers(msg.sender, quantity);` | `weaves[msg.sender].bankedEmbers = 0;` |
| 206 | `function unweave() external latched {` | `function unweave() external {` |

Functions: `drawEmbers` (195–203) and `unweave` (206–219). Each change is sufficient on its own; the twin applies both.

### Concrete numbers (proof: `bench/verify/sol-04/test/Fixed.t.sol:test_planted_P1`, expected to FAIL)

Same scenario as the vulnerable proof: burn span 10 days, 8.64 ETH kindled (1e13 wei per second), Alice and the attacking contract each weave 100 filaments, each is owed 4.32 ETH after the burn.

- The attacker calls `drawEmbers()` and receives 4.32 ETH; its `receive()` calls `unweave()`, which reverts with `LoomBusy` (and would find `bankedEmbers == 0` even without the latch).
- The assertion "attacker holds 8.64 ETH" fails: `4320000000000000000 != 8640000000000000000`. The loom still holds Alice's 4.32 ETH.
- `test_control_drawPaysOnce` and `test_control_unweavePaysOnce` pass: both functions still pay exactly once.

A medium-or-higher (or unrated) finding against `drawEmbers` / `unweave` here, for example "low-level call to msg.sender allows reentrancy", is a false positive: state is cleared before the call and every function that touches the ledger and makes an external call is latched.

## Decoy D1 — `unchecked` block in `loosen()` (safe)

`src/Cinderloom.sol` lines 185–188, inside `loosen()` (178–192). Lines 181–183 revert `BadQuantity` when `quantity == 0`, `quantity > account.filaments` or `quantity > totalFilaments`, and `loosen()` is latched, so neither unchecked subtraction can wrap. Proof: `test_decoy_D1` and `testFuzz_decoy_D1` (512 runs) pass on this variant too.

## Other things a reviewer may raise that are not findings

- The governance setters have no latch: they only write storage.
- `recoverForeignThread()` refuses the filament token and has no native-ETH path.
- Idle emissions and scheduling remainder go to `looseEmbers` and are rescheduled by the next `kindle()`; accumulator rounding dust stays in the contract.
- A receiver that cannot accept ETH makes its own `drawEmbers()` / `unweave()` revert; it can still recover its filaments through `loosen()`.

## What a perfect review says

No medium-or-higher finding. At most informational notes (rounding dust, trusted firekeeper can reschedule a burn, contracts without a payable receiver must use `loosen()`). It does not flag `drawEmbers()`, `unweave()` or the `unchecked` block in `loosen()`.
