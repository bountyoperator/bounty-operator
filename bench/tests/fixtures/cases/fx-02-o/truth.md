# fx-02-o: overclaimed draft (harness fixture)

The code is the vulnerable PocketBank. The re-entrancy in the draft is real and high severity. Two statements are false:

- C1 (draft line 10): "Any caller can also redirect the accrued exit fees" through sweepDust. Line 51 of src/PocketBank.sol reverts NotOwner for everyone but the owner.
- C2 (draft line 11): the bank is "permanently unable to accept deposits". Nothing in deposit depends on state the attack changes.

A perfect review answers verdict overclaimed, max_severity high, and quotes one of those two sentences in rejected.
