// API keys authorize inference only. They cannot manage the account or buy credit.
import { randomToken, sha256 } from './crypto.ts';
import { seconds } from './env.ts';
import type { Call, Env } from './env.ts';
import type { Session } from './auth.ts';
import { ApiError, json, readJson } from './http.ts';

export const MICRO_USD = 1_000_000;
export const TOPUP_USD = [20, 50, 100] as const;
export interface InferenceKey { id: string; account_id: string; budget_micro: number; spent_micro: number; reserved_micro: number }
export interface MeteredModel { id: string; inputRate: number; outputRate: number; minimumMicro: number; context: number; maxOutput: number }

export async function apiCreditData(env: Env, accountId: string, full = false): Promise<Record<string, unknown>> {
  const [wallet, keys, ledger, requests, topups] = await Promise.all([
    env.DB.prepare('SELECT balance_micro, reserved_micro FROM api_wallets WHERE account_id = ?').bind(accountId).first<{ balance_micro: number; reserved_micro: number }>(),
    env.DB.prepare('SELECT id, prefix, label, budget_micro, spent_micro, reserved_micro, created_at, expires, last_used, revoked_at FROM inference_keys WHERE account_id = ? ORDER BY created_at DESC').bind(accountId).all(),
    env.DB.prepare(`SELECT id, amount_micro, kind, reference, created_at FROM api_ledger WHERE account_id = ? ORDER BY created_at DESC${full ? '' : ' LIMIT 50'}`).bind(accountId).all(),
    env.DB.prepare(`SELECT id, key_id, model, status, charge_micro, input_tokens, output_tokens, created_at, finished_at, failure_code FROM inference_requests WHERE account_id = ? ORDER BY created_at DESC${full ? '' : ' LIMIT 50'}`).bind(accountId).all(),
    env.DB.prepare(`SELECT id, amount_micro, credited_micro, status, created_at FROM api_topups WHERE account_id = ? ORDER BY created_at DESC${full ? '' : ' LIMIT 20'}`).bind(accountId).all(),
  ]);
  const balance = wallet?.balance_micro ?? 0;
  const reserved = wallet?.reserved_micro ?? 0;
  return { currency: 'usd', unit: 'microdollar', balance_micro: balance, reserved_micro: reserved, available_micro: Math.max(0, balance - reserved), keys: keys.results, ledger: ledger.results, requests: requests.results, topups: topups.results };
}

export async function createInferenceKey({ env, request }: Call, session: Session): Promise<Response> {
  const body = await readJson(request, 2000);
  const label = typeof body.label === 'string' ? body.label.trim() : '';
  if (!label || label.length > 60 || /[\x00-\x1f]/.test(label)) throw new ApiError('Give this key a name of 1–60 characters.');
  const budget = body.budget_usd;
  if (typeof budget !== 'number' || !Number.isInteger(budget) || budget < 1 || budget > 1000) throw new ApiError('Choose a whole-dollar key limit between $1 and $1,000.');
  const days = body.expires_days ?? 90;
  if (![7, 30, 90, 365].includes(Number(days))) throw new ApiError('Choose a key expiry of 7, 30, 90 or 365 days.');
  const now = seconds();
  const token = `bo_api_${randomToken()}`;
  const id = crypto.randomUUID();
  const result = await env.DB.prepare(`INSERT INTO inference_keys(id, account_id, token_hash, prefix, label, budget_micro, created_at, expires)
    SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM inference_keys WHERE account_id = ? AND revoked_at IS NULL AND expires > ?) < 10`)
    .bind(id, session.account_id, await sha256(token), token.slice(0, 15), label, budget * MICRO_USD, now, now + Number(days) * 86400, session.account_id, now).run();
  if (!result.meta.changes) throw new ApiError('You can have up to 10 active API keys. Revoke one first.', 409, 'key_limit');
  return json({ id, key: token, expires: now + Number(days) * 86400, budget_usd: budget }, 201);
}

export async function revokeInferenceKey({ env, request }: Call, session: Session): Promise<Response> {
  const body = await readJson(request, 500);
  if (typeof body.id !== 'string') throw new ApiError('Choose an API key.');
  await env.DB.prepare('UPDATE inference_keys SET revoked_at = ? WHERE id = ? AND account_id = ? AND revoked_at IS NULL').bind(seconds(), body.id, session.account_id).run();
  return json({ revoked: true });
}

