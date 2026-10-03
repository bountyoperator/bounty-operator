// /benchmark: column sorting and a column picker for the leaderboard.
//
// The table is static markup generated from the results file and reads the
// same without this module. Sorting reorders the existing rows by their
// data-* values; the tier rows only make sense in the file's order, so they
// are hidden while another order is shown. Hidden columns are a list on the
// table's data-hide attribute, which the stylesheet reads. No markup is built
// from strings.

const ICONS = { ascending: 'icon--sort-up', descending: 'icon--sort-down', none: 'icon--sort' };
const STORE = 'bo-bench-hidden';

const table = document.getElementById('leaderboard');
const body = table?.tBodies[0];
const tools = document.querySelector('[data-lb-tools]');
const reset = tools?.querySelector('[data-lb-reset]');
const headers = table ? [...table.querySelectorAll('th[data-sort-key]')] : [];

function setDirection(header, direction) {
  header.setAttribute('aria-sort', direction);
  const icon = header.querySelector('.icon');
  if (icon) icon.className = `icon ${ICONS[direction]}`;
}

/** Rows in the order of the results file, tier rows in their places. */
function restore() {
  const rows = [...body.rows].filter((row) => row.classList.contains('lb__row'));
  rows.sort((a, b) => Number(a.dataset.order) - Number(b.dataset.order));
  const tiers = new Map([...body.rows].filter((row) => row.classList.contains('lb__tier')).map((row) => [row.dataset.tier, row]));
  const ordered = [];
  for (const row of rows) {
    const tier = tiers.get(row.dataset.tier);
    if (tier && !ordered.includes(tier)) ordered.push(tier);
    ordered.push(row);
  }
  body.append(...ordered);
  for (const row of tiers.values()) row.hidden = false;
  for (const header of headers) header.removeAttribute('aria-sort');
  for (const header of headers) {
    const icon = header.querySelector('.icon');
    if (icon) icon.className = `icon ${ICONS.none}`;
  }
  if (reset) reset.disabled = true;
}

function sortBy(header) {
  const key = header.dataset.sortKey;
  const better = header.dataset.better === 'ascending' ? 'ascending' : 'descending';
  const current = header.getAttribute('aria-sort');
  // The first press puts the better end first; a second press reverses.
  const direction = current === better ? (better === 'ascending' ? 'descending' : 'ascending') : better;
  const sign = direction === 'ascending' ? 1 : -1;
  const value = (row) => (row.dataset[key] === '' || row.dataset[key] === undefined ? null : Number(row.dataset[key]));

  const rows = [...body.rows].filter((row) => row.classList.contains('lb__row'));
  rows.sort((a, b) => {
    const x = value(a);
    const y = value(b);
    // A model with no value for the column goes last in either direction.
    if (x === null || y === null) return (x === null) - (y === null);
    return sign * (x - y) || Number(a.dataset.order) - Number(b.dataset.order);
  });
  for (const row of body.rows) if (row.classList.contains('lb__tier')) row.hidden = true;
  body.append(...rows);
  for (const other of headers) setDirection(other, other === header ? direction : 'none');
  if (reset) reset.disabled = false;
}

function readHidden() {
  try {
    const value = JSON.parse(localStorage.getItem(STORE) ?? '[]');
    return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

function writeHidden(list) {
  try {
    localStorage.setItem(STORE, JSON.stringify(list));
  } catch {
    // Storage is off: the choice lasts for this visit.
  }
}

function applyHidden(list) {
  table.dataset.hide = list.join(' ');
}

if (table && body && tools) {
  tools.hidden = false;
  for (const header of headers) {
    const button = header.querySelector('.table__sort');
    if (!button) continue;
    button.disabled = false;
    button.addEventListener('click', () => sortBy(header));
  }
  reset?.addEventListener('click', restore);

  const boxes = [...tools.querySelectorAll('[data-lb-col]')];
  const known = new Set(boxes.map((box) => box.dataset.lbCol));
  const hidden = readHidden().filter((key) => known.has(key));
  for (const box of boxes) {
    box.checked = !hidden.includes(box.dataset.lbCol);
    box.addEventListener('change', () => {
      const list = boxes.filter((entry) => !entry.checked).map((entry) => entry.dataset.lbCol);
      applyHidden(list);
      writeHidden(list);
    });
  }
  applyHidden(hidden);
}
