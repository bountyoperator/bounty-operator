// Pages and assets. The Worker runs in front of every request, so the same
// code decides the headers for a page, a script and an API response.

import type { Call } from './env.ts';
import { countVisit } from './funnel.ts';

/** Serves a file from the assets directory, or the 404 page when there is none. */
export async function serveAsset({ env, ctx, request, url }: Call): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed.', {
      status: 405,
      headers: { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  const response = await env.ASSETS.fetch(request);
  countVisit(env, ctx, request, url, response);
  return response;
}
