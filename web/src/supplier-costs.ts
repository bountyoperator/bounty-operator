// Supplier allowance is business capital, never a customer's wallet balance.
// Runtime allowances limit admitted commitments; only vendor billing is actual
// compute cost. An HTTP cancellation does not prove a GPU stopped billing.
import { sha256 } from './crypto.ts';
import { seconds } from './env.ts';
import type { Env } from './env.ts';
import { ApiError } from './http.ts';
import { boundedBody } from '../public/review-core.mjs';

export type Provider = 'runpod' | 'infron' | 'orcarouter';
const PROVIDERS: readonly Provider[] = ['runpod', 'infron', 'orcarouter'];
type SupplierEnv = Pick<Env, 'DB'> & { SUPPLIER_COST_RULES?: string; SUPPLIER_BUDGET_SHARE?: string; RUNPOD_API_KEY?: string };
export interface SupplierModel {
  id: string; context: number; maxOutput: number; endpoint?: string; upstreamModel?: string; enabled?: boolean;
}
interface SupplierRule {
  model: string; endpoint: string; upstreamModel: string; provider: Provider; resourceId: string;
  basis: 'token_rate' | 'runtime_allowance'; revision: string; source: string; validUntil: number;
  inputMicroPerMillion?: number; outputMicroPerMillion?: number; fixedMicro?: number; holdMicro?: number;
}
export interface SupplierQuote extends SupplierRule { holdMicro: number }
interface Budget { id: string; provider: Provider; limit_micro: number; reserved_micro: number; consumed_micro: number }
interface Commitment {
  basis: SupplierRule['basis']; hold_micro: number; input_micro_per_million: number;
  output_micro_per_million: number; fixed_micro: number;
}
type Usage = { input: number; output: number } | null;
const MAX_MONEY = 1_000_000_000_000;
const nonnegative = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= MAX_MONEY;
const positive = (n: unknown): n is number => nonnegative(n) && n > 0;
const text = (s: unknown, limit = 200): s is string => typeof s === 'string' && s.length > 0 && s.length <= limit;
const unavailable = () => new ApiError('This model is temporarily unavailable. No charge was made.', 503, 'supplier_unavailable', { retryAfter: 60 });

function rules(env: SupplierEnv): SupplierRule[] {
  if (!env.SUPPLIER_COST_RULES) return [];
  try {
    const values: SupplierRule[] = JSON.parse(env.SUPPLIER_COST_RULES);
    if (!Array.isArray(values) || values.length > 64) return [];
    const identities = new Set<string>();
    for (const r of values) {
      if (!r || typeof r !== 'object' || !text(r.model, 80) || !text(r.upstreamModel, 180) || !text(r.resourceId, 180) ||
        !text(r.revision) || !text(r.source, 1000) || !Number.isSafeInteger(r.validUntil) || r.validUntil <= 0) return [];
      const source = new URL(r.source);
      if (source.protocol !== 'https:' || source.username || source.password) return [];
      if (r.provider === 'runpod') {
        const host = /^https:\/\/([a-z0-9]+)\.api\.runpod\.ai$/.exec(r.endpoint);
        if (!host || host[1] !== r.resourceId || r.basis !== 'runtime_allowance' || !positive(r.holdMicro)) return [];
      } else if (r.provider === 'infron' || r.provider === 'orcarouter') {
        if (r.endpoint !== `https://api.${r.provider}.ai` || r.resourceId !== r.upstreamModel || r.basis !== 'token_rate' ||
          !nonnegative(r.inputMicroPerMillion) || !nonnegative(r.outputMicroPerMillion) || !nonnegative(r.fixedMicro ?? 0) ||
          !(r.inputMicroPerMillion || r.outputMicroPerMillion || r.fixedMicro)) return [];
      } else return [];
      const identity = JSON.stringify([r.model, r.endpoint, r.upstreamModel]);
      if (identities.has(identity)) return [];
      identities.add(identity);
    }
    return values;
  } catch { return []; }
}