export async function authenticateInference({ env, request }: Call): Promise<InferenceKey> {
  const auth = request.headers.get('authorization') ?? '';
  if (!/^Bearer bo_api_[A-Za-z0-9_-]{43}$/.test(auth)) throw new ApiError('Supply an API key as a Bearer token.', 401, 'invalid_api_key');
  const key = await env.DB.prepare('SELECT id, account_id, budget_micro, spent_micro, reserved_micro FROM inference_keys WHERE token_hash = ? AND revoked_at IS NULL AND expires > ?')
    .bind(await sha256(auth.slice(7)), seconds()).first<InferenceKey>();
  if (!key) throw new ApiError('This API key is invalid, expired or revoked.', 401, 'invalid_api_key');
  return key;
}

export async function reserveInference(env: Env, key: InferenceKey, model: MeteredModel, maxOutput: number, idempotency: string | null): Promise<string> {
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const now = seconds();
  // The tokenizer is hosted with the model. Holding the context's worst-case
  // input cost before calling it prevents unmetered GPU work and overdrafts.
  const hold = Math.max(model.minimumMicro, model.context * model.inputRate + maxOutput * model.outputRate);
  const hash = idempotency ? await sha256(`${key.id}:${idempotency}`) : null;
  try {
    await env.DB.prepare(`INSERT INTO inference_requests(id, account_id, key_id, model, idempotency_hash, hold_micro, input_rate, output_rate, minimum_micro, created_at, lease_until)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, key.account_id, key.id, model.id, hash, hold, model.inputRate, model.outputRate, model.minimumMicro, now, now + 900).run();
  } catch (error) {
    const message = error instanceof Error ? `${error.message} ${error.cause instanceof Error ? error.cause.message : ''}` : '';
    if (message.includes('api_insufficient_credit')) throw new ApiError('Add API credit to cover this request. Any unused reservation is released.', 402, 'insufficient_quota');
    if (message.includes('api_key_budget')) throw new ApiError('This request exceeds the API key’s remaining limit, or the key has been revoked.', 402, 'key_budget_exceeded');
    if (message.includes('api_concurrency')) throw new ApiError('Two requests are already running on this account.', 429, 'concurrency_limit', { retryAfter: 10 });
    if (message.includes('api_capacity')) throw new ApiError('The model is at capacity. Try again shortly.', 429, 'capacity_limit', { retryAfter: 10 });
    if (hash && message.includes('UNIQUE')) throw new ApiError('This idempotency key has already been used. Responses are not stored for replay.', 409, 'idempotency_conflict');
    throw error;
  }
  return id;
}

export async function settleInference(env: Env, id: string, status: 'completed' | 'failed' | 'cancelled', tokens: { input: number; output: number } | null, failureCode: string | null = null): Promise<void> {
  const input = tokens?.input ?? 0;
  const output = tokens?.output ?? 0;
  if (![input, output].every((n) => Number.isSafeInteger(n) && n >= 0)) throw new Error('Invalid usage counters');
  await env.DB.prepare(`UPDATE inference_requests SET status = ?, input_tokens = ?, output_tokens = ?,
    charge_micro = CASE WHEN ? THEN MAX(minimum_micro, ? * input_rate + ? * output_rate) ELSE 0 END,
    finished_at = ?, failure_code = ? WHERE id = ? AND status = 'running'`)
    .bind(status, input, output, tokens ? 1 : 0, input, output, seconds(), failureCode, id).run();
}

export async function reapInferenceHolds(env: Env, now: number): Promise<number> {
  const result = await env.DB.prepare("UPDATE inference_requests SET status = 'failed', finished_at = ?, failure_code = 'interrupted' WHERE status = 'running' AND lease_until < ?").bind(now, now).run();
  return result.meta.changes;
}

export async function hasApiLiability(env: Env, accountId: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT 1 AS found WHERE EXISTS(SELECT 1 FROM api_wallets WHERE account_id = ? AND (balance_micro != 0 OR reserved_micro != 0))
    OR EXISTS(SELECT 1 FROM api_topups WHERE account_id = ? AND (status = 'pending' OR dispute_open = 1))`).bind(accountId, accountId).first();
  return Boolean(row);
}
