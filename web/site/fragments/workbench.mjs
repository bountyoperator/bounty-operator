// The workbench markup for the home page: the three-step shell and its dialogs.
//
// Everything here is static structure. The browser modules under
// web/public/app/ fill the lists (profiles, providers, evidence fields, files,
// the result) and own all behaviour. The ids and data attributes below are the
// contract between this markup and those modules; web/tests/app-core.test.mjs
// pins them.
//
// Use from a page module:
//
//   import { workbench, workbenchDialogs, workbenchStyles, workbenchScripts } from '../fragments/workbench.mjs';
//
//   export default {
//     path: '/',
//     styles: [...workbenchStyles],
//     scripts: [...workbenchScripts],
//     body: html`…${workbench()}…`,
//     overlays: workbenchDialogs(),
//   };
//
// Other controls on the page can drive the workbench without script of their own:
//   data-example[="<id>"]            loads the bundled example and opens the result
//   href="/?profile=<id>#workspace"  preselects a profile
//   href="/?start=report#workspace"  the same, for the hero button

import { button, checkbox, dialog, field, html, icon, input, progress, select, statusChip, stepper, textarea } from '../components.mjs';

// runners.css styles the gauntlet and panel rows and their result views (app/gauntlet.mjs, panel.mjs, dossier.mjs).
export const workbenchStyles = Object.freeze(['/css/workbench.css', '/css/runners.css']);
export const workbenchScripts = Object.freeze(['/app/main.mjs']);

/** The three steps, in order. `id` is the value of `data-step` and of the stored step. */
export const WORKBENCH_STEPS = Object.freeze([
  Object.freeze({ id: 'files', label: 'Load' }),
  Object.freeze({ id: 'review', label: 'Run' }),
  Object.freeze({ id: 'results', label: 'Result' }),
]);

function row({ label, labelFor, labelId, id, hidden = false, body, className }) {
  const heading = labelFor
    ? html`<h4 class="wb-row__label"${labelId ? html` id="${labelId}"` : ''}><label for="${labelFor}">${label}</label></h4>`
    : html`<h4 class="wb-row__label"${labelId ? html` id="${labelId}"` : ''}>${label}</h4>`;
  return html`<div class="wb-row${className ? ` ${className}` : ''}"${id ? html` id="${id}"` : ''}${hidden ? html` hidden` : ''}>
${heading}
<div class="wb-row__body">
${body}
</div>
</div>`;
}

function viaChoice({ value, title, text }) {
  return html`<label class="wb-pick wb-pick--wide"><input type="radio" name="wb-via" value="${value}"><span class="wb-pick__body"><span class="wb-pick__name">${title}</span><span class="wb-pick__tag">${text}</span></span></label>`;
}