/** Ceiling once on the combined token cost, without binary-float money math. */
export function supplierTokenCost(input: number, output: number, inputRate: number, outputRate: number, fixed = 0): number {
  if (![input, output, inputRate, outputRate, fixed].every(nonnegative)) throw unavailable();
  const amount = (BigInt(input) * BigInt(inputRate) + BigInt(output) * BigInt(outputRate) + 999999n) / 1000000n + BigInt(fixed);
  if (amount > BigInt(MAX_MONEY)) throw unavailable();
  return Number(amount);
}

/** A quote authorizes no spending. Its source and expiry must be configured by the operator. */
export function quoteSupplierCommitment(env: SupplierEnv, model: SupplierModel, maxOutput: number, now = seconds()): SupplierQuote {
  const rule = rules(env).find((r) => r.model === model.id && r.endpoint === model.endpoint && r.upstreamModel === (model.upstreamModel ?? model.id));
  if (!rule || rule.validUntil <= now || !positive(model.context) || !positive(maxOutput) || maxOutput > model.maxOutput) throw unavailable();
  const holdMicro = rule.basis === 'runtime_allowance' ? rule.holdMicro! : supplierTokenCost(model.context, maxOutput,
    rule.inputMicroPerMillion!, rule.outputMicroPerMillion!, rule.fixedMicro ?? 0);
  if (!positive(holdMicro)) throw unavailable();
  return { ...rule, holdMicro };
}

