import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { convertV4MiniflareOptions } from 'miniflare';

import { OFFLINE_ENV, localWorkerOptions } from './smoke-runtime.mjs';

test('a smoke bundle outside the checkout stays inside its module root', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bounty-smoke-options-'));
  try {
    const scriptPath = join(directory, 'worker.js');
    writeFileSync(scriptPath, 'export default { fetch() { return new Response("fixture"); } };\n');
    const options = localWorkerOptions(scriptPath);
    const converted = convertV4MiniflareOptions(options);
    const manifest = converted.workers[0].config.manifest;
    assert.equal(manifest.modulesRoot, directory);
    assert.equal(manifest.mainModule, 'worker.js');
    assert.deepEqual(Object.keys(manifest.modules), ['worker.js']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('smoke runtimes use local metadata and disable telemetry and the banner update check', () => {
  const options = localWorkerOptions('/tmp/example/worker.js');
  assert.equal(options.cf, false);
  assert.deepEqual(options.telemetry, { enabled: false });
  assert.equal(OFFLINE_ENV.CLOUDFLARE_CF_FETCH_ENABLED, 'false');
  assert.equal(OFFLINE_ENV.WRANGLER_SEND_METRICS, 'false');
  assert.equal(OFFLINE_ENV.WRANGLER_SEND_ERROR_REPORTS, 'false');
  assert.equal(OFFLINE_ENV.WRANGLER_HIDE_BANNER, 'true');
});
