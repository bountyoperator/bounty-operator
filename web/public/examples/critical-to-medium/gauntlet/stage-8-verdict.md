# Review
Verdict: prove-first
Mode: bounty
Counts: critical=0 high=0 medium=1 hardening=1 checked-safe=4
Headline: Medium reward theft from an unsettled stake() is real, but no assertion reads the stakers' unclaimed rewards yet. Run that test first.

## Stages
- input-5/stage-1-scope.md | rewrite-then-submit | Scope binds to v1.2.0. The freeze claim matches excluded N-1. The principal row is not met.
- input-6/stage-2-provenance.md | submit | Every decisive step is unprivileged. Overruled: its own text requires a Medium rewrite, and the proof does not read the victims' rewards.
- input-7/stage-3-prior-art.md | rewrite-then-submit | No duplicate. N-1 shares only the symptom. Duplicate clock is high.
- input-8/stage-4-poc.md | rewrite-then-submit | The impact-assertion, before-after, measured-loss and fix-assertion checks fail or are absent.
- input-9/stage-5-severity.md | rewrite-then-submit | The proof meets the Medium "Theft of unclaimed rewards" row, and no higher row.
- input-10/stage-6-triage.md | rewrite-then-submit | Rejection reason 2 (impact not shown) is still open.
- input-11/stage-7-report.md | rewrite-then-submit | Supplies a rewritten report and a test that asserts the impact. That test has no run log.

## Decision
Why: The passing test reads only the attacker's balance (input-2/test/ReserveDrain.t.sol:87-88) and the exit() revert (input-2/test/ReserveDrain.t.sol:91-97). That revert is excluded behaviour under N-1 (input-4/docs/known-issues.md:13). No assertion reads Alice's or Bob's unclaimed rewards, the object the Medium row names. The asserting test at input-11/stage-7-report.md:54-76 has never been run.
Rule: prove-first. No assertion reads the object the impact row names, and that also leaves the victims' loss unmeasured.
Blocker: No run log exists for an assertion showing that earned(alice)+earned(bob) exceeds rewardReserve() and that Alice's claim reverts while her withdraw() succeeds.
Cheapest action: Paste input-11/stage-7-report.md:54-76 into test/ReserveDrain.t.sol, run it on v1.2.0 with -vv, and save the output.
Severity to claim: Medium: Theft of unclaimed rewards, from the Tessera Staking programme scale.
Deadline: file within hours of removing the blocker, or skip
First reproduced: 2026-09-30

## To do
- 1 | Add test_stakeWithoutSettleTakesStakersRewards from input-11/stage-7-report.md:54-76 and run `forge test --match-test test_stakeWithoutSettleTakesStakersRewards -vv` on v1.2.0 | run log asserting the victims' reward loss with principal intact | stage-4-poc, stage-6-triage
- 2 | Add `_settle(msg.sender)` after `_updateGlobal()` in a local copy, run test_freshStakeEarnsNothingImmediately (input-8/stage-4-poc.md:88-97), then revert the patch | fix-assertion log | stage-4-poc
- 3 | Rewrite the draft from input-11/stage-7-report.md:36-40 and set form and body to "Medium: Theft of unclaimed rewards" | report without steps 6-7, the 1,070,000 TSR figure or the "no capital" claim | stage-5-severity, stage-7-report
- 4 | Write the first paragraph so it separates the root from N-1 and states the limits: bounded by rewardReserve per funded period, principal untouched, no flash-loan source tested | first paragraph and limits section | stage-3-prior-art, stage-6-triage, stage-7-report
- 5 | Inline the new test and its log in the body and the proof field, keeping the console2.log lines | self-contained proof | stage-7-report
- 6 | After filing, read back the stored proof field, severity and impact row under the report id and compare them with the draft | read-back record | stage-7-report

