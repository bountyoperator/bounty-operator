# ts-01-v — Tideloom (vulnerable variant)

Tideloom is a fictional multi-tenant invoicing ledger for marinas. A tenant is a marina ("workspace"), a `SlipBill` is an invoice for berth services, a `Remittance` is a recorded payment against a bill and a `TideCredit` is a credit note. Roles: `clerk` (read-only), `manager` (read and write inside the marina), `platform` (Tideloom support staff). Money is in integer minor units.

Files (1-based line counts): `src/tideloom-handlers.ts` (240), `src/tideloom-http.ts` (165), `src/tideloom-store.ts` (228).

## Planted bug P1 — cross-tenant read of payment records (IDOR)

- File: `src/tideloom-handlers.ts`, function `downloadPayment`, lines 198–200. Line 199 is the faulty lookup:
  `const row = store.getRemittance(id);`
- Mechanism: every other read handler resolves its object through a tenant-scoped accessor (`bill()` → `store.getBillForTenant(id, ctx.principal.tenantId)` at lines 75–79, `getCredit` → `store.getCreditForTenant(..., ctx.principal.tenantId)` at line 225). `downloadPayment` instead calls the unscoped `store.getRemittance(id)` (`src/tideloom-store.ts` lines 186–189, documented as the reconciliation accessor). The only gate in the handler is `authenticate()`, which proves the caller is a real member of *some* marina, so any member of marina A receives marina B's remittance when they supply its id. Ids are sequential (`remit-1`, `remit-2`, …), so the whole table can be walked.
- Impact: disclosure of another tenant's payment records — amount, bank/cash reference, owning bill id and tenant id — to the lowest-privilege authenticated role. Read-only; no cross-tenant write.
- Accepted severity: high (medium also accepted).

### Proof (`verify/ts-01/tideloom.test.mjs:planted_P1`)

Fixture: `marina-1` North Jetty (clerk `member-1`, manager `member-2`), `marina-2` South Reach (manager `member-3`), `marina-3` Tideloom Support (platform `member-4`). South Reach owns `bill-1` (Cormorant, berth S-12, total 25000) with `remit-1` = 5000 `BANK-SOUTH-77`, `remit-2` = 12000 `BANK-SOUTH-78` and `credit-1` = 3000. North Jetty owns `bill-2` (Petrel, N-03, total 9900) settled by `remit-3` = 9900 `CASH-NORTH-01`.

1. North Jetty's clerk (`member-1`, `marina-1`, role `clerk`) calls `getBill` for `bill-1` → 404, and `getCredit` for `credit-1` → 404. The sibling handlers hold.
2. The same clerk calls `downloadPayment` with `paymentId: "remit-1"` → **200** with body
   `{ id: "remit-1", tenantId: "marina-2", billId: "bill-1", amountMinor: 5000, reference: "BANK-SOUTH-77" }`.
3. Walking `remit-1` … `remit-5` as that clerk returns two foreign receipts, references `BANK-SOUTH-77` and `BANK-SOUTH-78`, totalling 17000 minor units of South Reach's payments.

The test passes on this variant and fails on the fixed twin (step 2 returns 404 there).

## Decoys (safe; flagging them at medium or above is a false positive)

- **D1 — error mapper appears to return stack traces.** `src/tideloom-http.ts`, `respond` lines 109–117 and `presentable` lines 50–55. `respond` builds a body containing `internalMessage`, `stack` and `cause`, then returns `presentable(body)`. `presentable` returns only `{ code, message, requestId }` unless the runtime mode is `development`; the mode comes from `environmentMode()` (lines 31–33), which is `production` for every `NODE_ENV` except the exact string `development`. Proof `decoy_D1`: in production mode an `Error("password authentication failed for user tideloom_rw", { cause: { dsn: "postgres://tideloom_rw:s3cr3t@10.0.4.17:5432/ledger" } })` — passed directly, thrown by the store underneath `listBills`, or replaced by a TypeError from a malformed context — yields status 500 with body keys exactly `code`, `message`, `requestId` and message `Unable to complete request`; a deliberate 404 carries only `Bill not found`. In development mode the same error does return the stack, which shows the stripping is what protects production. A child process confirms the default: `NODE_ENV` unset, `production`, `staging`, `test` and `Development` all give `production`.
- **D2 — list handler reads a tenant id from the query string.** `src/tideloom-handlers.ts`, `listBills` lines 105–109. `query.tenantId` is used only when `ctx.principal.role === "platform"`, and `authenticate()` (lines 22–28) has already checked the claimed role and tenant against the stored membership. Proof `decoy_D2`: North Jetty's clerk and manager with `?tenantId=marina-2` still receive only `marina-1/bill-2`; a forged `role: "platform"` or forged `tenantId` on `member-1` → 403; support staff with the selector receive `marina-2/bill-1`.
- **D3 — staff handler uses an unscoped lookup.** `src/tideloom-handlers.ts`, `inspectBill` lines 234–236. It calls `store.getBill(id)` without a tenant predicate, but `staff()` (lines 35–38) runs first and requires a stored `platform` membership. Proof `decoy_D3`: clerk and managers get 403 for both `bill-1` and `bill-2`; forged platform role on `member-1`, `member-2`, `member-3` and an unknown member → 403; real staff get 200 for `bill-1` (total 25000, paid 17000, credited 3000).

## Unscored notes (`acceptable`)

- Sequential, guessable ids (`src/tideloom-store.ts` lines 60–64): a low/info hardening note; isolation is meant to come from the tenant predicate.
- Pointing only at the store's `getRemittance` accessor (`src/tideloom-store.ts` lines 186–189) without naming the handler: neither a hit nor a false positive.
- Development mode returning diagnostics / the mode being configurable at bootstrap (`src/tideloom-http.ts` lines 31–43): low/info.

## What a perfect review says

One finding: `src/tideloom-handlers.ts`, `downloadPayment`, around line 199, high (or medium) — the remittance is fetched without the tenant predicate, so any authenticated member can read other marinas' payment records by id; use `getRemittanceForTenant(id, ctx.principal.tenantId)`. It explicitly clears the error mapper (stripped outside development), the `listBills` tenant selector (staff only) and `inspectBill` (role-gated), and at most mentions sequential ids as a low/info note.

## Reproduce

```
node bench/verify/ts-01/run.mjs bench/cases/ts-01-v   # all 5 tests pass, exit 0
node bench/verify/ts-01/run.mjs bench/cases/ts-01-f   # planted_P1 fails, exit 1
```