function loadPanel() {
  const review = html`<div class="wb-profiles" id="wb-profiles"></div>
<div class="wb-detail" id="wb-profile-detail"></div>
<div class="wb-mode" id="wb-mode" hidden>
<div class="segmented" role="radiogroup" aria-label="Whose code this is">
<label class="segmented__option"><input type="radio" name="wb-mode" value="bounty"><span>A bounty target</span></label>
<label class="segmented__option"><input type="radio" name="wb-mode" value="own-code"><span>My own code</span></label>
</div>
<p class="help" id="wb-mode-help"></p>
</div>`;

  const files = html`<div class="wb-drop" id="wb-drop">
${icon('upload', { className: 'wb-drop__icon' })}
<p class="wb-drop__title">Drop files or a folder here</p>
<p class="fine" id="wb-drop-limits">Source and text files. 120 KB per file. 240 KB, 50 files and 20,000 lines in total.</p>
<div class="cluster cluster--tight wb-drop__actions">
${button({ label: 'Choose files', id: 'wb-pick-files', icon: 'file' })}
${button({ label: 'Choose a folder', id: 'wb-pick-folder', variant: 'quiet' })}
</div>
<input class="visually-hidden" type="file" id="wb-file-input" multiple tabindex="-1" aria-hidden="true">
<input class="visually-hidden" type="file" id="wb-folder-input" webkitdirectory multiple tabindex="-1" aria-hidden="true">
</div>
<details class="disclosure" id="wb-paste">
<summary class="disclosure__summary"><span class="wb-sum">Paste text</span><span class="disclosure__hint">Code, a draft report or tool output</span></summary>
<div class="disclosure__body stack stack--12">
${field({
    label: 'Text',
    for: 'wb-paste-text',
    control: textarea({ id: 'wb-paste-text', rows: 6, mono: true, attrs: { spellcheck: 'false', autocomplete: 'off' } }),
  })}
${field({
    label: 'File name',
    for: 'wb-paste-name',
    control: input({ id: 'wb-paste-name', mono: true, attrs: { spellcheck: 'false', autocomplete: 'off', maxlength: '240' } }),
    help: 'Named from what you paste. The review cites it by this name.',
  })}
<div>${button({ label: 'Add as a file', id: 'wb-paste-add', icon: 'plus' })}</div>
</div>
</details>
<details class="disclosure" id="wb-github">
<summary class="disclosure__summary"><span class="wb-sum">Import from GitHub</span><span class="disclosure__hint">A file, folder, repository or pull request link</span></summary>
<div class="disclosure__body stack stack--12">
<div class="field">
<label class="label" for="wb-github-url">GitHub link</label>
<div class="wb-inline">
${input({ id: 'wb-github-url', type: 'url', mono: true, placeholder: 'https://github.com/owner/repo/tree/main/src', attrs: { spellcheck: 'false', autocomplete: 'off', inputmode: 'url', 'aria-describedby': 'wb-github-help wb-github-status' } })}
${button({ label: 'Find files', id: 'wb-github-go', icon: 'search' })}
</div>
<p class="help" id="wb-github-help">Files are read at one exact commit, straight from GitHub to this tab.</p>
</div>
<details class="wb-sub" id="wb-github-private">
<summary class="wb-sub__summary">Private repository</summary>
${field({
    label: 'GitHub token',
    for: 'wb-github-token',
    control: input({ id: 'wb-github-token', type: 'password', mono: true, attrs: { spellcheck: 'false', autocomplete: 'off' } }),
    help: 'A read-only token. It goes to api.github.com from this tab and is forgotten on reload.',
  })}
</details>
<p class="wb-note" id="wb-github-status" role="status"></p>
</div>
</details>
<div class="notice notice--warn" id="wb-file-errors"></div>
<ul class="wb-files" id="wb-files" aria-label="Loaded files"></ul>
<div class="wb-meter" id="wb-meter" hidden></div>`;

  const focus = html`${textarea({ id: 'wb-focus', rows: 3, attrs: { maxlength: '16000', 'aria-describedby': 'wb-focus-help' } })}
<p class="help" id="wb-focus-help">Optional. Tell the review what to focus on. Left empty, it uses its standard request.</p>`;

  const evidence = html`<details class="disclosure" id="wb-evidence">
<summary class="disclosure__summary"><span class="wb-sum">Program rules and PoC details</span><span class="disclosure__hint" id="wb-evidence-status"></span></summary>
<div class="disclosure__body" id="wb-evidence-fields"></div>
</details>`;

  const check = html`<div class="wb-privacy" id="wb-privacy" tabindex="-1"></div>
<div class="wb-actions">
${button({ label: 'Preview the prompt', id: 'wb-preview', icon: 'eye' })}
${button({ label: 'Continue', id: 'wb-continue', variant: 'primary', iconEnd: 'arrow-right' })}
</div>`;

  return html`<div class="wb__panel" id="wb-panel-files" data-panel="files" role="group" aria-labelledby="wb-files-title">
<h3 class="wb__title" id="wb-files-title" tabindex="-1">Add your files</h3>
<div class="wb-sheet">
${row({ label: 'Review type', labelId: 'wb-profile-label', body: review })}
${row({ label: 'Files', body: files })}
${row({ label: 'Focus', labelFor: 'wb-focus', body: focus })}
${row({ label: 'Evidence', body: evidence })}
${row({ label: 'Check', body: check })}
</div>
</div>`;
}

