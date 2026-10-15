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
const DEFAULT_SHARE = 900_000;
const SHARE_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const AUTOMATIC_TERM = 30 * 86400;
const AUTOMATIC_REFERENCE = 'automatic: share of confirmed customer API credit';
// The window covering now, preferring an enabled one. Disabling the window
// that covers now is the operator's pause: it still receives allowance, and no
// automatic window is opened beside it. A separate disabled window beside an
// enabled one pauses nothing, since the enabled one is preferred here too.
const TARGET = `target AS (SELECT w.id, w.limit_micro, w.reserved_micro, w.consumed_micro FROM supplier_budget_windows w, input
  WHERE w.provider = input.provider AND w.starts_at <= input.now AND w.ends_at > input.now ORDER BY w.enabled DESC, w.starts_at DESC LIMIT 1)`;
// The customer-funded allowance a window can still give up, to a carry or a
// refund: its unspent allowance, counting reserved holds as spent, and never
// more than its customer-funded part. Spending uses operator funding first.
const CARRYABLE = `MIN(w.limit_micro - w.reserved_micro - w.consumed_micro,
  (SELECT COALESCE(SUM(CASE WHEN a.window_id = w.id THEN a.amount_micro ELSE -a.amount_micro END), 0)
    FROM supplier_budget_adjustments a WHERE a.window_id = w.id OR a.from_window_id = w.id))`;
// What this payment has given this provider so far: the share its first credit
// used, and the allowance it still funds after any removals.
const PAID = `paid AS (SELECT
    (SELECT a.share_ppm FROM supplier_budget_adjustments a WHERE a.source = input.source AND a.provider = input.provider
      AND a.kind = 'customer_credit' AND a.customer_micro > 0 ORDER BY a.rowid LIMIT 1) AS share_ppm,
    (SELECT COALESCE(SUM(a.amount_micro), 0) FROM supplier_budget_adjustments a WHERE a.source = input.source AND a.provider = input.provider
      AND a.kind = 'customer_credit') AS net FROM input)`;
// A ledger entry is applied once per provider. A replay, or a batch that lost
// its revision race and reads the winner's entry, finds its rows and adds none.
const UNAPPLIED = 'NOT EXISTS (SELECT 1 FROM supplier_budget_adjustments a WHERE a.ledger_id = input.ledger_id AND a.provider = input.provider)';
// The allowance one positive ledger entry adds. A payment's first credit adds
// the current share. A later one (a dispute won after a removal) only gives
// back what removals actually took: at the payment's original share, and never
// beyond that share of what the payment is credited now. A payment that funded
// this provider nothing the first time gets nothing back. The payment's ledger
// ids are '<source>:<revision>', so they sort between '<source>:' and '<source>;'.
const GAIN = `${PAID},
  history AS (SELECT
    (SELECT COUNT(*) FROM api_ledger h WHERE h.id > input.source || ':' AND h.id < input.source || ';'
      AND h.id != input.ledger_id AND h.amount_micro > 0) AS earlier,
    (SELECT COALESCE(SUM(h.amount_micro), 0) FROM api_ledger h WHERE h.id > input.source || ':' AND h.id < input.source || ';') AS credited
    FROM input),
  gain AS (SELECT l.id, l.amount_micro, CASE WHEN history.earlier = 0 THEN input.share_ppm ELSE paid.share_ppm END AS share_ppm,
      l.amount_micro * (CASE WHEN history.earlier = 0 THEN input.share_ppm ELSE paid.share_ppm END) / ${SHARE_SCALE} AS requested,
      CASE WHEN history.earlier = 0 THEN l.amount_micro * input.share_ppm / ${SHARE_SCALE}
        ELSE MIN(l.amount_micro * paid.share_ppm / ${SHARE_SCALE}, MAX(0, history.credited * paid.share_ppm / ${SHARE_SCALE} - paid.net)) END AS micro
    FROM input JOIN api_ledger l ON l.id = input.ledger_id, history, paid
    WHERE l.amount_micro > 0 AND (history.earlier = 0 OR paid.share_ppm IS NOT NULL) AND ${UNAPPLIED})`;