/** Batch this after the customer request INSERT; D1 rolls both back if either fails. */
export function supplierReservationStatement(env: SupplierEnv, id: string, quote: SupplierQuote, now: number): D1PreparedStatement {
  return env.DB.prepare(`INSERT INTO supplier_commitments(request_id, budget_id, provider, resource_id, model, basis,
    rate_revision, rate_source, valid_until, input_micro_per_million, output_micro_per_million, fixed_micro, hold_micro, created_at)
    VALUES(?, (SELECT id FROM supplier_budget_windows WHERE provider = ? AND enabled = 1 AND starts_at <= ? AND ends_at > ? ORDER BY starts_at DESC LIMIT 1),
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, quote.provider, now, now, quote.provider, quote.resourceId, quote.model, quote.basis, quote.revision, quote.source,
      quote.validUntil, quote.inputMicroPerMillion ?? 0, quote.outputMicroPerMillion ?? 0, quote.fixedMicro ?? 0, quote.holdMicro, now);
}

/** Must complete before the first health/warm/start/generation request. No retry may redispatch this ID. */
export async function markSupplierDispatched(env: SupplierEnv, id: string): Promise<void> {
  const now = seconds();
  const result = await env.DB.prepare(`UPDATE supplier_commitments SET state = 'dispatched', dispatched_at = ?
    WHERE request_id = ? AND state = 'reserved' AND valid_until > ?
      AND EXISTS (SELECT 1 FROM inference_requests WHERE id = ? AND status = 'running' AND lease_until > ?)
      AND EXISTS (SELECT 1 FROM supplier_budget_windows WHERE id = supplier_commitments.budget_id AND enabled = 1 AND starts_at <= ? AND ends_at > ?
        AND limit_micro >= reserved_micro + consumed_micro)`)
    .bind(now, id, now, id, now, now, now).run();
  if (result.meta.changes !== 1) throw unavailable();
}

/** Build settlement after reading immutable pricing. Include it in the customer settlement batch. */
export async function supplierSettlementStatements(env: SupplierEnv, id: string, usage: Usage, now: number, terminalUsage = false): Promise<D1PreparedStatement[]> {
  const row = await env.DB.prepare(`SELECT basis, hold_micro, input_micro_per_million, output_micro_per_million, fixed_micro
    FROM supplier_commitments WHERE request_id = ? AND state IN ('reserved', 'dispatched')`).bind(id).first<Commitment>();
  // A request admitted before this migration may still need customer settlement.
  if (!row) return [];
  let estimate: number | null = null;
  if (row.basis === 'token_rate' && usage) {
    try { estimate = supplierTokenCost(usage.input, usage.output, row.input_micro_per_million, row.output_micro_per_million, row.fixed_micro); }
    catch { /* Unrepresentable supplier usage remains unknown; retain the full allowance and settle the customer safely. */ }
  }
  // Intermediate counters only describe work seen so far. The supplier may
  // continue after a timeout/disconnect, so only a confirmed terminal meter
  // allows a token-priced hold to be reduced. Keep partial estimates separate.
  const expense = terminalUsage ? estimate ?? row.hold_micro : row.hold_micro;
  return [env.DB.prepare(`UPDATE supplier_commitments SET state = CASE WHEN state = 'reserved' THEN 'released' ELSE 'consumed' END,
    expense_micro = CASE WHEN state = 'reserved' THEN 0 ELSE ? END,
    estimated_cost_micro = CASE WHEN state = 'reserved' THEN NULL ELSE ? END, finished_at = ?
    WHERE request_id = ? AND state IN ('reserved', 'dispatched')
      AND EXISTS (SELECT 1 FROM inference_requests WHERE id = ? AND status != 'running')`)
    .bind(expense, estimate, now, id, id)];
}

/** Run before the customer reaper in the same batch. Unknown dispatched costs retain the full hold. */
export function reapSupplierCommitmentsStatement(env: SupplierEnv, now: number): D1PreparedStatement {
  return env.DB.prepare(`UPDATE supplier_commitments SET state = CASE WHEN state = 'reserved' THEN 'released' ELSE 'consumed' END,
    expense_micro = CASE WHEN state = 'reserved' THEN 0 ELSE hold_micro END, finished_at = ?
    WHERE state IN ('reserved', 'dispatched') AND request_id IN (
      SELECT id FROM inference_requests WHERE status = 'running' AND lease_until < ?)`)
    .bind(now, now);
}

/** Discovery only. Request admission still checks its actual reservation atomically. */
export async function supplierAvailability(env: SupplierEnv, models: SupplierModel[]): Promise<Record<string, { available: boolean; code: 'available' | 'supplier_unavailable' | 'supplier_budget_exhausted' }>> {
  const now = seconds();
  const result = await env.DB.prepare(`SELECT id, provider, limit_micro, reserved_micro, consumed_micro FROM supplier_budget_windows
    WHERE enabled = 1 AND starts_at <= ? AND ends_at > ? AND limit_micro > 0`).bind(now, now).all<Budget>();
  return Object.fromEntries(models.map((model) => {
    try {
      const quote = quoteSupplierCommitment(env, model, 1, now);
      const budget = result.results.find((b) => b.provider === quote.provider);
      if (!budget || ![budget.limit_micro, budget.reserved_micro, budget.consumed_micro].every(nonnegative)) return [model.id, { available: false, code: 'supplier_unavailable' as const }];
      const available = budget.limit_micro - budget.reserved_micro - budget.consumed_micro >= quote.holdMicro;
      return [model.id, { available, code: available ? 'available' as const : 'supplier_budget_exhausted' as const }];
    } catch { return [model.id, { available: false, code: 'supplier_unavailable' as const }]; }
  }));
}

// Confirmed customer credit funds a share of supplier allowance, in the same
// D1 batch as the credit itself. Each provider with a sellable model receives
// the share separately, so the share caps each provider, not their total.
const SHARE_SCALE = 1_000_000;
const AUTOMATIC_TERM = 30 * 86400;
const AUTOMATIC_REFERENCE = 'automatic: share of confirmed customer API credit';
// The window covering now, preferring an enabled one. A disabled window that
// covers now is the operator's pause: it still receives allowance, and no
// automatic window is opened beside it.
const TARGET = `target AS (SELECT w.id, w.limit_micro, w.reserved_micro, w.consumed_micro FROM supplier_budget_windows w, input
  WHERE w.provider = input.provider AND w.starts_at <= input.now AND w.ends_at > input.now ORDER BY w.enabled DESC, w.starts_at DESC LIMIT 1)`;
// What an ended window can pass on: its unspent allowance, counting reserved
// holds as spent, and never more than its customer-funded part.
const CARRYABLE = `MIN(w.limit_micro - w.reserved_micro - w.consumed_micro,
  (SELECT COALESCE(SUM(CASE WHEN a.window_id = w.id THEN a.amount_micro ELSE -a.amount_micro END), 0)
    FROM supplier_budget_adjustments a WHERE a.window_id = w.id OR a.from_window_id = w.id))`;

/** SUPPLIER_BUDGET_SHARE in parts per million, clamped to 0..1. Unset means
 * 0.9. A value that is not a plain decimal means 0, so a typo can only stop
 * automatic funding, never multiply it. */
export function supplierBudgetShare(env: Pick<SupplierEnv, 'SUPPLIER_BUDGET_SHARE'>): number {
  const raw = env.SUPPLIER_BUDGET_SHARE?.trim();
  if (!raw) return 900_000;
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw)) return 0;
  return Math.round(Math.min(1, Math.max(0, Number(raw))) * SHARE_SCALE);
}

/** Providers with a sellable model: enabled in the catalog, with a current cost rule. */
export function supplierBudgetProviders(env: SupplierEnv, models: SupplierModel[], now = seconds()): Provider[] {
  const found = new Set<Provider>();
  for (const model of models) {
    if (model.enabled === false) continue;
    try { found.add(quoteSupplierCommitment(env, model, 1, now).provider); } catch { /* not sellable */ }
  }
  return PROVIDERS.filter((provider) => found.has(provider));
}

/** Opens a rolling window when none covers now and there is allowance for it:
 * a new positive credit or a carry. It ends early where a later window starts,
 * so it cannot trip the overlap guard and abort the customer credit with it. */
function openWindowStatement(env: SupplierEnv, provider: Provider, now: number, ledgerId: string | null): D1PreparedStatement {
  return env.DB.prepare(`WITH input AS (SELECT ? AS provider, CAST(? AS INTEGER) AS now, ? AS ledger_id)
    INSERT INTO supplier_budget_windows(id, provider, starts_at, ends_at, limit_micro, enabled, funding_reference, updated_at)
    SELECT ?, input.provider, input.now, MIN(input.now + ${AUTOMATIC_TERM}, COALESCE((SELECT MIN(w.starts_at) FROM supplier_budget_windows w
        WHERE w.provider = input.provider AND w.starts_at > input.now), input.now + ${AUTOMATIC_TERM})), 0, 1, ?, input.now
    FROM input WHERE NOT EXISTS (SELECT 1 FROM supplier_budget_windows w WHERE w.provider = input.provider AND w.starts_at <= input.now AND w.ends_at > input.now)
      AND ((input.ledger_id IS NOT NULL AND EXISTS (SELECT 1 FROM api_ledger l WHERE l.id = input.ledger_id AND l.amount_micro > 0)
          AND NOT EXISTS (SELECT 1 FROM supplier_budget_adjustments a WHERE a.ledger_id = input.ledger_id AND a.provider = input.provider))
        OR EXISTS (SELECT 1 FROM supplier_budget_windows w WHERE w.provider = input.provider AND w.ends_at <= input.now AND ${CARRYABLE} > 0))`)
    .bind(provider, now, ledgerId, `auto-${provider}-${now}-${crypto.randomUUID().slice(0, 8)}`, AUTOMATIC_REFERENCE);
}

/** Customer-funded allowance outlives its window: whatever an ended window did
 * not spend moves into the current one. Operator funding still ends with its window. */
function carryStatement(env: SupplierEnv, provider: Provider, now: number): D1PreparedStatement {
  return env.DB.prepare(`WITH input AS (SELECT ? AS provider, CAST(? AS INTEGER) AS now, ? AS prefix), ${TARGET},
    ended AS (SELECT w.id, ${CARRYABLE} AS carry FROM supplier_budget_windows w, input WHERE w.provider = input.provider AND w.ends_at <= input.now)
    INSERT INTO supplier_budget_adjustments(id, kind, provider, window_id, from_window_id, requested_micro, amount_micro, created_at)
    SELECT input.prefix || ended.id, 'carry', input.provider, target.id, ended.id, ended.carry, ended.carry, input.now
    FROM input, target, ended WHERE ended.carry > 0`)
    .bind(provider, now, `carry:${crypto.randomUUID()}:`);
}

function sweepStatements(env: SupplierEnv, provider: Provider, now: number, ledgerId: string | null): D1PreparedStatement[] {
  return [openWindowStatement(env, provider, now, ledgerId), carryStatement(env, provider, now)];
}

function creditStatement(env: SupplierEnv, provider: Provider, change: CustomerCreditChange, share: number, now: number): D1PreparedStatement {
  return env.DB.prepare(`WITH input AS (SELECT ? AS provider, CAST(? AS INTEGER) AS now, ? AS ledger_id, ? AS source, CAST(? AS INTEGER) AS share_ppm), ${TARGET}
    INSERT INTO supplier_budget_adjustments(id, kind, provider, window_id, ledger_id, source, customer_micro, share_ppm, requested_micro, amount_micro, created_at)
    SELECT l.id || ':' || input.provider, 'customer_credit', input.provider, target.id, l.id, input.source, l.amount_micro, input.share_ppm,
      l.amount_micro * input.share_ppm / ${SHARE_SCALE}, CASE WHEN target.id IS NULL THEN 0 ELSE l.amount_micro * input.share_ppm / ${SHARE_SCALE} END, input.now
    FROM input JOIN api_ledger l ON l.id = input.ledger_id LEFT JOIN target ON 1 = 1
    WHERE l.amount_micro > 0
    ON CONFLICT DO NOTHING`).bind(provider, now, change.ledgerId, change.source, share);
}

/** Removes the share this payment added, at the share it was added with. It
 * never removes more than the payment added in total, and never takes a
 * window below the allowance already reserved or consumed. */
function removalStatement(env: SupplierEnv, provider: Provider, change: CustomerCreditChange, now: number): D1PreparedStatement {
  return env.DB.prepare(`WITH input AS (SELECT ? AS provider, CAST(? AS INTEGER) AS now, ? AS ledger_id, ? AS source), ${TARGET},
    paid AS (SELECT
      (SELECT a.share_ppm FROM supplier_budget_adjustments a WHERE a.source = input.source AND a.provider = input.provider
        AND a.kind = 'customer_credit' AND a.customer_micro > 0 ORDER BY a.created_at, a.id LIMIT 1) AS share_ppm,
      (SELECT COALESCE(SUM(a.amount_micro), 0) FROM supplier_budget_adjustments a WHERE a.source = input.source AND a.provider = input.provider
        AND a.kind = 'customer_credit') AS net FROM input),
    removal AS (SELECT l.id, l.amount_micro, paid.share_ppm, MAX(0, MIN(-l.amount_micro * paid.share_ppm / ${SHARE_SCALE}, paid.net)) AS micro
      FROM input JOIN api_ledger l ON l.id = input.ledger_id, paid WHERE l.amount_micro < 0 AND paid.share_ppm IS NOT NULL)
    INSERT INTO supplier_budget_adjustments(id, kind, provider, window_id, ledger_id, source, customer_micro, share_ppm, requested_micro, amount_micro, created_at)
    SELECT removal.id || ':' || input.provider, 'customer_credit', input.provider, target.id, removal.id, input.source, removal.amount_micro, removal.share_ppm,
      -removal.micro, -MIN(removal.micro, COALESCE(MAX(0, target.limit_micro - target.reserved_micro - target.consumed_micro), 0)), input.now
    FROM input, removal LEFT JOIN target ON 1 = 1
    WHERE true
    ON CONFLICT DO NOTHING`).bind(provider, now, change.ledgerId, change.source);
}

export interface CustomerCreditChange {
  /** The api_ledger id that the credit's trigger posts in the same batch. */
  ledgerId: string;
  /** The payment the credit belongs to: 'topup:<id>' or 'monthly:<invoice>'. */
  source: string;
  /** New minus old credited amount, as the caller is about to write it. */
  deltaMicro: number;
}

/** Batch these after the UPDATE whose trigger posts `change.ledgerId`. They
 * read that ledger row, so an UPDATE that lost its revision race or changed
 * no credit adds nothing, and UNIQUE(ledger_id, provider) makes a replayed
 * event or resync a no-op. A share of 0 stops new funding and new windows;
 * refunds still remove what earlier payments added. */
export function supplierBudgetCreditStatements(env: SupplierEnv, models: SupplierModel[], change: CustomerCreditChange, now = seconds()): D1PreparedStatement[] {
  if (!Number.isSafeInteger(change.deltaMicro) || change.deltaMicro === 0) return [];
  const share = supplierBudgetShare(env);
  const funded = share > 0 ? supplierBudgetProviders(env, models, now) : [];
  return PROVIDERS.flatMap((provider) => {
    const statements = funded.includes(provider) ? sweepStatements(env, provider, now, change.deltaMicro > 0 ? change.ledgerId : null) : [];
    if (change.deltaMicro > 0 && funded.includes(provider)) statements.push(creditStatement(env, provider, change, share, now));
    if (change.deltaMicro < 0) statements.push(removalStatement(env, provider, change, now));
    return statements;
  });
}

/** Moves unspent customer-funded allowance out of ended windows, opening a
 * current window when there is any to move. Returns the rows written. */
export async function sweepSupplierBudgets(env: SupplierEnv, providers: readonly Provider[], now = seconds()): Promise<number> {
  if (!supplierBudgetShare(env) || !providers.length) return 0;
  const results = await env.DB.batch(providers.flatMap((provider) => sweepStatements(env, provider, now, null)));
  return results.reduce((total, result) => total + (result.meta.changes ?? 0), 0);
}

interface BillingRecord { startTime: string; endTime: string; serverlessId: string; totalAmount: number; gpuAmount: number; cpuAmount: number; diskAmount: number }
function dollarMicro(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('Invalid supplier billing amount');
  const micro = Math.round(value * 1000000);
  if (!nonnegative(micro)) throw new Error('Invalid supplier billing amount');
  return micro;
}

/** Read-only at RunPod. Imports exact endpoint/hour totals; no worker requests or funding calls. */
export async function reconcileRunpodBilling(env: SupplierEnv, window: { start: number; end: number; resourceIds: string[] }): Promise<{ resources: number; records: number }> {
  if (!env.RUNPOD_API_KEY || !Number.isSafeInteger(window.start) || !Number.isSafeInteger(window.end) || window.start < 0 ||
    window.end <= window.start || window.start % 3600 || window.end % 3600 || window.end - window.start > 7 * 86400 ||
    !Array.isArray(window.resourceIds) || !window.resourceIds.length || window.resourceIds.length > 64 ||
    new Set(window.resourceIds).size !== window.resourceIds.length || window.resourceIds.some((id) => !/^[a-z0-9]+$/.test(id))) throw new Error('Invalid supplier billing window');
  const fetched = seconds();
  const url = new URL('https://api.runpod.io/v2/billing/serverless');
  url.searchParams.set('bucketSize', 'hour');
  url.searchParams.set('startTime', new Date(window.start * 1000).toISOString());
  url.searchParams.set('endTime', new Date(window.end * 1000).toISOString());
  const response = await fetch(url, { headers: { Authorization: `Bearer ${env.RUNPOD_API_KEY}` }, redirect: 'manual', signal: AbortSignal.timeout(15000) });
  if (!response.ok) { await response.body?.cancel(); throw new Error('Supplier billing unavailable'); }
  const payload = JSON.parse(await boundedBody(response, 8 * 1024 * 1024)) as { records?: BillingRecord[]; metadata?: { query?: { startTime?: string; endTime?: string; bucketSize?: string; serverlessId?: string | null }; recordCount?: number } };
  const query = payload.metadata?.query;
  if (!Array.isArray(payload.records) || payload.records.length > 24000 || payload.metadata?.recordCount !== payload.records.length ||
    !query || Date.parse(query.startTime ?? '') / 1000 !== window.start || Date.parse(query.endTime ?? '') / 1000 !== window.end ||
    query.bucketSize !== 'hour' || query.serverlessId != null) throw new Error('Invalid supplier billing response');
  const seen = new Set<string>();
  const allowed = new Set(window.resourceIds);
  const normalized: Array<{ resourceId: string; start: number; end: number; total: number; gpu: number; cpu: number; disk: number; hash: string }> = [];
  for (const record of payload.records) {
    const start = Date.parse(record.startTime) / 1000;
    const end = Date.parse(record.endTime) / 1000;
    const identity = `${record.serverlessId}:${start}`;
    if (!/^[a-z0-9]+$/.test(record.serverlessId) || !Number.isSafeInteger(start) || start % 3600 || start < window.start ||
      end !== start + 3600 || end > window.end || seen.has(identity)) throw new Error('Invalid supplier billing record');
    seen.add(identity);
    const [total, gpu, cpu, disk] = [record.totalAmount, record.gpuAmount, record.cpuAmount, record.diskAmount].map(dollarMicro);
    // Billing may include other projects in the account. Never attribute them
    // to this product merely because they share the same RunPod API key.
    if (!allowed.has(record.serverlessId)) continue;
    const hash = await sha256(JSON.stringify([start, end, record.serverlessId, total, gpu, cpu, disk]));
    normalized.push({ resourceId: record.serverlessId, start, end, total, gpu, cpu, disk, hash });
  }
  const recordsJson = JSON.stringify(normalized);
  const resourcesJson = JSON.stringify(window.resourceIds);
  const omittedHash = await sha256(JSON.stringify(['omitted-from-complete-window', window.resourceIds, window.start, window.end]));
  // Three set-based statements cover all endpoints/hours. This avoids one D1
  // query per hour and stays below the free-plan per-invocation query limit.
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO supplier_billing_buckets(provider, resource_type, resource_id, bucket_start, bucket_end,
      total_micro, gpu_micro, cpu_micro, disk_micro, fetched_at, source_hash)
      SELECT 'runpod', 'serverless', json_extract(value, '$.resourceId'), json_extract(value, '$.start'), json_extract(value, '$.end'),
        json_extract(value, '$.total'), json_extract(value, '$.gpu'), json_extract(value, '$.cpu'), json_extract(value, '$.disk'), ?, json_extract(value, '$.hash')
      FROM json_each(?) WHERE true
      ON CONFLICT(provider, resource_type, resource_id, bucket_start, bucket_end) DO UPDATE SET
        total_micro = excluded.total_micro, gpu_micro = excluded.gpu_micro, cpu_micro = excluded.cpu_micro, disk_micro = excluded.disk_micro,
        fetched_at = excluded.fetched_at, source_hash = excluded.source_hash,
        revision = supplier_billing_buckets.revision + CASE WHEN supplier_billing_buckets.source_hash != excluded.source_hash THEN 1 ELSE 0 END
      WHERE excluded.fetched_at >= supplier_billing_buckets.fetched_at`).bind(fetched, recordsJson),
    // A complete snapshot may correct a previously billed hour by omitting it.
    // Preserve the record and increase its revision instead of deleting it.
    env.DB.prepare(`UPDATE supplier_billing_buckets SET total_micro = 0, gpu_micro = 0, cpu_micro = 0, disk_micro = 0,
      fetched_at = ?, source_hash = ?, revision = revision + CASE WHEN total_micro != 0 OR gpu_micro != 0 OR cpu_micro != 0 OR disk_micro != 0 THEN 1 ELSE 0 END
      WHERE provider = 'runpod' AND resource_type = 'serverless' AND resource_id IN (SELECT value FROM json_each(?))
        AND bucket_start >= ? AND bucket_end <= ? AND fetched_at <= ?
        AND NOT EXISTS (SELECT 1 FROM json_each(?) AS present WHERE json_extract(present.value, '$.resourceId') = supplier_billing_buckets.resource_id
          AND json_extract(present.value, '$.start') = supplier_billing_buckets.bucket_start)`)
      .bind(fetched, omittedHash, resourcesJson, window.start, window.end, fetched, recordsJson),
    env.DB.prepare(`INSERT INTO supplier_billing_syncs(provider, resource_type, resource_id, window_start, window_end, fetched_at, record_count)
      SELECT 'runpod', 'serverless', resource.value, ?, ?, ?,
        (SELECT COUNT(*) FROM json_each(?) AS record WHERE json_extract(record.value, '$.resourceId') = resource.value)
      FROM json_each(?) AS resource WHERE true
      ON CONFLICT(provider, resource_type, resource_id, window_start, window_end)
      DO UPDATE SET fetched_at = excluded.fetched_at, record_count = excluded.record_count WHERE excluded.fetched_at >= supplier_billing_syncs.fetched_at`)
      .bind(window.start, window.end, fetched, recordsJson, resourcesJson),
  ]);
  return { resources: window.resourceIds.length, records: normalized.length };
}

