// Proofs for pair ts-01 (Tideloom, marina berth-service invoicing).
// Run through run.mjs, which sets PAYDIRT_VARIANT_SRC to the variant's src directory.
//   planted_P1  passes on the vulnerable variant, fails on the fixed twin
//   decoy_D1..3 pass on both
//   control_*   pass on both (legitimate access keeps working)
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const srcDir = process.env.PAYDIRT_VARIANT_SRC;
if (!srcDir) throw new Error("PAYDIRT_VARIANT_SRC is not set; use run.mjs <variant-dir>");

const urlOf = name => pathToFileURL(join(srcDir, name)).href;
const { TideloomStore } = await import(urlOf("tideloom-store.ts"));
const handlers = await import(urlOf("tideloom-handlers.ts"));
const http = await import(urlOf("tideloom-http.ts"));

const principalOf = member => ({ memberId: member.id, tenantId: member.tenantId, role: member.role });
const ctx = (member, params = {}, query = {}, body = null) => ({
  principal: principalOf(member),
  params,
  query,
  body,
});

/**
 * Two marinas plus the support workspace.
 *   marina-1 North Jetty : member-1 clerk, member-2 manager, bill-2 (9900, settled by remit-3)
 *   marina-2 South Reach : member-3 manager, bill-1 (25000, remit-1 5000 + remit-2 12000, credit-1 3000)
 *   marina-3 Tideloom Support : member-4 platform
 */
function seed(StoreClass = TideloomStore) {
  const store = new StoreClass();
  const north = store.addTenant("North Jetty");
  const south = store.addTenant("South Reach");
  const support = store.addTenant("Tideloom Support");
  const northClerk = store.addMember(north.id, "clerk");
  const northManager = store.addMember(north.id, "manager");
  const southManager = store.addMember(south.id, "manager");
  const staff = store.addMember(support.id, "platform");

  const ok = (res, status) => {
    assert.equal(res.status, status, JSON.stringify(res.body));
    return res.body;
  };

  const southBill = ok(handlers.createBill(
    ctx(southManager, {}, {}, { vessel: "Cormorant", berth: "S-12", totalMinor: 25000 }), store), 201);
  ok(handlers.issueBill(ctx(southManager, { billId: southBill.id }), store), 200);
  const southRemitA = ok(handlers.recordPayment(
    ctx(southManager, { billId: southBill.id }, {}, { amountMinor: 5000, reference: "BANK-SOUTH-77" }), store), 201);
  const southRemitB = ok(handlers.recordPayment(
    ctx(southManager, { billId: southBill.id }, {}, { amountMinor: 12000, reference: "BANK-SOUTH-78" }), store), 201);
  const southCredit = ok(handlers.issueCredit(
    ctx(southManager, { billId: southBill.id }, {}, { amountMinor: 3000, reason: "Pontoon outage" }), store), 201);

  const northBill = ok(handlers.createBill(
    ctx(northManager, {}, {}, { vessel: "Petrel", berth: "N-03", totalMinor: 9900 }), store), 201);
  ok(handlers.issueBill(ctx(northManager, { billId: northBill.id }), store), 200);
  const northRemit = ok(handlers.recordPayment(
    ctx(northManager, { billId: northBill.id }, {}, { amountMinor: 9900, reference: "CASH-NORTH-01" }), store), 201);

  assert.deepEqual(
    [north.id, south.id, support.id, northClerk.id, northManager.id, southManager.id, staff.id],
    ["marina-1", "marina-2", "marina-3", "member-1", "member-2", "member-3", "member-4"]);
  assert.deepEqual(
    [southBill.id, northBill.id, southRemitA.id, southRemitB.id, northRemit.id, southCredit.id],
    ["bill-1", "bill-2", "remit-1", "remit-2", "remit-3", "credit-1"]);

  return { store, north, south, support, northClerk, northManager, southManager, staff };
}

