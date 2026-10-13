import { el } from './ui.mjs';

async function loadCatalog() {
  const status = document.getElementById('model-api-status');
  const catalog = document.getElementById('model-api-catalog');
  try {
    const response = await fetch('/api/inference/catalog');
    if (!response.ok) throw new Error('Catalog unavailable');
    const result = await response.json();
    status.replaceChildren(el('p', { text: result.enabled ? (result.topups_enabled ? 'Pilot available. Open your account to add credit and create an API key.' : 'Model checks passed. Customer top-ups are not open yet.') : 'The API is being prepared. Customer top-ups are currently closed.' }));
    catalog.replaceChildren(...result.models.map((model) => el('section', { class: 'portal-section' },
      el('h2', { text: model.name }),
      el('p', { text: `${model.context_length.toLocaleString()} token context · ${model.max_output_tokens.toLocaleString()} maximum output · ${model.quantization}` }),
      el('p', { text: `US$${model.pricing.input_per_million} per million input tokens · US$${model.pricing.output_per_million} per million output tokens · US$${model.pricing.minimum_request.toFixed(2)} minimum per request` }),
      el('p', null, 'Model ID: ', el('code', { text: model.id })),
      el('p', { class: 'help', text: `Source: ${model.source} · ${model.license} · revision ${model.revision}` }),
    )));
  } catch { status.replaceChildren(el('p', { text: 'Availability could not be checked. Refresh this page before adding credit.' })); }
}
if (typeof document !== 'undefined') loadCatalog();