function runPanel() {
  const summary = html`<div class="wb-summary">
<p class="wb-summary__text" id="wb-summary"></p>
${button({ label: 'Edit', variant: 'quiet', size: 'sm', attrs: { 'data-step-target': 'files' } })}
</div>`;

  const via = html`<div class="wb-picks wb-picks--wide" id="wb-via" role="radiogroup" aria-labelledby="wb-via-label">
${viaChoice({ value: 'connect', title: 'OpenRouter, one click', text: 'Connect your OpenRouter account. Every model, billed to your own credits.' })}
${viaChoice({ value: 'key', title: 'My own API key', text: 'Anthropic, OpenAI, Gemini, xAI, DeepSeek, Mistral, Groq or OpenRouter.' })}
${viaChoice({ value: 'export', title: 'My chat subscription', text: 'Copy the prompt into ChatGPT, Claude or Gemini and paste the reply back. Code security, Solidity and draft-report reviews only. No account, no daily limit.' })}
</div>`;

  const model = html`<div class="wb-fields">
<div class="field" id="wb-provider-field">
<label class="label" for="wb-provider">Provider</label>
${select({ id: 'wb-provider', options: [] })}
</div>
<div class="field">
<label class="label" for="wb-model">Model</label>
${input({ id: 'wb-model', mono: true, attrs: { list: 'wb-models', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', maxlength: '200', 'aria-describedby': 'wb-model-help wb-model-error' } })}
<datalist id="wb-models"></datalist>
<p class="help" id="wb-model-help"></p>
<p class="field-error" id="wb-model-error" role="alert" hidden></p>
</div>
<div class="wb-connect" id="wb-connect">
<div class="wb-connect__off" id="wb-or-off">
${button({ label: 'Connect OpenRouter', id: 'wb-or-connect', icon: 'key' })}
${checkbox({ id: 'wb-or-keep', label: 'Keep the key for this tab session, so a reload stays connected' })}
</div>
<div class="wb-connect__on" id="wb-or-on" hidden>
<p class="wb-connect__state"><span class="chip status" data-status="done">Connected</span><span id="wb-or-state">OpenRouter key held in this tab.</span></p>
${button({ label: 'Disconnect', id: 'wb-or-disconnect', variant: 'quiet', size: 'sm' })}
</div>
<p class="field-error" id="wb-or-error" role="alert" hidden></p>
</div>
<div class="field" id="wb-key-field">
<label class="label" for="wb-key" id="wb-key-label">API key</label>
<div class="wb-inline">
${input({ id: 'wb-key', type: 'password', mono: true, attrs: { spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', maxlength: '4096', 'aria-describedby': 'wb-key-help wb-key-error' } })}
${button({ label: 'Forget key', id: 'wb-key-forget', variant: 'quiet' })}
</div>
<p class="help" id="wb-key-help">Held in memory for this tab and sent with the review request. Never stored. <a class="link" id="wb-key-link" target="_blank" rel="noopener noreferrer" href="https://openrouter.ai/settings/keys">Create a key</a></p>
<p class="help wb-hint" id="wb-key-hint" role="status" hidden></p>
<p class="field-error" id="wb-key-error" role="alert" hidden></p>
</div>
</div>`;

  const run = html`<div class="wb-run-warn" id="wb-run-warn"></div>
<div class="wb-upgrade" id="wb-upgrade" hidden></div>
<div class="wb-actions" id="wb-run-actions">
${button({ label: 'Run review', id: 'wb-run', variant: 'primary', iconEnd: 'arrow-right' })}
<p class="fine wb-quota" id="wb-quota"></p>
</div>
<div class="wb-live" id="wb-live" hidden>
<div class="wb-live__head">
<span class="chip status" data-status="running">Running</span>
<span class="wb-live__clock num" id="wb-elapsed" aria-hidden="true">0:00</span>
<span class="wb-live__what" id="wb-live-what"></span>
${button({ label: 'Cancel', id: 'wb-cancel', variant: 'quiet', size: 'sm', icon: 'x' })}
</div>
<pre class="wb-live__text" id="wb-live-text" tabindex="0" role="log" aria-live="off" aria-label="The review as it is written"></pre>
</div>`;

  // The two Operator runs. app/gauntlet.mjs and app/panel.mjs fill and drive these rows.
  const liveBox = (name, label) => html`<div class="wb-live" id="wb-${name}-live" hidden>
<div class="wb-live__head">
<span class="chip status" data-status="running">Running</span>
<span class="wb-live__clock num" id="wb-${name}-elapsed" aria-hidden="true">0:00</span>
<span class="wb-live__what" id="wb-${name}-what"></span>
${button({ label: 'Cancel', id: `wb-${name}-cancel`, variant: 'quiet', size: 'sm', icon: 'x' })}
</div>
<pre class="wb-live__text" id="wb-${name}-text" tabindex="0" role="log" aria-live="off" aria-label="${label}"></pre>
</div>`;

  const gauntlet = html`<details class="disclosure">
<summary class="disclosure__summary">Eight-stage review ${statusChip('operator')}</summary>
<div class="disclosure__body">
<p class="wb-lead rn-lead">Eight stages on one finding, each reading the ones before it. The gates that end a report run first.</p>
<ol class="rn-pipe" id="wb-gauntlet-stages" aria-label="Gauntlet stages"></ol>
<div class="rn-note" id="wb-gauntlet-note"></div>
<div class="wb-actions" id="wb-gauntlet-actions">
${button({ label: 'Run the gauntlet', id: 'wb-gauntlet-run', icon: 'play' })}
<p class="fine wb-quota" id="wb-gauntlet-hint"></p>
</div>
${liveBox('gauntlet', 'The stage as it is written')}
</div></details>`;

  const panel = html`<details class="disclosure">
<summary class="disclosure__summary">Compare multiple models ${statusChip('operator')}</summary>
<div class="disclosure__body">
<p class="wb-lead rn-lead">Two to four models review the same files at once. One of them then cross-examines the reviews against the source and keeps what the code proves.</p>
<div class="rn-seats" id="wb-panel-seats" role="group" aria-label="Panel models"></div>
<div class="rn-note" id="wb-panel-note"></div>
<div class="wb-actions" id="wb-panel-actions">
${button({ label: 'Run the panel', id: 'wb-panel-run', icon: 'play' })}
<p class="fine wb-quota" id="wb-panel-hint"></p>
</div>
<div class="rn-streams" id="wb-panel-live" hidden></div>
</div></details>`;

  const prompt = html`<p class="wb-lead">Paste the prompt into a new chat with any model. It carries the method and your files, every line numbered.</p>
<div class="wb-actions">
${button({ label: 'Copy the prompt', id: 'wb-copy-prompt', variant: 'primary', icon: 'copy' })}
${button({ label: 'Download .md', id: 'wb-download-prompt', icon: 'download' })}
<p class="fine wb-quota" id="wb-prompt-size"></p>
</div>`;

  const reply = html`${textarea({ id: 'wb-reply', rows: 8, mono: true, placeholder: "Paste the model's whole reply here.", attrs: { spellcheck: 'false', autocomplete: 'off', 'aria-describedby': 'wb-reply-help' } })}
<p class="help" id="wb-reply-help">The result view and the packet are built in this tab. Nothing is sent.</p>
<div class="wb-fields">
${field({
    label: 'Model that answered',
    for: 'wb-reply-model',
    optional: true,
    control: input({ id: 'wb-reply-model', mono: true, placeholder: 'gpt-6-astra', attrs: { spellcheck: 'false', autocomplete: 'off', maxlength: '200' } }),
  })}
</div>
<div class="wb-actions">
${button({ label: 'Build the result', id: 'wb-reply-build', variant: 'primary', iconEnd: 'arrow-right' })}
</div>`;

  return html`<div class="wb__panel" id="wb-panel-review" data-panel="review" role="group" aria-labelledby="wb-review-title" hidden>
<h3 class="wb__title" id="wb-review-title" tabindex="-1">Run it on your model</h3>
<div class="wb-sheet">
${row({ label: 'Input', body: summary })}
${row({ label: 'Run with', labelId: 'wb-via-label', body: via })}
${row({ label: 'Model', id: 'wb-row-model', body: model })}
${row({ label: 'Run', id: 'wb-row-run', body: run })}
${row({ label: 'Gauntlet', id: 'wb-row-gauntlet', body: gauntlet })}
${row({ label: 'Panel', id: 'wb-row-panel', body: panel })}
${row({ label: 'Prompt', id: 'wb-row-prompt', hidden: true, body: prompt })}
${row({ label: 'Reply', labelFor: 'wb-reply', id: 'wb-row-reply', hidden: true, body: reply })}
</div>
</div>`;
}

