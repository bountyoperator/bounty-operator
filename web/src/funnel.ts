// First-party counters: one row per UTC day and event name, holding a number.
// No account id, no address, no content. Every write runs after the response
// and never fails a request.

import { seconds } from './env.ts';
import type { Env } from './env.ts';

/** Events the browser may report through POST /api/event. */
export const CLIENT_EVENTS: ReadonlySet<string> = new Set([
  'example_loaded',
  'prompt_exported',
  'reply_pasted',
  'packet_saved',
  'repo_imported',
  'signin_opened',
  'upgrade_clicked',
  'gauntlet_started',
  'gauntlet_finished',
  'panel_started',
  'panel_finished',
  'tool_report_check',
  'tool_secret_check',
  'tool_slither_focus',
  'tool_verify',
  'tool_acceptance_rates',
  'template_copied',
  'mcp_command_copied',
]);

// Referrer hosts worth a bucket of their own. A host matches an entry when it
// is that domain or a subdomain of it.
const REFERRER_HOSTS: readonly (readonly [string, string])[] = [
  ['x.com', 'x'],
  ['t.co', 'x'],
  ['twitter.com', 'x'],
  ['github.com', 'github'],
  ['news.ycombinator.com', 'hackernews'],
  ['reddit.com', 'reddit'],
  ['bing.com', 'bing'],
  ['duckduckgo.com', 'duckduckgo'],
  // Assistants that answer with links. gemini.google.com is listed before the
  // rule that files every other Google host under google.
  ['chatgpt.com', 'chatgpt'],
  ['chat.openai.com', 'chatgpt'],
  ['perplexity.ai', 'perplexity'],
  ['claude.ai', 'claude'],
  ['copilot.microsoft.com', 'copilot'],
  ['gemini.google.com', 'gemini'],
  ['immunefi.com', 'immunefi'],
  ['cantina.xyz', 'cantina'],
  ['sherlock.xyz', 'sherlock'],
  ['discord.com', 'discord'],
  ['openrouter.ai', 'openrouter'],
  ['t.me', 'telegram'],
  ['farcaster.xyz', 'farcaster'],
  ['warpcast.com', 'farcaster'],
];

// What a link may carry in ?ref=. The list is fixed so a visitor cannot mint
// new counter rows by inventing codes.
const REF_CODES: Readonly<Record<string, string>> = Object.freeze({
  x: 'x',
  twitter: 'x',
  github: 'github',
  gh: 'github',
  readme: 'github',
  hn: 'hackernews',
  hackernews: 'hackernews',
  reddit: 'reddit',
  immunefi: 'immunefi',
  cantina: 'cantina',
  sherlock: 'sherlock',
  discord: 'discord',
  openrouter: 'openrouter',
  telegram: 'telegram',
  tg: 'telegram',
  farcaster: 'farcaster',
  warpcast: 'farcaster',
  mcp: 'mcp',
  npm: 'npm',
  cli: 'cli',
  launch: 'launch',
  newsletter: 'newsletter',
});

// google.com, google.co.uk, google.com.au and the rest of the country sites.
const GOOGLE_HOST = /(?:^|\.)google\.(?:[a-z]{2,3}|com?\.[a-z]{2})$/;

const BOT_AGENT = /bot|crawl|spider|slurp|preview|scan|monitor|fetch|headless|lighthouse|curl|wget|python|http|java|ruby|go-http|node|axios|postman/i;

const MAX_PATH_CHARS = 80;

function matchesDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * The bucket for a Referer header: a named source, `other` for a site that is
 * not on the list, or null when there is no referrer or it is the site itself.
 */
export function referrerBucket(referer: string | null | undefined, siteOrigin: string): string | null {
  if (!referer) return null;

  let host: string;
  try {
    const url = new URL(referer);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.origin === siteOrigin) return null;
    host = url.hostname.toLowerCase();
  } catch {
    return null;
  }

  if (matchesDomain(host, new URL(siteOrigin).hostname)) return null;
  for (const [domain, bucket] of REFERRER_HOSTS) {
    if (matchesDomain(host, domain)) return bucket;
  }
  if (GOOGLE_HOST.test(host)) return 'google';
  return 'other';
}

/** The bucket for a ?ref= code, or null when the code is not on the list. */
export function refCodeBucket(code: string | null | undefined): string | null {
  if (!code) return null;
  const key = code.trim().toLowerCase();
  return Object.hasOwn(REF_CODES, key) ? REF_CODES[key] : null;
}

/** Where a visit came from. A ?ref= code on the link wins over the Referer header. */
export function visitSource(url: URL, referer: string | null | undefined, siteOrigin: string): string | null {
  return refCodeBucket(url.searchParams.get('ref')) ?? referrerBucket(referer, siteOrigin);
}

export function isBot(userAgent: string | null | undefined): boolean {
  return !userAgent || BOT_AGENT.test(userAgent);
}

/** The pageview event for a path, or null for a path too long to be a page. */
export function pageviewEvent(pathname: string): string | null {
  if (pathname.length > MAX_PATH_CHARS) return null;
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return `pv:${path || '/'}`;
}

export function dayOf(now: number): string {
  return new Date(now * 1000).toISOString().slice(0, 10);
}

async function increment(db: D1Database, events: string[], now: number): Promise<void> {
  const statement = db.prepare(
    'INSERT INTO funnel_daily (day, event, n) VALUES (?, ?, 1) ON CONFLICT(day, event) DO UPDATE SET n = n + 1',
  );
  const day = dayOf(now);
  await db.batch(events.map((event) => statement.bind(day, event)));
}

/** Adds one to each event's counter for today, after the response has gone out. */
export function count(env: Env, ctx: ExecutionContext, ...events: string[]): void {
  if (events.length === 0) return;
  ctx.waitUntil(
    increment(env.DB, events, seconds()).catch(() => {
      // A lost count is not worth failing or logging a request over.
    }),
  );
}

/** Counts a page view and its source for a page that was served to a browser. */
export function countVisit(env: Env, ctx: ExecutionContext, request: Request, url: URL, response: Response): void {
  // A 304 is a returning visitor whose browser still holds the page.
  if (request.method !== 'GET' || (response.status !== 200 && response.status !== 304)) return;
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('text/html')) return;
  if (isBot(request.headers.get('user-agent'))) return;

  // A browser marks a page load. Prefetches and embedded requests are not visits.
  const destination = request.headers.get('sec-fetch-dest');
  if (destination && destination !== 'document') return;
  if (request.headers.get('sec-purpose') || request.headers.get('purpose') === 'prefetch') return;

  const pageview = pageviewEvent(url.pathname);
  if (!pageview) return;
  const source = visitSource(url, request.headers.get('referer'), env.SITE_ORIGIN);
  count(env, ctx, ...(source ? [pageview, `ref:${source}`] : [pageview]));
}
