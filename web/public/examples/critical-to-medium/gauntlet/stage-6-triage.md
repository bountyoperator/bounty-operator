# Review
Verdict: rewrite-then-submit
Mode: bounty
Counts: critical=0 high=0 medium=1 hardening=1 checked-safe=4
Headline: The stake() checkpoint bug is real, but the reserve cap stops it at the rewards: Medium theft of unclaimed rewards, not Critical principal theft.

## Closing sentence
Sentence: Every payout is capped at and debited from rewardReserve (line 115-117) and withdraw() never reads the reserve, so no principal is stolen or frozen; the exit() revert is known issue N-1, and the proof meets at most "Medium: Theft of unclaimed rewards".
First paragraph: open
Answer: Add: "The payout is capped by rewardReserve, so the attacker takes the 70,000 TSR reward budget, including about 60,000 TSR already accrued to Alice and Bob; principal stays backed and withdraw() still succeeds."

## Rejection reasons
- 1 | Severity overclaimed | "Both Critical rows of the programme apply: direct theft of staked principal and permanent freezing of staked principal." | input-1/src/TesseraStaking.sol:115-117 caps and debits only the reserve, and input-1/src/TesseraStaking.sol:97-107 keeps principal withdrawable. The programme pays the row the proof satisfies, so refile under "Medium: Theft of unclaimed rewards". Step 6 (input-3/draft-report.md:32) and the 1,070,000 TSR figure (input-3/draft-report.md:83) go. | open
- 2 | Impact not shown | "After the attack every staker's `exit()` reverts, so the principal that is left is frozen permanently." The PoC reads only the attacker's balance and an exit() revert (input-2/test/ReserveDrain.t.sol:87-97). | Add the one artifact the proof lacks: asserts that `earned(alice)+earned(bob) > rewardReserve()`, that `claim()` by Alice reverts with ReserveShort, and that `withdraw(600_000e18)` succeeds, as in input-8/stage-4-poc.md:58-68. | open
- 3 | Out of scope | "`exit()` now reverts for Alice and Bob. Their 1,000,000 TSR is locked in the contract for good." The exit() revert is N-1 (input-4/docs/known-issues.md:13), and the rules exclude anything listed in known-issues.md. | The excluded claim is only the freeze. The reward theft has a different root, the missing settle at input-1/src/TesseraStaking.sol:89-90, and no item in input-4/docs/known-issues.md:7-15 covers it. Dropping the freeze claim leaves the finding in scope. | answered

## F-1: Unsettled stake() lets any account take the reward reserve, including stakers' unclaimed rewards
Severity: medium
Basis: proven-in-source
Location: input-1/src/TesseraStaking.sol:87-94; input-1/src/TesseraStaking.sol:71-74; input-1/src/TesseraStaking.sol:115-117
Impact: The loss is bounded per funded period by rewardReserve.
- Alice and Bob lose 36,000 and 24,000 TSR of accrued, unclaimed rewards.
- The remaining ~10,000 TSR of unstreamed budget is taken as well.
- The 1,000,000 TSR of principal stays backed and withdrawable.
Path:
1. The funder calls notifyReward(70_000e18). Alice stakes 600_000e18 and Bob stakes 400_000e18.
2. At t+6 days, rewardPerToken() ≈ 0.06e18.
3. The attacker calls stake(1_166_666e18). The function runs _updateGlobal but not _settle, so paidPerToken[attacker] stays 0 (input-1/src/TesseraStaking.sol:89-91).
4. claim() pays ≈ 69,999e18. This passes the check at :115, and rewardReserve falls to 1 wei.
5. withdraw(1_166_666e18) returns the attacker's stake. A claim by Alice for 36,000e18 now reverts with ReserveShort.
Counterargument: "Repeating from fresh addresses takes principal" (draft step 6) | resolved | With 1 wei left, any further claim reverts at input-1/src/TesseraStaking.sol:115. Only the funder can refill the reserve (input-1/src/TesseraStaking.sol:130).
Gap: none
Fix: Call _settle(msg.sender) after _updateGlobal() in stake() (input-1/src/TesseraStaking.sol:89).
Test:
```solidity
function test_freshStakeCannotTakeStakersRewards() public {
    vm.warp(block.timestamp + 6 days);
    uint256 owed = staking.earned(alice) + staking.earned(bob); // ~60,000e18
    uint256 size = (staking.rewardReserve() * 1e18) / staking.rewardPerToken();
    tsr.mint(attacker, size);
    vm.startPrank(attacker);
    tsr.approve(address(staking), size);
    staking.stake(size);
    assertEq(staking.claim(), 0);            // fails on v1.2.0, passes after the fix
    staking.withdraw(size);
    vm.stopPrank();
    assertGe(staking.rewardReserve(), owed);
    vm.prank(alice);
    staking.withdraw(600_000e18);            // principal always withdrawable
    assertEq(tsr.balanceOf(alice), 600_000e18);
}
```
Next: Retitle the report to "Medium: Theft of unclaimed rewards", cut steps 6-7 and the 1,070,000 TSR figure, and replace the exit() asserts with the reward and withdraw asserts. File quickly, because input-7/stage-3-prior-art.md:34 rates the duplicate clock high.

## Hardening
- exit() bundles claim() and blocks principal while the reserve is short | input-1/src/TesseraStaking.sol:123-126 | Pay the principal and defer the claim. This is listed as N-1 and is not eligible.

## Checked and safe
- Payout cannot reach principal | input-1/src/TesseraStaking.sol:115-117 | A claim above rewardReserve reverts, and only the reserve is debited.
- Principal withdrawal is independent of the reserve | input-1/src/TesseraStaking.sol:97-107 | withdraw() checks only balanceOf before it transfers.
- The attacker cannot refill the reserve | input-1/src/TesseraStaking.sol:130 | notifyReward is restricted to the trusted funder.
- Reserve debited before transfer | input-1/src/TesseraStaking.sol:116-118 | A re-entering token cannot be paid twice.

## Coverage
Reviewed: input-1/src/TesseraStaking.sol, input-2/test/ReserveDrain.t.sol, input-3/draft-report.md, input-4/docs/known-issues.md, input-5/stage-1-scope.md, input-6/stage-2-provenance.md, input-7/stage-3-prior-art.md, input-8/stage-4-poc.md, input-9/stage-5-severity.md
Not supplied: a TSR flash-loan source and its fee, which affect only the per-run size and the attacker's net