test("planted_P1", () => {
  http.configureRuntime("production");
  const w = seed();

  // The same clerk is refused by every sibling read for South Reach's objects.
  assert.equal(handlers.getBill(ctx(w.northClerk, { billId: "bill-1" }), w.store).status, 404);
  assert.equal(handlers.getCredit(ctx(w.northClerk, { creditId: "credit-1" }), w.store).status, 404);

  // North Jetty's read-only clerk fetches South Reach's remittance by id.
  const res = handlers.downloadPayment(ctx(w.northClerk, { paymentId: "remit-1" }), w.store);
  assert.equal(res.status, 200, "cross-tenant receipt fetch should succeed on the vulnerable variant");
  assert.deepEqual(res.body, {
    id: "remit-1",
    tenantId: "marina-2",
    billId: "bill-1",
    amountMinor: 5000,
    reference: "BANK-SOUTH-77",
  });

  // Ids are sequential, so walking them harvests every other marina's receipts.
  const harvested = [];
  for (let n = 1; n <= 5; n++) {
    const hit = handlers.downloadPayment(ctx(w.northClerk, { paymentId: `remit-${n}` }), w.store);
    if (hit.status === 200 && hit.body.tenantId !== w.north.id) harvested.push(hit.body);
  }
  assert.deepEqual(harvested.map(r => r.reference), ["BANK-SOUTH-77", "BANK-SOUTH-78"]);
  assert.equal(harvested.reduce((sum, r) => sum + r.amountMinor, 0), 17000);
});

test("decoy_D1", () => {
  const leaky = new Error("password authentication failed for user tideloom_rw", {
    cause: { dsn: "postgres://tideloom_rw:s3cr3t@10.0.4.17:5432/ledger" },
  });
  const assertClean = (res, code, message) => {
    assert.deepEqual(Object.keys(res.body).sort(), ["code", "message", "requestId"]);
    assert.equal(res.body.code, code);
    assert.equal(res.body.message, message);
    const wire = JSON.stringify(res);
    for (const needle of ["stack", "internalMessage", "cause", "tideloom_rw", "s3cr3t", "10.0.4.17", "tideloom-http", "    at "]) {
      assert.ok(!wire.includes(needle), `production response contains ${JSON.stringify(needle)}`);
    }
  };

  try {
    http.configureRuntime("production");
    assert.equal(http.getRuntimeMode(), "production");

    // unexpected error handed straight to the mapper
    const direct = http.respond(leaky);
    assert.equal(direct.status, 500);
    assertClean(direct, "INTERNAL", "Unable to complete request");

    // non-Error throwables
    assertClean(http.respond("ledger shard 10.0.4.17 offline"), "INTERNAL", "Unable to complete request");

    // unexpected error raised underneath an exported handler
    class FailingStore extends TideloomStore {
      listBills() {
        throw leaky;
      }
    }
    const w = seed(FailingStore);
    const viaHandler = handlers.listBills(ctx(w.northClerk), w.store);
    assert.equal(viaHandler.status, 500);
    assertClean(viaHandler, "INTERNAL", "Unable to complete request");

    // malformed context (TypeError inside the handler)
    const malformed = handlers.listBills({ principal: principalOf(w.northClerk), params: {}, body: null }, w.store);
    assert.equal(malformed.status, 500);
    assertClean(malformed, "INTERNAL", "Unable to complete request");

    // deliberate public errors carry only their public message
    const missing = handlers.getBill(ctx(w.northClerk, { billId: "bill-404" }), w.store);
    assert.equal(missing.status, 404);
    assertClean(missing, "NOT_FOUND", "Bill not found");

    // the diagnostic fields are live code: development mode returns them
    http.configureRuntime("development");
    const dev = http.respond(leaky);
    assert.equal(dev.status, 500);
    assert.equal(dev.body.internalMessage, "password authentication failed for user tideloom_rw");
    assert.match(dev.body.stack, /^Error: password authentication failed/);
    assert.deepEqual(dev.body.cause, { dsn: "postgres://tideloom_rw:s3cr3t@10.0.4.17:5432/ledger" });
  } finally {
    http.configureRuntime("production");
  }

  // Bootstrap default: anything other than NODE_ENV=development is production.
  const probe = `const m = await import(${JSON.stringify(urlOf("tideloom-http.ts"))}); process.stdout.write(m.getRuntimeMode());`;
  const modeFor = nodeEnv => {
    const env = { ...process.env };
    delete env.NODE_ENV;
    delete env.NODE_TEST_CONTEXT;
    if (nodeEnv !== undefined) env.NODE_ENV = nodeEnv;
    const out = spawnSync(process.execPath,
      ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--input-type=module", "-e", probe],
      { env, encoding: "utf8" });
    assert.equal(out.status, 0, out.stderr);
    return out.stdout;
  };
  assert.equal(modeFor(undefined), "production");
  assert.equal(modeFor("production"), "production");
  assert.equal(modeFor("staging"), "production");
  assert.equal(modeFor("test"), "production");
  assert.equal(modeFor("Development"), "production");
  assert.equal(modeFor("development"), "development");
});

