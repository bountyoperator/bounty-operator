/**
 * DOM helpers for the browser app. Nothing here parses markup: text a model,
 * a file or a user wrote reaches the page through textContent only.
 *
 * Imports nothing. Safe to import under node (nothing touches `document`
 * until a function is called).
 *
 * Exports
 *   Build
 *     el(tag, props?, ...children)        -> HTMLElement   props may be left out: el('p', 'text')
 *     icon(name, { label }?)              -> <span class="icon icon--name">
 *     button({ label, variant, size, icon, iconEnd, iconOnly, block, type, id, disabled, className, attrs, onClick })
 *                                         -> <button class="btn …">
 *     notice(tone, title, body?)          -> <div class="notice notice--tone">
 *     clear(node)                         -> node, emptied
 *   Find and listen
 *     qs(selector, root?)                 -> Element | null
 *     qsa(selector, root?)                -> Element[]
 *     on(target, types, handler, options?)            -> off()
 *     on(target, types, selector, handler, options?)  -> off()   delegated: handler(event, matchedElement)
 *   State of a control
 *     setBusy(button, busy, label?)       running state: spinner, no clicks, focus kept
 *     isBusy(button)                      -> boolean
 *     focusFirst(root?, { preferInvalid, skip }?) -> Element | null
 *   Status line
 *     announce(message, { error, tone, target }?) -> Element | null
 *   Clipboard and files
 *     copyText(text)                      -> Promise<boolean>
 *     download(name, content, type?)      -> void
 *   Numbers and time
 *     formatBytes(bytes)                  -> '812 B' | '1.2 KB' | '120 KB' | '2.4 MB'
 *     toDate(value)                       -> Date | null   epoch seconds, epoch ms, ISO text or Date
 *     formatDate(value, { time, utc, locale }?) -> '2 Oct 2026' | '2 Oct 2026, 14:05' | ''   in the visitor's locale
 *     formatElapsed(ms)                   -> '0:07' | '12:34' | '1:02:03'
 *     formatCountdown(ms)                 -> 'now' | 'under a minute' | '12 min' | '3 h 5 min' | '2 d 4 h'
 *     timeUntil(value, now?)              -> milliseconds until `value`, never below 0
 *     startTimer(onTick, { interval }?)   -> stop() -> elapsed ms
 *   Dialogs
 *     dialogController(dialog, { initialFocus, returnFocus, backdropClose, canDismiss, onOpen, onClose }?)
 *                                         -> { element, open(), close(value?), isOpen, destroy() }
 *
 * el() props
 *   class | className   string, or an array whose falsy entries are skipped
 *   text                textContent
 *   dataset             { name: value }; null, undefined and false are skipped
 *   style               an object: { '--i': 3 }. A style string is refused (the CSP blocks style attributes).
 *   onClick, onInput, … a function: addEventListener('click' | 'input' | …)
 *   value, checked, selected, indeterminate   set as properties, after the children
 *   href, src, action, formaction, poster      kept only when the URL is http(s), mailto, or has no scheme;
 *                                              `src` also takes data:image/. Anything else is dropped.
 *   anything else       setAttribute (`for` or `htmlFor` for a label); `true` gives an empty attribute;
 *                       null, undefined and false are skipped
 *   Refused with an error: the markup properties (inner and outer HTML, html, srcdoc) and on… given as a string.
 *   target="_blank" gets rel="noopener noreferrer" unless rel is given.
 *   Children are nodes, strings, numbers or arrays of those; null, undefined and false are skipped.
 *
 * announce()
 *   Writes to the workbench status line, #wb-status, and sets its role:
 *   `status` (polite) for progress and results, `alert` for errors. When that
 *   element has the class `notice` it is filled like the notice component and
 *   takes the tone's class; otherwise it gets the text and data-tone. An empty
 *   message clears it. Inside a modal dialog the page behind is inert: pass
 *   `target` (an element or a selector) for a status line in the dialog.
 *
 * Wired elsewhere (do not wire again): /theme.js handles [data-theme-toggle],
 * [data-copy] on code blocks and [data-close-dialog].
 */

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

