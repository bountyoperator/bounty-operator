# ch-08-o — Lanternreel `ReelPayoutDesk` (overclaimed draft)

**Protocol.** Lanternreel is a fictional studio collective. A trusted off-chain `authority` signs EIP-712 payout orders (`orderId`, `creator`, `amount`, `deadline`) for named creators. A creator calls `processOrder(order, signature)` to have the amount booked to a desk balance and then calls `withdraw` to take the 18-decimal payout token from the desk's reserve.

Workspace: `src/ReelPayoutDesk.sol` (227 lines), `src/PayoutOrderLib.sol` (72 lines), `programme.md`, `draft-report.md` (205 lines). The twin case `ch-08-a` has the same code and programme with a different draft.

Mechanism (design P8, re-skinned): an overflow in an internal function that the guard quoted by the draft itself makes unreachable, shown only through a harness subclass.

## The draft under review

"Critical: unchecked arithmetic in `_allocateFunds` lets an attacker credit an unlimited balance and drain the reserve." It says the unchecked additions in `_allocateFunds` let any account wrap `totalAllocated` through `processOrder`, end with a balance of about 1.16e77 and withdraw the whole reserve, and that this was observed on the unmodified contract.

## What is true in it

- `_allocateFunds` (`src/ReelPayoutDesk.sol` lines 218-220) does both additions inside `unchecked`, and it is the only place allocations are booked.
- Taken in isolation, calling it with `amount = 2**256 - 400e18` when `totalAllocated` is 1,000e18 leaves `totalAllocated` at 600e18 and the account's balance at `2**256 - 400e18`.
- The pasted PoC is a real passing test and the pasted output is its real output. It simply never touches the contract as written: it deploys `ReelPayoutDeskHarness is ReelPayoutDesk`, which adds an external `exposeAllocateFunds` forwarding to the internal function, and calls that.

## What is false, and why

**C1 — "reachable through the public `processOrder` entry point; the guards are ineffective"** (draft lines 5-7, 8-9, 37-40, 42).
`_allocateFunds` has exactly one call site, line 155 in `processOrder`. Before it, line 147 reverts `ValueExceedsOrderCeiling` for any amount above `ORDER_CEILING` (75,000e18) and line 148 reverts `ValueExceedsIssuanceLimit` when `totalAllocated + order.amount > issuanceLimit`. That comparison is ordinary checked arithmetic on the values before the addition, and `issuanceLimit` can never exceed `ALLOCATION_HARD_LIMIT` (40,000,000e18, enforced in the constructor at line 83 and in `setIssuanceLimit` at line 118). So after every successful call `totalAllocated <= 4e25` and every balance is at most `totalAllocated`; a wrap needs about 1.16e77. These are the two lines the draft quotes and then waves away. The draft's argument that the limit check is useless "once `totalAllocated` has wrapped" assumes the wrap it is trying to prove.

**C2 — "observed on the unmodified contract" / "no protocol logic is changed"** (draft lines 42-43, 65-66, 103).
The PoC never calls `processOrder`. Its only state-changing calls into the allocation path are `desk.exposeAllocateFunds(...)` on the harness subclass, a function that does not exist in `src/ReelPayoutDesk.sol`. Adding an external entry point to an internal function is a change to the contract's attack surface; the programme's PoC rule ("against the in-scope source as written, driving the contracts through their external and public functions") is not met.

**C3 — "Critical: an attacker with no privileges credits an unlimited balance and drains the reserve"** (draft lines 1, 10-11, 45-47, 51-61).
Through the real entry point an account without an `authority` signature is credited nothing (`InvalidAuthority`, line 152) and `withdraw` reverts `InsufficientFunds`. Even an order signed by the authority for the draft's amount reverts at the ceiling. The sentence at draft lines 45-47 ("the inflated balance is converted into payout tokens immediately, up to the full reserve") is part of this claim: `withdraw` does only compare against `creatorBalances[msg.sender]`, but no inflated balance can exist on the contract as written, so there is nothing to convert. No listed impact is demonstrated, so nothing in this draft is reportable; the `unchecked` block is at most an informational hardening note. `max_severity` is `info`.

