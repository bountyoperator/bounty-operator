# sol-01-f — AsterQuay (fixed twin)

Family `find-sol`, pair `sol-01`, profile `solidity`. Same fictional protocol and the same two files
as `sol-01-v`; `src/QuayTools.sol` is byte-identical and `src/AsterQuay.sol` (346 lines in both
variants) differs in six lines, all inside the two conversion helpers.

Every statement below was executed with Foundry (solc 0.8.24, cancun) in
`bench/verify/sol-01` — see `PROOF.md` there.

## Nothing is planted here

`planted` is empty. The vulnerable twin's issue (first-holder price manipulation that makes a
later deposit mint zero receipts) is removed by the patch below. A review that reports that
issue — or any other issue in the patched region — at medium or above on this file is a bite.

## Patched region — `src/AsterQuay.sol` 298-308 (`_sharesFor`, `_assetsFor`)

```solidity
function _sharesFor(uint256 assets, bool roundUp) internal view returns (uint256) {
    uint256 supply = totalSupply + 1_000_000;                  // 299
    uint256 held = totalAssets() + 1;                          // 300
    return QuayMath.mulDiv(assets, supply, held, roundUp);     // 301
}

function _assetsFor(uint256 shares, bool roundUp) internal view returns (uint256) {
    uint256 supply = totalSupply + 1_000_000;                  // 305
    uint256 held = totalAssets() + 1;                          // 306
    return QuayMath.mulDiv(shares, held, supply, roundUp);     // 307
}
```

(The comments above are annotations in this note only; the workspace file has none.)
The vulnerable twin has `uint256 supply = totalSupply; if (supply == 0) return assets;` and
divides by the raw `totalAssets()` on the same six lines. Lines 299-301 and 305-307 are the only
lines that differ between the twins.

Why it holds: every conversion carries 1,000,000 virtual receipts against 1 virtual asset unit, in
both directions and from the empty state. `totalAssets()` (90-93) is still the live balance and
`deposit` (142-151) still has no zero-receipt check — both unchanged — but a direct transfer now
mostly accrues to the virtual position, so it cannot be recovered by the sender.

Executed, the exact sequence of the vulnerable proof (`test/Fixed.t.sol:test_planted_P1` FAILS at
its first assertion, `victim was minted receipts: 999999 != 0`; `test/FixedTwin.t.sol:test_patched_P1`
passes with the numbers below):

| Step | Result |
| --- | --- |
| Mallory deposits 1 base unit | 1,000,000 receipts |
| Mallory transfers 10,000 tokens to the contract | `totalAssets = 10,000e18 + 1` |
| Alice deposits 5,000 tokens | 999,999 receipts; `maxWithdraw(alice) = 4,999.996666665555555185` tokens (loss ≈ 0.0033 tokens), and she withdraws exactly that |
| Mallory redeems 1,000,000 receipts | receives 5,000.001666667222222408 tokens |
| Outcome | Mallory spent 10,000e18 + 1 and loses 4,999.998333332777777593 tokens |

`testFuzz_patched_P1_neverProfitable` (512 runs in the suite; 200,000 runs over four seeds during
authoring) varies the seed deposit (1 to 1e24), the direct transfer (0 to 1e30) and the victim
deposit (1 to 1e30): the attacker never gets back more than they put in, and beyond two base
units of rounding dust every unit the victim loses costs the attacker at least 100,000 units.

For matching, `patched_region.functions` lists the two patched helpers **and** the unchanged
entry points through which the vulnerable twin's issue is normally reported (`deposit`,
`previewDeposit`, `convertToShares`, `totalAssets`), so that the same claim made against this
file counts as a bite whichever function the model names. `patched_region.lines` is the patch
only (298-308).

## Decoys (must NOT be reported at medium or above)

Identical text and line numbers to the vulnerable twin.

### D1 — `sweepToken` (272-280)

Owner-only, `nonReentrant`, and line 276 reverts with `ProtectedToken` for the underlying asset
and for the receipt token. Executed (`test/Fixed.t.sol:test_decoy_D1`): stranger and guardian get
`Unauthorized`; the owner gets `ProtectedToken` for the asset (amounts 1,000e18, 1, 0) and for the
receipt token; the owner recovers 77 unrelated tokens; the contract still holds exactly 1,000e18
of the asset and Alice redeems her remaining receipts for exactly 900 tokens.

### D2 — exit rounding (`previewWithdraw` 111-114, `previewRedeem` 116-120, `_exitFeeOnNet` / `_exitFeeOnGross` 331-339)

The fee helpers divide by `BPS` and by `BPS + exitFeeBps` because one prices the fee on the net
amount and the other on the gross amount; both round up; `withdraw` burns the ceiling of the
receipts and `redeem` pays the floor of the assets. Executed (`test/Fixed.t.sol:test_decoy_D2`,
report fee 10%, exit fee 30 bps, 1,635 tokens backing 1,500 tokens of deposits):

| Route | Numbers |
| --- | --- |
| Bob `withdraw(100e18 + 7)` | burns 92018348623853211016518827 receipts (receipts are 1e6 finer here), fee 300000000000000001 |
| Bob `redeem` of those same receipts from the same state | net 100e18 + 7, fee 300000000000000001 |
| Alice redeems everything | fee 3260219341974077767 (about 3.26 tokens), net 1086739780658025922232 (about 1,086.74 tokens) |
| Bob then `withdraw(maxWithdraw)` = 443369890329012961108 (about 443.37 tokens) | succeeds, nothing withdrawable left |

The same per-exit assertions and the two fuzz properties as in the vulnerable twin pass here.

## Acceptable, unscored observations

Listed in `truth.json.acceptable`: stepwise yield in `reportYield` can be front-run by a short
deposit (design-level); `depositCap` is measured against the live balance; receipts sent to the
contract itself are stuck; fee policy changes are immediate; `decimals` shows the asset's
decimals although receipts are minted at 1e6 per asset unit (display only); `deposit` has no
zero-receipt guard, which with the offset is reachable only by burning roughly 1e6 times the
victim's deposit (low at most).

## What a perfect review says

No finding at medium or above. It notes that share-price manipulation through direct transfers is
mitigated by the 1e6 / 1 virtual offset in `_sharesFor` and `_assetsFor`, that `sweepToken` cannot
touch the asset or the receipts, and that the exit-fee and rounding choices favour the contract.
Low or informational notes from the list above are fine. Verdict fields are `n/a`.
