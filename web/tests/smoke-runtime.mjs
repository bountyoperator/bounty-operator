// Shared local-only runtime settings for the smoke scripts.
import { dirname } from 'node:path';

export const OFFLINE_ENV = Object.freeze({
  CLOUDFLARE_CF_FETCH_ENABLED: 'false',
  WRANGLER_SEND_METRICS: 'false',
  WRANGLER_SEND_ERROR_REPORTS: 'false',
  // The banner checks npm for updates, including in CI.
  WRANGLER_HIDE_BANNER: 'true',
});

export function localWorkerOptions(scriptPath) {
  return {
    modules: true,
    scriptPath,
    // Miniflare 5 derives the module name relative to this root. A bundle
    // under the system temp directory must not become ../../tmp/worker.js.
    modulesRoot: dirname(scriptPath),
    // Use built-in Request.cf metadata; never fetch Cloudflare's cf.json.
    cf: false,
    telemetry: { enabled: false },
  };
}