function resultPanel() {
  return html`<div class="wb__panel" id="wb-panel-results" data-panel="results" role="group" aria-labelledby="wb-results-title" hidden>
<h3 class="wb__title" id="wb-results-title" tabindex="-1">Result</h3>
<div class="wb-result" id="wb-result"></div>
</div>`;
}

/**
 * The workbench section. Its title is an <h2>; the panel titles are <h3> and
 * the row labels <h4>, so it belongs directly under the page's <h1>.
 */
export function workbench({ title = 'Run a review', lede = 'Choose a review and add your files.' } = {}) {
  const steps = WORKBENCH_STEPS.map((step, index) => ({
    label: step.label,
    state: index === 0 ? 'current' : 'todo',
    attrs: { id: `wb-step-${step.id}`, 'data-step-target': step.id },
  }));

  return html`<section class="section wrap wb" id="workspace" aria-labelledby="wb-title" data-step="files">
<header class="wb__head">
<div class="wb__intro">
<h2 id="wb-title">${title}</h2>
<p class="lede">${lede}</p>
</div>
<div class="wb__tools no-print">
${button({ label: 'Load the example', id: 'wb-example', variant: 'quiet', size: 'sm', icon: 'play', attrs: { 'data-example': '' } })}
${button({ label: 'History', id: 'wb-history-open', variant: 'quiet', size: 'sm', icon: 'clock' })}
${button({ label: 'Clear', id: 'wb-clear', variant: 'quiet', size: 'sm', icon: 'trash' })}
</div>
</header>
<div class="wb__bar no-print">
${stepper({ label: 'Review steps', steps, className: 'wb__stepper' })}
${progress({ label: 'Review running', className: 'wb__progress' })}
<div class="notice notice--info wb__status" id="wb-status" role="status"></div>
</div>
${loadPanel()}
${runPanel()}
${resultPanel()}
<noscript><p class="notice notice--warn"><span class="notice__content">The workbench runs in the browser and needs JavaScript. The <a class="link" href="/mcp">MCP server</a> runs the same reviews from an editor.</span></p></noscript>
</section>`;
}

