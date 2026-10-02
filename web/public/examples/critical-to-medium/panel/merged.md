# Review
Verdict: rewrite-then-submit
Mode: bounty
Counts: critical=0 high=0 medium=1 hardening=2 checked-safe=4
Headline: stake() skips settlement, so a fresh stake claims the whole reward reserve; principal stays withdrawable, so this is Medium, not Critical

## Agreement
- Unsettled stake() lets a fresh account claim the reward reserve | 3/3 | kept | input-1/src/TesseraStaking.sol:87-94 | panel-1-anthropic-claude-opus-5.5.md, panel-2-openai-gpt-6-astra.md, panel-3-google-gemini-3.8-flash.md
- Repeating the attack steals principal (draft step 6) | 0/3 | dropped | input-1/src/TesseraStaking.sol:115-117 | none
- exit() revert permanently freezes principal (draft step 7) | 0/3 | dropped | input-1/src/TesseraStaking.sol:97-107 | none
- Payout is 70,000 TSR minus 1 wei, not 69,999 TSR | 1/3 | kept, folded into F-1 | input-2/test/ReserveDrain.t.sol:84 | panel-2-openai-gpt-6-astra.md
- exit() is all-or-nothing | 1/3 | kept as hardening | input-1/src/TesseraStaking.sol:123-126 | panel-1-anthropic-claude-opus-5.5.md

## F-1: stake() does not settle the caller, so a zero-second position claims the whole reward reserve
Severity: medium
Basis: proven-in-source
Location: input-1/src/TesseraStaking.sol:87-94; input-1/src/TesseraStaking.sol:71-74; input-1/src/TesseraStaking.sol:110-118
Impact: Any unprivileged caller takes every staker's unclaimed rewards, capped at rewardReserve (70,000 TSR here). Alice's and Bob's claims then revert ReserveShort at line 115. Their roughly 60,000 TSR of accrued rewards is never paid out of this funding, and paying it later consumes the next funding. An existing staker who tops up is over-credited the same way on the added amount.
Path:
1. setUp: the funder calls notifyReward(70_000e18), so rewardRate = 70_000e18 / 604800. Alice stakes 600,000 TSR and Bob 400,000 TSR (input-2/test/ReserveDrain.t.sol:49-56).
2. Six days later, rewardPerToken() ≈ 0.06e18.
3. The attacker calls stake(size) with size = 70_000e18 * 1e18 / rpt ≈ 1,166,666e18. Line 89 stores rpt. No _settle runs, so paidPerToken[attacker] = 0.
4. In the same block the attacker calls claim(). earned() = size * rpt / 1e18 = 70,000e18 - 1. This is ≤ rewardReserve, so lines 117-118 pay it and the reserve falls to 1 wei (input-2/test/ReserveDrain.t.sol:84).
5. withdraw(size) returns the capital. The attacker ends with size + stolen (input-2/test/ReserveDrain.t.sol:87).
Counterargument: N-1 makes the reserve-short revert known and excluded | resolved | input-4/docs/known-issues.md:13 covers only the exit() revert. No entry in input-4/docs/known-issues.md:7-15 covers retroactive reward credit on deposit.
Gap: none
Fix: Call _settle(msg.sender) right after _updateGlobal() in stake(), before the balance changes (input-1/src/TesseraStaking.sol:89-90).
Test:
```solidity
// Add to ReserveDrainTest (input-2/test/ReserveDrain.t.sol). Fails on v1.2.0, passes after the fix.
function test_freshStakeEarnsNothingRetroactively() public {
    vm.warp(block.timestamp + 6 days);
    uint256 size = 1_166_666e18;
    _stake(attacker, size);

    vm.prank(attacker);
    assertEq(staking.claim(), 0);
    vm.prank(attacker);
    staking.withdraw(size);

    assertEq(staking.rewardReserve(), 70_000e18);
    assertEq(tsr.balanceOf(address(staking)), 1_070_000e18);

    vm.prank(alice);
    uint256 paid = staking.claim();
    assertApproxEqAbs(paid, 36_000e18, 1e18);
}
```
Next: Rewrite the draft as follows.
- Select "Medium: Theft of unclaimed rewards" and change the title to match.
- State the payout as 70,000 TSR minus 1 wei, capped by rewardReserve.
- Delete steps 6-7 and the 1,070,000 TSR figure (input-3/draft-report.md:32-33, 83).
- Add a contract-balance assertion showing principal is intact.

## Hardening
- exit() is all-or-nothing | input-1/src/TesseraStaking.sol:123-126 | Withdraw the principal and skip the claim when the reserve is short, so exit() does not revert on documented N-1 behaviour.
- Reward obligations can exceed the reserve | input-1/src/TesseraStaking.sol:115 | Streaming continues after the drain, so owed rewards accrue unbacked. Track committed rewards against the reserve.

## Checked and safe
- Principal withdrawal | input-1/src/TesseraStaking.sol:97-107 | withdraw() never reads rewardReserve, so Alice and Bob can always take back 1,000,000 TSR.
- Reward payout bound | input-1/src/TesseraStaking.sol:115-117 | A claim above rewardReserve reverts, and each payout reduces the reserve. Repeating the attack cannot reach principal.
- Attacker gain | input-2/test/ReserveDrain.t.sol:87 | The attacker ends with size + stolen. The contract keeps the 1,000,000 TSR staked plus 1 wei, not the 1,070,000 TSR loss the draft claims.
- Funding access | input-1/src/TesseraStaking.sol:130 | Only the trusted funder can call notifyReward().

## Coverage
Reviewed: input-1/src/TesseraStaking.sol, input-2/test/ReserveDrain.t.sol, input-3/draft-report.md, input-4/docs/known-issues.md, input-5/panel-1-anthropic-claude-opus-5.5.md, input-6/panel-2-openai-gpt-6-astra.md, input-7/panel-3-google-gemini-3.8-flash.md
Not supplied: none
