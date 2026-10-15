// Behaviour for the report-template pages (/templates/*).
//
// 1. "Copy as Markdown": copies the template source that is already on the page,
//    then says where the filled draft goes next (data-template-copied) until
//    the next copy.
// 2. "Challenge the draft": hands a pasted draft to the workbench through
//    sessionStorage key "bo:handoff" and opens /#workspace. Every
//    data-handoff-go button hands it over, each with its own
//    data-handoff-profile and data-handoff-focus where it has them.
//
// One request: the first copy is counted by name (/tools/ping.mjs). It carries
// the event name and nothing of a draft. The DOM is built with createElement
// and textContent only.

import { ping } from '../tools/ping.mjs';

const HANDOFF_KEY = 'bo:handoff';
const WORKBENCH = '/#workspace';
const FILE_LIMIT_BYTES = 120000; // LIMITS.fileBytes in review-core.mjs
const COPIED_MS = 2000;

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

/** The template text as shown in the source block, without the trailing line feed. */
export function sourceText(block) {
  const text = block?.textContent ?? '';
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

const COPIED_NOTE = 'Copied to the clipboard.';

function setStatus(root, message) {
  const status = root.querySelector('[data-template-status]');
  if (status) status.textContent = message;
}

/** What the status line says after a copy: the page's own next step, or the plain note. */
export function copiedNote(status) {
  return status?.dataset?.templateCopied || COPIED_NOTE;
}

function selectContents(node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function wireCopy(root) {
  const block = root.querySelector('[data-template-source] pre');
  if (!block) return;

  // The source block has its own copy button, wired by /theme.js. It counts the same.
  block.closest('[data-template-source]')?.addEventListener('click', (event) => {
    if (event.target.closest?.('[data-copy]')) ping('template_copied');
  });

  for (const button of root.querySelectorAll('[data-template-copy]')) {
    const label = button.querySelector('.btn__label');
    const original = label?.textContent ?? '';

    button.addEventListener('click', async () => {
      ping('template_copied');
      try {
        await navigator.clipboard.writeText(sourceText(block));
        if (label) label.textContent = 'Copied';
        // The next step stays on screen until the next copy, which clears it
        // and writes it again.
        setStatus(root, '');
        setStatus(root, copiedNote(root.querySelector('[data-template-status]')));
        window.setTimeout(() => {
          if (label) label.textContent = original;
        }, COPIED_MS);
      } catch {
        // Clipboard access can be refused. Show the source and select it instead.
        const details = block.closest('details');
        if (details) details.open = true;
        selectContents(block);
        block.scrollIntoView({ block: 'nearest' });
        setStatus(root, 'Copying is blocked in this browser. The source is selected: press Ctrl+C or ⌘C.');
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Placeholders
// ---------------------------------------------------------------------------

/** Every distinct {placeholder} in the template source. */
export function placeholdersIn(template) {
  return [...new Set(String(template).match(/\{[^{}\n]+\}/g) ?? [])];
}

/** The template placeholders that are still present, word for word, in a draft. */
export function remainingPlaceholders(draft, placeholders) {
  const text = String(draft);
  return placeholders.filter((placeholder) => text.includes(placeholder));
}

// ---------------------------------------------------------------------------
// Handoff to the workbench
// ---------------------------------------------------------------------------

/** The object the workbench reads from sessionStorage. */
export function buildHandoff({ name, content, profile, focus, note }) {
  return {
    files: [{ name, content }],
    profile,
    focus,
    context: { notes: note },
  };
}

function showError(box, title, detail) {
  box.replaceChildren();
  if (!title) return;
  const icon = document.createElement('span');
  icon.className = 'icon icon--error';
  icon.setAttribute('aria-hidden', 'true');
  const content = document.createElement('div');
  content.className = 'notice__content';
  const heading = document.createElement('p');
  heading.className = 'notice__title';
  heading.textContent = title;
  const body = document.createElement('div');
  body.className = 'notice__body';
  body.textContent = detail;
  content.append(heading, body);
  box.append(icon, content);
}

/** The profile and focus a hand-off button sends: its own where it has them, else the panel's. */
export function handoffTarget(button, panel) {
  return {
    profile: button?.dataset?.handoffProfile || panel.dataset.handoffProfile,
    focus: button?.dataset?.handoffFocus || panel.dataset.handoffFocus,
  };
}

function wireHandoff(root) {
  const panel = root.querySelector('[data-handoff]');
  if (!panel) return;

  const input = panel.querySelector('[data-handoff-input]');
  const buttons = [...panel.querySelectorAll('[data-handoff-go]')];
  const state = panel.querySelector('[data-handoff-state]');
  const error = panel.querySelector('.tpl-check__error');
  if (!input || buttons.length === 0) return;

  // The report pages mark what is left to fill with {placeholders}; the Foundry
  // scaffold marks it with TODO, and its braces are Solidity.
  const source = sourceText(root.querySelector('[data-template-source] pre'));
  const placeholders = panel.dataset.handoffMarkers === 'todo' ? [] : placeholdersIn(source);
  let storageBlocked = false;

  const describe = () => {
    const draft = input.value;
    if (!state) return;
    if (!draft.trim()) {
      state.textContent = '';
      state.removeAttribute('data-state');
      return;
    }
    const left = remainingPlaceholders(draft, placeholders);
    const todos = (draft.match(/\bTODO\b/g) ?? []).length;
    const open = left.length + todos;
    if (open === 0) {
      state.textContent = 'No template placeholders left in the draft.';
      state.setAttribute('data-state', 'ok');
    } else {
      const first = left[0] ?? 'TODO';
      state.textContent = `${open} template ${open === 1 ? 'placeholder is' : 'placeholders are'} still in the draft. First: ${first}`;
      state.setAttribute('data-state', 'open');
    }
  };
  input.addEventListener('input', describe);
  describe();

  const handOver = (event, button) => {
    const draft = input.value;
    // With nothing pasted the link opens the workbench on the profile, as it does without script.
    // The same goes for a browser that refused the handoff once: the link still works.
    // A click with a modifier key opens a new tab, which has its own session storage: it follows the link too.
    if (!draft.trim() || storageBlocked || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();

    const bytes = new TextEncoder().encode(draft).length;
    if (bytes > FILE_LIMIT_BYTES) {
      showError(
        error,
        `The draft is ${Math.ceil(bytes / 1000)} KB. A review takes files up to ${FILE_LIMIT_BYTES / 1000} KB.`,
        'Trim the pasted output to the lines that carry the result, then send it again.',
      );
      return;
    }

    const handoff = buildHandoff({
      name: panel.dataset.handoffName,
      content: draft,
      ...handoffTarget(button, panel),
      note: panel.dataset.handoffNote,
    });
    try {
      window.sessionStorage.setItem(HANDOFF_KEY, JSON.stringify(handoff));
    } catch {
      storageBlocked = true;
      showError(error, 'This browser blocks session storage, so the draft cannot be handed over.', 'The draft is selected. Copy it, press the button again and paste it into the review that opens.');
      input.select();
      return;
    }
    showError(error, '', '');
    window.location.assign(WORKBENCH);
  };

  for (const button of buttons) button.addEventListener('click', (event) => handOver(event, button));
}

if (typeof document !== 'undefined') {
  wireCopy(document);
  wireHandoff(document);
}