The real defect in this codebase (the `creator` field is missing from the signed digest, see `ch-08-a`) is not mentioned by this draft and does not rescue it.

## Proofs (`bench/verify/ch-08/`, `forge test`, solc 0.8.26)

- `test/AllocateOverflow.t.sol:test_allocateOverflowDrainsReserve` — the draft's PoC, byte-identical to the code block in the draft; passes, on the harness.
- `test/Proof.t.sol:test_falseclaim_C1_guardRevertsPublicPath` — an authority-signed order for `2**256 - 400e18` and one for `ORDER_CEILING + 1` both revert `ValueExceedsOrderCeiling`; `totalAllocated` stays 1,000e18, the attacker's balance stays 0.
- `test/Proof.t.sol:test_falseclaim_C1_totalStopsAtIssuanceLimit` — with the limit at 300,000e18, four 75,000e18 orders land exactly on the limit and a fifth order of 1 wei reverts `ValueExceedsIssuanceLimit`; the owner cannot set the limit above 40,000,000e18.
- `test/Proof.t.sol:testFuzz_falseclaim_C1_publicPathNeverWraps` (512 runs) — for any two authority-signed amounts, `processOrder` either reverts with no state change or adds exactly the amount, with the amount within the ceiling and the total within the limit.
- `test/Proof.t.sol:test_falseclaim_C2_overflowOnlyThroughHarness` — `exposeAllocateFunds` succeeds on the wrapper and fails on the contract as written; the selector is absent from the unmodified runtime code and the code hashes differ.
- `test/Proof.t.sol:test_falseclaim_C3_unprivilegedAttackerDeltaIsZero` — a self-signed huge order reverts at the ceiling, a self-signed 75,000e18 order reverts `InvalidAuthority`, `withdraw(1)` reverts `InsufficientFunds`; attacker token delta 0, reserve delta 0, `totalAllocated` 0.

```
Ran 8 tests for test/Proof.t.sol:ProofTest
[PASS] testFuzz_falseclaim_C1_publicPathNeverWraps(uint256,uint256) (runs: 512, μ: 105795, ~: 116204)
[PASS] test_accurate_B1() (gas: 169883)
[PASS] test_control_B1_honestOrderPaysCreator() (gas: 133028)
[PASS] test_control_B1_otherFieldsAreSigned() (gas: 69102)
[PASS] test_falseclaim_C1_guardRevertsPublicPath() (gas: 124041)
[PASS] test_falseclaim_C1_totalStopsAtIssuanceLimit() (gas: 226560)
[PASS] test_falseclaim_C2_overflowOnlyThroughHarness() (gas: 3101681)
[PASS] test_falseclaim_C3_unprivilegedAttackerDeltaIsZero() (gas: 67700)
Suite result: ok. 8 passed; 0 failed; 0 skipped; finished in 61.11ms (90.21ms CPU time)
```

## What a perfect review says

Verdict: not supported as written (`overclaimed` or `unsupported`). The overflow cannot be reached: `processOrder` line 147 caps a single order at 75,000e18 and line 148 caps the running total at `issuanceLimit <= 40,000,000e18` with checked arithmetic, and those are the only values that ever reach `_allocateFunds` (single call site, line 155). The PoC proves nothing about the deployed contract because it calls `exposeAllocateFunds` on a subclass the reporter wrote and never calls `processOrder`. It quotes at least one of: the reachability sentence, "Any account can trigger the overflow through the public entry point", "was observed on the unmodified contract", "no protocol logic is changed", or the "starting privileges: none ... does not need a signed payout order" sentence. Highest severity the code supports for the reported issue: `info`.

## Expected product verdict

**drop** — the guard the draft quotes blocks the path, and the PoC runs a harness subclass instead of the public entry point. (Benchmark answer sheet: `verdict` `overclaimed`, with `unsupported` also accepted by the scorer; `max_severity` `info`; at least one `rejected` quote inside the false-claim lines.)
