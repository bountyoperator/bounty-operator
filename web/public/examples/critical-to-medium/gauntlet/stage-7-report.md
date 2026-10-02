# Review
Verdict: rewrite-then-submit
Mode: bounty
Counts: critical=0 high=0 medium=1 hardening=1 checked-safe=4
Headline: stake() skipping _settle is real, but :115 caps payouts at rewardReserve, so it is Medium theft of unclaimed rewards, not Critical

## Claims
- C1 | confirmed | input-1/src/TesseraStaking.sol:87-94; input-1/src/TesseraStaking.sol:72-73; input-1/src/TesseraStaking.sol:83 | stake() runs _updateGlobal but never _settle. paidPerToken is written only in _settle, so a fresh account's new balance earns all history.
- C2 | confirmed | input-3/draft-report.md:27-31; input-3/draft-report.md:74-76 | Steps 1-5 match the run: stake of 1166666 TSR, profit of 69999 TSR, 1 wei of reserve left.
- C3 | contradicted | input-1/src/TesseraStaking.sol:115-117 | Step 6 says repeat runs take principal. Every payout is capped at rewardReserve and debited from it, and the reserve holds 1 wei. Only the funder refills it (:130).
- C4 | contradicted | input-1/src/TesseraStaking.sol:97-107; input-4/docs/known-issues.md:13 | Step 7 claims a permanent freeze. withdraw() never reads the reserve. The exit() revert is N-1, which is excluded.
- C5 | contradicted | input-3/draft-report.md:83; input-2/test/ReserveDrain.t.sol:87-88 | The figure "1,070,000 TSR" is wrong. The proof measures 69,999 TSR. Balance stays equal to totalStaked + rewardReserve, so the contract keeps 1,000,000e18 + 1 wei.
- C6 | overstated | input-3/draft-report.md:83; input-2/test/ReserveDrain.t.sol:73 | "No capital of their own" is not shown. The loan is minted and no TSR flash-loan source is supplied. Any stake size steals proportionally (:73), so the finding stands.
- C7 | overstated | input-3/draft-report.md:3-4 | The evidence supports Medium "Theft of unclaimed rewards": Alice and Bob had about 60,000 TSR accrued. The one assumption that would move it to High is a withdraw() revert lasting 24 hours or more, and :97-107 contradicts that.
- C8 | confirmed | input-3/draft-report.md:89-93; input-1/src/TesseraStaking.sol:114 | The fix closes the path. paidPerToken is set to rewardPerTokenStored when the stake lands, so claim() returns 0. It also covers top-up stakes by existing accounts.
- C9 | overstated | input-2/test/ReserveDrain.t.sol:87-97 | :88 fails once the fix is applied, which is good. :91-97 assert only the N-1 exit() revert, and nothing reads the stakers' rewards or principal.
- C10 | contradicted | input-3/draft-report.md:9 | The draft does not state what the stages settled: the Medium row (input-9/stage-5-severity.md:18), N-1 as the nearest item (input-7/stage-3-prior-art.md:19), and the scope match on N-1 (input-5/stage-1-scope.md:11).

## Submission checks
- proof-inline | pass | input-3/draft-report.md:37-79. The inline test omits the console2.log lines that produce the Logs block; restore input-2/test/ReserveDrain.t.sol:82-84.
- form-matches-body | fail | The body argues two Critical rows (input-3/draft-report.md:4, :83) and the form selects one. Set both to "Medium: Theft of unclaimed rewards".
- limits-stated | fail | Add that the loss per funded period is bounded by rewardReserve and that principal is untouched. Also add that no flash-loan source was tested.
- title | fail | The consequence in input-3/draft-report.md:1 is contradicted by input-1/src/TesseraStaking.sol:115.
- steps-separate | pass | input-3/draft-report.md:25-33
- read-back | not-supplied | Context holds no stored submission.
- concrete-detail | pass | input-3/draft-report.md:13; input-3/draft-report.md:29; input-3/draft-report.md:75

