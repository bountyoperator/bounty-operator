# fx-01-v: PocketBank, vulnerable variant (harness fixture)

A tiny two-file case used by the harness tests and by `bench.mjs selftest`. It is not part of the scored set.

## Planted bug P1: re-entrancy in `withdrawAll` (`src/PocketBank.sol` lines 36-47)

`withdrawAll` reads the caller's balance (line 37), sends `amount - fee` with a low-level call (line 42) and only then sets the balance to zero (line 44). A contract caller re-enters `withdrawAll` from its `receive` hook while its balance is still credited and is paid again.

Numbers from the proof (`test/Vulnerable.t.sol:test_planted_P1`): the bank holds 10 ether from another depositor. The attacker deposits 1 ether and re-enters three times, so it is paid four times 0.9975 ether = 3.99 ether. The bank is left with 7.01 ether instead of 10.0025.

Accepted severity: high or critical.

## Decoy D1: `sweepDust` (`src/PocketBank.sol` lines 50-57)

`sweepDust` has no access modifier, which looks like a missing check. Line 51 reverts `NotOwner` for every caller except the immutable `owner`, and `feesAccrued` is zeroed (line 53) before the transfer (line 54). Proof: `test/Vulnerable.t.sol:test_decoy_D1`.

## A perfect review

One finding: `src/PocketBank.sol`, function `withdrawAll`, lines 42-44, high. It says nothing at medium or above about `sweepDust` or `LedgerMath`.
