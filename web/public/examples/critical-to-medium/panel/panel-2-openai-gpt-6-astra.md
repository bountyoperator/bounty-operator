# Review
Verdict: rewrite-then-submit
Mode: bounty
Counts: critical=0 high=0 medium=1 hardening=0 checked-safe=0
Headline: Missing stake settlement enables reward theft, but the reserve guard protects principal and withdraw remains available.

## Claims
- C1 | confirmed | input-1/src/TesseraStaking.sol:81-94 | stake() updates the global accumulator without settling the caller before increasing its balance.
- C2 | confirmed | input-1/src/TesseraStaking.sol:71-74; input-1/src/TesseraStaking.sol:89-91 | A fresh account's zero paidPerToken credits its new stake against the accumulated historical reward-per-token value.
- C3 | overstated | input-2/test/ReserveDrain.t.sol:71-88; input-3/draft-report.md:74-76 | The proof uses a computed stake, not exactly 1,166,666 TSR. Its integer logs truncate: the payout is 70,000 TSR minus 1 wei, not exactly 69,999 TSR.
- C4 | overstated | input-2/test/ReserveDrain.t.sol:73-79; input-3/draft-report.md:83 | The same-transaction stake/claim/withdraw sequence is demonstrated; borrowing, repayment and zero-capital profitability are not. Capital is minted.
- C5 | contradicted | input-1/src/TesseraStaking.sol:113-118 | Repetition cannot drain principal: each payout must fit rewardReserve and reduces that reserve. The claimed 1,070,000 TSR theft is not demonstrated.
- C6 | contradicted | input-1/src/TesseraStaking.sol:97-105; input-1/src/TesseraStaking.sol:122-125 | exit() reverting does not permanently freeze principal. withdraw() returns the caller's recorded stake without checking rewardReserve.
- C7 | contradicted | input-2/test/ReserveDrain.t.sol:87-97; input-1/src/TesseraStaking.sol:115-117 | The demonstrated severity is Medium: theft of unclaimed rewards. Critical would require the payout limit to permit debiting staked principal; it does not.
- C8 | confirmed | input-3/draft-report.md:87-93; input-1/src/TesseraStaking.sol:81-83 | Settling after _updateGlobal() and before increasing balance closes the path. The proof's positive-profit assertion then fails.
- C9 | confirmed | input-4/docs/known-issues.md:7-15 | The missing stake checkpoint is distinct from the listed issues. N-1 documents reserve-short exit behavior, not historical reward theft.

## Submission checks
- proof-inline | not-supplied | input-3/draft-report.md:39-79 contains source, command and output; no separate proof-field contents were supplied.
- form-matches-body | pass | The selected Critical principal-theft row matches input-3/draft-report.md:3-4, although both require correction.
- limits-stated | fail | State the rewardReserve bound, accumulated-reward prerequisite, minted capital and untested flash-loan integration.
- title | pass | input-3/draft-report.md:1 names mechanism and consequence; the consequence must be narrowed.
- steps-separate | pass | input-3/draft-report.md:25-33
- read-back | not-supplied | No stored submission was supplied.
- concrete-detail | pass | input-3/draft-report.md:23-30; input-3/draft-report.md:40-78

## Rewritten report
Title: Missing settlement in stake() lets new deposits steal previously accumulated rewards.
Severity: medium
Summary: stake() increases the caller's balance without checkpointing its historical reward entitlement. A fresh account can immediately claim rewards for time before its deposit.
Impact: Alice and Bob lose access to accrued rewards when the attacker depletes their shared reward budget; the supplied run transfers 70,000 TSR minus 1 wei to the attacker, bounded by rewardReserve.
Limits: The attack requires a positive accumulated reward-per-token value and sufficient temporary stake capital. Principal remains withdrawable; flash-loan integration was not tested.

## F-1: Missing stake checkpoint enables theft of unclaimed rewards
Severity: medium
Basis: proven-in-source
Location: input-1/src/TesseraStaking.sol:71-94; input-1/src/TesseraStaking.sol:110-118
Impact: An unprivileged depositor takes rewards allocated to existing stakers, capped by the available rewardReserve.
Path:
1. Replace the rounded stake in the draft with size = rewardReserve * 1e18 / rewardPerToken(), evaluated after six days against the 70,000 TSR reserve.
2. After stake(size), claim() and withdraw(size), the reserve contains 1 wei; repetition cannot cross the reserve guard.
3. Alice and Bob can separately withdraw their 600,000 and 400,000 TSR principal despite exit() reverting.
Counterargument: Reserve-short exit() is documented as intended and excluded. | resolved | That behavior is not the finding; the missing deposit checkpoint creates unauthorized reward entitlement, distinct from N-1 in input-4/docs/known-issues.md:13.
Gap: none
Fix: Insert _settle(msg.sender) immediately after _updateGlobal() in stake(), before either stake balance increases, at input-1/src/TesseraStaking.sol:89-91.
Test:
```solidity
// Add to the supplied local ReserveDrainTest fixture.
// Demonstrates the corrected impact; the theft assertion fails after the fix.
function test_rewardTheftDoesNotConsumePrincipal() public {
    vm.warp(block.timestamp + 6 days);
    uint256 size =
        staking.rewardReserve() * 1e18 / staking.rewardPerToken();
    _stake(attacker, size);

    vm.startPrank(attacker);
    uint256 stolen = staking.claim();
    staking.withdraw(size);
    vm.stopPrank();

    assertEq(stolen, 70_000e18 - 1);
    assertEq(staking.rewardReserve(), 1);
    assertEq(tsr.balanceOf(address(staking)), 1_000_000e18 + 1);

    vm.prank(alice);
    staking.withdraw(600_000e18);
    vm.prank(bob);
    staking.withdraw(400_000e18);

    assertEq(tsr.balanceOf(alice), 600_000e18);
    assertEq(tsr.balanceOf(bob), 400_000e18);
    assertEq(tsr.balanceOf(address(staking)), 1);
}
```
Next: Revise the body and form to Medium: Theft of unclaimed rewards, include the corrected limits, and populate both proof locations.

## Coverage
Reviewed: input-1/src/TesseraStaking.sol; input-2/test/ReserveDrain.t.sol; input-3/draft-report.md; input-4/docs/known-issues.md
Not supplied: Separate proof field and stored submission read-back.
