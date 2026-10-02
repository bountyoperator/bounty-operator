# sol-06-v — TollWeaver (vulnerable)

Pair `sol-06`, family `find-sol`, bug class: access control on sibling functions.
Drafted by `openai/gpt-6.1-sol`, repaired and proven by the case engineer. Proof project: `bench/verify/sol-06/`.

## The code

`TollWeaver` is the charge collector of the fictional Velisara protocol (prepaid execution lanes for cross-application message delivery).

- `contributeRouteCharge` (anyone) and `submitSettlementCharge` (courier only) pull an approved ERC-20 into the contract and split each charge between two accruals: `serviceAccrued` (`serviceBps` of the amount) and `continuityAccrued` (the rest).
- `releaseProceeds(asset)` is permissionless by design. It zeroes both accruals and pushes them to the stored `serviceBeneficiary` and `continuityFund`.
- The `steward` (two-step transfer: `nominateSteward` / `acceptStewardship`) configures everything through seven setters.

Files: `src/TollWeaver.sol` (323 lines), `src/libraries/CoinMoves.sol` (45 lines).

## Planted bug P1 — `setServiceBeneficiary` has no access control

`src/TollWeaver.sol` lines 180–185:

```solidity
180    function setServiceBeneficiary(address next) external {
181        if (next == address(0)) revert ZeroAddress();
182        address previous = serviceBeneficiary;
183        serviceBeneficiary = next;
184        emit ServiceBeneficiaryUpdated(previous, next);
185    }
```

Every sibling setter (`setRouteRate` 156, `setServiceWeight` 164, `setCourier` 172, `setContinuityFund` 188, `setIntakePaused` 196, `setAssetPolicy` 202) carries `onlySteward`. This one does not, and its body has no caller check either. Any account can make itself the service beneficiary. Because `releaseProceeds` (239–253) can be called by anyone and pays whatever address is stored at that moment, the attacker collects the whole accrued service share of every asset in the same transaction, and keeps receiving the service share of all future charges until the steward notices and resets the address (which the attacker can immediately undo).

Severity: high (critical accepted). Unprivileged, no preconditions, direct theft of all accrued and future service-side protocol revenue.

### Concrete numbers (`test/Vulnerable.t.sol:test_planted_P1`)

Setup: `routeBps = 30` (0.30 %), `serviceBps = 7000` (70 %), 6-decimal asset LANE with a 1,000,000 LANE outstanding limit.

1. A payer contributes the route charge on 50,000,000 LANE of notional: 150,000 LANE (105,000 service / 45,000 continuity).
2. The courier submits a 10,000 LANE settlement charge (7,000 service / 3,000 continuity).
3. The contract now holds 160,000 LANE: `serviceAccrued = 112,000`, `continuityAccrued = 48,000`.
4. The attacker (holding 0 LANE, no role) calls `setServiceBeneficiary(attacker)` — accepted — then `releaseProceeds(LANE)`.

Result: attacker 112,000 LANE, configured beneficiary 0 LANE, continuity fund 48,000 LANE, contract 0 LANE; `serviceBeneficiary()` now returns the attacker.

On the fixed twin the same call sequence leaves the attacker with 0 LANE and the beneficiary with 112,000 LANE, so the first balance assertion fails (`0 != 112000000000`).

## Decoys (safe)

- **D1 — `acceptStewardship`, lines 147–153.** It has no modifier, which looks like the same omission. It is safe: the first statement reverts `NotPendingSteward` unless `msg.sender == pendingSteward`, `pendingSteward` is only written by `nominateSteward` (`onlySteward`) and by the acceptance itself (cleared to zero), and the zero default can never equal a caller. `test_decoy_D1` shows an outsider, the courier and the current steward all revert before and after a nomination, the nominee succeeds once, the acceptance cannot be replayed, and the previous steward loses its rights.
- **D2 — `laneSnapshot`, lines 278–294.** A public view that returns the steward, pending steward, courier, both recipients, both rates, the pause flag and an asset's limit and accruals, including the `private` `_ledgers` mapping. Nothing here is secret (every field is already a public getter or derivable from `outstandingProceeds` and events) and the function cannot change state. `test_decoy_D2` records storage accesses during the call (zero writes), runs it under `STATICCALL`, checks each field against the public getters (112,000 / 48,000 LANE accruals), and shows a release afterwards still pays the configured beneficiary 112,000 LANE and the fund 48,000 LANE.

## Acceptable, unscored

- `releaseProceeds` (239–253) pushes both shares in one call; a recipient that cannot receive the asset blocks the other share until the steward repoints it. Low.
- `nominateSteward` (140–144) cannot clear a nomination to `address(0)`; it can only be overwritten. Informational.
- `quoteRouteCharge` (272–275) and `_receiveCharge` (310–311) divide before multiplying, but the split form `(x / BPS) * r + ((x % BPS) * r) / BPS` equals `floor(x * r / BPS)` exactly; a "precision loss" finding there is wrong.
- `CoinMoves` (`holdings` / `push` / `pull`) checks code size, call success and the optional boolean return; there is no unchecked transfer.

## What a perfect review says

One finding, high severity: `setServiceBeneficiary` (`src/TollWeaver.sol:180`) is missing `onlySteward`; anyone can set themselves as service beneficiary and call `releaseProceeds` to take the accrued service share (70 % of collected charges at the deployed weight) and all future service proceeds. Fix: add `onlySteward`. It does not report `acceptStewardship` or `laneSnapshot` as vulnerabilities.
