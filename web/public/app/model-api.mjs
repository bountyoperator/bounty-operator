import { button, copyText, el } from './ui.mjs';

function modelCard(model) {
  const copied = el('span', { role: 'status', class: 'help' });
  return el('section', { class: 'catalog-card' },
    el('h3', { text: model.name }),
    model.description && el('p', { text: model.description }),
    el('p', { class: 'help', text: [(model.capabilities ?? []).includes('tools') ? 'Works with agents' : 'Chat', ...(model.tags ?? []).filter(value => ['cybersecurity', 'uncensored'].includes(value)).map(value => value === 'cybersecurity' ? 'Security focused' : 'Uncensored')].join(' · ') }),
    el('p', { class: 'catalog-card__price', text: `US$${model.pricing.input_per_million} input / US$${model.pricing.output_per_million} output per 1M tokens` }),
    el('p', { class: 'help', text: `US$${model.pricing.minimum_request.toFixed(2)} minimum per request` }),
    el('p', null, 'Model ID: ', el('code', { text: model.id })),
    button({ label: 'Copy model ID', size: 'sm', variant: 'secondary', attrs: { 'aria-label': `Copy ${model.name} model ID` }, onClick: async () => { copied.textContent = await copyText(model.id) ? 'Model ID copied.' : 'Select and copy the model ID above.'; } }),
    copied,
    el('details', null, el('summary', { text: 'Model details' }),
      el('p', { text: `${model.context_length.toLocaleString()} token context · ${model.max_output_tokens.toLocaleString()} maximum output · ${model.quantization}` }),
      el('p', { class: 'help', text: (model.capabilities ?? []).map(value => value.replaceAll('_', ' ')).join(' · ') }),
      el('p', { class: 'help' }, 'Source: ', el('a', { href: `https://huggingface.co/${model.source.split('/').map(encodeURIComponent).join('/')}`, text: model.source, target: '_blank', rel: 'noopener noreferrer' }), ` · ${model.license}`),
      model.reasoning_parameter && el('p', { class: 'help' }, 'Reasoning control: ', el('code', { text: model.reasoning_parameter })),
      el('p', { class: 'help' }, 'Revision: ', el('code', { text: model.revision })),
    ),
  );
}

async function loadCatalog() {
  const status = document.getElementById('model-api-status');
  const catalog = document.getElementById('model-api-catalog');
  try {
    const response = await fetch('/api/inference/catalog');
    if (!response.ok) throw new Error('Catalog unavailable');
    const result = await response.json();
    status.replaceChildren(el('p', { text: result.enabled ? `${result.models.length} model${result.models.length === 1 ? '' : 's'} available. ${result.topups_enabled ? 'Open your account to add credit and create an API key.' : 'Customer top-ups are currently closed.'}` : 'The API is being prepared. Customer top-ups are currently closed.' }));
    const list = el('div', { class: 'catalog-grid' });
    const count = el('p', { class: 'help', role: 'status' });
    const search = el('input', { id: 'catalog-search', class: 'input', type: 'search', placeholder: 'Search models' });
    const filter = el('select', { id: 'catalog-filter', class: 'input' },
      el('option', { value: '', text: 'All models' }),
      el('option', { value: 'cybersecurity', text: 'Cybersecurity' }),
      el('option', { value: 'uncensored', text: 'Uncensored models' }),
      el('option', { value: 'tools', text: 'For agents' }),
      ...(result.models.some(model => (model.capabilities ?? []).includes('reasoning')) ? [el('option', { value: 'reasoning', text: 'Reasoning' })] : []),
    );
    const render = () => {
      const query = search.value.trim().toLowerCase();
      const models = result.models.filter((model) => {
        const labels = [...(model.tags ?? []), ...(model.capabilities ?? [])];
        return (!filter.value || labels.includes(filter.value)) && [model.id, model.name, model.source, model.description, ...labels].join(' ').toLowerCase().includes(query);
      });
      count.textContent = `${models.length} of ${result.models.length} models`;
      list.replaceChildren(...(models.length ? models.map(modelCard) : [el('p', { text: 'No models match these filters.' })]));
    };
    search.addEventListener('input', render);
    filter.addEventListener('change', render);
    catalog.replaceChildren(
      el('div', { class: 'catalog-filters' },
        el('div', { class: 'field' }, el('label', { class: 'label', for: 'catalog-search', text: 'Find a model' }), search),
        el('div', { class: 'field' }, el('label', { class: 'label', for: 'catalog-filter', text: 'Filter models' }), filter),
      ), count, list,
    );
    render();
  } catch { status.replaceChildren(el('p', { text: 'Availability could not be checked. Refresh this page before adding credit.' })); }
}
if (typeof document !== 'undefined') loadCatalog();
