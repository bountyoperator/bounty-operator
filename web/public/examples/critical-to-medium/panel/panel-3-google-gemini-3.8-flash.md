# Review
Verdict: rewrite-then-submit
Mode: bounty
Counts: critical=0 high=0 medium=1 hardening=0 checked-safe=1
Headline: stake() omits caller settlement, letting an attacker drain unclaimed rewards in one transaction, but staked principal is safe.

## Claims
- C1 | confirmed | input-1/src/TesseraStaking.sol:87-94 | stake() updates the global accumulator but does not call _settle(msg.sender), leaving paidPerToken at 0.
- C2 | confirmed | input-1/src/TesseraStaking.sol:71-74 | earned() evaluates unindexed balance against the entire accumulated rewardPerTokenStored.
- C3 | confirmed | input-2/test/ReserveDrain.t.sol:71-80 | Flash-staking enables immediate claiming of 69,999 TSR accrued over the preceding six days.
- C4 | contradicted | input-1/src/TesseraStaking.sol:115 | Line 115 enforces reward <= rewardReserve, preventing any claim from touching staked principal.
- C5 | contradicted | input-3/draft-report.md:32 | Steps 3 to 5 cannot be repeated to drain principal; subsequent claims revert with ReserveShort.
- C6 | contradicted | input-3/draft-report.md:33 | Principal is not locked; withdraw() does not check rewardReserve and executes successfully.
- C7 | contradicted | input-4/docs/known-issues.md:13 | exit() reverts by design when reserve is empty (N-1), but withdraw() remains fully operational.
- C8 | overstated | input-3/draft-report.md:82-84 | Severity is Medium under programme rules (theft of unclaimed rewards); moving to Critical requires principal loss.
- C9 | confirmed | input-3/draft-report.md:87-93 | Invoking _settle(msg.sender) prior to balance modification eliminates retroactive reward accrual.

## Submission checks
- proof-inline | pass | input-3/draft-report.md:39-79
- form-matches-body | pass | input-3/draft-report.md:3-4
- limits-stated | fail | input-3/draft-report.md:82-84; state that theft is capped at rewardReserve and principal is withdrawable via withdraw()
- title | fail | input-3/draft-report.md:1; update title to reflect reward reserve theft rather than total contract drain and locking
- steps-separate | pass | input-3/draft-report.md:27-33
- read-back | not-supplied | none
- concrete-detail | pass | input-3/draft-report.md:27-33

## Generic passages
- "takes the rest of the contract's TSR, which is Alice's and Bob's principal" | input-3/draft-report.md:32 | Line 115 reverts with ReserveShort(reward, 1 wei)
- "Their 1,000,000 TSR is locked in the contract for good." | input-3/draft-report.md:33 | staking.withdraw(balanceOf[alice]) succeeds and returns 600,000 TSR

## Rewritten report
Title: Missing settlement in stake() allows draining of rewardReserve via flash-deposit
Severity: Medium
Summary: TesseraStaking.stake() omits _settle(msg.sender), allowing a new depositor to retain paidPerToken == 0 and claim rewards retroactively for elapsed periods. An unprivileged caller using flash-loaned capital can extract the entire rewardReserve in a single transaction.
Impact: Stakers lose up to 100% of unclaimed rewards (capped at rewardReserve, 70,000 TSR in PoC). Staked principal is neither stolen nor frozen.
Limits: Theft is bounded by rewardReserve via line 115. Stakers can retrieve full principal at any time via withdraw(); only exit() reverts due to the zeroed reserve.

## F-1: Missing account settlement in stake() allows draining of reward reserve
Severity: medium
Basis: proven-in-source
Location: input-1/src/TesseraStaking.sol:87-95; input-1/src/TesseraStaking.sol:113-118
Impact: Legitimate stakers lose all accrued, unclaimed rewards up to the remaining rewardReserve.
Path: none
Counterargument: N-1 states exit() reversion on empty reserve is known and by design | resolved | N-1 acknowledges exit() failing when rewards run short, but not instantaneous theft of the entire reserve by an uncheckpointed zero-duration stake.
Gap: none
Fix: Add _settle(msg.sender) to stake() after _updateGlobal() and before updating balances.
Test:
```solidity
function test_principalCanBeWithdrawnDespiteEmptyReserve() public {
    vm.warp(block.timestamp + 6 days);
    uint256 size = (staking.rewardReserve() * 1e18) / staking.rewardPerToken();
    tsr.mint(attacker, size);
    vm.startPrank(attacker);
    tsr.approve(address(staking), size);
    staking.stake(size);
    staking.claim();
    staking.withdraw(size);
    vm.stopPrank();

    // Alice can successfully withdraw her principal despite empty rewardReserve
    vm.prank(alice);
    staking.withdraw(600_000e18);
    assertEq(tsr.balanceOf(alice), 600_000e18);
}
```
Next: Rewrite the draft report to target Medium severity (theft of unclaimed rewards) and remove claims of principal loss.

## Checked and safe
- withdraw() principal safety | input-1/src/TesseraStaking.sol:97-107 | Does not read rewardReserve or depend on reward solvency; principal transfers out directly.

## Coverage
Reviewed: input-1/src/TesseraStaking.sol, input-2/test/ReserveDrain.t.sol, input-3/draft-report.md, input-4/docs/known-issues.md
Not supplied: none
