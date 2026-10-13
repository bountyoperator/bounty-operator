import { button, copyText, el } from './ui.mjs';

function modelCard(model) {
  const copied = el('span', { role: 'status', class: 'help' });
  const copyButton = (label, value) => button({ label, size: 'sm', variant: 'secondary', attrs: { 'aria-label': `${label} for ${model.name}` }, onClick: async () => { copied.textContent = await copyText(value) ? `${label === 'Copy model ID' ? 'Model ID' : 'Base URL'} copied.` : 'Select and copy the value above.'; } });
  const rate = (label, value, unit) => el('div', null, el('dt', { text: label }), el('dd', null, el('strong', { text: `$${value}` }), el('span', { text: unit })));
  return el('section', { class: 'catalog-card', 'aria-label': model.name },
    el('div', { class: 'catalog-card__main' },
      el('div', { class: 'catalog-card__about' },
        el('h3', { text: model.name }),
        model.description && el('p', { text: model.description }),
        el('ul', { class: 'catalog-tags', 'aria-label': 'Capabilities' },
          el('li', { text: (model.capabilities ?? []).includes('tools') ? 'Agent tools' : 'Chat only' }),
          ...(model.tags ?? []).filter(value => ['cybersecurity', 'uncensored'].includes(value)).map(value => el('li', { text: value === 'cybersecurity' ? 'Security focused' : 'Uncensored' })),
        ),
      ),
      el('dl', { class: 'catalog-rates' },
        rate('Input', model.pricing.input_per_million, '/ 1M tokens'),
        rate('Output', model.pricing.output_per_million, '/ 1M tokens'),
        rate('Minimum', model.pricing.minimum_request.toFixed(2), '/ request'),
      ),
    ),
    el('details', { class: 'catalog-details' }, el('summary', { text: 'Connection & model details', 'aria-label': `Connection and model details for ${model.name}` }),
      el('div', { class: 'catalog-connect' },
        el('div', null, el('p', { class: 'help', text: 'Model ID' }), el('code', { text: model.id }), copyButton('Copy model ID', model.id)),
        el('div', null, el('p', { class: 'help', text: 'Base URL' }), el('code', { text: 'https://bountyoperator.com/v1' }), copyButton('Copy base URL', 'https://bountyoperator.com/v1')),
      ),
      copied,
      el('p', null, el('a', { href: '/docs/model-api', text: 'Setup guide' })),
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
    status.textContent = result.enabled ? `${result.models.length} model${result.models.length === 1 ? '' : 's'} available.${result.topups_enabled ? '' : ' Customer top-ups are currently closed.'}` : 'The API is being prepared. Customer top-ups are currently closed.';
    const list = el('div', { class: 'catalog-grid' });
    const count = el('p', { class: 'help catalog-count', role: 'status' });
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
  } catch { status.textContent = 'Availability could not be checked. Refresh this page before adding credit.'; }
}
if (typeof document !== 'undefined') loadCatalog();
