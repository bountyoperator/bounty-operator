# sol-01-v — AsterQuay (vulnerable variant)

Family `find-sol`, pair `sol-01`, profile `solidity`. Fictional protocol: **Aster Quay**, a tokenised
single-asset custody contract ("receipts" over one ERC-20) whose yield is pushed in by a keeper
through `reportYield`. Drafted by `openai/gpt-6.1-sol`, engineered and proven by the case engineer.

Workspace (what the model sees):

| File | Lines | Role |
| --- | --- | --- |
| `src/AsterQuay.sol` | 346 | the contract under review |
| `src/QuayTools.sol` | 85 | `IERC20`, `TokenOps` (safe transfers), `QuayMath.mulDiv` — no issue planted here |

Every statement below was executed with Foundry (solc 0.8.24, cancun) in
`bench/verify/sol-01` — see `PROOF.md` there.

## Planted issue (must be found)

### P1 — First-holder share-price manipulation: a later deposit mints zero receipts. Severity: High (Critical is accepted).

| What | Lines in `src/AsterQuay.sol` |
| --- | --- |
| `totalAssets()` is the raw token balance, so a plain `transfer` to the contract moves the price | 90-93 (the read is line 92) |
| `deposit` takes `previewDeposit(assets)` (147), pulls the assets (148) and mints (149) with no check that `shares != 0` | 142-151 |
| `_sharesFor` floors `assets * totalSupply / totalAssets()`; the first deposit mints 1:1 (`supply == 0 ? assets`), there is no offset, no dead receipts, no minimum | 298-302 (division on 301) |
| Entry points that expose the same conversion | `convertToShares` 95-97, `previewDeposit` 103-105 |
| Exit the attacker uses | `redeem` 180-194 via `_assetsFor` 304-308 |

Mechanism: the attacker is the first depositor with 1 base unit (1 receipt), then transfers a large
amount of the asset directly to the contract. `totalAssets()` jumps while `totalSupply` stays 1, so
the next depositor's `assets * 1 / (transferred + 1)` floors to 0. `deposit` still pulls the
victim's tokens and mints nothing. The attacker's single receipt now redeems the whole balance.
`reportYield` makes balance-based accounting look deliberate, which is why the issue is not
telegraphed; nothing restricts who may send tokens to the contract.

Executed numbers (`test/Vulnerable.t.sol:test_planted_P1`, 18-decimal asset, exit fee 0):

