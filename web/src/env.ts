// Bindings and constants shared by every Worker module.

export const VERSION = '0.9.16';
export const SUPPORT_EMAIL = 'support@bountyoperator.com';
export const PRICE = Object.freeze({ usd: 10, interval: 'month', included_api_credit_usd: 2 });

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
  /** Off until the deployed model and payment flow have passed live checks. */
  INFERENCE_ENABLED?: string;
  API_TOPUPS_ENABLED?: string;
  API_AUTOTOPUPS_ENABLED?: string;
  /** Validated server-side catalog; endpoints and vendor keys are never public. */
  INFERENCE_MODELS?: string;
  /** Verified supplier rates; admission also requires a funded current budget window. */
  SUPPLIER_COST_RULES?: string;
  /** Share (0..1, default 0.9) of confirmed customer API credit that funds each provider's budget window. */
  SUPPLIER_BUDGET_SHARE?: string;
  RUNPOD_API_KEY?: string;
  INFRON_API_KEY?: string;
  ORCAROUTER_API_KEY?: string;
  /** The cron emails the owner once the RunPod balance drops below this many USD. Unset, blank or unreadable means 10. */
  RUNPOD_ALERT_USD?: string;
  /** send_email binding for owner alerts, pinned with destination_address. Absent (as in the template) means alerts are off. */
  ALERT_EMAIL?: SendEmail;
  /**
   * Where owner alerts go: exactly the binding's destination_address, a verified
   * Email Routing destination (the owner's own inbox, not a routing rule such as
   * support@). No default: blank with the binding bound means not configured.
   */
  ALERT_EMAIL_TO?: string;
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
  /**
   * Set only on the in-process Model API call a hosted review makes: called
   * once when the model's worker is found to be starting, so the review can
   * tell its reader. See readyWorker in inference.ts.
   */
  onStarting?: () => void;
}

export function seconds(): number {
  return Math.floor(Date.now() / 1000);
}
