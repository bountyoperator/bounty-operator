// Rate limits. A client is identified by a keyed hash of its network address,
// so the database never holds an IP address and the keys cannot be reversed
// by hashing the 4 billion IPv4 addresses.

import { hmacSha256 } from './crypto.ts';
import { seconds } from './env.ts';
import type { Env } from './env.ts';
import { ApiError } from './http.ts';

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HEX_GROUP = /^[0-9a-f]{1,4}$/;

function parseIpv4(text: string): number[] | null {
  const match = text.match(IPV4);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
}

function parseGroups(text: string): number[] | null {
  if (text === '') return [];
  const groups: number[] = [];
  for (const part of text.split(':')) {
    if (!HEX_GROUP.test(part)) return null;
    groups.push(parseInt(part, 16));
  }
  return groups;
}

/** The eight 16-bit groups of an IPv6 address, or null when it is not one. */
function parseIpv6(text: string): number[] | null {
  let address = text;

  // An embedded IPv4 address stands for the last two groups: ::ffff:192.0.2.1
  if (address.includes('.')) {
    const lastColon = address.lastIndexOf(':');
    const octets = lastColon === -1 ? null : parseIpv4(address.slice(lastColon + 1));
    if (!octets) return null;
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    address = `${address.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const halves = address.split('::');
  if (halves.length > 2) return null;
  const head = parseGroups(halves[0]);
  const rest = halves.length === 2 ? parseGroups(halves[1]) : [];
  if (!head || !rest) return null;

  if (halves.length === 1) return head.length === 8 ? head : null;
  const elided = 8 - head.length - rest.length;
  if (elided < 1) return null;
  return [...head, ...new Array<number>(elided).fill(0), ...rest];
}

/**
 * The part of an address that identifies one subscriber: the whole IPv4
 * address, or the /64 prefix of an IPv6 address. One customer line holds a
 * whole /64, so limiting on the full IPv6 address limits nothing.
 */
export function ipBucket(ip: string | null | undefined): string {
  const text = (ip ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (!text) return 'unknown';

  const v4 = parseIpv4(text);
  if (v4) return `v4:${v4.join('.')}`;

  const groups = parseIpv6(text);
  if (!groups) return 'unknown';

  const isMapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  if (isMapped) {
    return `v4:${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
  }
  return `v6:${groups.slice(0, 4).map((group) => group.toString(16)).join(':')}`;
}

/** The HMAC secret: IP_HASH_KEY in production, a value derived from the origin in local development. */
export function ipHashSecret(env: Pick<Env, 'IP_HASH_KEY' | 'SITE_ORIGIN'>): string {
  return env.IP_HASH_KEY || `bounty-operator:ip-hash:${env.SITE_ORIGIN}`;
}

/** The rate-limit key for an address: HMAC-SHA-256 over its bucket, cut to 128 bits. */
export async function rateKey(env: Pick<Env, 'IP_HASH_KEY' | 'SITE_ORIGIN'>, ip: string | null | undefined): Promise<string> {
  const digest = await hmacSha256(ipHashSecret(env), ipBucket(ip));
  return digest.slice(0, 22);
}

export function clientKey(env: Env, request: Request): Promise<string> {
  return rateKey(env, request.headers.get('cf-connecting-ip'));
}

function tooManyRequests(retryAfter: number): ApiError {
  const minutes = Math.ceil(retryAfter / 60);
  const wait = retryAfter < 90 ? 'a minute' : `${minutes} minutes`;
  return new ApiError(`Too many requests. Try again in ${wait}.`, 429, 'rate_limited', { retryAfter });
}

/**
 * Counts one hit against `id` and throws once more than `max` have landed in
 * the current window. One statement, so concurrent requests cannot both pass.
 */
export async function rateLimit(db: D1Database, id: string, max: number, windowSeconds: number, now = seconds()): Promise<void> {
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (id, hits, expires) VALUES (?1, 1, ?2)
       ON CONFLICT(id) DO UPDATE SET
         hits = CASE WHEN expires <= ?3 THEN 1 ELSE hits + 1 END,
         expires = CASE WHEN expires <= ?3 THEN ?2 ELSE expires END
       RETURNING hits, expires`,
    )
    .bind(id, now + windowSeconds, now)
    .first<{ hits: number; expires: number }>();

  if (!row) throw tooManyRequests(windowSeconds);
  if (row.hits > max) throw tooManyRequests(Math.max(1, row.expires - now));
}

/** Throws when `id` has already used its `max` hits, without counting this request. */
export async function assertBelowLimit(db: D1Database, id: string, max: number, now = seconds()): Promise<void> {
  const row = await db
    .prepare('SELECT hits, expires FROM rate_limits WHERE id = ? AND expires > ?')
    .bind(id, now)
    .first<{ hits: number; expires: number }>();
  if (row && row.hits >= max) throw tooManyRequests(Math.max(1, row.expires - now));
}

/**
 * The first gate on every POST: a per-address counter held at the edge. It
 * turns a flood away before the request body is read and before any database
 * write. The binding is optional so a deployment without it still runs.
 */
export async function edgeLimit(env: Env, key: string): Promise<void> {
  if (!env.API_LIMITER) return;
  const { success } = await env.API_LIMITER.limit({ key });
  if (!success) throw tooManyRequests(60);
}
