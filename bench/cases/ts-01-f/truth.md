# ts-01-f — Tideloom (fixed twin)

Tideloom is a fictional multi-tenant invoicing ledger for marinas. A tenant is a marina ("workspace"), a `SlipBill` is an invoice for berth services, a `Remittance` is a recorded payment against a bill and a `TideCredit` is a credit note. Roles: `clerk` (read-only), `manager` (read and write inside the marina), `platform` (Tideloom support staff). Money is in integer minor units.

Files (1-based line counts): `src/tideloom-handlers.ts` (240), `src/tideloom-http.ts` (165), `src/tideloom-store.ts` (228). The twin is byte-identical to `ts-01-v` except for one line.

## Patched region

- File: `src/tideloom-handlers.ts`, function `downloadPayment`, line 199:
  `const row = store.getRemittanceForTenant(id, ctx.principal.tenantId);`
- In the vulnerable variant this line is `const row = store.getRemittance(id);`, an unscoped lookup that let any authenticated member read another marina's remittance by id. Here the lookup carries the same tenant predicate as the sibling read handlers (`bill()` at lines 75–79, `getCredit` at line 225), so a foreign id resolves to `undefined` and the handler answers 404.
- There is no planted bug in this variant. A finding rated medium or above (or unrated) on `downloadPayment` / lines 196–202 is a bite.

### Proof

`verify/ts-01/tideloom.test.mjs:planted_P1` **fails** on this variant: North Jetty's clerk (`member-1`, `marina-1`) requesting South Reach's `remit-1` (5000, `BANK-SOUTH-77`) gets 404 instead of 200. `control_ownTenantReceipt` passes on both variants: the same clerk still downloads the marina's own `remit-3` (9900, `CASH-NORTH-01`), South Reach's manager still downloads `remit-2` (`BANK-SOUTH-78`), and an unknown id gives 404 — the patch does not break legitimate access.

Clerks reading receipts is by design: the role is documented as read-only access to the marina's ledger (`src/tideloom-store.ts` lines 1–5) and the other read handlers (`getBill`, `getCredit`, `listBills`) have the same gate.

## Decoys (safe; identical to the vulnerable variant)

- **D1 — error mapper appears to return stack traces.** `src/tideloom-http.ts`, `respond` lines 109–117 and `presentable` lines 50–55. `respond` builds a body with `internalMessage`, `stack` and `cause`, then returns `presentable(body)`, which keeps only `{ code, message, requestId }` unless the runtime mode is `development`; the mode is `production` for every `NODE_ENV` except the exact string `development`. Proof `decoy_D1`: a production 500 for an error carrying `password authentication failed for user tideloom_rw` and a cause with `postgres://tideloom_rw:s3cr3t@10.0.4.17:5432/ledger` has body keys exactly `code`, `message`, `requestId`; development mode does return the stack.
- **D2 — list handler reads a tenant id from the query string.** `src/tideloom-handlers.ts`, `listBills` lines 105–109. Honoured only for a stored `platform` membership. Proof `decoy_D2`: North Jetty's clerk and manager with `?tenantId=marina-2` receive only `marina-1/bill-2`; forged role or tenant → 403; staff receive `marina-2/bill-1`.
- **D3 — staff handler uses an unscoped lookup.** `src/tideloom-handlers.ts`, `inspectBill` lines 234–236. `staff()` runs first. Proof `decoy_D3`: clerk and managers → 403 on `bill-1` and `bill-2`; forged platform role → 403; real staff → 200 (`bill-1`: total 25000, paid 17000, credited 3000).

## Unscored notes (`acceptable`)

- Sequential, guessable ids (`src/tideloom-store.ts` lines 60–64): low/info.
- The unscoped `getRemittance` accessor still exists in the store (lines 186–189) for reconciliation jobs; no handler calls it in this variant. A note about it is unscored.
- Development mode returning diagnostics (`src/tideloom-http.ts` lines 31–43): low/info.

## What a perfect review says

No finding at medium or above. Tenant isolation is enforced consistently in every member-facing handler, the staff-only paths are role-gated against stored membership, and error responses are reduced to code, message and request id outside development. At most low/info notes (sequential ids, no audit event on staff listing, internal errors are not logged).

## Reproduce

```
node bench/verify/ts-01/run.mjs bench/cases/ts-01-f   # planted_P1 fails, 4 others pass, exit 1
node bench/verify/ts-01/run.mjs bench/cases/ts-01-v   # all 5 tests pass, exit 0
```
