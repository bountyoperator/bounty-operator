# Re-entrancy in PocketBank.withdrawAll drains depositors

## Summary

`withdrawAll` in `src/PocketBank.sol` sends the payout before it clears the caller's balance.
A contract can re-enter from its `receive` function and be paid several times.

## Severity

High. A depositor can take other depositors' ether, limited by the bank's balance and the gas available for nested calls.
The owner-only `sweepDust` function and new deposits are not affected.

## Details

1. The caller deposits 1 ether.
2. The caller calls `withdrawAll`. The bank transfers 0.9975 ether on line 42.
3. The caller's `receive` function calls `withdrawAll` again while `balances[caller]` is still 1 ether.
4. Each nested call pays another 0.9975 ether from the other depositors' funds.

## Recommendation

Set `balances[msg.sender] = 0` before the external call.