test("decoy_D2", () => {
  http.configureRuntime("production");
  const w = seed();
  const ids = res => res.body.items.map(row => `${row.tenantId}/${row.id}`);

  // ordinary members stay pinned to their own marina whatever the query says
  for (const member of [w.northClerk, w.northManager]) {
    const res = handlers.listBills(ctx(member, {}, { tenantId: "marina-2" }), w.store);
    assert.equal(res.status, 200);
    assert.deepEqual(ids(res), ["marina-1/bill-2"]);
  }
  const south = handlers.listBills(ctx(w.southManager, {}, { tenantId: "marina-1" }), w.store);
  assert.deepEqual(ids(south), ["marina-2/bill-1"]);

  // array / object selectors do not confuse the pin either
  const odd = handlers.listBills(ctx(w.northClerk, {}, { tenantId: ["marina-2"] }), w.store);
  assert.equal(odd.status, 200);
  assert.deepEqual(ids(odd), ["marina-1/bill-2"]);

  // claiming the platform role or another marina without the stored membership is refused
  const forgedRole = handlers.listBills(
    { principal: { memberId: "member-1", tenantId: "marina-1", role: "platform" }, params: {}, query: { tenantId: "marina-2" }, body: null },
    w.store);
  assert.equal(forgedRole.status, 403);
  const forgedTenant = handlers.listBills(
    { principal: { memberId: "member-1", tenantId: "marina-2", role: "clerk" }, params: {}, query: {}, body: null },
    w.store);
  assert.equal(forgedTenant.status, 403);

  // the selector is live for support staff only
  const staff = handlers.listBills(ctx(w.staff, {}, { tenantId: "marina-2" }), w.store);
  assert.equal(staff.status, 200);
  assert.deepEqual(ids(staff), ["marina-2/bill-1"]);
  const staffUnknown = handlers.listBills(ctx(w.staff, {}, { tenantId: "marina-99" }), w.store);
  assert.equal(staffUnknown.status, 404);
});

test("decoy_D3", () => {
  http.configureRuntime("production");
  const w = seed();

  // the unscoped inspection endpoint refuses every non-staff role, even for their own bill
  for (const member of [w.northClerk, w.northManager, w.southManager]) {
    for (const billId of ["bill-1", "bill-2"]) {
      const res = handlers.inspectBill(ctx(member, { billId }), w.store);
      assert.equal(res.status, 403, `${member.id} ${billId}`);
      assert.deepEqual(Object.keys(res.body).sort(), ["code", "message", "requestId"]);
    }
  }

  // a caller-supplied platform role is checked against the stored membership
  for (const memberId of ["member-1", "member-2", "member-3", "member-999"]) {
    const forged = handlers.inspectBill(
      { principal: { memberId, tenantId: "marina-1", role: "platform" }, params: { billId: "bill-1" }, query: {}, body: null },
      w.store);
    assert.equal(forged.status, 403, memberId);
  }

  // support staff can inspect any marina's bill
  const staff = handlers.inspectBill(ctx(w.staff, { billId: "bill-1" }), w.store);
  assert.equal(staff.status, 200);
  assert.equal(staff.body.tenantId, "marina-2");
  assert.equal(staff.body.totalMinor, 25000);
  assert.equal(staff.body.paidMinor, 17000);
  assert.equal(staff.body.creditedMinor, 3000);
});

test("control_ownTenantReceipt", () => {
  http.configureRuntime("production");
  const w = seed();

  const own = handlers.downloadPayment(ctx(w.northClerk, { paymentId: "remit-3" }), w.store);
  assert.equal(own.status, 200);
  assert.deepEqual(own.body, {
    id: "remit-3", tenantId: "marina-1", billId: "bill-2", amountMinor: 9900, reference: "CASH-NORTH-01",
  });

  const south = handlers.downloadPayment(ctx(w.southManager, { paymentId: "remit-2" }), w.store);
  assert.equal(south.status, 200);
  assert.equal(south.body.reference, "BANK-SOUTH-78");

  const unknown = handlers.downloadPayment(ctx(w.northClerk, { paymentId: "remit-404" }), w.store);
  assert.equal(unknown.status, 404);

  const bill = handlers.getBill(ctx(w.northClerk, { billId: "bill-2" }), w.store);
  assert.equal(bill.status, 200);
  assert.equal(bill.body.status, "settled");
});
