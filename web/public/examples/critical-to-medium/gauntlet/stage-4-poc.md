# Review
Verdict: rewrite-then-submit
Mode: bounty
Counts: critical=0 high=0 medium=1 hardening=1 checked-safe=4
Headline: Bug is real but capped by rewardReserve: proof supports Medium theft of unclaimed rewards, not Critical principal theft

## Steps
- Funder starts a 7-day period with 70,000 TSR | executed | funder prank through public notifyReward; tokens minted by harness | input-2/test/ReserveDrain.t.sol:49-52
- Alice stakes 600,000 TSR and Bob stakes 400,000 TSR | executed | public stake(); balances minted by harness | input-2/test/ReserveDrain.t.sol:55-65
- Six days elapse | mocked | vm.warp, a route that only needs waiting | input-2/test/ReserveDrain.t.sol:69
- Attacker obtains 1,166,666 TSR | mocked | tsr.mint in place of a flash loan; not decisive, because the gain scales with any stake size | input-2/test/ReserveDrain.t.sol:72-73
- Stake leaves paidPerToken[attacker] at 0 | executed | production stake() with no _settle | input-1/src/TesseraStaking.sol:87-94
- Claim pays 69,999 TSR out of rewardReserve | executed | production claim() | input-2/test/ReserveDrain.t.sol:78; input-1/src/TesseraStaking.sol:110-120
- Attacker withdraws principal | executed | production withdraw() | input-2/test/ReserveDrain.t.sol:79
- Loan repaid | narrated | comment only | input-2/test/ReserveDrain.t.sol:86
- Repeating from fresh addresses takes the principal | narrated | draft only; the code contradicts it | input-3/draft-report.md:32
- Stakers' principal frozen for good | executed as an exit() revert, narrated as a freeze | ReserveShort from claim() inside exit(), which is the N-1 behaviour | input-2/test/ReserveDrain.t.sol:91-97; input-3/draft-report.md:33

## PoC checklist
- setup | pass | One command, `forge test --match-test test_attackerDrainsContractAndFreezesStakers -vv`, run against the supplied test file.
- revision | pass | The proof ran on release v1.2.0, the scoped revision.
- live-state | pass | The file is marked as never deployed (input-1/src/TesseraStaking.sol:11). All setup goes through public calls and nothing is hand-set in storage.
- real-path | pass | stake, claim and withdraw are the production functions (input-2/test/ReserveDrain.t.sol:77-79).
- actors | pass | The attacker holds no role. The funder only funds in normal operation.
- values | pass | Concrete amounts and a 6-day warp.
- before-after | fail | Add pre-attack asserts: rewardReserve == 70,000e18, earned(alice) == 36,000e18, attacker balance == size.
- impact-assertion | fail | :87 reads the attacker balance after the state change. :88 is a local comparison. :91-97 assert only the N-1 exit() revert. Nothing reads staker principal or the stakers' claimable rewards.
- measured-loss | fail | The contract balance after the run is unmeasured, and there is no control run. The draft's 1,070,000 TSR figure (input-3/draft-report.md:83) is unmeasured, and the code contradicts it.
- run-log | pass | The command, revision and output are in Context and in input-3/draft-report.md:70-79.
- fix-assertion | absent | Add a test that fails once _settle is added to stake().
- intended-behaviour | fail | exit() reverting on ReserveShort is acknowledged by design (input-4/docs/known-issues.md:13). Assert withdraw() instead.

## End state
Object: Alice's and Bob's staked principal, meaning the TSR backing totalStaked.
Assertion: none
Measured: Attacker net is 69,999 TSR of reward budget, before any flash-loan fee. Victim principal loss was not measured. From the source it is 0, since the contract keeps 1,000,000e18 + 1 wei against a totalStaked of 1,000,000e18.

