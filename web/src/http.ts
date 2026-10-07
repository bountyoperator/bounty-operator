// Responses: JSON bodies, coded errors, the canonical-host redirect, and the one
// place that decides security and cache headers.

import { boundedBody } from '../public/review-core.mjs';
import { SUPPORT_EMAIL } from './env.ts';

/**
 * An error the client is meant to read. `code` is the stable value the browser
 * app and the MCP server switch on; `extra` is merged into the JSON body.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly extra: Record<string, unknown>;

  constructor(message: string, status = 400, code = 'bad_request', extra: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export interface JsonOptions {
  cookies?: string[];
  headers?: Record<string, string>;
}

export function json(data: unknown, status = 200, options: JsonOptions = {}): Response {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', ...options.headers });
  for (const cookie of options.cookies ?? []) headers.append('Set-Cookie', cookie);
  return new Response(JSON.stringify(data), { status, headers });
}

export function errorBody(error: ApiError): Record<string, unknown> {
  return { ...error.extra, error: error.message, code: error.code };
}

export function errorResponse(error: ApiError): Response {
  const headers: Record<string, string> = {};
  const retryAfter = error.extra.retryAfter;
  if (typeof retryAfter === 'number') headers['Retry-After'] = String(retryAfter);
  if (error.status === 405 && typeof error.extra.allow === 'string') headers.Allow = error.extra.allow;
  return json(errorBody(error), error.status, { headers });
}

export function internalError(): ApiError {
  return new ApiError(`This request could not be completed. Try again, or write to ${SUPPORT_EMAIL}.`, 500, 'internal');
}

/**
 * Reads a JSON object from the request body, refusing anything over `limit` bytes.
 * `anyContentType` is for `navigator.sendBeacon`, which sends text/plain.
 */
export async function readJson(request: Request, limit: number, anyContentType = false): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('content-type')?.toLowerCase() ?? '';
  if (!anyContentType && !contentType.startsWith('application/json')) {
    throw new ApiError('Send the request body as JSON.', 415, 'bad_request');
  }
  const declared = Number(request.headers.get('content-length'));
  if (declared > limit) throw new ApiError('Request exceeds the size limit.', 413, 'too_large');

  let text: string;
  try {
    text = await boundedBody(request, limit);
  } catch {
    throw new ApiError('Request exceeds the size limit or is not UTF-8 text.', 413, 'too_large');
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ApiError('Request body is not valid JSON.', 400, 'bad_request');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError('Request body must be a JSON object.', 400, 'bad_request');
  }
  return value as Record<string, unknown>;
}

/**
 * Where a request for another host or scheme is sent: the same path on
 * SITE_ORIGIN. Only GET and HEAD are redirected. A POST is answered where it
 * arrives, so the Stripe webhook keeps working on a legacy host.
 */
export function canonicalRedirect(method: string, url: URL, siteOrigin: string): string | null {
  if (method !== 'GET' && method !== 'HEAD') return null;
  if (url.origin === siteOrigin) return null;
  return `${siteOrigin}${url.pathname}${url.search}`;
}

// Addresses that tools and people try first, answered where the file lives.
// RFC 9116 allows a redirect from the top-level security.txt.
const ALIASES: Readonly<Record<string, string>> = Object.freeze({
  '/security.txt': '/.well-known/security.txt',
  '/favicon.png': '/icon-192.png',
});

/** The address a GET or HEAD for an alias moves to, or null. */
export function aliasRedirect(method: string, url: URL): string | null {
  if (method !== 'GET' && method !== 'HEAD') return null;
  return Object.hasOwn(ALIASES, url.pathname) ? `${url.origin}${ALIASES[url.pathname]}` : null;
}

export function redirectResponse(location: string, status = 301): Response {
  return new Response(null, { status, headers: { Location: location } });
}

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self' https://api.github.com https://openrouter.ai",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
});

// `no-transform` keeps Cloudflare from rewriting the page. Without it the
// proxy may inject its analytics beacon as an inline script, which the
// policy above then blocks and reports in every visitor's console.
export const HTML_CACHE = 'public, max-age=0, must-revalidate, no-transform';
export const ASSET_CACHE = 'public, max-age=3600, stale-while-revalidate=86400';
// Modules and stylesheets have no hash in their names and import each other.
// A cached copy next to a fresh one is a broken page, so the browser
// revalidates them on every load; an unchanged file costs one 304.
export const CODE_CACHE = 'public, max-age=0, must-revalidate';
export const API_CACHE = 'no-store';

export type ResponseKind = 'api' | 'static' | 'redirect';

export interface CachePolicyInput {
  kind: ResponseKind;
  pathname: string;
  contentType: string | null;
}

function extensionOf(pathname: string): string {
  const name = pathname.slice(pathname.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

function isHtml(contentType: string | null, extension: string): boolean {
  if (contentType) return contentType.toLowerCase().startsWith('text/html');
  // A 304 carries no Content-Type. Pages are served without an extension.
  return extension === '' || extension === 'html';
}

/** /dl/ holds the MCP package and the list of its checksums: two files that must come from one deploy. */
function isDownload(pathname: string): boolean {
  return pathname.startsWith('/dl/');
}

function isCode(contentType: string | null, extension: string): boolean {
  if (['mjs', 'js', 'css'].includes(extension)) return true;
  const type = contentType?.toLowerCase() ?? '';
  return type.includes('javascript') || type.startsWith('text/css');
}

/** The Cache-Control value for a response. */
export function cachePolicy({ kind, pathname, contentType }: CachePolicyInput): string {
  if (kind === 'api') return API_CACHE;
  if (kind === 'redirect') return 'public, max-age=3600';

  const extension = extensionOf(pathname);
  if (isHtml(contentType, extension)) return HTML_CACHE;
  if (isCode(contentType, extension) || isDownload(pathname)) return CODE_CACHE;
  return ASSET_CACHE;
}

/**
 * Returns the response with the security headers and the cache policy set.
 * Every response the Worker sends passes through here, and nothing else sets
 * these headers.
 */
export function finalize(response: Response, kind: ResponseKind, pathname: string): Response {
  const result = new Response(response.body, response);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) result.headers.set(name, value);

  // An error page must not be cached as if it were the asset.
  const failed = kind === 'static' && response.status >= 400;
  // The asset server knows no media type for a package tarball.
  if (kind === 'static' && !failed && !result.headers.has('content-type') && pathname.endsWith('.tgz')) {
    result.headers.set('Content-Type', 'application/gzip');
  }
  const contentType = result.headers.get('content-type');
  result.headers.set('Cache-Control', failed ? HTML_CACHE : cachePolicy({ kind, pathname, contentType }));
  return result;
}
