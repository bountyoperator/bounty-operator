# Proof — pair ch-08 (Lanternreel `ReelPayoutDesk`, draft-review pair)

Foundry project, solc 0.8.26 pinned, `offline = true`, forge-std from `../_lib/forge-std`.

- `src/` holds the two sources both case workspaces contain (`bench/cases/ch-08-o/workspace/src`, `.../ch-08-a/workspace/src`); the workspaces differ only in `draft-report.md`.
- `test/AllocateOverflow.t.sol` is the PoC quoted in the overclaimed draft, byte for byte.
- `test/CreatorFrontRun.t.sol` is the PoC quoted in the accurate draft, byte for byte.
- `test/Proof.t.sol` is the answer-key suite (`test_accurate_*`, `test_falseclaim_*`, controls).

The PoC tests keep hunter-style names because their source is pasted into the drafts; a name containing "accurate" or "falseclaim" there would reveal the variant. An authoring script that is not published (`check-case.mjs`) checks that the code and output blocks in each draft equal these files and the stored forge output.

## Command (run from this directory)

```
forge test
```

Expected: 3 suites, 10 tests passed, 0 failed.

| Test | File | Result | Shows |
|---|---|---|---|
| `test_allocateOverflowDrainsReserve` | `AllocateOverflow.t.sol` | PASS | The overclaimed draft's PoC really passes, on a subclass that exposes `_allocateFunds`. It does not call `processOrder`. |
| `test_creatorFrontRun` | `CreatorFrontRun.t.sol` | PASS | The accurate draft's PoC, through the public entry point on the contract as written. |
| `test_accurate_B1` | `Proof.t.sol` | PASS | Same scenario with stricter assertions (see below). |
| `test_control_B1_honestOrderPaysCreator` | `Proof.t.sol` | PASS | Without interference the creator is paid. |
| `test_control_B1_otherFieldsAreSigned` | `Proof.t.sol` | PASS | `amount`, `orderId`, `deadline` are signed; only the recipient can be swapped. |
| `test_falseclaim_C1_guardRevertsPublicPath` | `Proof.t.sol` | PASS | The draft's amount reverts at the per-order ceiling even with the authority's signature. |
| `test_falseclaim_C1_totalStopsAtIssuanceLimit` | `Proof.t.sol` | PASS | The running total lands on the limit and stops; the limit cannot exceed the hard constant. |
| `testFuzz_falseclaim_C1_publicPathNeverWraps` (512 runs, fixed seed) | `Proof.t.sol` | PASS | For any signed amounts the public path reverts or adds exactly the amount, within ceiling and limit. |
| `test_falseclaim_C2_overflowOnlyThroughHarness` | `Proof.t.sol` | PASS | `exposeAllocateFunds` exists only on the wrapper; the selector is absent from the unmodified runtime code. |
| `test_falseclaim_C3_unprivilegedAttackerDeltaIsZero` | `Proof.t.sol` | PASS | No role, no authority signature: no credit, no withdrawal, reserve untouched. |

## Accurate draft: numbers (`test_accurate_B1`)

Reserve 250,000e18. The authority (test key) signs order #7 for the victim: 40,000e18, deadline now + 3 days. The attacker holds no role. The copy with `creator = attacker` has the identical digest (`getOrderDigest`), so the same signature passes; `OrderProcessed(7, attacker, 40000e18)` is emitted; the attacker withdraws 40,000e18. The victim's `processOrder` then reverts `OrderAlreadyProcessed`.

End state: attacker 40,000e18 tokens; victim 0 tokens and 0 desk balance; reserve 210,000e18; `totalAllocated` 40,000e18 (nothing issued beyond what the authority signed, which is why the programme's High row applies and the Critical row does not).

## Overclaimed draft: why each claim is false

- **C1, reachable through `processOrder`.** `src/ReelPayoutDesk.sol` line 147 (`order.amount > ORDER_CEILING`) and line 148 (`totalAllocated + order.amount > issuanceLimit`, checked arithmetic) run before the only call to `_allocateFunds` (line 155). `issuanceLimit <= ALLOCATION_HARD_LIMIT = 4e25` (lines 83, 118). `2**256 / 4e25` is about 2.9e51, so the total cannot approach a wrap. An authority-signed order for `2**256 - 400e18` reverts `ValueExceedsOrderCeiling`; with the limit set to 300,000e18 the fifth order (1 wei) reverts `ValueExceedsIssuanceLimit`.
- **C2, observed on the unmodified contract.** The low-level call `exposeAllocateFunds(attacker, 2**256 - 400e18)` succeeds on the wrapper and fails on `ReelPayoutDesk`; the 4-byte selector is present in the wrapper's runtime code and absent from the contract's; the code hashes differ.
- **C3, unprivileged attacker drains the reserve (Critical).** Self-signed huge order: `ValueExceedsOrderCeiling`. Self-signed 75,000e18 order: `InvalidAuthority`. `withdraw(1)`: `InsufficientFunds`. Attacker token delta 0, reserve delta 0, `totalAllocated` 0.

## Independent check (2 Oct 2026)

- Clean rebuild (`forge clean`, `forge test`): 3 suites, 10 passed, 0 failed. The gas figures and log lines pasted in both drafts match a fresh `-vv` run; only the timing lines differ.
- Each draft's own mitigation was applied to a throwaway copy of `src/`. With `creator` added to the type string and struct hash, `test_creatorFrontRun` fails at its "same digest" assertion, so the accurate draft's PoC passes because of the stated root cause. With the `unchecked` block removed, `test_allocateOverflowDrainsReserve` fails with an arithmetic panic inside the wrapper call, so that PoC depends only on the exposed internal function, never on `processOrder`.
- Answer key change: false claim C3 in `ch-08-o/truth.json` now also covers draft lines 45-47 ("the inflated balance is converted into payout tokens immediately, up to the full reserve"). `test_falseclaim_C3_unprivilegedAttackerDeltaIsZero` already covers it (`withdraw(1)` reverts `InsufficientFunds`).