## PoC plan
```solidity
// Added to ReserveDrainTest. Same setUp. Local only.
function test_stakeWithoutSettleStealsUnclaimedRewards() public {
    vm.warp(block.timestamp + 6 days);
    assertEq(staking.rewardReserve(), 70_000e18);
    uint256 owedBefore = staking.earned(alice) + staking.earned(bob); // ~60,000e18
    assertApproxEqRel(owedBefore, 60_000e18, 1e15);

    uint256 size = (staking.rewardReserve() * 1e18) / staking.rewardPerToken();
    tsr.mint(attacker, size);
    vm.startPrank(attacker);
    tsr.approve(address(staking), size);
    staking.stake(size);
    uint256 stolen = staking.claim();
    staking.withdraw(size);
    vm.stopPrank();

    assertGt(stolen, 69_999e18);                       // assertion that fails after the fix
    assertEq(tsr.balanceOf(attacker), size + stolen);
    assertLe(staking.rewardReserve(), 1);
    // Victims' accrued rewards can no longer be paid
    assertGt(staking.earned(alice) + staking.earned(bob), staking.rewardReserve());
    vm.prank(alice);
    vm.expectRevert(TesseraStaking.ReserveShort.selector);
    staking.claim();
    // Principal intact, so no principal-row claim
    assertGe(tsr.balanceOf(address(staking)), staking.totalStaked());
    vm.prank(alice);
    staking.withdraw(600_000e18);
    assertEq(tsr.balanceOf(alice), 600_000e18);
}
```

## F-1: Unsettled stake() lets any account claim the reward reserve, not principal
Severity: medium
Basis: proven-in-source
Location: input-1/src/TesseraStaking.sol:87-94; input-1/src/TesseraStaking.sol:71-74; input-1/src/TesseraStaking.sol:115-117
Impact: Alice and Bob lose about 60,000 TSR of accrued, unclaimed rewards, and the remaining 10,000 TSR stream goes with them. The loss per funded period is bounded by rewardReserve. The 1,000,000 TSR of principal is untouched and stays withdrawable.
Path:
1. The funder calls notifyReward(70,000e18). rewardRate ≈ 0.1157e18/s. Alice stakes 600,000e18 and Bob stakes 400,000e18.
2. At t+6 days, rewardPerToken ≈ 6e16.
3. The attacker stakes 1,166,666e18. paidPerToken[attacker] stays 0 (input-1/src/TesseraStaking.sol:89-91).
4. claim() credits 1,166,666e18 × 6e16 / 1e18 ≈ 69,999e18, which passes the cap at :115. rewardReserve falls to 1 wei.
5. withdraw(1,166,666e18) returns the attacker's principal. Alice's claim of 36,000e18 now reverts with ReserveShort.
Counterargument: The freeze is N-1 and principal is safe | resolved | The theft of rewards survives that objection. Draft step 6 is false, because the payout cap at input-1/src/TesseraStaking.sol:115 stops a repeat claim and withdraw() never reads the reserve (input-1/src/TesseraStaking.sol:97-107).
Gap: none
Fix: Call _settle(msg.sender) after _updateGlobal() in stake() (input-1/src/TesseraStaking.sol:89).
Test:
```solidity
function test_freshStakeEarnsNothingImmediately() public {
    vm.warp(block.timestamp + 6 days);
    tsr.mint(attacker, 1_000_000e18);
    vm.startPrank(attacker);
    tsr.approve(address(staking), 1_000_000e18);
    staking.stake(1_000_000e18);
    assertEq(staking.claim(), 0);      // fails on v1.2.0, passes after the fix
    vm.stopPrank();
    assertEq(staking.rewardReserve(), 70_000e18);
}
```
Next: Retitle the report to "Medium: Theft of unclaimed rewards" and drop draft steps 6-7 and the 1,070,000 TSR figure. Replace the exit() asserts with the PoC plan test.

## Hardening
- exit() blocks principal while the reserve is short | input-1/src/TesseraStaking.sol:123-126 | Pay the principal and skip or defer the claim. The behaviour is already known as N-1 and is not eligible.

## Checked and safe
- Payout capped by reserve | input-1/src/TesseraStaking.sol:115 | A claim larger than rewardReserve reverts, so deposits never fund rewards.
- Principal withdrawal independent of reserve | input-1/src/TesseraStaking.sol:97-107 | withdraw() checks only balanceOf.
- Reserve debited before transfer | input-1/src/TesseraStaking.sol:116-118 | A re-entering token cannot be paid twice.
- Funding restricted | input-1/src/TesseraStaking.sol:130 | Only the trusted funder refills the reserve.

## Coverage
Reviewed: input-1/src/TesseraStaking.sol, input-2/test/ReserveDrain.t.sol, input-3/draft-report.md, input-4/docs/known-issues.md, input-5/stage-1-scope.md, input-6/stage-2-provenance.md, input-7/stage-3-prior-art.md
Not supplied: a TSR flash-loan source (it affects only the per-run size)
