// Tab behaviour for the docs pages.
//
// Markup: a container with [data-tabs] holding one [role="tablist"] (the tabs()
// helper) and one panel per tab with id="panel-<id>". Without this script every
// panel is visible under its own heading, so the page still reads top to bottom.
// With it, one panel shows at a time and the arrow keys move between tabs.

const KEYS = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

function panelFor(tab) {
  const id = tab.getAttribute('aria-controls');
  return id ? document.getElementById(id) : null;
}

function select(tabs, chosen, { focus = false } = {}) {
  for (const tab of tabs) {
    const selected = tab === chosen;
    tab.setAttribute('aria-selected', selected ? 'true' : 'false');
    if (selected) tab.removeAttribute('tabindex');
    else tab.setAttribute('tabindex', '-1');
    const panel = panelFor(tab);
    if (panel) panel.hidden = !selected;
  }
  if (focus) chosen.focus();
}

function setUp(container) {
  const list = container.querySelector('[role="tablist"]');
  if (!list) return;
  const tabs = [...list.querySelectorAll('[role="tab"]')];
  if (!tabs.length) return;

  for (const tab of tabs) {
    const panel = panelFor(tab);
    if (!panel) continue;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', tab.id);
    panel.setAttribute('tabindex', '0');
  }

  // A link such as /mcp#codex opens that client's tab.
  const fromHash = tabs.find((tab) => tab.id === `tab-${window.location.hash.slice(1)}`);
  select(tabs, fromHash ?? tabs.find((tab) => tab.getAttribute('aria-selected') === 'true') ?? tabs[0]);
  container.setAttribute('data-ready', '');

  list.addEventListener('click', (event) => {
    const tab = event.target.closest('[role="tab"]');
    if (tab && list.contains(tab)) select(tabs, tab);
  });

  list.addEventListener('keydown', (event) => {
    const current = tabs.indexOf(document.activeElement);
    if (current === -1) return;
    let next = null;
    if (event.key in KEYS) next = (current + KEYS[event.key] + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    if (next === null) return;
    event.preventDefault();
    select(tabs, tabs[next], { focus: true });
  });
}

for (const container of document.querySelectorAll('[data-tabs]')) setUp(container);
