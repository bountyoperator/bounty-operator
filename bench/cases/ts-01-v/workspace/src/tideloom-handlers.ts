import { BadInput, Forbidden, NotFound, Conflict, respond, audit } from "./tideloom-http.ts";
import type { Response } from "./tideloom-http.ts";
import type { Role, SlipBill, TideloomStore } from "./tideloom-store.ts";

export interface RequestContext {
  principal: { memberId: string; tenantId: string; role: Role };
  params: Record<string, unknown>;
  query: Record<string, unknown>;
  body: unknown;
}

type Action = () => Response;

function run(action: Action): Response {
  try {
    return action();
  } catch (error) {
    return respond(error);
  }
}

function authenticate(ctx: RequestContext, store: TideloomStore): void {
  const member = store.getMember(ctx.principal.memberId);
  if (!member || member.tenantId !== ctx.principal.tenantId
    || member.role !== ctx.principal.role) {
    throw new Forbidden();
  }
}

function manager(ctx: RequestContext, store: TideloomStore): void {
  authenticate(ctx, store);
  if (ctx.principal.role !== "manager") throw new Forbidden();
}

function staff(ctx: RequestContext, store: TideloomStore): void {
  authenticate(ctx, store);
  if (ctx.principal.role !== "platform") throw new Forbidden();
}

function text(value: unknown, field: string, max = 120): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new BadInput(`Invalid ${field}`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) throw new BadInput(`Invalid ${field}`);
  return value.trim();
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BadInput("Expected an object");
  }
  return value as Record<string, unknown>;
}

function amount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)
    || value <= 0 || value > 1_000_000_000) {
    throw new BadInput("Invalid amountMinor");
  }
  return value;
}

function pageNumber(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw new BadInput("Invalid pagination");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new BadInput("Invalid pagination");
  }
  return parsed;
}

function bill(ctx: RequestContext, store: TideloomStore): SlipBill {
  const row = store.getBillForTenant(text(ctx.params.billId, "billId"), ctx.principal.tenantId);
  if (!row) throw new NotFound("Bill not found");
  return row;
}

function writable(row: SlipBill, status: "draft" | "issued"): void {
  if (row.status !== status) throw new Conflict(`Bill must be ${status}`);
}

function balance(row: SlipBill, value: number): void {
  writable(row, "issued");
  if (value > row.totalMinor - row.paidMinor - row.creditedMinor) {
    throw new Conflict("Amount exceeds remaining balance");
  }
}

function event(ctx: RequestContext, action: string, objectId: string): void {
  audit.emitEvent({
    actorId: ctx.principal.memberId,
    tenantId: ctx.principal.tenantId,
    action,
    objectId,
  });
}

/** List berth-service bills, with an optional staff workspace selector. */
export function listBills(ctx: RequestContext, store: TideloomStore): Response {
  return run(() => {
    authenticate(ctx, store);
    let tenantId = ctx.principal.tenantId;
    if (ctx.principal.role === "platform" && ctx.query.tenantId !== undefined) {
      tenantId = text(ctx.query.tenantId, "tenantId");
      if (!store.getTenant(tenantId)) throw new NotFound("Marina not found");
    }
    const offset = pageNumber(ctx.query.offset, 0, 1_000_000);
    const limit = pageNumber(ctx.query.limit, 25, 100);
    if (limit === 0) throw new BadInput("Limit must be positive");
    // TODO: add cursor pagination when archive volumes justify it.
    return { status: 200, body: store.listBills(tenantId, offset, limit) };
  });
}

/** Read one bill from the current workspace. */
export function getBill(ctx: RequestContext, store: TideloomStore): Response {
  return run(() => {
    authenticate(ctx, store);
    return { status: 200, body: bill(ctx, store) };
  });
}

/** Prepare a draft for berth charges. */
export function createBill(ctx: RequestContext, store: TideloomStore): Response {
  return run(() => {
    manager(ctx, store);
    const input = object(ctx.body);
    const vessel = text(input.vessel, "vessel");
    const berth = text(input.berth, "berth", 40);
    const row = store.createBill(ctx.principal.tenantId, vessel, berth, amount(input.totalMinor));
    event(ctx, "bill.created", row.id);
    return { status: 201, body: row };
  });
}