// Properties that would parse a string as markup.
const REFUSED_PROPS = new Set([...['inner', 'outer'].map((side) => `${side}HTML`), 'html', 'srcdoc']);
const PROPERTY_PROPS = new Set(['value', 'checked', 'selected', 'indeterminate']);
const URL_PROPS = new Set(['href', 'src', 'action', 'formaction', 'poster']);
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const SAFE_SCHEME = /^(?:https?|mailto):/i;
const IMAGE_DATA = /^data:image\/(?:png|jpeg|gif|webp|avif);/i;

/** True when a URL may be put in an attribute: http(s), mailto, or no scheme at all. */
function safeUrl(name, value) {
  // Browsers skip control characters and spaces inside a scheme.
  const compact = String(value).replace(/[\u0000- ]/g, '');
  if (!SCHEME.test(compact)) return true;
  if (SAFE_SCHEME.test(compact)) return true;
  return name === 'src' && IMAGE_DATA.test(compact);
}

function classNames(value) {
  return Array.isArray(value) ? value.flat().filter(Boolean).join(' ') : String(value);
}

function appendChildren(node, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false || child === true) continue;
    if (Array.isArray(child)) appendChildren(node, child);
    else node.append(typeof child === 'number' ? String(child) : child);
  }
}

/**
 * Creates an element. See "el() props" at the top of this file.
 *
 *   el('li', { class: 'file' }, el('span', { class: 'file__name', text: file.name }), formatBytes(size))
 *
 * @param {string} tag
 * @param {Record<string, unknown> | null} [props]
 * @param {...unknown} children
 * @returns {HTMLElement}
 */
export function el(tag, props, ...children) {
  const node = document.createElement(tag);
  const late = [];
  // el('p', 'text') and el('ul', items): the second argument is a child, not props.
  const isProps = props !== null && typeof props === 'object' && !Array.isArray(props) && typeof props.nodeType !== 'number';
  if (!isProps && props !== undefined && props !== null) {
    appendChildren(node, [props, ...children]);
    return node;
  }

  for (const [name, value] of Object.entries(props ?? {})) {
    if (REFUSED_PROPS.has(name)) throw new TypeError(`el() does not take "${name}". Build the nodes and pass them as children.`);
    if (value === null || value === undefined || value === false) continue;

    if (name === 'class' || name === 'className') {
      const names = classNames(value);
      if (names) node.className = names;
    } else if (name === 'text') {
      node.textContent = String(value);
    } else if (name === 'dataset') {
      for (const [key, entry] of Object.entries(value)) {
        if (entry !== null && entry !== undefined && entry !== false) node.dataset[key] = entry === true ? '' : String(entry);
      }
    } else if (name === 'style') {
      if (typeof value !== 'object') throw new TypeError('el() takes style as an object. The CSP blocks style attributes; prefer a class.');
      for (const [property, entry] of Object.entries(value)) node.style.setProperty(property, String(entry));
    } else if (/^on/i.test(name)) {
      if (typeof value !== 'function') throw new TypeError(`el() takes "${name}" as a function. The CSP blocks inline handlers.`);
      node.addEventListener(name.slice(2).toLowerCase(), value);
    } else if (PROPERTY_PROPS.has(name)) {
      late.push([name, value]);
    } else if (URL_PROPS.has(name)) {
      if (safeUrl(name, value)) node.setAttribute(name, String(value));
    } else {
      node.setAttribute(name === 'htmlFor' ? 'for' : name, value === true ? '' : String(value));
    }
  }

  if (props && props.target === '_blank' && !props.rel) node.setAttribute('rel', 'noopener noreferrer');
  appendChildren(node, children);
  // A <select> takes its value only once its options exist.
  for (const [name, value] of late) node[name] = value;
  return node;
}

/**
 * An icon, as the build-time helper emits it. Icons are CSS masks: no SVG.
 * Pass `label` when the icon is the only content of a control.
 *
 * @param {string} name  A name from the icon list in web/site/COMPONENTS.md.
 * @param {{ label?: string }} [options]
 * @returns {HTMLElement}
 */
