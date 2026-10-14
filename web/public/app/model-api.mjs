import { button, copyText, el } from './ui.mjs';

function familyMark(model) {
  const text = `${model.name ?? ''} ${model.source ?? ''}`;
  if (/qwen/i.test(text)) return 'Q';
  if (/deephat|deepseek/i.test(text)) return 'D';
  if (/dolphin|mistral/i.test(text)) return 'M';
  if (/orca|nex/i.test(text)) return 'O';
  if (/hermes|nous/i.test(text)) return 'H';
  if (/foundation|cisco/i.test(text)) return 'F';
  if (/cyberstrike/i.test(text)) return 'C';
  if (/glm|z-ai/i.test(text)) return 'Z';
  if (/gemma|google/i.test(text)) return 'G';
  if (/nemotron|nvidia/i.test(text)) return 'N';
  return (model.name ?? 'M').trim().charAt(0).toUpperCase();
}

function categoryPills(model) {
  const tags = model.tags ?? [];
  const pills = [];
  if (tags.includes('cybersecurity')) pills.push(el('span', { class: 'catalog-pill', dataset: { badge: 'cybersecurity' }, text: 'Cybersecurity' }));
  if (tags.includes('uncensored')) pills.push(el('span', { class: 'catalog-pill', dataset: { badge: 'low-refusal' }, text: 'Low refusal' }));
  if (!pills.length) pills.push(el('span', { class: 'catalog-pill', dataset: { badge: 'general' }, text: 'General' }));
  return pills;
}

function modelCard(model) {
  const copied = el('span', { role: 'status', class: 'help catalog-copied' });
  const copyButton = (label, value) => button({ label, size: 'sm', variant: 'secondary', attrs: { 'aria-label': `${label} for ${model.name}` }, onClick: async () => { copied.textContent = await copyText(value) ? `${label === 'Copy model ID' ? 'Model ID' : 'Base URL'} copied.` : 'Select and copy the value above.'; } });
  const rate = (label, value) => el('div', { class: 'catalog-rate' }, el('dt', { text: label }), el('dd', null, el('strong', { text: `$${value}` })));
  const hasTools = (model.capabilities ?? []).includes('tools');
  return el('section', { class: 'catalog-card', 'aria-label': model.name },
    el('div', { class: 'catalog-card__main' },
      el('div', { class: 'catalog-card__identity' },
        el('span', { class: 'catalog-mark', 'aria-hidden': 'true', text: familyMark(model) }),
        el('div', { class: 'catalog-card__titles' },
          el('h3', { text: model.name }),
          el('p', { class: 'catalog-card__sub' },
            el('code', { class: 'catalog-slug', text: model.id }),
            el('span', { class: 'catalog-meta', text: `${Math.round(model.context_length / 1024)}K ctx · ${hasTools ? 'Agent tools' : 'Chat only'}` }),
          ),
        ),
      ),
      el('div', { class: 'catalog-card__badges', 'aria-label': 'Model category' }, ...categoryPills(model)),
      el('dl', { class: 'catalog-rates' },
        rate('Input', model.pricing.input_per_million),
        rate('Output', model.pricing.output_per_million),
        rate('Min', model.pricing.minimum_request.toFixed(2)),
      ),
    ),
    el('details', { class: 'catalog-details' }, el('summary', { text: 'Connection & model details', 'aria-label': `Connection and model details for ${model.name}` }),
      model.description && el('p', { class: 'catalog-desc', text: model.description }),
      el('div', { class: 'catalog-connect' },
        el('div', null, el('p', { class: 'help', text: 'Model ID' }), el('code', { text: model.id }), copyButton('Copy model ID', model.id)),
        el('div', null, el('p', { class: 'help', text: 'Base URL' }), el('code', { text: 'https://bountyoperator.com/v1' }), copyButton('Copy base URL', 'https://bountyoperator.com/v1')),
      ),
      copied,
      el('p', { class: 'help', text: `${model.context_length.toLocaleString()} token context · ${model.max_output_tokens.toLocaleString()} maximum output · ${model.quantization} · ${(model.capabilities ?? []).map(value => value.replaceAll('_', ' ')).join(' · ')}` }),
      el('p', { class: 'help' }, 'Source: ', el('a', { href: `https://huggingface.co/${model.source.split('/').map(encodeURIComponent).join('/')}`, text: model.source, target: '_blank', rel: 'noopener noreferrer' }), ` · ${model.license} · `, el('a', { href: '/docs/model-api', text: 'Setup guide' })),
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
    status.textContent = result.enabled ? `${result.models.length} model${result.models.length === 1 ? '' : 's'} · one security stack.${result.topups_enabled ? '' : ' Customer top-ups are currently closed.'}` : 'The API is being prepared. Customer top-ups are currently closed.';
    const list = el('div', { class: 'catalog-grid' });
    const count = el('p', { class: 'help catalog-count', role: 'status' });
    const search = el('input', { id: 'catalog-search', class: 'input', type: 'search', placeholder: 'Search by model name, ID or family' });
    let selectedFilter = '';
    const filters = [['', 'All'], ['cybersecurity', 'Cybersecurity'], ['uncensored', 'Low refusal'], ['tools', 'Agent tools']];
    const filterButtons = filters.map(([value, label]) => button({ label: `${label} (${result.models.filter(model => !value || [...(model.tags ?? []), ...(model.capabilities ?? [])].includes(value)).length})`, size: 'sm', variant: 'secondary', attrs: { 'aria-pressed': value === '' ? 'true' : 'false' }, onClick: () => {
      selectedFilter = value;
      filterButtons.forEach((item, index) => item.setAttribute('aria-pressed', filters[index][0] === value ? 'true' : 'false'));
      render();
    } }));
    const render = () => {
      const query = search.value.trim().toLowerCase().replace(/\b(?:unfiltered|low[- ]refusal|abliterated)\b/g, 'uncensored');
      const models = result.models.filter((model) => {
        const labels = [...(model.tags ?? []), ...(model.capabilities ?? [])];
        return (!selectedFilter || labels.includes(selectedFilter)) && [model.id, model.name, model.source, model.description, ...labels].join(' ').toLowerCase().includes(query);
      });
      count.textContent = `${models.length} of ${result.models.length} models`;
      list.replaceChildren(...(models.length ? models.map(modelCard) : [el('p', { class: 'catalog-empty', text: 'No models match these filters.' })]));
    };
    search.addEventListener('input', render);
    catalog.replaceChildren(
      el('div', { class: 'catalog-filters' },
        el('div', { class: 'field' }, el('label', { class: 'label', for: 'catalog-search', text: 'Find a model' }), search),
        el('div', { class: 'catalog-filter-buttons', role: 'group', 'aria-label': 'Filter models' }, ...filterButtons),
      ), count, list,
    );
    render();
  } catch { status.textContent = 'Availability could not be checked. Refresh this page before adding credit.'; }
}
if (typeof document !== 'undefined') loadCatalog();
