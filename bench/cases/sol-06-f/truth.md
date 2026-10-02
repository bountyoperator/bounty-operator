# sol-06-f — TollWeaver (fixed twin)

Pair `sol-06`, family `find-sol`. Twin of `sol-06-v`; the two workspaces differ in exactly one line.
Drafted by `openai/gpt-6.1-sol`, repaired and proven by the case engineer. Proof project: `bench/verify/sol-06/`.

## The code

`TollWeaver` is the charge collector of the fictional Velisara protocol (prepaid execution lanes for cross-application message delivery).

- `contributeRouteCharge` (anyone) and `submitSettlementCharge` (courier only) pull an approved ERC-20 into the contract and split each charge between `serviceAccrued` (`serviceBps` of the amount) and `continuityAccrued` (the rest).
- `releaseProceeds(asset)` is permissionless by design. It zeroes both accruals and pushes them to the stored `serviceBeneficiary` and `continuityFund`.
- The `steward` (two-step transfer: `nominateSteward` / `acceptStewardship`) configures everything through seven setters, all `onlySteward`.

Files: `src/TollWeaver.sol` (323 lines), `src/libraries/CoinMoves.sol` (45 lines).

## Patched region — nothing to find

`src/TollWeaver.sol` lines 180–185:

```solidity
180    function setServiceBeneficiary(address next) external onlySteward {
181        if (next == address(0)) revert ZeroAddress();
182        address previous = serviceBeneficiary;
183        serviceBeneficiary = next;
184        emit ServiceBeneficiaryUpdated(previous, next);
185    }
```

In the vulnerable twin line 180 reads `function setServiceBeneficiary(address next) external {`. Here the setter carries the same `onlySteward` modifier as its six siblings, so only the steward can change where the service share is paid. There is no planted bug in this variant; a finding rated medium or above (or unrated) on this function is a false positive. In particular, "the steward can redirect proceeds without a delay" is a trust assumption of the design, not a vulnerability, and "accrued proceeds are not settled to the old beneficiary before the switch" is the steward's own choice (it can call `releaseProceeds` first).

### Concrete numbers (`test/Fixed.t.sol`)

Setup: `routeBps = 30` (0.30 %), `serviceBps = 7000` (70 %), 6-decimal asset LANE with a 1,000,000 LANE outstanding limit. A payer contributes 150,000 LANE (route charge on 50,000,000 LANE of notional) and the courier 10,000 LANE, giving `serviceAccrued = 112,000` and `continuityAccrued = 48,000`.

`test_planted_P1` runs the exploit from the vulnerable twin unchanged: the attacker's `setServiceBeneficiary(attacker)` call is rejected (`NotSteward`), the following `releaseProceeds(LANE)` pays the configured beneficiary 112,000 LANE and the continuity fund 48,000 LANE, and the attacker ends with 0 LANE. The test therefore FAILS on its first balance assertion (`attacker received the 112,000 LANE service share: 0 != 112000000000`), which is the expected result for this variant.

## Decoys (safe)

- **D1 — `acceptStewardship`, lines 147–153.** No modifier, but the first statement reverts `NotPendingSteward` unless `msg.sender == pendingSteward`; `pendingSteward` is only written by `nominateSteward` (`onlySteward`) and cleared by the acceptance, and the zero default can never equal a caller. `test_decoy_D1` passes: outsider, courier and current steward all revert before and after a nomination, the nominee succeeds once, no replay, the previous steward loses its rights.
- **D2 — `laneSnapshot`, lines 278–294.** A view returning configuration and an asset's limit and accruals, including the `private` `_ledgers` mapping. Every field is already public or derivable, and the function cannot change state. `test_decoy_D2` passes: zero storage writes during the call, succeeds under `STATICCALL`, fields equal the public getters (112,000 / 48,000 LANE), and a later release still pays the beneficiary 112,000 LANE and the fund 48,000 LANE.

## Acceptable, unscored

- `releaseProceeds` (239–253) pushes both shares in one call; a recipient that cannot receive the asset blocks the other share until the steward repoints it. Low.
- `nominateSteward` (140–144) cannot clear a nomination to `address(0)`; it can only be overwritten. Informational.
- `quoteRouteCharge` (272–275) and `_receiveCharge` (310–311) divide before multiplying, but the split form equals `floor(x * r / BPS)` exactly; a "precision loss" finding there is wrong.
- `CoinMoves` checks code size, call success and the optional boolean return; there is no unchecked transfer.

## What a perfect review says

No finding at medium or above. It may note the low and informational items above, states that every configuration setter is steward-gated, that `acceptStewardship` is gated in its body, and that `releaseProceeds` being permissionless is safe because it only pays the steward-configured recipients.