export function icon(name, { label } = {}) {
  return label
    ? el('span', { class: `icon icon--${name}`, role: 'img', 'aria-label': label })
    : el('span', { class: `icon icon--${name}`, 'aria-hidden': 'true' });
}

/**
 * A button with the markup of the build-time `button()` helper, so setBusy()
 * and the stylesheet treat both alike.
 *
 *   button({ label: 'Run review', variant: 'primary', iconEnd: 'arrow-right', onClick: run })
 *
 * @param {{ label: string, variant?: 'primary' | 'secondary' | 'quiet' | 'danger', size?: 'sm' | 'md' | 'lg', icon?: string, iconEnd?: string, iconOnly?: boolean, block?: boolean, type?: string, id?: string, disabled?: boolean, className?: string, attrs?: Record<string, unknown>, onClick?: (event: MouseEvent) => void }} options
 * @returns {HTMLButtonElement}
 */
export function button({
  label,
  variant = 'secondary',
  size = 'md',
  icon: iconStart,
  iconEnd,
  iconOnly = false,
  block = false,
  type = 'button',
  id,
  disabled = false,
  className,
  attrs = {},
  onClick,
} = {}) {
  if (!label) throw new TypeError('button() needs a label. On an icon-only button it is the accessible name.');
  const classes = ['btn', `btn--${variant}`, size !== 'md' && `btn--${size}`, block && 'btn--block', iconOnly && 'btn--icon', className];
  const content = iconOnly
    ? [icon(iconStart ?? iconEnd), el('span', { class: 'visually-hidden', text: label })]
    : [iconStart && icon(iconStart), el('span', { class: 'btn__label', text: label }), iconEnd && icon(iconEnd)];
  return /** @type {HTMLButtonElement} */ (el('button', { class: classes, type, id, disabled, ...attrs, onClick }, content));
}

const NOTICE_ICONS = { info: 'info', success: 'ok', warn: 'warn', error: 'error' };

function noticeTone(tone) {
  return Object.hasOwn(NOTICE_ICONS, tone) ? tone : 'info';
}

function noticeContent(tone, title, body) {
  const content = el('div', { class: 'notice__content' }, title ? el('p', { class: 'notice__title', text: title }) : null);
  if (body !== null && body !== undefined && body !== '' && body !== false) {
    content.append(el('div', { class: 'notice__body' }, typeof body === 'string' ? el('p', { text: body }) : body));
  }
  return [icon(NOTICE_ICONS[tone]), content];
}

/**
 * A notice block, as the build-time `notice()` helper emits it.
 *
 * @param {'info' | 'success' | 'warn' | 'error'} tone
 * @param {string} title
 * @param {string | Node | null} [body]  Text, or nodes you built.
 * @returns {HTMLElement}
 */
export function notice(tone, title, body) {
  const kind = noticeTone(tone);
  return el('div', { class: `notice notice--${kind}`, role: kind === 'error' ? 'alert' : null }, noticeContent(kind, title, body));
}

/**
 * Removes every child of `node`.
 *
 * @template {Element} T
 * @param {T} node
 * @returns {T}
 */
export function clear(node) {
  node.replaceChildren();
  return node;
}

// ---------------------------------------------------------------------------
// Find and listen
// ---------------------------------------------------------------------------

/**
 * @param {string} selector
 * @param {ParentNode} [root]
 * @returns {Element | null}
 */
export function qs(selector, root = document) {
  return root.querySelector(selector);
}

/**
 * @param {string} selector
 * @param {ParentNode} [root]
 * @returns {Element[]}
 */
export function qsa(selector, root = document) {
  return [...root.querySelectorAll(selector)];
}

