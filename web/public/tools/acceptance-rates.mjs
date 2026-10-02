// /tools/acceptance-rates: sorts the table and copies one row as Markdown.
// The table itself is static markup; this module only reorders its rows. The
// first sort or copy is counted by name (ping.mjs): no row and no tag is sent.

import { copyWithFeedback } from './dom.mjs';
import { ping } from './ping.mjs';

const PAGE = 'https://bountyoperator.com/tools/acceptance-rates';
const ICONS = { ascending: 'icon--sort-up', descending: 'icon--sort-down', none: 'icon--sort' };

const table = document.getElementById('rates');
const body = table?.tBodies[0];
const headers = table ? [...table.querySelectorAll('th[data-sort-key]')] : [];

function setDirection(header, direction) {
  header.setAttribute('aria-sort', direction);
  const icon = header.querySelector('.icon');
  if (icon) icon.className = `icon ${ICONS[direction]}`;
}

function sortBy(header) {
  const key = header.dataset.sortKey;
  const current = header.getAttribute('aria-sort');
  // Text starts A to Z, numbers start high to low; a second press reverses.
  const first = key === 'label' ? 'ascending' : 'descending';
  const direction = current === first ? (first === 'ascending' ? 'descending' : 'ascending') : first;
  const sign = direction === 'ascending' ? 1 : -1;

  const rows = [...body.rows].sort((a, b) => {
    if (key === 'label') return sign * a.dataset.label.localeCompare(b.dataset.label);
    const difference = Number(a.dataset[key]) - Number(b.dataset[key]);
    // Ties fall back to the larger sample, then the name, so the order is stable.
    return sign * difference || Number(b.dataset.total) - Number(a.dataset.total) || a.dataset.label.localeCompare(b.dataset.label);
  });
  body.append(...rows);
  for (const other of headers) setDirection(other, other === header ? direction : 'none');
}

/** "**Reentrancy**: 78% accepted (40 of 51 judged contest findings). Source: …#reentrancy" */
export function rowMarkdown(row) {
  const { label, rate, accepted, total } = row.dataset;
  return `**${label}**: ${rate}% accepted (${accepted} of ${total} judged contest findings). Source: ${PAGE}#${row.id}`;
}

if (table && body) {
  for (const header of headers) {
    header.querySelector('.table__sort')?.addEventListener('click', () => {
      sortBy(header);
      ping('tool_acceptance_rates');
    });
  }
  table.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('[data-copy-row]') : null;
    const row = button?.closest('tr');
    if (!row) return;
    copyWithFeedback(button, rowMarkdown(row));
    ping('tool_acceptance_rates');
  });
}
