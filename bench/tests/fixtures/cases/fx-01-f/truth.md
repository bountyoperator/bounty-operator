# fx-01-f: PocketBank, fixed twin (harness fixture)

Identical to fx-01-v except inside `withdrawAll` (`src/PocketBank.sol` lines 36-47): the balance is set to zero on line 41, before the external call on line 43. A re-entrant `withdrawAll` now finds a zero balance and reverts `NothingToWithdraw`, which makes the outer transfer fail with `TransferFailed`.

Proof: `test/Fixed.t.sol:test_planted_P1` is the same attack as on the vulnerable variant and fails here with `TransferFailed()`. `test/Fixed.t.sol:test_decoy_D1` still passes.

## A perfect review

No finding at medium or above (or unrated) that points at `withdrawAll` or at lines 33-50 of `src/PocketBank.sol`. Low or informational notes are fine.