/**
 * Adds a listener and returns the function that removes it. `types` is one
 * event name or several separated by spaces.
 *
 *   on(form, 'input change', update);
 *   on(list, 'click', '[data-remove]', (event, button) => remove(button.dataset.remove));
 *
 * With a selector the listener is delegated: it runs for events that start
 * inside a descendant matching the selector, and receives that descendant.
 *
 * @param {EventTarget} target
 * @param {string} types
 * @param {string | ((event: Event) => void)} selectorOrHandler
 * @param {((event: Event, match: Element) => void) | AddEventListenerOptions | boolean} [handlerOrOptions]
 * @param {AddEventListenerOptions | boolean} [maybeOptions]
 * @returns {() => void}
 */
export function on(target, types, selectorOrHandler, handlerOrOptions, maybeOptions) {
  const delegated = typeof selectorOrHandler === 'string';
  const handler = delegated ? handlerOrOptions : selectorOrHandler;
  const options = delegated ? maybeOptions : handlerOrOptions;
  if (typeof handler !== 'function') throw new TypeError('on() needs a handler function.');

  const listener = delegated
    ? (event) => {
        const origin = typeof event.target?.closest === 'function' ? event.target : event.target?.parentElement;
        const match = origin?.closest?.(selectorOrHandler);
        if (match && (typeof target.contains !== 'function' || target.contains(match))) handler(event, match);
      }
    : handler;

  const names = String(types).split(/\s+/).filter(Boolean);
  for (const name of names) target.addEventListener(name, listener, options);
  return () => {
    for (const name of names) target.removeEventListener(name, listener, options);
  };
}

// ---------------------------------------------------------------------------
// State of a control
// ---------------------------------------------------------------------------

/** @type {WeakMap<Element, { label: string | null, ariaDisabled: string | null }>} */
const busyButtons = new WeakMap();

function blockClick(event) {
  event.preventDefault();
  event.stopImmediatePropagation();
}

/**
 * Puts a button in or out of its running state.
 *
 * Running sets aria-busy="true" (the stylesheet shows the spinner) and
 * aria-disabled="true", and swallows clicks, so a second press does nothing.
 * The button is not given the `disabled` attribute: it keeps keyboard focus
 * and screen readers still read it. Pass `label` to change the text while it
 * runs; the original text comes back when `busy` is false.
 *
 * @param {Element | null} button
 * @param {boolean} busy
 * @param {string} [label]
 * @returns {void}
 */
export function setBusy(button, busy, label) {
  if (!button) return;
  const labelNode = button.querySelector('.btn__label');
  const saved = busyButtons.get(button);

  if (busy) {
    if (!saved) {
      busyButtons.set(button, { label: labelNode ? labelNode.textContent : null, ariaDisabled: button.getAttribute('aria-disabled') });
      button.addEventListener('click', blockClick, true);
    }
    button.setAttribute('aria-busy', 'true');
    button.setAttribute('aria-disabled', 'true');
    if (label !== undefined && labelNode) labelNode.textContent = label;
    return;
  }

  if (!saved) return;
  busyButtons.delete(button);
  button.removeEventListener('click', blockClick, true);
  button.removeAttribute('aria-busy');
  if (saved.ariaDisabled === null) button.removeAttribute('aria-disabled');
  else button.setAttribute('aria-disabled', saved.ariaDisabled);
  if (labelNode && saved.label !== null) labelNode.textContent = saved.label;
}

/**
 * @param {Element | null} button
 * @returns {boolean}
 */
export function isBusy(button) {
  return Boolean(button) && button.getAttribute('aria-busy') === 'true';
}

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

function isShown(node) {
  return !node.closest('[hidden], [inert]') && node.getClientRects().length > 0;
}

/**
 * Moves focus into `root`: to its [autofocus] element, else to the first
 * control marked aria-invalid="true", else to the first focusable element,
 * else to `root` itself. Hidden and inert elements are passed over.
 *
 * @param {Element | Document} [root]
 * @param {{ preferInvalid?: boolean, skip?: string }} [options]  `skip` is a selector for elements to pass over.
 * @returns {Element | null} The element that took focus.
 */
