// Supplier allowance is business capital, never a customer's wallet balance.
// Runtime allowances limit admitted commitments; only vendor billing is actual
// compute cost. An HTTP cancellation does not prove a GPU stopped billing.
import { sha256 } from './crypto.ts';
import { seconds } from './env.ts';
import type { Env } from './env.ts';
import { ApiError } from './http.ts';
import { boundedBody } from '../public/review-core.mjs';

type Provider = 'runpod' | 'infron' | 'orcarouter';
type SupplierEnv = Pick<Env, 'DB'> & { SUPPLIER_COST_RULES?: string; RUNPOD_API_KEY?: string };
export interface SupplierModel {
  id: string; context: number; maxOutput: number; endpoint?: string; upstreamModel?: string;
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
  const [budgets, commitments, costs, syncs, revenue, wallets] = await Promise.all([
    env.DB.prepare('SELECT * FROM supplier_budget_windows ORDER BY provider, starts_at').all(),
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
  return { currency: 'usd', unit: 'microdollar', start, end, budgets: budgets.results, commitments: commitments.results,
    actual_supplier_costs: costs.results, successful_billing_reads: syncs.results, revenue, current_customer_wallets: wallets,
    stripe_fees_micro: null, net_profit_micro: null, owner_withdrawable_micro: null,
    note: 'Allowances cap admitted commitments, not actual vendor bills. Missing reconciliation and payment fees remain unknown. Customer credit is a service liability.' };
}