/** Operator-only data. Quotes/allowances and actual vendor costs are never summed as if both were expenses. */
export async function supplierOperatingReport(env: SupplierEnv, start: number, end: number): Promise<Record<string, unknown>> {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) throw new Error('Invalid operating report window');
  const [budgets, adjustments, commitments, costs, syncs, revenue, wallets] = await Promise.all([
    env.DB.prepare('SELECT * FROM supplier_budget_windows ORDER BY provider, starts_at').all(),
    env.DB.prepare(`SELECT provider, kind, COUNT(*) AS entries, SUM(CASE WHEN amount_micro > 0 THEN amount_micro ELSE 0 END) AS added_micro,
      SUM(CASE WHEN amount_micro < 0 THEN -amount_micro ELSE 0 END) AS removed_micro
      FROM supplier_budget_adjustments WHERE created_at >= ? AND created_at < ? GROUP BY provider, kind ORDER BY provider, kind`).bind(start, end).all(),
    env.DB.prepare(`SELECT provider, resource_id, basis, state, COUNT(*) AS requests, SUM(hold_micro) AS allowance_micro,
      SUM(expense_micro) AS consumed_allowance_micro, SUM(estimated_cost_micro) AS estimated_cost_micro
      FROM supplier_commitments WHERE created_at >= ? AND created_at < ? GROUP BY provider, resource_id, basis, state`).bind(start, end).all(),
    env.DB.prepare(`SELECT provider, resource_type, resource_id, SUM(total_micro) AS actual_cost_micro, MIN(bucket_start) AS first_bucket,
      MAX(bucket_end) AS last_bucket, MIN(fetched_at) AS oldest_read FROM supplier_billing_buckets
      WHERE bucket_start >= ? AND bucket_end <= ? GROUP BY provider, resource_type, resource_id`).bind(start, end).all(),
    env.DB.prepare(`SELECT * FROM supplier_billing_syncs WHERE window_start <= ? AND window_end >= ? ORDER BY fetched_at DESC`).bind(start, end).all(),
    env.DB.prepare(`SELECT COALESCE(-SUM(amount_micro), 0) AS usage_revenue_micro FROM api_ledger WHERE kind = 'usage' AND created_at >= ? AND created_at < ?`).bind(start, end).first(),
    env.DB.prepare(`SELECT COALESCE(SUM(MAX(balance_micro, 0)), 0) AS customer_credit_liability_micro,
      COALESCE(SUM(MAX(-balance_micro, 0)), 0) AS customer_deficit_micro,
      COALESCE(SUM(reserved_micro), 0) AS customer_reserved_micro FROM api_wallets`).first(),
  ]);
  return { currency: 'usd', unit: 'microdollar', start, end, budgets: budgets.results, budget_adjustments: adjustments.results, commitments: commitments.results,
    actual_supplier_costs: costs.results, successful_billing_reads: syncs.results, revenue, current_customer_wallets: wallets,
    stripe_fees_micro: null, net_profit_micro: null, owner_withdrawable_micro: null,
    note: 'Allowances cap admitted commitments, not actual vendor bills. Missing reconciliation and payment fees remain unknown. Customer credit is a service liability.' };
}