/** Replace editable draft fields. */
export function amendBill(ctx: RequestContext, store: TideloomStore): Response {
  return run(() => {
    manager(ctx, store);
    const row = bill(ctx, store);
    writable(row, "draft");
    const input = object(ctx.body);
    const result = store.amendBill(row.id, ctx.principal.tenantId,
      text(input.vessel, "vessel"), text(input.berth, "berth", 40), amount(input.totalMinor));
    event(ctx, "bill.amended", row.id);
    return { status: 200, body: result };
  });
}

/** Publish a draft to the vessel operator's ledger. */
export function issueBill(ctx: RequestContext, store: TideloomStore): Response {
  return run(() => {
    manager(ctx, store);
    const row = bill(ctx, store);
    writable(row, "draft");
    const result = store.transition(row.id, ctx.principal.tenantId, "issued");
    event(ctx, "bill.issued", row.id);
    return { status: 200, body: result };
  });
}

/** Cancel an untouched draft or issued bill. */
export function voidBill(ctx: RequestContext, store: TideloomStore): Response {
  return run(() => {
    manager(ctx, store);
    const row = bill(ctx, store);
    if (!["draft", "issued"].includes(row.status) || row.paidMinor || row.creditedMinor) {
      throw new Conflict("Bill cannot be voided");
    }
    const result = store.transition(row.id, ctx.principal.tenantId, "void");
    event(ctx, "bill.voided", row.id);
    return { status: 200, body: result };
  });
}

/** Record a bank or cash remittance confirmed by a marina manager. */
export function recordPayment(ctx: RequestContext, store: TideloomStore): Response {
  return run(() => {
    manager(ctx, store);
    const row = bill(ctx, store);
    const input = object(ctx.body);
    const value = amount(input.amountMinor);
    balance(row, value);
    const result = store.recordRemittance(row.id, ctx.principal.tenantId,
      value, text(input.reference, "reference"));
    event(ctx, "remittance.recorded", result.id);
    return { status: 201, body: result };
  });
}

/** Fetch the remittance receipt for display or local download. */
export function downloadPayment(ctx: RequestContext, store: TideloomStore): Response {
  return run(() => {
    authenticate(ctx, store);
    const id = text(ctx.params.paymentId, "paymentId");
    const row = store.getRemittance(id);
    if (!row) throw new NotFound("Remittance not found");
    event(ctx, "remittance.downloaded", row.id);
    return { status: 200, body: row };
  });
}

/** Issue a tide credit against unpaid charges. */
export function issueCredit(ctx: RequestContext, store: TideloomStore): Response {
  return run(() => {
    manager(ctx, store);
    const row = bill(ctx, store);
    const input = object(ctx.body);
    const value = amount(input.amountMinor);
    balance(row, value);
    const result = store.issueCredit(row.id, ctx.principal.tenantId,
      value, text(input.reason, "reason", 240));
    event(ctx, "credit.issued", result.id);
    return { status: 201, body: result };
  });
}

/** Fetch a credit document from the current marina. */
export function getCredit(ctx: RequestContext, store: TideloomStore): Response {
  return run(() => {
    authenticate(ctx, store);
    const row = store.getCreditForTenant(text(ctx.params.creditId, "creditId"), ctx.principal.tenantId);
    if (!row) throw new NotFound("Credit not found");
    return { status: 200, body: row };
  });
}

/** Platform support's read-only ledger inspection. */
export function inspectBill(ctx: RequestContext, store: TideloomStore): Response {
  return run(() => {
    staff(ctx, store);
    const row = store.getBill(text(ctx.params.billId, "billId"));
    if (!row) throw new NotFound("Bill not found");
    event(ctx, "platform.bill.inspected", row.id);
    return { status: 200, body: row };
  });
}
