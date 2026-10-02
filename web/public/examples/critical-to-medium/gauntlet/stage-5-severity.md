# Review
Verdict: rewrite-then-submit
Mode: bounty
Counts: critical=0 high=0 medium=1 hardening=1 checked-safe=3
Headline: The stake() checkpoint bug is real but the reserve cap bounds it: the proof supports Medium theft of unclaimed rewards, not Critical

## Severity grid
- "Direct theft of staked principal." | not-met | input-1/src/TesseraStaking.sol:115-117 caps every payout at rewardReserve and debits only the reserve; the run leaves 1 wei of reserve and principal untouched
- "Permanent freezing of staked principal." | not-met | withdraw() never reads the reserve (input-1/src/TesseraStaking.sol:97-107); the proof asserts only exit() reverting (input-2/test/ReserveDrain.t.sol:91-97), which is excluded as N-1 (input-4/docs/known-issues.md:13)
- "Temporary freezing of staked principal for 24 hours or longer." | not-met | same as above: withdraw() stays callable for Alice and Bob, so principal is not frozen for any length of time
- "Theft of unclaimed rewards." | met | the attacker takes 69,999 TSR out of a 70,000 TSR reserve (input-2/test/ReserveDrain.t.sol:87-88, log "reserve left (wei) 1"); about 60,000 TSR of that was already accrued to Alice and Bob (input-1/src/TesseraStaking.sol:72-73)
- "Temporary or permanent freezing of unclaimed rewards." | met | Alice's and Bob's claims revert with ReserveShort until the funder refunds (input-1/src/TesseraStaking.sol:115); this is the same Medium tier and adds nothing to it
- "Rewards streamed at the wrong rate with no loss to a staker." | not-met | stakers do lose accrued rewards, so this lower row does not describe the outcome

## Calibration
Claimed: Critical
Form: Critical: Direct theft of staked principal (the draft also lists Permanent freezing of staked principal, input-3/draft-report.md:3-4)
Rubric level: Medium
Victim actions: 0. Alice and Bob only stake before the attack (draft step 1) and take no action during it.
Loss lands on: user
Attacker net: 69,999 TSR before any flash-loan fee. The loan is minted by the harness, so no fee was measured.
Recoverable: no for the stolen 69,999 TSR. The funder's next notifyReward pays stakers out of the reward budget, which ends the freeze but does not undo the theft.
Step change: a proof that withdraw() reverts for Alice or Bob for 24 hours or longer would move the finding to High. The code at input-1/src/TesseraStaking.sol:97-107 contradicts that.

## F-1: Unsettled stake() lets any account take the reward reserve, including stakers' unclaimed rewards
Severity: medium
Basis: proven-in-source
Location: input-1/src/TesseraStaking.sol:87-94; input-1/src/TesseraStaking.sol:71-74; input-1/src/TesseraStaking.sol:115-117
Impact:
- Alice and Bob lose 60,000 TSR of accrued, unclaimed rewards (36,000 and 24,000).
- The remaining roughly 10,000 TSR of unstreamed budget goes with it.
- Each run is bounded by rewardReserve.
- Principal of 1,000,000 TSR stays backed and withdrawable.

Path:
1. The funder calls notifyReward(70,000e18), which sets rewardRate to about 0.1157e18 per second. Alice stakes 600,000e18 and Bob stakes 400,000e18.
2. After 6 days, rewardPerToken() is about 0.06e18.
3. The attacker calls stake(1,166,666e18). This runs _updateGlobal() but never _settle, so paidPerToken[attacker] stays 0.
4. The attacker calls claim(). earned() returns about 69,999e18, which passes the check at :115, and rewardReserve falls to 1 wei.
5. The attacker calls withdraw(1,166,666e18) and gets the full stake back. Alice's claim of 36,000e18 now reverts with ReserveShort.

Counterargument: "Repeating from fresh addresses takes principal" (draft step 6) | resolved | With 1 wei left, any further claim reverts at input-1/src/TesseraStaking.sol:115, and only the funder can refill the reserve (input-1/src/TesseraStaking.sol:130).
Gap: none. The current proof does not read the stakers' rewards, so the rewrite should add an assert of `earned(alice)+earned(bob) > rewardReserve()`.
Fix: call `_settle(msg.sender)` after `_updateGlobal()` in stake() (input-1/src/TesseraStaking.sol:89).
Test:
```solidity
function test_freshStakeTakesStakersRewards() public {
    vm.warp(block.timestamp + 6 days);
    uint256 owed = staking.earned(alice) + staking.earned(bob); // ~60,000e18
    uint256 size = (staking.rewardReserve() * 1e18) / staking.rewardPerToken();
    tsr.mint(attacker, size);
    vm.startPrank(attacker);
    tsr.approve(address(staking), size);
    staking.stake(size);
    assertEq(staking.claim(), 0);          // fails on v1.2.0, passes after the fix
    staking.withdraw(size);
    vm.stopPrank();
    assertGe(staking.rewardReserve(), owed);
    vm.prank(alice);
    staking.withdraw(600_000e18);          // principal always withdrawable
}
```
Next: Rewrite the report as follows:
- Retitle it to "Medium: Theft of unclaimed rewards" and set the form to that row.
- Drop draft steps 6 and 7 and the 1,070,000 TSR figure (input-3/draft-report.md:32-33, 83).
- Replace the exit() asserts with an earned/claim assert and a withdraw() assert.

## Hardening
- exit() blocks principal while the reserve is short | input-1/src/TesseraStaking.sol:123-126 | Pay the principal and defer the claim. This behaviour is already listed as N-1 and is not eligible.

## Checked and safe
- Payout cannot reach principal | input-1/src/TesseraStaking.sol:115-117 | Every payout is capped by rewardReserve and debited from it. The contract keeps 1,000,000e18 + 1 wei against a totalStaked of 1,000,000e18.
- Principal withdrawal is independent of the reserve | input-1/src/TesseraStaking.sol:97-107 | withdraw() checks only balanceOf before it transfers.
- The reserve cannot be refilled by the attacker | input-1/src/TesseraStaking.sol:130 | notifyReward is restricted to the trusted funder.

## Coverage
Reviewed: input-1/src/TesseraStaking.sol, input-2/test/ReserveDrain.t.sol, input-3/draft-report.md, input-4/docs/known-issues.md, input-5/stage-1-scope.md, input-6/stage-2-provenance.md, input-7/stage-3-prior-art.md, input-8/stage-4-poc.md
Not supplied: a TSR flash-loan source and its fee. This affects only the per-run size and the attacker's net, not the level.
