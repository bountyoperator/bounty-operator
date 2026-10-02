# sol-04-v — Cinderloom (vulnerable)

**Protocol.** Cinderloom is a fictional distributor: accounts lock an ERC-20 ("filaments") with `weave()` and earn native ETH ("embers") streamed over a funded period ("burn") that the `firekeeper` starts with `kindle()`. A per-filament accumulator (`emberIndex`) is settled into each account's `bankedEmbers` by `_inscribe()`.

Files: `src/Cinderloom.sol` (304 lines), `src/LoomPrimitives.sol` (48 lines: token interface, safe-transfer library `TokenWire`, reentrancy guard `LoomLatch` with modifier `latched`).

## P1 — cross-function reentrancy pays banked embers twice (high / critical)

`src/Cinderloom.sol`

- `drawEmbers()` lines 195–203. It is `latched`, but line 200 sends the ETH (`_sendEmbers(msg.sender, quantity)`) and only line 201 zeroes `weaves[msg.sender].bankedEmbers`.
- `unweave()` lines 206–219. It has **no** `latched` modifier (line 206). It reads the same `bankedEmbers` slot (line 210), zeroes it (line 214), returns the filaments (line 216) and pays the embers (line 217).

While `drawEmbers()` is in the middle of its ETH call the caller's `bankedEmbers` is still the full amount, and the latch only blocks functions that carry the modifier. A contract receiver calls `unweave()` from its `receive()`: `unweave()` sees the un-cleared balance and pays it again. Control then returns to `drawEmbers()`, which writes zero. One entitlement, two payments; the second one is other participants' ETH.

`unweave()`'s own ordering is correct, and so is every other function; neither function is exploitable alone. `weave()`, `loosen()`, `kindle()` and `recoverForeignThread()` are latched, so `unweave()` is the only way back in. The double payment is exactly 2x per round (a second nested `unweave()` reverts `BadQuantity`), but the attacker can re-weave and repeat until the loom holds no ETH.

### Concrete numbers (proof: `bench/verify/sol-04/test/Vulnerable.t.sol:test_planted_P1`)

- Burn span 10 days (864,000 s); the firekeeper kindles 8.64 ETH, so `embersPerSecond` = 1e13 wei exactly and `looseEmbers` = 0.
- Alice weaves 100 filaments; the attacking contract weaves 100 filaments. After the full burn each is owed 4.32 ETH and the loom holds 8.64 ETH.
- The attacker calls `drawEmbers()`: receives 4.32 ETH, its `receive()` calls `unweave()`, which returns its 100 filaments and pays another 4.32 ETH.
- Result: attacker holds 8.64 ETH (two payments) plus its 100 filaments; the loom holds 0 ETH; `embersOf(alice)` still reports 4.32 ETH and Alice's `drawEmbers()` reverts with `NativeDeliveryFailed`.

## Decoy D1 — `unchecked` block in `loosen()` (safe)

`src/Cinderloom.sol` lines 185–188, inside `loosen()` (178–192):

```solidity
unchecked {
    account.filaments -= quantity;
    totalFilaments -= quantity;
}
```

Lines 181–183 revert `BadQuantity` when `quantity == 0`, `quantity > account.filaments` or `quantity > totalFilaments`, and `loosen()` is latched, so nothing can change either counter between the check and the subtraction. Neither subtraction can wrap. Proof: `test_decoy_D1` (40e18 + 1 from an account holding 40e18 reverts; 140e18 + 1 against a total of 140e18 reverts; exact amounts land on 0 and the total stays equal to the tokens held) and `testFuzz_decoy_D1` (512 runs).

## Other things a reviewer may raise that are not findings

- The governance setters (`nominateSteward`, `acceptStewardship`, `appointFirekeeper`, `setWeavingStopped`, `setBurnSpan`) have no latch: they only write storage.
- `recoverForeignThread()` refuses the filament token and has no native-ETH path; the steward cannot take principal or embers.
- Emissions while `totalFilaments == 0` and the division remainder in `kindle()` go to `looseEmbers` and are rescheduled by the next `kindle()`; accumulator rounding dust (at most `totalFilaments / 1e18` wei per settlement) stays in the contract.
- `LIFETIME_FUEL_LIMIT` (1e24) and `FILAMENT_LIMIT` (1e27) keep `emitted * 1e18` and `filaments * delta` far below 2^256.

## What a perfect review says

One high/critical finding: `drawEmbers()` (lines 195–203, pay at 200 before clear at 201) combined with the unlatched `unweave()` (line 206) lets a contract receiver re-enter `unweave()` during the payout and collect its banked embers twice, draining ETH owed to other weavers. Fix: clear `bankedEmbers` before the call and add `latched` to `unweave()`. It does not flag the `unchecked` block in `loosen()`.
