// Bindings and constants shared by every Worker module.

export const VERSION = '0.7.4';
export const SUPPORT_EMAIL = 'support@bountyoperator.com';
export const PRICE = Object.freeze({ usd: 10, interval: 'week' });

/** The Workers Rate Limiting binding: a counter held at the edge, with no database write. */
export interface EdgeLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** The one origin the site is served from, such as https://bountyoperator.com. */
  SITE_ORIGIN: string;
  AI_REVIEW_ENABLED: string;
  BILLING_MODE: string;
  STRIPE_PRICE_ID: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PORTAL_CONFIGURATION?: string;
  /** Secret for the keyed hash that turns an IP address into a rate-limit key. */
  IP_HASH_KEY?: string;
  API_LIMITER?: EdgeLimiter;
  CF_VERSION_METADATA?: { id: string; tag: string; timestamp: string };
}

/** Everything a route handler needs about one request. */
export interface Call {
  request: Request;
  env: Env;
  ctx: ExecutionContext;
  url: URL;
}

export function seconds(): number {
  return Math.floor(Date.now() / 1000);
}