export function focusFirst(root = document, { preferInvalid = true, skip = '' } = {}) {
  const usable = (node) => isShown(node) && !(skip && node.matches(skip));
  const candidates = [...root.querySelectorAll(FOCUSABLE)].filter(usable);
  const target =
    candidates.find((node) => node.hasAttribute('autofocus'))
    ?? (preferInvalid ? candidates.find((node) => node.getAttribute('aria-invalid') === 'true') : undefined)
    ?? candidates[0]
    ?? (typeof root.focus === 'function' ? root : null);
  if (!target) return null;

  if (target === root && !root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1');
  target.focus();
  return document.activeElement === target ? target : null;
}

// ---------------------------------------------------------------------------
// Status line
// ---------------------------------------------------------------------------

const STATUS_ID = 'wb-status';
const REANNOUNCE_MS = 40;
/** @type {WeakMap<Element, ReturnType<typeof setTimeout>>} */
const pendingAnnouncements = new WeakMap();

function statusLine(target) {
  if (target && typeof target === 'object') return target;
  if (typeof target === 'string') return document.querySelector(target);
  const found = document.getElementById(STATUS_ID);
  if (found) return found;
  // A page without the workbench still gets a live region for screen readers.
  const region = el('div', { id: STATUS_ID, class: 'visually-hidden', role: 'status' });
  document.body.append(region);
  return region;
}

/**
 * Writes a message to the status line. See "announce()" at the top of this file.
 *
 *   announce('Review running.');
 *   announce(error.message, { error: true });
 *   announce('Packet saved.', { tone: 'success' });
 *   announce('');   // clear
 *
 * @param {string | null | undefined} message
 * @param {{ error?: boolean, tone?: 'info' | 'success' | 'warn' | 'error', target?: Element | string }} [options]
 * @returns {Element | null} The status element, or null when `target` matched nothing.
 */
export function announce(message, { error = false, tone, target } = {}) {
  const node = statusLine(target);
  if (!node) return null;

  const kind = error ? 'error' : noticeTone(tone);
  const text = message === null || message === undefined ? '' : String(message);
  const asNotice = node.classList.contains('notice');

  const write = () => {
    node.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    node.dataset.tone = kind;
    if (asNotice) {
      for (const name of Object.keys(NOTICE_ICONS)) node.classList.toggle(`notice--${name}`, name === kind);
      node.replaceChildren(...(text ? noticeContent(kind, text) : []));
    } else {
      node.textContent = text;
    }
  };

  clearTimeout(pendingAnnouncements.get(node));
  pendingAnnouncements.delete(node);
  if (text !== '' && node.textContent === text) {
    // Screen readers stay silent when the same text is written twice: clear it, then write it.
    node.replaceChildren();
    pendingAnnouncements.set(node, setTimeout(write, REANNOUNCE_MS));
  } else {
    write();
  }
  return node;
}

// ---------------------------------------------------------------------------
// Clipboard and files
// ---------------------------------------------------------------------------

function topModal() {
  try {
    const open = document.querySelectorAll('dialog:modal');
    return open.length ? open[open.length - 1] : null;
  } catch {
    return document.activeElement?.closest?.('dialog[open]') ?? null;
  }
}

function legacyCopy(text) {
  const active = document.activeElement;
  const field = el('textarea', { class: 'visually-hidden', readonly: true, 'aria-hidden': 'true', tabindex: '-1' });
  field.value = text;
  // Inside a modal dialog the rest of the page is inert and cannot be selected.
  (topModal() ?? document.body).append(field);
  field.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  field.remove();
  if (active && typeof active.focus === 'function') active.focus({ preventScroll: true });
  return copied;
}

/**
 * Copies text to the clipboard. Uses the async Clipboard API, and a temporary
 * field with `execCommand('copy')` where that is missing or refused.
 * Resolves with whether the text was copied; it never rejects. Tell the user
 * with announce() or on the button itself.
 *
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export async function copyText(text) {
  const value = String(text ?? '');
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Permission refused, or the document is not focused: try the old way.
  }
  try {
    return legacyCopy(value);
  } catch {
    return false;
  }
}

function safeFileName(name) {
  const cleaned = String(name ?? '').replace(/[\u0000-\u001f\u007f\\/:*?"<>|]+/g, '-').replace(/^\.+/, '').trim();
  return cleaned.slice(0, 120) || 'download';
}

/**
 * Saves text (or a Blob) as a file through a temporary object URL.
 *
 * @param {string} name  Characters a file system refuses are replaced with "-".
 * @param {string | Blob} content
 * @param {string} [type]  MIME type for text content. Default text/plain.
 * @returns {void}
 */
export function download(name, content, type = 'text/plain') {
  const blob = typeof content === 'string' ? new Blob([content], { type: `${type};charset=utf-8` }) : content;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = safeFileName(name);
  anchor.className = 'visually-hidden';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------
// Numbers and time
// ---------------------------------------------------------------------------

/**
 * A byte count in the decimal units the limits are stated in (120 KB = 120,000 bytes).
 *
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  const value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (value < 1000) return `${Math.round(value)} B`;
  if (value < 99950) return `${(value / 1000).toFixed(1)} KB`;
  if (value < 999500) return `${Math.round(value / 1000)} KB`;
  if (value < 99950000) return `${(value / 1000000).toFixed(1)} MB`;
  return `${Math.round(value / 1000000)} MB`;
}

/**
 * A Date from what the Worker sends: epoch seconds (`created_at`), epoch
 * milliseconds, ISO text (`resetsAt`), or a Date. Null when it is none of these.
 *
 * @param {unknown} value
 * @returns {Date | null}
 */
export function toDate(value) {
  let date = null;
  if (value instanceof Date) date = value;
  // Epoch seconds stay below 1e11 until the year 5138; milliseconds passed it in 1973.
  else if (typeof value === 'number' && Number.isFinite(value)) date = new Date(Math.abs(value) < 1e11 ? value * 1000 : value);
  else if (typeof value === 'string' && value.trim() !== '') date = new Date(value);
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

/**
 * A date for display, in the visitor's locale and time zone: "2 Oct 2026",
 * or with `time` "2 Oct 2026, 14:05". Empty text for a value that is no date.
 *
 * @param {unknown} value  Anything toDate() takes.
 * @param {{ time?: boolean, utc?: boolean, locale?: string }} [options]
 * @returns {string}
 */
export function formatDate(value, { time = false, utc = false, locale } = {}) {
  const date = toDate(value);
  if (!date) return '';
  const options = { dateStyle: 'medium' };
  if (time) options.timeStyle = 'short';
  if (utc) options.timeZone = 'UTC';
  return new Intl.DateTimeFormat(locale, options).format(date);
}

function pad(value) {
  return String(value).padStart(2, '0');
}

/**
 * Elapsed time for a running timer: "0:07", "12:34", "1:02:03".
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatElapsed(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/**
 * A wait in words, for "opens in …": "now", "under a minute", "12 min",
 * "3 h 5 min", "2 d 4 h".
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatCountdown(ms) {
  const value = Number(ms) || 0;
  if (value <= 0) return 'now';
  if (value < 60000) return 'under a minute';
  const minutes = Math.floor(value / 60000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} d ${hours % 24} h` : `${days} d`;
}

/**
 * Milliseconds from `now` until `value`; 0 when it has passed or is no date.
 *
 *   formatCountdown(timeUntil(account.usage.resetsAt))
 *
 * @param {unknown} value  Anything toDate() takes.
 * @param {number} [now]
 * @returns {number}
 */
export function timeUntil(value, now = Date.now()) {
  const date = toDate(value);
  return date ? Math.max(0, date.getTime() - now) : 0;
}

/**
 * Calls `onTick(elapsedMs)` now and then every `interval` milliseconds.
 * Returns a function that stops the timer and returns the elapsed time.
 *
 *   const stop = startTimer((ms) => { clock.textContent = formatElapsed(ms); });
 *
 * @param {(elapsedMs: number) => void} onTick
 * @param {{ interval?: number }} [options]
 * @returns {() => number}
 */
export function startTimer(onTick, { interval = 1000 } = {}) {
  const started = Date.now();
  const tick = () => onTick(Date.now() - started);
  tick();
  const timer = setInterval(tick, interval);
  return () => {
    clearInterval(timer);
    return Date.now() - started;
  };
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

let scrollLocks = 0;
let scrollBefore = '';

/** The stylesheet locks the page with html:has(dialog:modal). This covers browsers without :has(). */
function cssLocksScroll() {
  try {
    return CSS.supports('selector(html:has(dialog:modal))');
  } catch {
    return false;
  }
}

function lockScroll() {
  if (cssLocksScroll()) return;
  if (scrollLocks === 0) {
    scrollBefore = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
  }
  scrollLocks += 1;
}

function unlockScroll() {
  if (scrollLocks === 0) return;
  scrollLocks -= 1;
  if (scrollLocks === 0) document.documentElement.style.overflow = scrollBefore;
}

// Safari does not focus a button when it is clicked, so the element that had
// focus when a dialog opened can be <body>, or a focusable ancestor of the
// button such as <main tabindex="-1">. The control that was just pressed is
// remembered, and focus goes back to it.
const PRESSABLE = 'button, a[href], summary, input, select, textarea, [tabindex]';
const PRESS_WINDOW_MS = 1000;
let lastPressed = null;
let lastPressedAt = 0;
let watchingPresses = false;

function watchPresses() {
  if (watchingPresses || typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
  watchingPresses = true;
  document.addEventListener(
    'pointerdown',
    (event) => {
      const origin = typeof event.target?.closest === 'function' ? event.target : event.target?.parentElement;
      lastPressed = origin?.closest?.(PRESSABLE) ?? null;
      lastPressedAt = Date.now();
    },
    true,
  );
}

// Watching starts with the module, not with the first controller: a dialog that
// is built when its button is first pressed must still know which button it was.
watchPresses();

function currentOpener() {
  const active = document.activeElement;
  const pressed = lastPressed && lastPressed.isConnected !== false && Date.now() - lastPressedAt < PRESS_WINDOW_MS ? lastPressed : null;
  // The press did not move focus to the control: focus is on <body> or on something that holds the control.
  if (pressed && active !== pressed && (!active || active === document.body || holds(active, pressed))) return pressed;
  if (active && active !== document.body) return active;
  return pressed;
}

/** True when `outer` is an ancestor of `inner`. */
function holds(outer, inner) {
  return outer !== inner && typeof outer?.contains === 'function' && outer.contains(inner);
}

function nativeLightDismiss() {
  return typeof HTMLDialogElement !== 'undefined' && 'closedBy' in HTMLDialogElement.prototype;
}

function resolveElement(value, root) {
  if (typeof value === 'function') return value(root);
  if (typeof value === 'string') return root.querySelector(value) ?? document.querySelector(value);
  return value ?? null;
}

/**
 * Controls one modal <dialog> built by the `dialog()` page helper.
 *
 *   const account = dialogController(qs('#account-dialog'), { onOpen: loadPortal });
 *   on(qs('#account-button'), 'click', () => account.open());
 *   const answer = await confirm.open();      // resolves with dialog.returnValue when it closes
 *
 * What it does
 *   open()   showModal(); the page behind stops scrolling; focus goes to
 *            `initialFocus`, else to [autofocus], else to the first control in
 *            the dialog body, else to the close button.
 *   close(value?)  closes with an optional returnValue.
 *   Escape, the close button ([data-close-dialog], wired by /theme.js) and a
 *   click on the backdrop close it. `backdropClose: false` turns the backdrop
 *   off. `canDismiss()` returning false keeps it open against Escape and the
 *   backdrop, for a step that must not be lost (a recovery code not yet saved).
 *   On close, focus returns to `returnFocus`, else to the element that had it
 *   when the dialog opened (in Safari, which does not focus a clicked button,
 *   to the control that was pressed).
 *
 * Dialogs stack: opening a second one over the first works, and the page
 * unlocks when the last one closes.
 *
 * @param {HTMLDialogElement} dialog
 * @param {{ initialFocus?: string | Element | ((dialog: HTMLDialogElement) => Element | null), returnFocus?: string | Element | (() => Element | null), backdropClose?: boolean, canDismiss?: () => boolean, onOpen?: (dialog: HTMLDialogElement) => void, onClose?: (returnValue: string) => void }} [options]
 * @returns {{ element: HTMLDialogElement, open: () => Promise<string>, close: (value?: string) => void, readonly isOpen: boolean, destroy: () => void }}
 */
export function dialogController(dialog, { initialFocus, returnFocus, backdropClose = true, canDismiss, onOpen, onClose } = {}) {
  if (!dialog || typeof dialog.showModal !== 'function') throw new TypeError('dialogController() needs a <dialog> element.');

  watchPresses();
  let opener = null;
  let locked = false;
  let pressedBackdrop = false;
  /** @type {Promise<string> | null} */
  let closed = null;
  /** @type {((value: string) => void) | null} */
  let settle = null;

  const mayDismiss = () => typeof canDismiss !== 'function' || canDismiss() !== false;

  // The page helper emits closedby="any". Without backdrop closing, only Escape and the button close it.
  if (!backdropClose) dialog.setAttribute('closedby', 'closerequest');
  const manualBackdrop = backdropClose && !(nativeLightDismiss() && dialog.getAttribute('closedby') === 'any');

  const onBackdrop = (event) => {
    if (event.target !== dialog) return false;
    const box = dialog.getBoundingClientRect();
    return event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
  };

  const offs = [
    on(dialog, 'cancel', (event) => {
      if (!mayDismiss()) event.preventDefault();
    }),
    on(dialog, 'close', () => {
      if (locked) {
        locked = false;
        unlockScroll();
      }
      const target = resolveElement(returnFocus, document) ?? opener;
      opener = null;
      // The browser returns focus by itself when it can. This covers an opener it lost track of.
      const active = document.activeElement;
      if (target?.isConnected && (!active || active === document.body || dialog.contains(active) || holds(active, target))) {
        target.focus({ preventScroll: true });
      }
      if (typeof onClose === 'function') onClose(dialog.returnValue);
      const done = settle;
      settle = null;
      closed = null;
      if (done) done(dialog.returnValue);
    }),
    // A drag that starts inside the dialog and ends on the backdrop is not a dismissal.
    on(dialog, 'pointerdown', (event) => {
      pressedBackdrop = onBackdrop(event);
    }),
    on(dialog, 'click', (event) => {
      const dismiss = manualBackdrop && pressedBackdrop && onBackdrop(event) && mayDismiss();
      pressedBackdrop = false;
      if (dismiss) dialog.close();
    }),
  ];

  function open() {
    if (dialog.open && closed) return closed;
    opener = currentOpener();
    dialog.returnValue = '';
    if (!dialog.open) dialog.showModal();
    if (!locked) {
      locked = true;
      lockScroll();
    }
    closed = new Promise((resolve) => {
      settle = resolve;
    });

    const first = resolveElement(initialFocus, dialog);
    if (first && typeof first.focus === 'function') first.focus();
    else {
      const body = dialog.querySelector('.dialog__body') ?? dialog;
      const marked = dialog.querySelector('[autofocus]');
      if (marked) marked.focus();
      else if (!body.querySelector(FOCUSABLE) || !focusFirst(body)) focusFirst(dialog);
    }
    if (typeof onOpen === 'function') onOpen(dialog);
    return closed;
  }

  function close(value) {
    if (!dialog.open) return;
    if (value === undefined) dialog.close();
    else dialog.close(String(value));
  }

  function destroy() {
    for (const off of offs) off();
    if (locked) {
      locked = false;
      unlockScroll();
    }
  }

  return {
    element: dialog,
    open,
    close,
    get isOpen() {
      return dialog.open;
    },
    destroy,
  };
}