## F-1: Unsettled stake() lets any account take the reward reserve, including stakers' unclaimed rewards
Severity: medium
Basis: proven-in-source
Location: input-1/src/TesseraStaking.sol:87-94; input-1/src/TesseraStaking.sol:71-74; input-1/src/TesseraStaking.sol:115-117
Impact: Alice and Bob lose about 60,000 TSR of accrued, unclaimed rewards (36,000 and 24,000), and the roughly 10,000 TSR of unstreamed budget is taken with it. The loss is bounded by rewardReserve per funded period. The 1,000,000 TSR of principal stays withdrawable.
Path:
1. The funder calls notifyReward(70_000e18), which sets rewardRate to about 0.1157e18 per second. Alice stakes 600_000e18 and Bob stakes 400_000e18.
2. After 6 days, rewardPerToken() is about 6e16.
3. The attacker calls stake(1_166_666e18). stake() runs _updateGlobal but never _settle, so paidPerToken[attacker] stays 0 (input-1/src/TesseraStaking.sol:89-91).
4. The attacker calls claim(). earned() returns about 69,999e18, which passes the check at :115, and rewardReserve falls to 1 wei.
5. The attacker calls withdraw(1_166_666e18) and gets the full stake back. Alice's claim() of about 36,000e18 now reverts with ReserveShort.
Counterargument: The exit() freeze is N-1, and repeat runs take principal | resolved | Only the freeze symptom is excluded (input-4/docs/known-issues.md:13). The reward cap at input-1/src/TesseraStaking.sol:115 blocks any payout from principal, and withdraw() never reads the reserve (input-1/src/TesseraStaking.sol:97-107). The reward theft has a separate root.
Gap: run log of the impact-asserting test on v1.2.0
Fix: Call `_settle(msg.sender)` after `_updateGlobal()` in stake() (input-1/src/TesseraStaking.sol:89).
Test:
```solidity
function test_stakeWithoutSettleTakesStakersRewards() public {
    vm.warp(block.timestamp + 6 days);
    assertApproxEqRel(staking.earned(alice) + staking.earned(bob), 60_000e18, 1e15);
    uint256 size = (staking.rewardReserve() * 1e18) / staking.rewardPerToken();
    tsr.mint(attacker, size);
    vm.startPrank(attacker);
    tsr.approve(address(staking), size);
    staking.stake(size);
    uint256 stolen = staking.claim();
    staking.withdraw(size);
    vm.stopPrank();
    assertGt(stolen, 69_999e18);                         // fails after the fix
    uint256 owedAlice = staking.earned(alice);
    uint256 reserve = staking.rewardReserve();
    assertGt(owedAlice + staking.earned(bob), reserve);
    vm.prank(alice);
    vm.expectRevert(abi.encodeWithSelector(TesseraStaking.ReserveShort.selector, owedAlice, reserve));
    staking.claim();
    assertGe(tsr.balanceOf(address(staking)), staking.totalStaked());
    vm.prank(alice);
    staking.withdraw(600_000e18);
    assertEq(tsr.balanceOf(alice), 600_000e18);
}
```
Next: Run this test locally on v1.2.0 and save the log.

## Hardening
- exit() blocks principal while the reserve is short | input-1/src/TesseraStaking.sol:123-126 | Pay the principal and defer the claim. This is N-1 and is not eligible.

## Checked and safe
- Payout cannot reach principal | input-1/src/TesseraStaking.sol:115-117 | Every payout is capped by rewardReserve and debited from it, so the contract keeps 1,000,000e18 + 1 wei. Draft step 6 is false.
- Principal withdrawal is independent of the reserve | input-1/src/TesseraStaking.sol:97-107 | withdraw() checks only balanceOf before it transfers.
- The attacker cannot refill the reserve | input-1/src/TesseraStaking.sol:130 | Only the trusted funder can call notifyReward.
- Reserve is debited before the transfer | input-1/src/TesseraStaking.sol:116-118 | A re-entering token cannot be paid twice.

## Coverage
Reviewed: input-1/src/TesseraStaking.sol, input-2/test/ReserveDrain.t.sol, input-3/draft-report.md, input-4/docs/known-issues.md, input-5/stage-1-scope.md, input-6/stage-2-provenance.md, input-7/stage-3-prior-art.md, input-8/stage-4-poc.md, input-9/stage-5-severity.md, input-10/stage-6-triage.md, input-11/stage-7-report.md
Not supplied: a TSR flash-loan source and its fee, which affect only the per-run size; the stored submission for read-back
