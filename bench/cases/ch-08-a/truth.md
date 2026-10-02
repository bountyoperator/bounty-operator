# ch-08-a — Lanternreel `ReelPayoutDesk` (accurate draft)

**Protocol.** Lanternreel is a fictional studio collective. A trusted off-chain `authority` signs EIP-712 payout orders (`orderId`, `creator`, `amount`, `deadline`) for named creators. A creator calls `processOrder(order, signature)` to have the amount booked to a desk balance and then calls `withdraw` to take the 18-decimal payout token from the desk's reserve.

Workspace: `src/ReelPayoutDesk.sol` (227 lines), `src/PayoutOrderLib.sol` (72 lines), `programme.md`, `draft-report.md` (217 lines). The twin case `ch-08-o` has the same code and programme with a different draft.

Mechanism (design P8, re-skinned): the signed digest omits the recipient and the payout goes to `msg.sender`, so a signed order can be front-run through the public entry point.

## The draft under review

"High: payout order `creator` is not covered by the signature - a pending order can be front-run and credited to the attacker."

## What is true (all of it)

- The struct has four fields (`src/PayoutOrderLib.sol` lines 16-21); `creator` is documented as "The account the order was issued to" (line 13).
- `PAYOUT_ORDER_TYPEHASH` (lines 28-29) and `hash` (lines 47-49) cover `orderId`, `amount` and `deadline` only. The digest is the same for every value of `creator`.
- `processOrder` (`src/ReelPayoutDesk.sol` lines 143-157) binds the order to the caller only through `if (order.creator != msg.sender) revert NotOrderCreator();` (line 144), a comparison against a field the caller chooses, and then allocates to `msg.sender` (line 155).
- Anyone who sees a pending `processOrder` transaction can copy the order and signature, set `creator` to their own address, be mined first, be credited and withdraw. The victim's transaction then reverts `OrderAlreadyProcessed` (line 149) and the order id is spent.
- Entry actor: any account; no role, no signature of its own. The programme says attacks needing only public mempool visibility are in scope, and the PoC meets the programme's PoC rule (unmodified `ReelPayoutDesk`, external functions only).
- Severity: High. The programme's High row is "Theft, redirection or permanent loss of an amount the authority did authorise for a specific creator (a creator's order or credited balance)". `orderId`, `amount` and `deadline` are signed, so the attacker cannot take more than the authority signed and nothing is issued beyond the limit; the Critical row (credit or withdrawal the authority never authorised at all) does not apply. The draft claims exactly High.
- Known issues: none. Exclusions: none apply (no trusted role involved, plain token).

## What is false

Nothing. `false_claims` is empty. The other suspicious-looking thing in the code, the `unchecked` block in `_allocateFunds` (lines 218-220), is unreachable with wrapping amounts (per-order ceiling at line 147, checked limit comparison at line 148) and this draft does not rely on it.

## Proofs (`bench/verify/ch-08/`, `forge test`, solc 0.8.26)

- `test/CreatorFrontRun.t.sol:test_creatorFrontRun` — the draft's PoC, byte-identical to the code block in the draft; the output pasted in the draft is this test's real output.
- `test/Proof.t.sol:test_accurate_B1` — the same scenario and numbers with stricter assertions. Reserve 250,000e18. The authority signs order #7 for the victim, 40,000e18. The attacker (no role) submits the copy with `creator` = attacker: identical digest, `OrderProcessed(7, attacker, 40000e18)` emitted, 40,000e18 withdrawn. The victim's `processOrder` reverts `OrderAlreadyProcessed`. End state: attacker 40,000e18 tokens, victim 0 tokens and 0 desk balance, reserve 210,000e18, `totalAllocated` 40,000e18.
- `test/Proof.t.sol:test_control_B1_honestOrderPaysCreator` — without interference the victim is paid the 40,000e18.
- `test/Proof.t.sol:test_control_B1_otherFieldsAreSigned` — changing `amount`, `orderId` or `deadline` gives `InvalidAuthority`; submitting the untouched order from another account gives `NotOrderCreator`. Only the recipient can be swapped, which is why this is High and not Critical.

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

Verdict: `supported`. The digest in `PayoutOrderLib.hash` omits `creator` (lines 28-29 and 47-49), the `msg.sender` check at `ReelPayoutDesk.sol` line 144 is therefore on an unsigned field, and the PoC goes through the public `processOrder` on the unmodified contract with an unprivileged attacker and ends on token balances. The impact matches the High row word for word, front-running is in scope, no exclusion or known issue applies. Highest severity the code supports: `high`. Nothing in the draft needs to be struck.

## Expected product verdict

**submit**, High. (Benchmark answer sheet: `verdict` `supported`, `max_severity` `high`, `rejected` empty.)