## Generic passages
- "whatever is staked on mainnet" | input-3/draft-report.md:83 | Use 69,999 TSR of a 70,000 TSR reserve. The file is undeployed (input-1/src/TesseraStaking.sol:11).
- "empties the contract in one transaction" | input-3/draft-report.md:9 | Use the log line "reserve left (wei) 1". Principal stays at 1,000,000e18.
- "takes the rest of the contract's TSR" | input-3/draft-report.md:32 | A repeat claim reverts with ReserveShort at input-1/src/TesseraStaking.sol:115.
- "locked in the contract for good" | input-3/draft-report.md:33 | Show withdraw(600_000e18) succeeding for Alice (input-8/stage-4-poc.md:66-68).
- "with no capital of their own" | input-3/draft-report.md:83 | Say "tsr.mint stands in for a flash loan" (input-2/test/ReserveDrain.t.sol:73).

## Rewritten report
Title: stake() never settles the caller, so a fresh stake claims the whole reward reserve, including stakers' unclaimed rewards.
Severity: Medium (Theft of unclaimed rewards)
Summary: stake() runs _updateGlobal() but not _settle(), so a new account's paidPerToken stays 0 and earned() credits its whole balance with every reward since deployment. Six days into a 70,000 TSR period, an unprivileged stake → claim → withdraw takes 69,999 TSR and leaves 1 wei. That reserve backed about 60,000 TSR already accrued to Alice and Bob (36,000 and 24,000).
Impact: Stakers lose accrued unclaimed rewards and the programme loses the unstreamed budget. Each run is bounded by rewardReserve, and the attack can be repeated each funded period.
Limits: Principal is untouched. Every payout is capped and debited at :115-117, and withdraw() still succeeds. The exit() revert is known issue N-1 and is not claimed. The finding differs from N-1 in its root cause. No flash-loan source was tested, and the gain scales with stake size.

## F-1: Unsettled stake() lets any account take the reward reserve, including stakers' accrued rewards
Severity: medium
Basis: proven-in-source
Location: input-1/src/TesseraStaking.sol:87-94; input-1/src/TesseraStaking.sol:71-74; input-1/src/TesseraStaking.sol:115-117
Impact: Alice and Bob lose about 60,000 TSR of accrued unclaimed rewards, and about 10,000 TSR of unstreamed budget goes with it. The loss is bounded by rewardReserve per funded period. The 1,000,000 TSR of principal stays withdrawable.
Path:
1. This replaces draft steps 6-7. After step 5, Alice's claim() of about 36,000e18 reverts with ReserveShort(≈36,000e18, 1), and withdraw(600_000e18) returns her principal.
Counterargument: The freeze is the excluded N-1 behaviour | resolved | Only the exit() symptom is shared. The theft root is the missing _settle at input-1/src/TesseraStaking.sol:89-90, which input-4/docs/known-issues.md:7-15 does not list.
Gap: none
Fix: Add _settle(msg.sender) after _updateGlobal() in stake() (input-1/src/TesseraStaking.sol:89).
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
    assertGt(stolen, 69_999e18);                       // fails after the fix
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
Next: Refile under the Medium row with this test in the body and the proof field. File quickly, because the duplicate clock is high (input-7/stage-3-prior-art.md:34).

## Hardening
- exit() blocks principal while the reserve is short | input-1/src/TesseraStaking.sol:123-126 | Pay the principal and defer the claim. This is N-1 and is not eligible.

## Checked and safe
- Payout cannot reach principal | input-1/src/TesseraStaking.sol:115 | A claim above rewardReserve reverts.
- Principal withdrawal is independent of the reserve | input-1/src/TesseraStaking.sol:97-107 | withdraw() checks only balanceOf.
- Reserve debited before transfer | input-1/src/TesseraStaking.sol:116-118 | A re-entering token cannot be paid twice.
- Refill restricted | input-1/src/TesseraStaking.sol:130 | Only the trusted funder calls notifyReward.

## Coverage
Reviewed: input-1/src/TesseraStaking.sol, input-2/test/ReserveDrain.t.sol, input-3/draft-report.md, input-4/docs/known-issues.md, input-5/stage-1-scope.md, input-6/stage-2-provenance.md, input-7/stage-3-prior-art.md, input-8/stage-4-poc.md, input-9/stage-5-severity.md, input-10/stage-6-triage.md
Not supplied: a TSR flash-loan source and its fee, which affect only the per-run size; the stored submission for read-back
