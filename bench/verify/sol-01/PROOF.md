# sol-01 proof project — AsterQuay

Foundry project proving pair `sol-01` (cases `sol-01-v` and `sol-01-f`).
Toolchain: forge 1.7.1, solc 0.8.24 (pinned in `foundry.toml`), evm `cancun`, optimizer 200 runs,
forge-std 1.17.0 from `../_lib/forge-std`, `offline = true`, fuzz 512 runs with seed `0x5a17`.

## Layout

| Path | What |
| --- | --- |
| `src/vulnerable/AsterQuay.sol`, `src/vulnerable/QuayTools.sol` | byte-identical to `sol-01-v/workspace/src/*` |
| `src/fixed/AsterQuay.sol`, `src/fixed/QuayTools.sol` | byte-identical to `sol-01-f/workspace/src/*`; generated from `src/vulnerable` by `make-twin.mjs` (six changed lines, 299-301 and 305-307) |
| `test/Vulnerable.t.sol` | `VulnerableTest`: the proofs, written once |
| `test/Fixed.t.sol` | `FixedTest`: generated from `Vulnerable.t.sol` by `make-twin.mjs`; differs only in the import path and the contract name, so every test body and assertion is identical |
| `test/FixedTwin.t.sol` | `FixedTwinTest`: runs only against `src/fixed`; shows the attack loses money there |
| `make-twin.mjs` | regenerates the derived files; `--check` fails on drift |

## Commands (run from `bench/verify/sol-01`)

```
node make-twin.mjs --check
forge test --match-contract VulnerableTest
forge test --match-contract FixedTest --match-test test_decoy
forge test --match-contract FixedTest --match-test test_planted
forge test --match-contract FixedTwinTest
forge test            # everything: exits 1 because of the one expected failure
```

## Expected results

| Test | `VulnerableTest` | `FixedTest` |
| --- | --- | --- |
| `test_planted_P1` | PASS | **FAIL** (`victim was minted receipts: 999999 != 0`) |
| `test_decoy_D1` | PASS | PASS |
| `test_decoy_D2` | PASS | PASS |
| `testFuzz_support_D2_exitNeverOverpays` | PASS | PASS |
| `testFuzz_support_roundTripNeverProfits` | PASS | PASS |
| `testFuzz_support_mulDiv` | PASS | PASS |
| `test_support_mulDivWide` | PASS | PASS |

| Test (`FixedTwinTest`, fixed sources only) | Result |
| --- | --- |
| `test_patched_P1` | PASS |
| `testFuzz_patched_P1_neverProfitable` | PASS |

Whole run: 16 tests, 15 pass, 1 fails (`FixedTest.test_planted_P1`). Any other outcome means the
pair is broken.

## Observed (2026-10-02, after `forge clean`)

```
Ran 2 tests for test/FixedTwin.t.sol:FixedTwinTest
[PASS] testFuzz_patched_P1_neverProfitable(uint256,uint256,uint256) (runs: 512)
[PASS] test_patched_P1()
  victim receipts    999999
  victim claim       4999996666665555555185
  attacker payout    5000001666667222222408
  attacker loss      4999998333332777777593
Suite result: ok. 2 passed; 0 failed

Ran 7 tests for test/Fixed.t.sol:FixedTest
[PASS] testFuzz_support_D2_exitNeverOverpays(...) (runs: 512)
[PASS] testFuzz_support_mulDiv(...) (runs: 512)
[PASS] testFuzz_support_roundTripNeverProfits(...) (runs: 512)
[PASS] test_decoy_D1()
[PASS] test_decoy_D2()
  withdraw: receipts burnt 92018348623853211016518827
  withdraw: fee            300000000000000001
  redeem:   net out        100000000000000000007
  redeem:   fee            300000000000000001
  alice net out           1086739780658025922232
  alice exit fee          3260219341974077767
  bob maxWithdraw         443369890329012961108
  bob claim left behind   0
[FAIL: victim was minted receipts: 999999 != 0] test_planted_P1()
  victim receipts         999999
  victim maxWithdraw      4999996666665555555185
  attacker receipts       1000000
  attacker previewRedeem  5000001666667222222408
[PASS] test_support_mulDivWide()
Suite result: FAILED. 6 passed; 1 failed

Ran 7 tests for test/Vulnerable.t.sol:VulnerableTest
[PASS] testFuzz_support_D2_exitNeverOverpays(...) (runs: 512)
[PASS] testFuzz_support_mulDiv(...) (runs: 512)
[PASS] testFuzz_support_roundTripNeverProfits(...) (runs: 512)
[PASS] test_decoy_D1()
[PASS] test_decoy_D2()
  withdraw: receipts burnt 92018348623853211017
  withdraw: fee            300000000000000001
  redeem:   net out        100000000000000000007
  redeem:   fee            300000000000000001
  alice net out           1086739780658025922233
  alice exit fee          3260219341974077767
  bob maxWithdraw         443369890329012961108
  bob claim left behind   0
[PASS] test_planted_P1()
  victim receipts         0
  victim maxWithdraw      0
  attacker receipts       1
  attacker previewRedeem  15000000000000000000001
[PASS] test_support_mulDivWide()
Suite result: ok. 7 passed; 0 failed

Ran 3 test suites: 15 tests passed, 1 failed, 0 skipped (16 total tests)
```

Exit codes: `VulnerableTest` 0; `FixedTest --match-test test_decoy` 0; `FixedTest --match-test
test_planted` 1; `FixedTwinTest` 0.

Extra stress during authoring (not part of the default run): `FOUNDRY_FUZZ_RUNS=30000` with seeds
`0xa1` and `0xb2` for the three `testFuzz_support_*` tests on both variants, and
`FOUNDRY_FUZZ_RUNS=50000` with seeds `0x5a17`, `0x111`, `0x222`, `0x333` for
`testFuzz_patched_P1_neverProfitable` — all passed.

## What each proof establishes

- `test_planted_P1` — attacker deposits 1 base unit, transfers 10,000 tokens to the contract, the
  victim's 5,000-token deposit mints 0 receipts and has `maxWithdraw == 0`, the attacker redeems
  15,000e18 + 1 and nets exactly 5,000 tokens. On the fixed sources the victim is minted 999,999
  receipts, so the first assertion fails.
- `test_decoy_D1` — `sweepToken` is owner-only, rejects the underlying and the receipt token, and
  leaves the depositor's claim intact.
- `test_decoy_D2` — both exit routes charge at least `exitFeeBps` of the net amount, never pay out
  more than the burned receipts were worth, never dilute the holders who stay, and redeeming the
  receipts a withdrawal burned never pays a smaller fee.
- `test_patched_P1` / `testFuzz_patched_P1_neverProfitable` — on the fixed sources the same
  sequence costs the attacker about 5,000 tokens and no parameter choice makes it profitable.