/** SUPPLIER_BUDGET_SHARE in parts per million, clamped to 0..1. Unset means
 * 0.9. A value that is not a plain decimal means 0, so a typo can only stop
 * automatic funding, never multiply it. */
export function supplierBudgetShare(env: Pick<SupplierEnv, 'SUPPLIER_BUDGET_SHARE'>): number {
  const raw = env.SUPPLIER_BUDGET_SHARE?.trim();
  if (!raw) return DEFAULT_SHARE;
  if (!SHARE_PATTERN.test(raw)) return 0;
  return Math.round(Math.min(1, Math.max(0, Number(raw))) * SHARE_SCALE);
}

/** Why SUPPLIER_BUDGET_SHARE is not used as written, or null when it is (or is unset). */
export function supplierBudgetShareProblem(env: Pick<SupplierEnv, 'SUPPLIER_BUDGET_SHARE'>): 'unreadable' | 'out_of_range' | null {
  const raw = env.SUPPLIER_BUDGET_SHARE?.trim();
  if (!raw) return null;
  if (!SHARE_PATTERN.test(raw)) return 'unreadable';
  const value = Number(raw);
  return value < 0 || value > 1 ? 'out_of_range' : null;
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

/** Sellable models whose price funds less allowance, at the configured share,
 * than their requests use. A runtime allowance uses its whole hold however
 * little the customer pays, so the share of the minimum price must cover the
 * hold. A token rate needs the share of each customer rate to cover the
 * supplier's. Funding from such sales falls behind spending: the budget runs
 * out and the model is unavailable while customers still hold credit. */
export function supplierShareShortfalls(env: SupplierEnv, models: Array<SupplierModel & { minimumMicro: number; inputRate: number; outputRate: number }>, now = seconds()): string[] {
  const share = supplierBudgetShare(env);
  if (!share) return [];
  const funded = (micro: number) => Math.floor(micro * share / SHARE_SCALE);
  return models.filter((model) => {
    if (model.enabled === false) return false;
    let quote: SupplierQuote;
    try { quote = quoteSupplierCommitment(env, model, 1, now); } catch { return false; }
    if (quote.basis === 'runtime_allowance') return funded(model.minimumMicro) < quote.holdMicro;
    // Customer rates are whole US dollars per million tokens; supplier rates are microdollars per million.
    return funded(model.inputRate * SHARE_SCALE) < (quote.inputMicroPerMillion ?? 0) || funded(model.outputRate * SHARE_SCALE) < (quote.outputMicroPerMillion ?? 0);
  }).map((model) => model.id);
}

/** Models held back only by supplier allowance that a payment of `creditMicro`
 * would itself restore. Each has a current cost rule, automatic funding is on,
 * and its provider either has an enabled current window without room for one
 * request, or no current window after earlier ones ended. A disabled window
 * covering now (the operator's pause) and a provider that was never funded do
 * not count: neither is fixed by a customer payment. */
export async function supplierBudgetRefillable(env: SupplierEnv, models: SupplierModel[], creditMicro: number, now = seconds()): Promise<Set<string>> {
  const found = new Set<string>();
  const share = supplierBudgetShare(env);
  if (!share || !models.length) return found;
  const result = await env.DB.prepare(`SELECT provider, enabled, ends_at > ? AS is_current, limit_micro, reserved_micro, consumed_micro
    FROM supplier_budget_windows WHERE starts_at <= ?`).bind(now, now)
    .all<{ provider: Provider; enabled: number; is_current: number; limit_micro: number; reserved_micro: number; consumed_micro: number }>();
  for (const model of models) {
    if (model.enabled === false) continue;
    let quote: SupplierQuote;
    try { quote = quoteSupplierCommitment(env, model, 1, now); } catch { continue; }
    const windows = result.results.filter((w) => w.provider === quote.provider);
    const current = windows.filter((w) => w.is_current);
    const open = current.find((w) => w.enabled === 1);
    if (!open && (current.length || !windows.length)) continue;
    const room = open ? Math.max(0, open.limit_micro - open.reserved_micro - open.consumed_micro) : 0;
    if (room < quote.holdMicro && room + Math.floor(creditMicro * share / SHARE_SCALE) >= quote.holdMicro) found.add(model.id);
  }
  return found;
}

/** Opens a rolling window when none covers now and there is allowance for it:
 * a credit that adds some, or a carry. It ends early where a later window
 * starts, so it cannot trip the overlap guard and abort the customer credit. */
function openWindowStatement(env: SupplierEnv, provider: Provider, now: number, change: CustomerCreditChange | null, share: number): D1PreparedStatement {
  return env.DB.prepare(`WITH input AS (SELECT ? AS provider, CAST(? AS INTEGER) AS now, ? AS ledger_id, ? AS source, CAST(? AS INTEGER) AS share_ppm), ${GAIN}
    INSERT INTO supplier_budget_windows(id, provider, starts_at, ends_at, limit_micro, enabled, funding_reference, updated_at)
    SELECT ?, input.provider, input.now, MIN(input.now + ${AUTOMATIC_TERM}, COALESCE((SELECT MIN(w.starts_at) FROM supplier_budget_windows w
        WHERE w.provider = input.provider AND w.starts_at > input.now), input.now + ${AUTOMATIC_TERM})), 0, 1, ?, input.now
    FROM input WHERE NOT EXISTS (SELECT 1 FROM supplier_budget_windows w WHERE w.provider = input.provider AND w.starts_at <= input.now AND w.ends_at > input.now)
      AND (EXISTS (SELECT 1 FROM gain WHERE gain.micro > 0)
        OR EXISTS (SELECT 1 FROM supplier_budget_windows w WHERE w.provider = input.provider AND w.ends_at <= input.now AND ${CARRYABLE} > 0))`)
    .bind(provider, now, change?.ledgerId ?? null, change?.source ?? null, share, `auto-${provider}-${now}-${crypto.randomUUID().slice(0, 8)}`, AUTOMATIC_REFERENCE);
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

function sweepStatements(env: SupplierEnv, provider: Provider, now: number, change: CustomerCreditChange | null, share: number): D1PreparedStatement[] {
  return [openWindowStatement(env, provider, now, change, share), carryStatement(env, provider, now)];
}

function creditStatement(env: SupplierEnv, provider: Provider, change: CustomerCreditChange, share: number, now: number): D1PreparedStatement {
  return env.DB.prepare(`WITH input AS (SELECT ? AS provider, CAST(? AS INTEGER) AS now, ? AS ledger_id, ? AS source, CAST(? AS INTEGER) AS share_ppm), ${TARGET}, ${GAIN}
    INSERT INTO supplier_budget_adjustments(id, kind, provider, window_id, ledger_id, source, customer_micro, share_ppm, requested_micro, amount_micro, created_at)
    SELECT gain.id || ':' || input.provider, 'customer_credit', input.provider, target.id, gain.id, input.source, gain.amount_micro, gain.share_ppm,
      gain.requested, CASE WHEN target.id IS NULL THEN 0 ELSE gain.micro END, input.now
    FROM input, gain LEFT JOIN target ON 1 = 1
    WHERE true
    ON CONFLICT DO NOTHING`).bind(provider, now, change.ledgerId, change.source, share);
}

/** Removes the share this payment added, at the share it was added with,
 * whatever the share is now and whether or not the provider still sells. It
 * never removes more than the payment still funds, and never takes a window
 * below the allowance already reserved or consumed, nor below its operator
 * funding. The allowance is taken wherever customer funding still sits,
 * ended windows first, so a later carry cannot bring refunded allowance back:
 * one row per window it is taken from, or one row of 0 when there is none. */
function removalStatement(env: SupplierEnv, provider: Provider, change: CustomerCreditChange, now: number): D1PreparedStatement {
  return env.DB.prepare(`WITH input AS (SELECT ? AS provider, CAST(? AS INTEGER) AS now, ? AS ledger_id, ? AS source), ${PAID},
    removal AS (SELECT l.id, l.amount_micro, paid.share_ppm, MAX(0, MIN(-l.amount_micro * paid.share_ppm / ${SHARE_SCALE}, paid.net)) AS micro
      FROM input JOIN api_ledger l ON l.id = input.ledger_id, paid WHERE l.amount_micro < 0 AND paid.share_ppm IS NOT NULL AND ${UNAPPLIED}),
    holding AS (SELECT w.id, w.starts_at, w.starts_at <= input.now AND w.ends_at > input.now AS covering, ${CARRYABLE} AS room
      FROM supplier_budget_windows w, input WHERE w.provider = input.provider),
    ranked AS (SELECT id, room, ROW_NUMBER() OVER (ORDER BY covering, starts_at, id) AS n,
        COALESCE(SUM(room) OVER (ORDER BY covering, starts_at, id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS prior
      FROM holding WHERE room > 0),
    taken AS (SELECT ranked.id AS window_id, ranked.n, MIN(ranked.room, removal.micro - ranked.prior) AS micro
      FROM ranked, removal WHERE removal.micro > ranked.prior),
    parts AS (SELECT window_id, n, micro FROM taken UNION ALL SELECT NULL, 1, 0 WHERE NOT EXISTS (SELECT 1 FROM taken))
    INSERT INTO supplier_budget_adjustments(id, kind, provider, window_id, ledger_id, source, customer_micro, share_ppm, requested_micro, amount_micro, created_at)
    SELECT removal.id || ':' || input.provider || CASE WHEN parts.n = 1 THEN '' ELSE ':' || parts.n END, 'customer_credit', input.provider, parts.window_id,
      removal.id, input.source, removal.amount_micro, removal.share_ppm, -removal.micro, -parts.micro, input.now
    FROM input, removal, parts
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
 * no credit adds nothing, and an entry already applied is never applied again.
 * A share of 0 stops new funding, new windows and carries; refunds still
 * remove what earlier payments added, wherever it sits. */
export function supplierBudgetCreditStatements(env: SupplierEnv, models: SupplierModel[], change: CustomerCreditChange, now = seconds()): D1PreparedStatement[] {
  if (!Number.isSafeInteger(change.deltaMicro) || change.deltaMicro === 0) return [];
  const share = supplierBudgetShare(env);
  const funded = share > 0 ? supplierBudgetProviders(env, models, now) : [];
  return PROVIDERS.flatMap((provider) => {
    // Only a credit sweeps. A removal already takes from ended windows, so
    // sweeping first would carry the allowance into a window it then empties,
    // leaving an automatic window of 0 that blocks an overlapping one for 30 days.
    const statements = change.deltaMicro > 0 && funded.includes(provider)
      ? [...sweepStatements(env, provider, now, change, share), creditStatement(env, provider, change, share, now)] : [];
    if (change.deltaMicro < 0) statements.push(removalStatement(env, provider, change, now));
    return statements;
  });
}

/** Moves unspent customer-funded allowance out of ended windows, opening a
 * current window when there is any to move. Returns the rows written. */
export async function sweepSupplierBudgets(env: SupplierEnv, providers: readonly Provider[], now = seconds()): Promise<number> {
  const share = supplierBudgetShare(env);
  if (!share || !providers.length) return 0;
  const results = await env.DB.batch(providers.flatMap((provider) => sweepStatements(env, provider, now, null, share)));
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
    env.DB.prepare(`SELECT provider, kind, COUNT(DISTINCT COALESCE(ledger_id, id)) AS entries, SUM(CASE WHEN amount_micro > 0 THEN amount_micro ELSE 0 END) AS added_micro,
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