/** The workbench dialogs. Put them in the page's `overlays`. */
export function workbenchDialogs() {
  const github = dialog({
    id: 'wb-github-dialog',
    title: 'Import from GitHub',
    size: 'lg',
    body: html`<p class="wb-gh__source" id="wb-gh-source"></p>
<div class="wb-gh__filters">
<div class="field wb-gh__search">
<label class="label" for="wb-gh-search">Filter by path</label>
${input({ id: 'wb-gh-search', type: 'search', mono: true, placeholder: 'src/vault', attrs: { spellcheck: 'false', autocomplete: 'off' } })}
</div>
${checkbox({ id: 'wb-gh-skip', label: 'Skip tests, mocks and lib', checked: true })}
</div>
<div class="wb-gh__exts" id="wb-gh-exts" role="group" aria-label="File types"></div>
<div class="wb-gh__tree" id="wb-gh-tree" role="group" aria-label="Files in the repository"></div>
<p class="wb-note" id="wb-gh-note"></p>
<div class="notice notice--error" id="wb-gh-status" role="alert"></div>`,
    foot: html`<p class="wb-gh__meter num" id="wb-gh-meter" role="status"></p>
${button({ label: 'Cancel', variant: 'quiet', attrs: { 'data-close-dialog': '' } })}
${button({ label: 'Import', id: 'wb-gh-import', variant: 'primary' })}`,
  });

  const preview = dialog({
    id: 'wb-preview-dialog',
    title: 'The prompt your model receives',
    size: 'lg',
    body: html`<p class="wb-note" id="wb-preview-note"></p>
<figure class="code code--wrap wb-preview">
<pre class="code__pre" id="wb-preview-text" tabindex="0" role="region" aria-label="Prompt"></pre>
</figure>
<div class="notice notice--info" id="wb-preview-status" role="status"></div>`,
    foot: html`${button({ label: 'Download .md', id: 'wb-preview-download', icon: 'download' })}
${button({ label: 'Copy the prompt', id: 'wb-preview-copy', variant: 'primary', icon: 'copy' })}`,
  });

  const source = dialog({
    id: 'wb-source-dialog',
    title: 'Cited lines',
    size: 'lg',
    body: html`<div class="wb-source" id="wb-source-body"></div>`,
    foot: html`<p class="wb-gh__meter" id="wb-source-meta" role="status"></p>
${button({ label: 'Show the whole file', id: 'wb-source-all', variant: 'quiet' })}
${button({ label: 'Copy the lines', id: 'wb-source-copy', icon: 'copy' })}`,
  });

  const history = dialog({
    id: 'wb-history-dialog',
    title: 'Local history',
    size: 'md',
    body: html`${checkbox({ id: 'wb-history-on', label: 'Keep finished reviews in this browser' })}
<p class="help" id="wb-history-help">Off by default. When on, each finished review is saved in this browser as its packet and manifest. Source files and keys are never saved. Nothing is uploaded.</p>
<div class="notice notice--info" id="wb-history-status" role="status"></div>
<ul class="wb-history" id="wb-history-list" aria-label="Saved reviews"></ul>`,
    foot: html`${button({ label: 'Delete all', id: 'wb-history-clear', variant: 'danger' })}
${button({ label: 'Export all', id: 'wb-history-export', icon: 'download' })}`,
  });

  return html`${github}
${preview}
${source}
${history}`;
}
