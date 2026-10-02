# sol-06 proof — TollWeaver (`setServiceBeneficiary` without `onlySteward`)

Foundry project, solc pinned to 0.8.28 (`foundry.toml`), forge-std from `../_lib/forge-std`.

| Path | Content |
|---|---|
| `src/vulnerable/` | the sources shipped in `bench/cases/sol-06-v/workspace/src/` |
| `src/fixed/` | the sources shipped in `bench/cases/sol-06-f/workspace/src/` |
| `test/Vulnerable.t.sol` | `VulnerableTest`, imports `src/vulnerable/TollWeaver.sol` |
| `test/Fixed.t.sol` | `FixedTest`, imports `src/fixed/TollWeaver.sol`; generated from `Vulnerable.t.sol` |
| `test/mocks/LaneCoinMock.sol` | plain 6-decimal ERC-20 used by both |
| `make-fixed-test.mjs` | regenerates `test/Fixed.t.sol`; `--check` verifies it has not drifted |

The two test files differ only in the TollWeaver import path and the test contract name. The test bodies are byte-identical (`node make-fixed-test.mjs --check`).

## Commands

Run from `bench/verify/sol-06/`:

```
forge test --offline --match-path test/Vulnerable.t.sol -vv
forge test --offline --match-path test/Fixed.t.sol -vv
```

## Expected results

| Test | `test/Vulnerable.t.sol` | `test/Fixed.t.sol` |
|---|---|---|
| `test_planted_P1` | PASS | **FAIL** (`attacker received the 112,000 LANE service share: 0 != 112000000000`) |
| `test_decoy_D1` | PASS | PASS |
| `test_decoy_D2` | PASS | PASS |

So the first command exits 0 with `3 passed; 0 failed`, the second exits 1 with `2 passed; 1 failed`, and a plain `forge test --offline` exits 1 with `5 tests passed, 1 failed`. The single failure is the expected one.

## What each test shows

Shared setup: `routeBps = 30`, `serviceBps = 7000`, LANE (6 decimals) enabled with a 1,000,000 LANE limit. A payer contributes the route charge on 50,000,000 LANE of notional (150,000 LANE) and the courier submits a 10,000 LANE settlement charge. The contract holds 160,000 LANE: 112,000 accrued to the service side, 48,000 to the continuity side.

- `test_planted_P1` — an account with no role calls `setServiceBeneficiary(attacker)` through a low-level call (so the outcome is decided by the balance assertions, not by a revert), then `releaseProceeds(LANE)`.
  - Vulnerable: the setter accepts; attacker 112,000 LANE, configured beneficiary 0, continuity fund 48,000, contract 0.
  - Fixed: the setter reverts `NotSteward`; attacker 0, configured beneficiary 112,000, continuity fund 48,000. The assertion `balanceOf(attacker) == 112,000 LANE` fails.
- `test_decoy_D1` — `acceptStewardship` has no modifier but is gated in its body: outsider, courier and current steward revert `NotPendingSteward` both with no nomination and with one pending; only the nominee can accept; the pending slot is cleared; the acceptance cannot be replayed; the previous steward can no longer configure.
- `test_decoy_D2` — `laneSnapshot` only reads: zero storage writes recorded during the call, it succeeds under `STATICCALL`, every returned field equals the corresponding public getter (accruals 112,000 / 48,000 LANE), and a release triggered by the same caller afterwards still pays the configured beneficiary and fund.

## Observed (2 Oct 2026, forge 1.7.1, solc 0.8.28)

```
test/Vulnerable.t.sol:VulnerableTest
[PASS] test_decoy_D1()
[PASS] test_decoy_D2()
[PASS] test_planted_P1()
  setServiceBeneficiary called by attacker: accepted
  attacker LANE: 112000.000000
  beneficiary LANE: 0.000000
  continuity fund LANE: 48000.000000
Suite result: ok. 3 passed; 0 failed; 0 skipped

test/Fixed.t.sol:FixedTest
[PASS] test_decoy_D1()
[PASS] test_decoy_D2()
[FAIL: attacker received the 112,000 LANE service share: 0 != 112000000000] test_planted_P1()
  setServiceBeneficiary called by attacker: rejected
  attacker LANE: 0.000000
  beneficiary LANE: 112000.000000
  continuity fund LANE: 48000.000000
Suite result: FAILED. 2 passed; 1 failed; 0 skipped
```
