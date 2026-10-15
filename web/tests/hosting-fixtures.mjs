// Answers the RunPod hosting API can give to { myself { underBalance } }.
// Each failure must leave the funding state unknown, which closes payments.

export const HOSTING_API = 'https://api.runpod.io/graphql';

export const fundedHosting = () => Response.json({ data: { myself: { underBalance: false } } });
export const pausedHosting = () => Response.json({ data: { myself: { underBalance: true } } });

/** Each returns what a mocked fetch would: a Response, or a rejection. */
export const HOSTING_FAILURES = {
  'fetch 500': () => new Response('Internal Server Error', { status: 500 }),
  'network error': () => Promise.reject(new TypeError('fetch failed')),
  'GraphQL errors': () => Response.json({ errors: [{ message: 'Unauthorized' }], data: null }),
  'GraphQL errors beside data': () => Response.json({ errors: [{ message: 'Field failed' }], data: { myself: { underBalance: false } } }),
  'myself null': () => Response.json({ data: { myself: null } }),
  'underBalance missing': () => Response.json({ data: { myself: {} } }),
  'malformed JSON': () => new Response('{"data": {"myself": ', { status: 200, headers: { 'Content-Type': 'application/json' } }),
  // AbortSignal.timeout rejects the fetch with this error. hosting-state tests
  // also wait for the real five-second signal once.
  timeout: () => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
  // The same deadline reached while the body is read: the stream fails instead
  // of the fetch, under the other abort name. It is still a timeout, not a bad body.
  'body aborted': () => new Response(new ReadableStream({
    start(controller) { controller.error(new DOMException('The operation was aborted', 'AbortError')); },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  redirect: () => new Response(null, { status: 302, headers: { Location: 'https://other.example/graphql' } }),
};

/** The reason code each failure reports: in the log, in billing and in /api/health. */
export const HOSTING_REASONS = {
  'fetch 500': 'http_500',
  'network error': 'network_error',
  'GraphQL errors': 'graphql_errors',
  'GraphQL errors beside data': 'graphql_errors',
  'myself null': 'no_account',
  'underBalance missing': 'no_flag',
  'malformed JSON': 'malformed_body',
  timeout: 'timeout',
  'body aborted': 'timeout',
  redirect: 'redirect',
};
