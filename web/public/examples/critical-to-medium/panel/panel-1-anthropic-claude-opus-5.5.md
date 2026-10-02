# Review
Verdict: rewrite-then-submit
Mode: bounty
Counts: critical=0 high=0 medium=1 hardening=1 checked-safe=3
Headline: stake() skips settlement, so a fresh staker claims the whole reward reserve; principal is untouched, so the bug is Medium, not Critical

## Claims
- C1 | confirmed | input-1/src/TesseraStaking.sol:87-94 | stake() runs _updateGlobal but never _settle. For a fresh account, earned() at input-1/src/TesseraStaking.sol:72-73 multiplies the new balance by rewardPerToken() - 0.
- C2 | confirmed | input-2/test/ReserveDrain.t.sol:72-79 | Steps 1-5 hold. A zero-second position of 1,166,666 TSR claims 69,999 TSR, and the log shows "attacker profit (TSR) 69999" with "reserve left (wei) 1".
- C3 | overstated | input-1/src/TesseraStaking.sol:115-117 | The draft says rewards come "straight out of the contract's balance". claim() reverts above rewardReserve and debits only rewardReserve, so payouts are capped at the reward budget.
- C4 | contradicted | input-1/src/TesseraStaking.sol:115 | Step 6 says repeating from fresh addresses takes principal. After the first run rewardReserve is 1 wei, so every further claim reverts ReserveShort.
- C5 | contradicted | input-1/src/TesseraStaking.sol:97-107 | Step 7 says principal is locked for good. withdraw() never reads the reserve. The exit() revert is documented as by design in input-4/docs/known-issues.md:13 (N-1) and is excluded.
- C6 | contradicted | input-2/test/ReserveDrain.t.sol:87 | The draft says 1,070,000 TSR is stolen. The test's own assertion fixes the attacker's gain at `stolen`, about 70,000 TSR. Contract balance was not measured.
- C7 | overstated | input-1/src/TesseraStaking.sol:115 | The draft rates this Critical. The evidence supports Medium: theft of unclaimed rewards, and freezing of Alice's and Bob's unclaimed rewards. It would move to Critical only if claim() could pay beyond rewardReserve.
- C8 | overstated | input-2/test/ReserveDrain.t.sol:91-97 | The proof asserts only that exit() reverts, which is documented behaviour. It never asserts that withdraw() fails.
- C9 | confirmed | input-3/draft-report.md:87-93 | The fix holds. With _settle in stake(), paidPerToken = rewardPerTokenStored and the delta is 0. assertGt at input-2/test/ReserveDrain.t.sol:88 then fails.

## Submission checks
- proof-inline | fail | Inline setUp() and TestToken from input-2/test/ReserveDrain.t.sol:7-65. The draft shows only the test function.
- form-matches-body | fail | Change the selected row and the body (input-3/draft-report.md:3-4, 83) to "Medium: Theft of unclaimed rewards".
- limits-stated | fail | Add that the loss is capped at rewardReserve per funding (input-1/src/TesseraStaking.sol:115) and that principal stays withdrawable.
- title | fail | The consequence in the title, "lock every staker's funds", is contradicted by input-1/src/TesseraStaking.sol:97-107.
- steps-separate | pass | input-3/draft-report.md:27-33
- read-back | not-supplied | none
- concrete-detail | pass | input-3/draft-report.md:13, 29-31, 40, 71-76

## Generic passages
- "whatever is staked on mainnet" | input-3/draft-report.md:83 | The bound is rewardReserve: 70,000 TSR before the run and 1 wei after it.
- "with no capital of their own" | input-3/draft-report.md:83 | Needs 1,166,666 TSR of flash liquidity, minted at input-2/test/ReserveDrain.t.sol:73. No flash fee is modelled.
- "Their 1,000,000 TSR is locked in the contract for good" | input-3/draft-report.md:33 | withdraw(600_000e18) does not depend on the reserve (input-1/src/TesseraStaking.sol:97-107).

## Rewritten report
Title: stake() does not settle the caller, so a flash-staked fresh account claims the entire TesseraStaking reward reserve.
Severity: Medium
Summary: stake() calls _updateGlobal() but not _settle(), so a fresh account keeps paidPerToken = 0, and earned() credits it rewardPerToken() × balance immediately. Six days into a 70,000 TSR period, staking 1,166,666 TSR and calling claim() and then withdraw() in one block pays the attacker 69,999 TSR and leaves rewardReserve at 1 wei.
Impact: The attacker takes Alice's and Bob's roughly 60,000 TSR of accrued rewards plus the unstreamed remainder. Their claim() then reverts ReserveShort until the next funding. The loss is capped at rewardReserve and can be repeated each funding.
Limits: Principal is not reachable. claim() is bounded by rewardReserve and withdraw() ignores the reserve. The exit() revert is the documented N-1. Flash-loan availability and fees were not tested.

## F-1: Unsettled stake() lets a fresh account claim the whole reward reserve
Severity: medium
Basis: proven-in-source
Location: input-1/src/TesseraStaking.sol:87-94; input-1/src/TesseraStaking.sol:71-74; input-1/src/TesseraStaking.sol:110-118
Impact: Stakers lose all unclaimed rewards held in rewardReserve, 70,000 TSR here, and their claims are frozen until the next funding. Principal is unaffected.
Path:
6. Repeat from a fresh address: claim() reverts ReserveShort(reward, 1) at input-1/src/TesseraStaking.sol:115.
7. Alice calls withdraw(600_000e18), which succeeds. Her claim() reverts ReserveShort.
Counterargument: The exit() revert is known issue N-1 | resolved | input-4/docs/known-issues.md:13 covers only the exit() revert, and no entry there covers the reward theft.
Gap: none
Fix: Call _settle(msg.sender) after _updateGlobal() in stake() (input-1/src/TesseraStaking.sol:89).
Test:
```solidity
// append after line 80 of test_attackerDrainsContractAndFreezesStakers
assertLe(stolen, 70_000e18);
vm.prank(alice);
vm.expectRevert(); // ReserveShort: Alice's accrued rewards are gone
staking.claim();
vm.prank(alice);
staking.withdraw(600_000e18); // principal still exits
assertEq(tsr.balanceOf(alice), 600_000e18);
```
Next: Rewrite the report as Medium, select "Medium: Theft of unclaimed rewards", and inline the full test file.

## Hardening
- exit() is all-or-nothing | input-1/src/TesseraStaking.sol:123-126 | Skip the claim when the reserve is short, so stakers using exit() are not forced to call withdraw() separately.

## Checked and safe
- Principal withdrawal | input-1/src/TesseraStaking.sol:97-107 | withdraw() never reads rewardReserve.
- Reward payout bound | input-1/src/TesseraStaking.sol:115 | A claim larger than rewardReserve reverts.
- Funding access | input-1/src/TesseraStaking.sol:130 | Only the funder can call notifyReward().

## Coverage
Reviewed: input-1/src/TesseraStaking.sol, input-2/test/ReserveDrain.t.sol, input-3/draft-report.md, input-4/docs/known-issues.md
Not supplied: none
