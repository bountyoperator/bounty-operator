// A small tree for markup that is built twice from the same code: as a string
// when the site is generated, and as DOM nodes when the page script redraws a
// section from newer data. render.mjs returns trees; nothing in it knows which
// of the two it is feeding.
//
// A node is { tag, attrs, children } or a string. A string is always text: it
// is escaped on the way to a string and set through a text node in the
// browser, so a program name can never become markup. The data on this page
// is written by third parties.

const SVG_TAGS = new Set(['svg', 'path', 'polyline', 'polygon', 'circle', 'line', 'rect', 'g']);
const VOID_TAGS = new Set(['input', 'br', 'hr', 'col']);

/**
 * @param {string} tag
 * @param {Record<string, string | number | boolean | null | undefined>} [attrs]  null, undefined and false are left out; true is a bare attribute.
 * @param {unknown[]} [children]  Nodes, strings and numbers; nested arrays are flattened; null, undefined and false are left out.
 */
export function h(tag, attrs = {}, children = []) {
  const kept = [];
  const walk = (child) => {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) child.forEach(walk);
    else kept.push(typeof child === 'object' ? child : String(child));
  };
  walk(children);
  for (const name of Object.keys(attrs)) {
    // The page's CSP refuses both, and a tree is never the place for them.
    if (name === 'style' || /^on/i.test(name)) throw new Error(`The attribute ${name} is not allowed.`);
  }
  return { tag, attrs, children: kept };
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ESCAPES[char]);

/** The tree as markup. */
export function toHtml(node) {
  if (Array.isArray(node)) return node.map(toHtml).join('');
  if (node === null || node === undefined || node === false) return '';
  if (typeof node !== 'object') return escape(node);
  const attrs = Object.entries(node.attrs)
    .filter(([, value]) => value !== null && value !== undefined && value !== false)
    .map(([name, value]) => (value === true ? ` ${name}` : ` ${name}="${escape(value)}"`))
    .join('');
  if (VOID_TAGS.has(node.tag)) return `<${node.tag}${attrs}>`;
  return `<${node.tag}${attrs}>${node.children.map(toHtml).join('')}</${node.tag}>`;
}

/** The tree as DOM nodes, in `doc`. */
export function toDom(node, doc = document) {
  if (typeof node !== 'object' || node === null) return doc.createTextNode(String(node ?? ''));
  const element = SVG_TAGS.has(node.tag) ? doc.createElementNS('http://www.w3.org/2000/svg', node.tag) : doc.createElement(node.tag);
  for (const [name, value] of Object.entries(node.attrs)) {
    if (value === null || value === undefined || value === false) continue;
    element.setAttribute(name, value === true ? '' : String(value));
  }
  for (const child of node.children) element.append(toDom(child, doc));
  return element;
}

/** Replaces what `target` holds with the tree (or trees). */
export function mount(target, tree, doc = document) {
  target.replaceChildren(...(Array.isArray(tree) ? tree : [tree]).filter(Boolean).map((node) => toDom(node, doc)));
}