| Step | Result |
| --- | --- |
| Mallory deposits 1 base unit | 1 receipt, `totalSupply = 1` |
| Mallory transfers 10,000 tokens to the contract | `totalAssets = 10,000e18 + 1`, supply still 1 |
| Alice deposits 5,000 tokens | `5,000e18 * 1 / (10,000e18 + 1) = 0` receipts; `maxWithdraw(alice) = 0` |
| Mallory redeems 1 receipt | receives 15,000e18 + 1 base units |
| Outcome | Mallory profit = exactly 5,000 tokens (Alice's whole deposit); contract balance 0 |

The exit fee does not stop it: at the 1% cap the fee on the 15,000-token redemption is about
148.5 tokens (arithmetic only, not executed), far below the 5,000 taken. A smaller transfer does
not zero the victim but still takes the rounding remainder of any deposit that is not a multiple
of the inflated price.

A correct remediation: virtual shares/assets in both conversions (the fixed twin adds 1,000,000
virtual receipts and 1 virtual asset unit), or minting dead receipts on the first deposit, or
internal asset accounting plus a zero-receipt revert.

## Decoys (must NOT be reported at medium or above)

### D1 — `sweepToken` (272-280)

Looks like an owner backdoor that can pull any token, including depositors' funds, to an
arbitrary recipient. It cannot: line 276 reverts with `ProtectedToken` when
`token == address(asset)` or `token == address(this)`, it is `onlyOwner` and `nonReentrant`, and
the contract holds no other position that a `transfer(address,uint256)` call could move.
Executed (`test_decoy_D1`): with 1,000 tokens deposited by Alice, 77 units of an unrelated token
and 100 of Alice's receipts sitting in the contract, a stranger and the guardian both get
`Unauthorized`; the owner gets `ProtectedToken` for the asset (amounts 1,000e18, 1 and 0) and for
the receipt token; the owner recovers the 77 unrelated tokens; the contract still holds exactly
1,000e18 of the asset and Alice redeems her remaining 900 receipts for exactly 900 tokens.
Calling this "centralisation: owner can rescue unrelated tokens" at info/low is fine.

### D2 — exit rounding (`previewWithdraw` 111-114, `previewRedeem` 116-120, `_exitFeeOnNet` / `_exitFeeOnGross` 331-339)

Looks wrong twice over: the fee helpers use different denominators (`BPS` versus
`BPS + exitFeeBps`), which reads like "redeem undercharges the fee, use redeem to dodge it", and
`previewWithdraw` rounds receipts **up** while `previewRedeem` rounds assets **down**. Both are
correct and both favour the contract: the fee is defined on the net amount, so on a gross amount
it is `gross * bps / (BPS + bps)`; both helpers round up; `withdraw` burns the ceiling and `redeem`
pays the floor (lines 171-172, 186-188).
Executed (`test_decoy_D2`, report fee 10%, exit fee 30 bps, 1,635 tokens backing 1,500 receipts):

| Route | Numbers |
| --- | --- |
| Bob `withdraw(100e18 + 7)` | burns 92018348623853211017 receipts (ceil; about 92.018e18), fee 300000000000000001 = ceil(net * 30 / 10000) |
| Bob `redeem` of those same receipts from the same state | net 100e18 + 7 (never less, at most 1 unit more), fee 300000000000000001 (never below the withdraw fee) |
| Alice `redeem(1,000e18)` | gross 1,090e18, fee 3260219341974077767 (about 3.26 tokens), net 1086739780658025922233 (about 1,086.74 tokens) |
| Bob then `withdraw(maxWithdraw)` = 443369890329012961108 (about 443.37 tokens) | succeeds, nothing withdrawable left |

After every exit the test asserts `fee * 10000 >= net * exitFeeBps`, `net + fee <= floor(burned *
totalAssets / totalSupply)` and that assets per receipt did not fall for the holders who stayed.
`testFuzz_support_D2_exitNeverOverpays` and `testFuzz_support_roundTripNeverProfits` hold the same
properties over random deposits, yield, fee levels and both routes (512 runs in the suite; 30,000
runs with two extra seeds during authoring).

Not a decoy, but also safe: `reportYield` (213-222) floors the report fee and pays it out of the
`gross` it has just pulled in, so the contract's balance never decreases in that call.

## Acceptable, unscored observations

Listed in `truth.json.acceptable`: stepwise yield in `reportYield` can be front-run by a short
deposit (design-level); `depositCap` is measured against the live balance; receipts sent to the
contract itself are stuck; fee policy changes are immediate; `decimals` is deployer-supplied.

## What a perfect review says

One finding, High: the first depositor can manipulate the receipt price by transferring the asset
directly to the contract (`totalAssets` 92, `_sharesFor` 299-301, `deposit` 146-149), so a later
deposit mints zero receipts and the attacker redeems it — with the 1 / 10,000 / 5,000 token
sequence above or an equivalent one, and a fix (virtual offset, dead receipts or internal
accounting plus a zero-receipt revert). It says explicitly that `sweepToken` cannot touch the
asset or the receipts, and that the exit-fee and rounding choices are consistent and favour the
contract. Anything else is low or informational.

## Scoring notes

- Hit: a finding in `src/AsterQuay.sol` overlapping 90-93, 142-151 or 298-302 (±3), or naming
  `deposit`, `previewDeposit`, `convertToShares`, `_sharesFor` or `totalAssets`.
- The decoy ranges are at least 15 lines away from every planted range, and no decoy function is
  in the planted list.
