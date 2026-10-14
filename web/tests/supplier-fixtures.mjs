// Explicit test-only supplier capital. Production migrations create no funds.
import { inferenceModels } from '../src/inference.ts';

export function enableSupplierFixture(env) {
  const now = Math.floor(Date.now() / 1000);
  for (const provider of ['runpod', 'infron', 'orcarouter']) {
    env.DB.sqlite.prepare(`INSERT OR IGNORE INTO supplier_budget_windows
      (id, provider, starts_at, ends_at, limit_micro, enabled, funding_reference, updated_at)
      VALUES(?, ?, ?, ?, 100000000000, 1, 'test fixture only - not real funding', ?)`)
      .run(`fixture-${provider}`, provider, now - 86400, now + 86400, now);
  }
  Object.defineProperty(env, 'SUPPLIER_COST_RULES', {
    configurable: true,
    get() {
      return JSON.stringify(inferenceModels(env).map((model) => {
        const runpod = /^https:\/\/([a-z0-9]+)\.api\.runpod\.ai$/.exec(model.endpoint);
        const provider = runpod ? 'runpod' : model.endpoint === 'https://api.infron.ai' ? 'infron' : 'orcarouter';
        return { model: model.id, endpoint: model.endpoint, upstreamModel: model.upstreamModel, provider,
          resourceId: runpod ? runpod[1] : model.upstreamModel, basis: runpod ? 'runtime_allowance' : 'token_rate',
          revision: 'test-only-quote', source: 'https://fixtures.invalid/pricing', validUntil: now + 86400,
          ...(runpod ? { holdMicro: 1000 } : { inputMicroPerMillion: 1000000, outputMicroPerMillion: 1000000, fixedMicro: 0 }) };
      }));
    },
  });
  return env;
}
