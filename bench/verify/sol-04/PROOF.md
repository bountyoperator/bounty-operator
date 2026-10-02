# Proof — pair sol-04 (Cinderloom)

Foundry project, solc 0.8.26 pinned, `offline = true`, forge-std from `../_lib/forge-std`.

- `src/vulnerable/` and `src/fixed/` are copies of the two case workspaces (`bench/cases/sol-04-v/workspace/src`, `.../sol-04-f/workspace/src`). They differ on lines 200, 201 and 206 of `Cinderloom.sol` only.
- `test/Vulnerable.t.sol` is the hand-written suite. `test/Fixed.t.sol` is generated from it by `node make-fixed-test.mjs`; the only differences are the import path (`../src/fixed/`) and the contract name (`FixedTest`). Every test body and assertion is identical.

## Commands (run from this directory)

```
forge test --match-path test/Vulnerable.t.sol
forge test --match-path test/Fixed.t.sol
```

## Expected results

| Test | `Vulnerable.t.sol` | `Fixed.t.sol` |
|---|---|---|
| `test_planted_P1` | PASS | **FAIL** (`nested participant received double its entitlement: 4320000000000000000 != 8640000000000000000`) |
| `test_decoy_D1` | PASS | PASS |
| `testFuzz_decoy_D1` (512 runs, fixed seed) | PASS | PASS |
| `test_control_drawPaysOnce` | PASS | PASS |
| `test_control_unweavePaysOnce` | PASS | PASS |

So `forge test --match-path test/Vulnerable.t.sol` exits 0 (5 passed) and `forge test --match-path test/Fixed.t.sol` exits 1 (4 passed, 1 failed, the failure being `test_planted_P1`). A plain `forge test` reports 9 passed, 1 failed.

## What the planted test shows

Burn span 10 days (864,000 s), 8.64 ETH kindled, so 1e13 wei per second and no scheduling remainder. Alice and a contract participant each weave 100 filaments; after the burn each is owed 4.32 ETH and the loom holds 8.64 ETH.

The contract participant calls `drawEmbers()` and, from `receive()`, calls `unweave()` once (inside `try/catch`).

- Vulnerable: the nested `unweave()` succeeds. The participant ends with 8.64 ETH from two payments plus its 100 filaments, the loom holds 0 ETH, `embersOf(alice)` is still 4.32 ETH and Alice's `drawEmbers()` reverts `NativeDeliveryFailed`.
- Fixed: the nested `unweave()` reverts `LoomBusy`; the participant ends with 4.32 ETH and the first assertion fails.

## What the decoy tests show

`loosen()` reverts `BadQuantity` for zero, for one wei above the caller's filaments, and for one wei above the total; exact amounts land on zero; the fuzz test checks that for any request the call either reverts or leaves `filamentsOf` and `totalFilaments` reduced by exactly the request with the token balance equal to `totalFilaments`. The `unchecked` block at lines 185–188 never wraps.
