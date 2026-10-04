/**
 * The result view: the verdict, the finding cards, the profile's own sections
 * as tables and lists, the manifest, and the actions on a finished review.
 *
 * Model output and pasted text are untrusted. Everything here is built with
 * createElement and textContent; no string is ever parsed as markup, and a URL
 * in a review is shown as text, never as a link.
 *
 * Exports
 *   initResults()                              render #wb-result from the store and keep it current
 *   For the modules that draw composite results (./dossier.mjs)
 *     reviewNodes(result, { files, idPrefix, head, skip })  -> { nodes, analysis }   one review as the Findings tab draws it
 *     inlineNodes(text, { analysis, files, manifest })      -> nodes   one line of review text, cited locations as chips
 *     registerResultBody(source, build)        draw the Findings tab for results of one source
 *     onResultDrawn(listener)                  listener({ target, result, readOnly }) after every draw
 *   Pure helpers (tested)
 *     analyse(result)                          -> { parsed, problems, problemAt, labels, refCount }
 *     sectionKey(title)                        -> 'checked and safe'
 *     orderSections(sections)                  -> { lead, tail }   which sections go above the findings
 *     sectionShape(section)                    -> { kind: 'table' | 'list' | 'fields' | 'blocks', … }
 *     sectionColumns(title, width)             -> string[] | null
 *     cellTone(text)                           -> 'observed' | 'unproven' | 'danger' | ''
 *     splitInline(text, labels)                -> [{ type: 'text' | 'code' | 'strong' | 'ref', … }]
 *     textBlocks(text)                         -> [{ type: 'p' | 'code', … }]
 *     issueMarkdown(result, analysis)          -> string
 *     manifestJson(result, analysis)           -> string
 *     packetFor(result, context, analysis)     -> string
 *     packetName(result, extension)            -> 'bounty-operator-report-20261002-1405.md'
 *     stageFileName(files, profileId)          -> 'stage-1-report.md'
 *
 * DOM this module owns: everything inside #wb-result. Stable hooks for other
 * modules and tests: .wb-result[data-source][data-parsed], #wb-result-tabs,
 * #panel-findings, #panel-raw, [data-action="copy|packet|manifest|issue|print"],
 * [data-next="<profile id>"], button.ref[data-ref], .finding[data-sev].
 */

import { VERIFY_URL, reviewPacket } from '../evidence.mjs';
import { checkRefs, defang, extractRefs, parseReview } from '../parse.mjs';
import { reviewProfile } from '../profiles.mjs';
import { PROVIDERS } from '../providers.mjs';
import { track } from './api.mjs';
import { EVENTS } from './events.mjs';
import { addEntries } from './files.mjs';
import { historyEnabled, saveReview } from './history.mjs';
import { openSource } from './source-pane.mjs';
import { workbench } from './state.mjs';
import { button, clear, copyText, download, el, formatBytes, formatDate, icon, notice, on, qs, qsa } from './ui.mjs';
import { leaveExample, say, setStep, view } from './workbench.mjs';

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

const VERDICT_LABELS = Object.freeze({
  submit: 'Submit',
  'rewrite-then-submit': 'Rewrite, then submit',
  'prove-first': 'Prove first',
  'hold-duplicate': 'Hold: duplicate',
  drop: 'Drop',
  'fix-before-deploy': 'Fix before deploy',
  'no-blocking-issues': 'No blocking issues',
});

const SEVERITY_LABELS = Object.freeze({ critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', info: 'Info', unrated: 'Unrated' });

const BASIS = Object.freeze({
  'proven-in-source': ['proven', 'Proven in source'],
  'needs-test': ['needs-test', 'Needs test'],
  'depends-on-unsupplied-code': ['unsupplied', 'Depends on unsupplied code'],
});

const SOURCE_LABELS = Object.freeze({
  ai: 'Hosted run',
  pasted: 'Pasted reply',
  example: 'Example',
  panel: 'Panel review',
  gauntlet: 'Gauntlet',
});

const PROBLEM_TEXT = Object.freeze({
  'unknown-file': 'This file was not supplied.',
  'line-out-of-range': 'These lines are outside the file.',
});

const COUNT_LABELS = Object.freeze([
  ['critical', 'critical', 'Critical'],
  ['high', 'high', 'High'],
  ['medium', 'medium', 'Medium'],
  ['hardening', 'hardening', 'Hardening'],
  ['checkedSafe', 'checked-safe', 'Checked safe'],
]);

// Column names for the sections the profiles define. A section whose rows have
// another width is shown without a header row.
const SECTION_COLUMNS = Object.freeze({
  hardening: [['Item', 'Location', 'Note']],
  'checked and safe': [['Item', 'Location', 'Why it holds']],
  'entry points': [['Entry point', 'Location', 'Reachable by', 'Effect'], ['Function', 'Location', 'Reachable by', 'Guard', 'Value']],
  invariants: [['Property', 'State', 'Evidence'], ['Property', 'Source', 'State', 'Evidence']],
  claims: [['Claim', 'Status', 'Location', 'What it says, and why']],
  'submission checks': [['Check', 'Result', 'Evidence or change']],
  'generic passages': [['Passage', 'Location', 'Replace with']],
  binding: [['Asset', 'Repository', 'Deployed revision', 'Proof revision', 'State', 'Evidence']],
  exclusions: [['Exclusion', 'Result', 'Evidence']],
  'impact row': [['Clause', 'Text', 'Artefact', 'State']],
  actors: [['Step', 'Actor', 'Decisive value', 'Class', 'Location']],
  intent: [['Line', 'Evidence', 'Reading']],
  counterfactual: [['Path', 'End state', 'What the bug step adds']],
  preconditions: [['State', 'Created by', 'Route from live state', 'Reachability']],
  overlap: [['Prior item', 'Class', 'In the prior material', 'In this code', 'Prior fix']],
  'own reports': [['Earlier report', 'Class', 'Invariant', 'New evidence']],
  'search strings': [['String', 'Where to run it']],
  steps: [['Step', 'Kind', 'Performed by', 'Location']],
  'poc checklist': [['Check', 'Result', 'Evidence or change']],
  'severity grid': [['Criterion', 'Result', 'Evidence']],
  'rejection reasons': [['Rank', 'Reason', 'Trigger', 'What flips it', 'State']],
  'removed claims': [['Removed text', 'Reason', 'What lets it back in']],
  queue: [['Rank', 'Root cause', 'Location', 'Detectors', 'Cost', 'Next check', 'Flags']],
  dropped: [['Detector', 'Count', 'Reason']],
  'needs context': [['Missing', 'Lead it settles']],
  stages: [['Stage', 'Verdict', 'Decided']],
  'to do': [['Order', 'Action', 'Artifact', 'Stage']],
  agreement: [['Finding', 'Agreement', 'Result', 'Settled by', 'Reported by']],
});

// Sections that support the findings rather than lead to them.
const TAIL_SECTIONS = new Set(['entry points', 'invariants', 'hardening', 'checked and safe', 'coverage', 'dropped', 'needs context', 'search strings']);

const CELL_TONES = Object.freeze({
  observed: ['pass', 'met', 'holds', 'satisfied', 'confirmed', 'clear', 'answered', 'reachable', 'bound', 'kept', 'executed', 'resolved'],
  danger: ['fail', 'broken', 'contradicted', 'not-met', 'not-satisfied', 'unreachable', 'not-bound', 'match', 'same-root'],
  unproven: ['overstated', 'unverifiable', 'not-supplied', 'not-shown', 'absent', 'mocked', 'narrated', 'open', 'not-stated', 'same-symptom-different-root'],
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function refKey(ref) {
  return `${ref.label}:${ref.start}-${ref.end}`;
}

/**
 * Parses a result and checks every cited location against its manifest.
 *
 * @param {{ review: string, manifest?: { label: string, lines?: number }[] }} result
 */
export function analyse(result) {
  const manifest = Array.isArray(result?.manifest) ? result.manifest : [];
  const labels = manifest.map((entry) => entry.label);
  const parsed = parseReview(result?.review ?? '', { labels });
  const problems = checkRefs(parsed, manifest);
  const problemAt = new Map(problems.map((entry) => [refKey(entry.ref), entry.problem]));
  const refCount = new Set(extractRefs(parsed.raw, labels).map(refKey)).size;
  return { parsed, problems, problemAt, labels, refCount };
}

/** "Checked and safe", "Checked & Safe" and "CHECKED-AND-SAFE (3)" are one key. */
export function sectionKey(title) {
  return String(title).toLowerCase().replaceAll('&', ' and ').replace(/\(\d+\)\s*$/, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Splits the sections into those shown above the findings (the profile's own
 * analysis) and those shown below them (supporting lists and coverage).
 */
export function orderSections(sections) {
  const lead = [];
  const tail = [];
  for (const section of sections ?? []) (TAIL_SECTIONS.has(sectionKey(section.title)) ? tail : lead).push(section);
  const rank = (section) => {
    const key = sectionKey(section.title);
    return key === 'coverage' ? 3 : key === 'checked and safe' ? 2 : key === 'hardening' ? 1 : 0;
  };
  tail.sort((a, b) => rank(a) - rank(b));
  return { lead, tail };
}

/** Column names for a known section whose rows are `width` cells wide. */
export function sectionColumns(title, width) {
  const options = SECTION_COLUMNS[sectionKey(title)];
  return options?.find((columns) => columns.length === width) ?? null;
}

/** The tone of a table cell that holds one of the format's fixed values. */
export function cellTone(text) {
  const value = String(text).trim().toLowerCase();
  if (!value || value.length > 32) return '';
  for (const [tone, values] of Object.entries(CELL_TONES)) {
    if (values.includes(value)) return tone;
  }
  return '';
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;

/**
 * Splits section text into paragraphs and fenced code blocks.
 *
 * @param {string} text
 * @returns {({ type: 'p', text: string } | { type: 'code', code: string, language: string })[]}
 */
export function textBlocks(text) {
  const blocks = [];
  let paragraph = [];
  let fence = null;
  let code = [];

  const flush = () => {
    const joined = paragraph.join('\n').trim();
    if (joined) blocks.push({ type: 'p', text: joined });
    paragraph = [];
  };

  for (const line of String(text ?? '').split('\n')) {
    if (fence) {
      const close = line.trim();
      if (close.startsWith(fence.marker[0].repeat(fence.marker.length)) && /^[`~]+$/.test(close)) {
        blocks.push({ type: 'code', code: code.join('\n'), language: fence.language });
        fence = null;
        code = [];
      } else {
        code.push(line);
      }
      continue;
    }
    const open = line.match(FENCE_OPEN);
    if (open) {
      flush();
      fence = { marker: open[1], language: open[2].toLowerCase() };
    } else if (!line.trim()) {
      flush();
    } else {
      paragraph.push(line);
    }
  }
  if (fence) blocks.push({ type: 'code', code: code.join('\n'), language: fence.language });
  flush();
  return blocks;
}

const FIELD = /^([A-Z][A-Za-z' /-]{0,40}):\s*(.*)$/;

function fieldLines(text) {
  const fields = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    if (/^ {0,3}(?:```|~~~)/.test(line)) return null;
    const match = line.match(FIELD);
    if (match) fields.push([match[1], match[2].trim()]);
    else if (fields.length) fields[fields.length - 1][1] += ` ${line.trim()}`;
    else return null;
  }
  return fields.length ? fields : null;
}

/**
 * How a section is drawn: a table, a list, labelled fields, or paragraphs and
 * code blocks.
 *
 * @param {{ title: string, rows: string[][] | null, text: string }} section
 */
export function sectionShape(section) {
  const rows = section.rows ?? [];
  if (rows.length) {
    const width = Math.max(...rows.map((row) => row.length));
    if (width === 1) return { kind: 'list', items: rows.map((row) => row[0]) };
    return { kind: 'table', width, rows: rows.map((row) => [...row, ...Array(width - row.length).fill('')]), columns: sectionColumns(section.title, width) };
  }
  const fields = fieldLines(section.text);
  if (fields) return { kind: 'fields', fields };
  return { kind: 'blocks', blocks: textBlocks(section.text) };
}

const REF_IN_TEXT = /(?<![A-Za-z0-9_./-])input-\d{1,3}(?:\/[^\s:;|,()[\]{}<>`'"*]{1,300})?(?::L?|#L)\d{1,9}(?!\d)(?:\s?[-‒-―]\s?L?\d{1,9}(?!\d))?/g;
const STRONG = /(\*\*[^*\n]+\*\*)/;

/**
 * Splits one line of review text into plain text, `code`, **strong** and
 * cited locations. Nothing else is interpreted: links and images stay text.
 *
 * @param {string} text
 * @param {string[]} [labels]
 */
export function splitInline(text, labels = []) {
  const tokens = [];
  const pushPlain = (value) => {
    for (const piece of value.split(STRONG)) {
      if (!piece) continue;
      if (piece.length > 4 && piece.startsWith('**') && piece.endsWith('**')) tokens.push({ type: 'strong', text: piece.slice(2, -2) });
      else tokens.push({ type: 'text', text: piece });
    }
  };
  const pushWithRefs = (value) => {
    let last = 0;
    for (const match of value.matchAll(REF_IN_TEXT)) {
      const [ref] = extractRefs(match[0], labels);
      if (!ref) continue;
      if (match.index > last) pushPlain(value.slice(last, match.index));
      tokens.push({ type: 'ref', ref });
      last = match.index + match[0].length;
    }
    if (last < value.length) pushPlain(value.slice(last));
  };

  for (const part of String(text ?? '').split(/(`[^`\n]+`)/)) {
    if (!part) continue;
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) {
      const inner = part.slice(1, -1);
      const refs = extractRefs(inner, labels);
      const cited = inner.trim().match(REF_IN_TEXT);
      const whole = refs.length === 1 && (inner.trim().startsWith(refs[0].label)
        || (cited?.length === 1 && cited[0] === inner.trim()));
      if (whole) tokens.push({ type: 'ref', ref: refs[0] });
      else tokens.push({ type: 'code', text: inner });
    } else {
      pushWithRefs(part);
    }
  }
  return tokens;
}

function stamp(timestamp) {
  const date = new Date(timestamp ?? Date.now());
  const valid = Number.isNaN(date.getTime()) ? new Date() : date;
  return valid.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
}

/** @param {{ profile?: { id: string }, timestamp?: string }} result */
export function packetName(result, extension = 'md') {
  const profile = String(result?.profile?.id ?? 'review').replace(/[^a-z0-9-]/gi, '') || 'review';
  return `bounty-operator-${profile}-${stamp(result?.timestamp)}.${extension}`;
}

/** The name the next profile sees this review under: stage-<n>-<profile>.md */
export function stageFileName(files, profileId) {
  const taken = new Set(files.map((file) => file.name));
  const stages = files.filter((file) => /^stage-\d+-[\w-]+\.md$/.test(file.name)).length;
  const profile = String(profileId).replace(/[^a-z0-9-]/gi, '') || 'review';
  for (let number = stages + 1; number < stages + 100; number += 1) {
    const name = `stage-${number}-${profile}.md`;
    if (!taken.has(name)) return name;
  }
  return `stage-${Date.now()}-${profile}.md`;
}

function providerLabel(id) {
  return PROVIDERS.find((entry) => entry.id === id)?.label ?? '';
}

/**
 * The Markdown packet for a result.
 *
 * @param {import('./state.mjs').WorkbenchResult} result
 * @param {Record<string, string>} context
 * @param {ReturnType<typeof analyse>} analysis
 */
export function packetFor(result, context, analysis = analyse(result)) {
  const input = {
    review: result.review,
    manifest: result.manifest ?? [],
    provider: providerLabel(result.provider),
    model: result.model ?? '',
    timestamp: result.timestamp,
    source: result.source ?? 'ai',
    profileId: result.profile?.id ?? 'general',
    parsed: analysis.parsed,
    refProblems: analysis.problems,
    stages: result.stages,
  };
  try {
    return reviewPacket({ ...input, context });
  } catch {
    // A Context field over its limit must not cost the user the packet.
    return reviewPacket({ ...input, context: {} });
  }
}

/** The manifest as JSON: what was reviewed, by what, with the SHA-256 of every file. */
export function manifestJson(result, analysis = analyse(result)) {
  return `${JSON.stringify({
    tool: 'Bounty Operator',
    created: result.timestamp ?? new Date().toISOString(),
    profile: result.profile ?? null,
    mode: result.mode ?? '',
    source: result.source ?? 'ai',
    provider: result.provider ?? '',
    model: result.model ?? '',
    verdict: analysis.parsed.ok ? analysis.parsed.verdict : '',
    files: result.manifest ?? [],
    verify: VERIFY_URL,
  }, null, 2)}\n`;
}

function refText(ref) {
  return ref.end !== ref.start ? `${ref.label}:${ref.start}-${ref.end}` : `${ref.label}:${ref.start}`;
}

/**
 * The review as an issue body: one section per finding with location, impact,
 * path, fix and test. Markup in the model's text is neutralised.
 *
 * @param {import('./state.mjs').WorkbenchResult} result
 * @param {ReturnType<typeof analyse>} analysis
 */
export function issueMarkdown(result, analysis = analyse(result)) {
  const { parsed } = analysis;
  if (!parsed.ok || !parsed.findings.length) return `${defang(result.review).trim()}\n`;

  const lines = [];
  const title = parsed.findings.length === 1 ? parsed.findings[0].title : parsed.headline || `${parsed.findings.length} findings`;
  lines.push(`# ${title}`, '');

  for (const finding of parsed.findings) {
    if (parsed.findings.length > 1) lines.push(`## ${finding.id}: ${finding.title}`, '');
    lines.push(`- Severity: ${finding.severity || 'unrated'}`);
    if (finding.basis) lines.push(`- Basis: ${finding.basis}`);
    if (finding.locations.length) lines.push(`- Location: ${finding.locations.map((ref) => `\`${refText(ref)}\``).join(', ')}`);
    lines.push('');
    if (finding.impact) lines.push('**Impact**', '', finding.impact, '');
    // The steps keep the numbers the review gave them: a path that starts at step 6 is not renumbered from 1.
    if (finding.path.length) lines.push('**Path**', '', ...finding.path.map((step, index) => `${(finding.pathStart ?? 1) + index}. ${step}`), '');
    if (finding.counterargument.objection) {
      const { objection, status, why } = finding.counterargument;
      lines.push('**Counterargument**', '', `${objection}${status ? ` (${status})` : ''}${why ? `: ${why}` : ''}`, '');
    }
    if (finding.gap) lines.push('**Evidence gap**', '', finding.gap, '');
    if (finding.fix) lines.push('**Fix**', '', finding.fix, '');
    if (finding.test) lines.push('**Test**', '', '```', finding.test, '```', '');
  }

  const by = [result.profile?.name, result.model].filter(Boolean).join(', ');
  lines.push('---', `Reviewed with Bounty Operator${by ? ` (${by})` : ''}. File hashes are in the review packet.`);
  return `${defang(lines.join('\n')).trim()}\n`;
}

// ---------------------------------------------------------------------------
// DOM builders
// ---------------------------------------------------------------------------

function chip(text, tone, extra = '') {
  return el('span', { class: ['chip', extra], dataset: { tone: tone || 'neutral' }, text });
}

function refNode(ref, context) {
  const lines = ref.end !== ref.start ? `:${ref.start}-${ref.end}` : `:${ref.start}`;
  const parts = [el('span', { class: 'ref__file', text: ref.label }), el('span', { class: 'ref__lines', text: lines })];
  const problem = context.problemAt.get(refKey(ref));

  if (problem) {
    return el('span', { class: 'ref wb-ref--bad', title: PROBLEM_TEXT[problem], dataset: { problem } },
      icon('warn'), parts, el('span', { class: 'visually-hidden', text: ` ${PROBLEM_TEXT[problem]}` }));
  }
  if (!context.files) return el('span', { class: 'ref', title: `${ref.label}${lines}` }, parts);
  return el('button', {
    class: 'ref',
    type: 'button',
    title: `${ref.label}${lines}`,
    'aria-label': `Show ${ref.label}, line${ref.end !== ref.start ? `s ${ref.start} to ${ref.end}` : ` ${ref.start}`}`,
    'aria-haspopup': 'dialog',
    dataset: { ref: `${ref.label}${lines}` },
    onClick: (event) => openSource(ref, { files: context.files, manifest: context.manifest, trigger: event.currentTarget }),
  }, parts);
}

function inline(text, context) {
  return splitInline(text, context.labels).map((token) => {
    if (token.type === 'code') return el('code', { text: token.text });
    if (token.type === 'strong') return el('strong', { text: token.text });
    if (token.type === 'ref') return refNode(token.ref, context);
    return token.text;
  });
}

/**
 * One line of review text as nodes: `code`, **strong** and cited locations as
 * chips, nothing else interpreted.
 *
 * @param {string} text
 * @param {{ analysis: ReturnType<typeof analyse>, files?: { name: string, content: string }[] | null, manifest?: { label: string }[] }} source
 * @returns {(Node | string)[]}
 */
export function inlineNodes(text, { analysis, files = null, manifest = [] }) {
  return inline(text, { ...analysis, files, manifest });
}

/**
 * The accessible name of a scrolling region. A region is a landmark, and two
 * landmarks with one name cannot be told apart in a landmark list: the name
 * carries the review it belongs to (`scope`, when a page draws several) and a
 * number from the second use on.
 */
function regionName(base, context) {
  const scoped = context?.scope ? `${context.scope}: ${base}` : base;
  if (!context) return scoped;
  context.regions ??= new Map();
  const seen = (context.regions.get(scoped) ?? 0) + 1;
  context.regions.set(scoped, seen);
  return seen === 1 ? scoped : `${scoped} (${seen})`;
}

function codeFigure(code, { name = '', wrap = false, label = 'Code', context = null } = {}) {
  const source = String(code ?? '').replace(/\r\n?/g, '\n').replace(/\n$/, '');
  const copy = el('button', { class: ['code__copy', !name && 'code__copy--corner'], type: 'button', 'data-copy': '' },
    icon('copy'), el('span', { 'data-copy-label': '', text: 'Copy' }));
  return el('figure', { class: ['code', wrap && 'code--wrap'] },
    name ? el('figcaption', { class: 'code__bar' }, el('span', { class: 'code__name', text: name }), copy) : null,
    el('pre', { class: 'code__pre', tabindex: '0', role: 'region', 'aria-label': regionName(name ? `${label}, ${name}` : label, context) },
      el('code', {}, source.split('\n').map((line) => el('span', { class: 'code__line', text: `${line}\n` })))),
    name ? null : copy);
}

function rail(kind, label, body, status) {
  return el('div', { class: 'rail', dataset: { rail: kind, status: status ?? null } },
    el('dt', { class: 'rail__label', text: label }),
    el('dd', { class: 'rail__body' }, body));
}

/** The Path as a numbered list that keeps the numbers the review gave its steps. */
function stepList(finding, context) {
  const list = el('ol', { class: 'steps' }, finding.path.map((step) => el('li', {}, inline(step, context))));
  const start = Number.isInteger(finding.pathStart) ? finding.pathStart : 1;
  if (start > 1) {
    list.setAttribute('start', String(start));
    // The numbers are drawn by the `step` counter of .steps, which the start attribute alone does not move.
    if (list.style) list.style.counterReset = `step ${start - 1}`;
  }
  return list;
}

function findingCard(finding, context) {
  const severity = Object.hasOwn(SEVERITY_LABELS, finding.severity) ? finding.severity : 'unrated';
  const basis = BASIS[finding.basis];
  // A page that draws several reviews gives each its own prefix, so the title ids stay unique.
  const titleId = `${context.idPrefix ?? 'wb'}-${finding.id.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-title`;
  const rows = [];

  if (finding.impact) rows.push(rail('impact', 'Impact', el('p', {}, inline(finding.impact, context))));
  if (finding.path.length) {
    rows.push(rail('observed', 'Observed', stepList(finding, context)));
  }
  if (finding.counterargument.objection) {
    const status = finding.counterargument.status === 'resolved' ? 'resolved' : 'open';
    rows.push(rail('counter', 'Counterargument', [
      el('p', { class: 'rail__quote' }, inline(finding.counterargument.objection, context)),
      el('p', { class: 'rail__answer' },
        el('span', { class: 'chip status', dataset: { status }, text: status === 'resolved' ? 'Resolved' : 'Open' }),
        el('span', {}, inline(finding.counterargument.why, context))),
    ], status));
  }
  rows.push(finding.gap
    ? rail('gap', 'Evidence gap', el('ul', { class: 'gaps' }, el('li', {}, inline(finding.gap, context))), 'open')
    : rail('gap', 'Evidence gap', el('p', { class: 'muted', text: 'None named.' }), 'none'));
  if (finding.fix) rows.push(rail('fix', 'Fix', el('p', {}, inline(finding.fix, context))));
  if (finding.test) rows.push(rail('test', 'Test', codeFigure(finding.test, { label: `Test for ${finding.id}`, context })));
  if (finding.next) rows.push(rail('next', 'Next', el('p', { class: 'rail__next' }, icon('arrow-right'), el('span', {}, inline(finding.next, context)))));

  return el('article', { class: 'finding', dataset: { sev: severity }, 'aria-labelledby': titleId },
    el('header', { class: 'finding__head' },
      el('div', { class: 'finding__tags' },
        el('span', { class: 'finding__id', text: finding.id }),
        el('span', { class: 'chip sev', dataset: { sev: severity }, text: SEVERITY_LABELS[severity] }),
        basis ? el('span', { class: 'chip status', dataset: { status: basis[0] }, text: basis[1] }) : null),
      el('h4', { class: 'finding__title', id: titleId }, inline(finding.title, context)),
      finding.locations.length
        ? el('ul', { class: 'finding__refs', 'aria-label': 'Locations' }, finding.locations.map((ref) => el('li', {}, refNode(ref, context))))
        : null),
    el('dl', { class: 'finding__rows' }, rows));
}

function dossier(parsed) {
  const total = parsed.findings.length;
  const headline = parsed.headline || (total ? `${total} finding${total === 1 ? '' : 's'}.` : 'No finding reported.');
  return el('header', { class: 'dossier' },
    el('div', { class: 'dossier__verdict' },
      el('span', { class: 'meta', text: 'Verdict' }),
      el('span', { class: 'chip verdict verdict--lg', dataset: { verdict: parsed.verdict }, text: VERDICT_LABELS[parsed.verdict] ?? parsed.verdict })),
    el('p', { class: 'dossier__headline', text: headline }),
    el('ul', { class: 'counts' }, COUNT_LABELS.map(([key, name, label]) => el('li', { dataset: { sev: name, zero: parsed.counts[key] === 0 ? true : null } },
      el('span', { class: 'counts__n', text: String(parsed.counts[key]) }),
      el('span', { class: 'counts__label', text: label })))));
}

function cell(text, context, first) {
  const tone = cellTone(text);
  const content = tone ? chip(text.trim(), tone) : inline(text, context);
  return first ? el('th', { scope: 'row' }, content) : el('td', {}, content);
}

function tableNode(title, shape, context) {
  return el('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': regionName(title, context) },
    el('table', { class: 'table table--dense' },
      shape.columns ? el('thead', {}, el('tr', {}, shape.columns.map((name) => el('th', { scope: 'col', text: name })))) : null,
      el('tbody', {}, shape.rows.map((row) => (isNoteRow(row)
        // A line the model wrote under the table, with no cells: it runs the width of the table.
        ? el('tr', {}, el('td', { colspan: String(row.length) }, inline(row[0], context)))
        : el('tr', {}, row.map((value, index) => cell(value, context, index === 0))))))));
}

/** A row that holds one cell of text in a table of several columns. */
function isNoteRow(row) {
  return row.length > 1 && row[0] !== '' && row.slice(1).every((value) => value === '');
}

/** Lines of a section that stand beside its rows: labelled fields as a list of fields, anything else as paragraphs. */
function proseNode(text, context) {
  if (!text) return null;
  const fields = fieldLines(text);
  if (fields) return fieldsNode(fields, context);
  const blocks = textBlocks(text).filter((block) => block.type === 'p');
  if (!blocks.length) return null;
  return el('div', { class: 'wb-prose' }, blocks.map((block) => el('p', {}, block.text.split('\n').flatMap((line, index) => [index ? el('br') : null, ...inline(line, context)]))));
}

function fieldsNode(fields, context) {
  return el('dl', { class: 'kv' }, fields.map(([label, value]) => el('div', { class: 'kv__row' },
    el('dt', { text: label }),
    el('dd', {}, cellTone(value) ? chip(value, cellTone(value)) : inline(value, context)))));
}

function sectionNode(section, context) {
  const shape = sectionShape(section);
  const heading = el('h4', { class: 'wb-section__title', text: section.title });
  let body;
  if (shape.kind === 'table') {
    // Lines the model wrote after the last row, with no cells, read as a list under the table
    // and wrap at the width of the page instead of the width of a scrolling table.
    let last = shape.rows.length;
    while (last > 1 && isNoteRow(shape.rows[last - 1])) last -= 1;
    const notes = shape.rows.slice(last);
    // What the model wrote around the rows stays on the card: above them what came first, below them the rest.
    body = [
      proseNode(section.lead, context),
      tableNode(section.title, { ...shape, rows: shape.rows.slice(0, last) }, context),
      proseNode(section.tail, context),
      notes.length ? el('ul', { class: 'wb-list' }, notes.map((row) => el('li', {}, inline(row[0], context)))) : null,
    ];
  } else if (shape.kind === 'list') {
    body = [
      proseNode(section.lead, context),
      el('ul', { class: 'wb-list' }, shape.items.map((item) => el('li', {}, inline(item, context)))),
      proseNode(section.tail, context),
    ];
  } else if (shape.kind === 'fields') {
    body = fieldsNode(shape.fields, context);
  } else {
    body = el('div', { class: 'wb-prose' }, shape.blocks.map((block) => (block.type === 'code'
      ? codeFigure(block.code, { name: block.language || 'text', wrap: ['markdown', 'md', 'text', ''].includes(block.language), label: section.title, context })
      : el('p', {}, block.text.split('\n').flatMap((line, index) => [index ? el('br') : null, ...inline(line, context)])))));
    if (!shape.blocks.length) return null;
  }
  return el('section', { class: 'wb-section', dataset: { section: sectionKey(section.title) } }, heading, body);
}

function manifestNode(result) {
  const manifest = result.manifest ?? [];
  if (!manifest.length) return null;
  return el('section', { class: 'wb-section', dataset: { section: 'files' } },
    el('h4', { class: 'wb-section__title', text: 'Files reviewed' }),
    el('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Files reviewed' },
      el('table', { class: 'table table--dense' },
        el('thead', {}, el('tr', {},
          el('th', { scope: 'col', text: 'File' }),
          el('th', { scope: 'col', class: 'num', text: 'Size' }),
          el('th', { scope: 'col', class: 'num', text: 'Lines' }),
          el('th', { scope: 'col', text: 'SHA-256' }))),
        el('tbody', {}, manifest.map((entry) => el('tr', {},
          el('th', { scope: 'row', class: 'mono', text: entry.label }),
          el('td', { class: 'num', text: formatBytes(entry.bytes) }),
          el('td', { class: 'num', text: Number.isFinite(entry.lines) ? entry.lines.toLocaleString('en-US') : '' }),
          el('td', { class: 'mono wb-hash', title: entry.sha256, text: entry.sha256 })))))),
    el('p', { class: 'fine' }, 'Check any file against this list at ', el('a', { class: 'link', href: '/tools/verify', text: 'the verifier' }), '. It runs in the browser.'));
}

/**
 * One review as the Findings tab draws it: the verdict head, the note on cited
 * locations, the profile's sections and the finding cards. For modules that
 * draw more than one review on a page (the gauntlet dossier, the panel).
 *
 * @param {import('./state.mjs').WorkbenchResult} result
 * @param {{ files?: { name: string, content: string }[] | null, analysis?: ReturnType<typeof analyse>, idPrefix?: string, head?: boolean, skip?: string[], scope?: string }} [options]
 *   `files` makes cited locations open; `head: false` leaves the verdict head out; `skip` lists section keys to leave out;
 *   `scope` names this review among several on one page ("Stage 3"), and prefixes the names of its scrolling regions.
 * @returns {{ nodes: Node[], analysis: ReturnType<typeof analyse> }}
 */
export function reviewNodes(result, { files = null, analysis = analyse(result), idPrefix = 'wb', head = true, skip = [], scope = '' } = {}) {
  const { parsed } = analysis;
  const context = { ...analysis, files, manifest: result.manifest ?? [], idPrefix, scope, regions: new Map() };
  const nodes = [];
  if (!parsed.ok) {
    nodes.push(el('pre', { class: 'wb-raw', tabindex: '0', text: result.review }));
    return { nodes, analysis };
  }

  const wanted = parsed.sections.filter((section) => !skip.includes(sectionKey(section.title)));
  const { lead, tail } = orderSections(wanted);
  if (head) nodes.push(dossier(parsed));
  if (analysis.refCount > 0) {
    const bad = analysis.problems.length;
    nodes.push(el('p', { class: 'wb-note', dataset: { tone: bad ? 'warn' : null } },
      icon(bad ? 'warn' : 'check'),
      bad
        ? `${bad} of ${analysis.refCount} cited locations ${bad === 1 ? 'does' : 'do'} not match the supplied files. ${bad === 1 ? 'It is' : 'They are'} marked.`
        : `${analysis.refCount === 1 ? 'The cited location resolves' : `All ${analysis.refCount} cited locations resolve`} to supplied lines.`));
  }
  for (const section of lead) {
    const node = sectionNode(section, context);
    if (node) nodes.push(node);
  }
  if (parsed.findings.length) {
    nodes.push(el('div', { class: 'findings stagger' }, parsed.findings.map((finding) => findingCard(finding, context))));
  }
  for (const section of tail) {
    const node = sectionNode(section, context);
    if (node) nodes.push(node);
  }
  return { nodes, analysis };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

let tab = 'findings';
let shownResult = null;

/** @type {Map<string, (result: object, shown: { files: object[] | null, readOnly: boolean, analysis: ReturnType<typeof analyse> }) => Node[] | null>} */
const bodies = new Map();
/** @type {Set<(drawn: { target: Element, result: object | null, readOnly: boolean }) => void>} */
const drawn = new Set();

/**
 * Lets another module draw the Findings tab for results of one source
 * ('gauntlet', 'panel'). `build(result, { files, readOnly, analysis })` returns
 * the nodes, or null to get the usual review.
 *
 * @param {string} source
 * @param {(result: object, shown: { files: object[] | null, readOnly: boolean, analysis: ReturnType<typeof analyse> }) => Node[] | null} build
 */
export function registerResultBody(source, build) {
  bodies.set(source, build);
}

/**
 * Calls `listener({ target, result, readOnly })` after every draw of #wb-result,
 * so another module can add controls to it.
 *
 * @param {(drawn: { target: Element, result: object | null, readOnly: boolean }) => void} listener
 */
export function onResultDrawn(listener) {
  drawn.add(listener);
}

function notifyDrawn(target, result, readOnly) {
  for (const listener of drawn) {
    try {
      listener({ target, result, readOnly });
    } catch (error) {
      console.error(error);
    }
  }
}

function current() {
  const saved = view.get().history;
  if (saved) {
    return { result: saved.result, context: saved.context ?? {}, files: null, readOnly: true, savedAt: saved.savedAt, packet: saved.packet };
  }
  const state = workbench.get();
  return { result: state.result, context: state.context, files: state.files, readOnly: false };
}

function selectTab(name, { focus = false } = {}) {
  tab = name;
  for (const control of qsa('#wb-result-tabs [role="tab"]')) {
    const selected = control.dataset.tab === name;
    control.setAttribute('aria-selected', String(selected));
    control.tabIndex = selected ? 0 : -1;
    if (selected && focus) control.focus();
  }
  for (const pane of qsa('#wb-result [role="tabpanel"]')) pane.hidden = pane.dataset.tab !== name;
}

function metaLine(result, shown) {
  const files = result.manifest?.length ?? 0;
  const items = [
    el('span', { class: 'wb-result__profile', text: result.profile?.name ?? 'Review' }),
    result.source === 'example'
      ? el('span', { class: 'chip status', dataset: { status: 'example' }, text: 'Example' })
      : chip(SOURCE_LABELS[result.source] ?? 'Review', result.source === 'ai' ? 'observed' : 'neutral'),
  ];
  const model = [providerLabel(result.provider), result.model].filter(Boolean).join(' / ');
  if (model) items.push(el('span', { class: 'mono wb-result__model', text: model }));
  items.push(el('span', { text: `${files} file${files === 1 ? '' : 's'}` }));
  const when = formatDate(shown.savedAt ?? result.timestamp, { time: true });
  if (when) items.push(el('time', { datetime: result.timestamp ?? '', text: when }));
  const tokens = result.usage && Number.isFinite(result.usage.output) ? `${Number(result.usage.input ?? 0).toLocaleString('en-US')} in · ${result.usage.output.toLocaleString('en-US')} out tokens` : '';
  if (tokens) items.push(el('span', { class: 'num', text: tokens }));
  return el('div', { class: 'wb-result__meta' }, items);
}

function actionsRow() {
  const action = (name, label, iconName, variant = 'secondary') => button({ label, icon: iconName, variant, size: 'sm', attrs: { 'data-action': name } });
  return el('div', { class: 'wb-result__actions no-print' },
    action('packet', 'Download packet', 'download', 'primary'),
    action('copy', 'Copy review', 'copy'),
    action('issue', 'Copy as issue', 'copy'),
    action('manifest', 'Manifest .json', 'hash'),
    action('print', 'Print or save PDF', 'file'));
}

function nextRow(result, shown) {
  if (shown.readOnly) return null;
  if (result.source === 'example') {
    return el('div', { class: 'wb-next no-print' },
      el('p', { class: 'wb-next__text', text: 'This is the bundled example. Your own files replace it.' }),
      el('div', { class: 'wb-actions' }, button({ label: 'Start my own review', variant: 'primary', iconEnd: 'arrow-right', attrs: { 'data-action': 'own' } })));
  }
  let profile;
  try {
    profile = reviewProfile(result.profile?.id);
  } catch {
    return null;
  }
  const next = profile.next.map((id) => {
    try {
      return reviewProfile(id);
    } catch {
      return null;
    }
  }).filter((entry) => entry && entry.listed);
  if (!next.length) return null;
  return el('div', { class: 'wb-next no-print' },
    el('p', { class: 'meta', text: 'Run next' }),
    el('p', { class: 'wb-next__text', text: 'This review travels with the next one as a stage file.' }),
    el('div', { class: 'wb-actions' }, next.map((entry) => button({ label: entry.name, iconEnd: 'arrow-right', attrs: { 'data-next': entry.id, title: entry.tagline } }))));
}

function render() {
  const target = qs('#wb-result');
  if (!target) return;
  const shown = current();
  const { result } = shown;
  clear(target);
  shownResult = null;

  if (!result) {
    target.append(el('div', { class: 'wb-empty' },
      el('p', { class: 'wb-empty__title', text: 'No result yet' }),
      el('p', { class: 'muted', text: 'Run a review, or open the example to see what one looks like.' }),
      el('div', {}, button({ label: 'Load the example', icon: 'play', attrs: { 'data-example': '' } }))));
    notifyDrawn(target, null, false);
    return;
  }

  const analysis = analyse(result);
  const { parsed } = analysis;
  shownResult = { ...shown, analysis };
  target.dataset.source = result.source ?? 'ai';
  target.dataset.parsed = String(parsed.ok);

  // Notices first: what the reader must know before trusting the page.
  const notices = [];
  if (shown.readOnly) {
    notices.push(notice('info', 'A saved review, read only', el('div', { class: 'stack stack--8' },
      el('p', { text: 'The source files were not saved, so cited lines cannot be opened.' }),
      el('div', {}, button({ label: 'Back to my work', size: 'sm', attrs: { 'data-action': 'leave-history' } })))));
  }
  if (result.refused) notices.push(notice('warn', 'The model declined to answer', 'Its reply is shown as written. A refusal is not counted against the daily review.'));
  if (result.truncated) notices.push(notice('warn', 'The answer was cut off', 'The model stopped before the end. What arrived is shown. The last finding ends where the answer stopped.'));
  if (!parsed.ok) notices.push(notice('info', 'Shown as written', 'The reply has no Verdict line in the review format, so it could not be split into findings.'));

  const tabs = el('div', { class: 'tabs no-print', id: 'wb-result-tabs', role: 'tablist', 'aria-label': 'Result view' },
    el('button', { class: 'tabs__tab', type: 'button', role: 'tab', id: 'tab-findings', 'aria-controls': 'panel-findings', dataset: { tab: 'findings' } },
      'Findings', el('span', { class: 'tabs__count', text: String(parsed.findings.length) })),
    el('button', { class: 'tabs__tab', type: 'button', role: 'tab', id: 'tab-raw', 'aria-controls': 'panel-raw', dataset: { tab: 'raw' }, text: 'Raw' }));

  const findings = el('div', { class: 'wb-result__body', id: 'panel-findings', role: 'tabpanel', 'aria-labelledby': 'tab-findings', dataset: { tab: 'findings' } });
  // A gauntlet or a panel run draws its own body; every other result is one review.
  const own = bodies.get(result.source)?.(result, { files: shown.files, readOnly: shown.readOnly, analysis });
  findings.append(...(own ?? reviewNodes(result, { files: shown.files, analysis }).nodes));
  const files = manifestNode(result);
  if (files) findings.append(files);

  const raw = el('div', { class: 'wb-result__body', id: 'panel-raw', role: 'tabpanel', 'aria-labelledby': 'tab-raw', dataset: { tab: 'raw' }, hidden: true },
    el('pre', { class: 'wb-raw', tabindex: '0', 'aria-label': 'The review as the model wrote it', text: result.review }));

  target.append(
    el('div', { class: 'wb-result__bar' }, metaLine(result, shown), actionsRow()),
    ...notices,
    tabs,
    findings,
    raw,
  );
  const next = nextRow(result, shown);
  if (next) target.append(next);
  selectTab(parsed.ok ? tab : 'findings');
  notifyDrawn(target, result, shown.readOnly);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function runNext(profileId) {
  const state = workbench.get();
  if (!state.result || state.busy) return;
  let profile;
  try {
    profile = reviewProfile(profileId);
  } catch {
    return;
  }
  const name = stageFileName(state.files, state.result.profile?.id ?? state.profile);
  const outcome = addEntries([{ name, content: state.result.review }], { quiet: true });
  if (!outcome.added.length) {
    say(`${name} ${outcome.errors[0]?.reason ?? 'was not added'}. Remove a file to make room, then pick the next profile.`, { error: true });
    return;
  }
  workbench.set((latest) => ({ profile: profile.id, mode: profile.mode === 'either' ? latest.mode : profile.mode, focus: '' }));
  setStep('files');
  say(`${profile.name} is selected. This review travels with it as ${name}.`, { tone: 'success', hold: true });
}

/** Hides every sibling branch of the workbench while printing, wherever the page puts it. */
function markForPrint(active) {
  const root = qs('#workspace');
  if (!root) return;
  for (const node of qsa('[data-wb-print-hide]')) node.removeAttribute('data-wb-print-hide');
  if (!active) return;
  for (let node = root; node && node !== document.body; node = node.parentElement) {
    for (const sibling of node.parentElement?.children ?? []) {
      if (sibling !== node && !['SCRIPT', 'STYLE', 'LINK'].includes(sibling.tagName)) sibling.setAttribute('data-wb-print-hide', '');
    }
  }
}

async function act(name) {
  if (!shownResult) return;
  const { result, context, analysis } = shownResult;

  if (name === 'copy') {
    const copied = await copyText(result.review);
    say(copied ? 'Review copied as Markdown.' : 'The browser refused the copy. Open the Raw tab and copy from there.', { tone: copied ? 'success' : 'warn' });
  } else if (name === 'issue') {
    const copied = await copyText(issueMarkdown(result, analysis));
    say(copied ? 'Copied as an issue body.' : 'The browser refused the copy.', { tone: copied ? 'success' : 'warn' });
  } else if (name === 'packet') {
    // A saved review hands back the packet it was saved with.
    download(packetName(result, 'md'), shownResult.packet || packetFor(result, context, analysis), 'text/markdown');
    track(EVENTS.PACKET_SAVED);
    say('Packet downloaded. It holds the review, the evidence and the SHA-256 of every file.', { tone: 'success' });
  } else if (name === 'manifest') {
    download(packetName(result, 'json'), manifestJson(result, analysis), 'application/json');
    say('Manifest downloaded.', { tone: 'success' });
  } else if (name === 'print') {
    selectTab('findings');
    window.print();
  } else if (name === 'own') {
    leaveExample();
    setStep('files');
    say('The example is gone. Load your own files.', { tone: 'success' });
  } else if (name === 'leave-history') {
    const state = workbench.get();
    view.set({ history: null });
    setStep(state.result ? 'results' : 'files');
  }
}

function remember(result) {
  if (!result || result.source === 'example' || view.get().example || !historyEnabled()) return;
  const analysis = analyse(result);
  saveReview({
    result,
    packet: packetFor(result, workbench.get().context, analysis),
    verdict: analysis.parsed.ok ? analysis.parsed.verdict : '',
    headline: analysis.parsed.headline,
    counts: analysis.parsed.counts,
  }).catch(() => {});
}

/** Wires the Result panel. Call after initWorkbench(). */
export function initResults() {
  const target = qs('#wb-result');
  if (!target) return;

  on(target, 'click', '[data-action]', (event, control) => {
    act(control.dataset.action);
  });
  on(target, 'click', '[data-next]', (event, control) => runNext(control.dataset.next));
  on(target, 'click', '[role="tab"]', (event, control) => selectTab(control.dataset.tab));
  on(target, 'keydown', '[role="tab"]', (event, control) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft' && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const order = ['findings', 'raw'];
    const at = order.indexOf(control.dataset.tab);
    const to = event.key === 'Home' ? 0 : event.key === 'End' ? order.length - 1 : (at + (event.key === 'ArrowRight' ? 1 : order.length - 1)) % order.length;
    selectTab(order[to], { focus: true });
  });

  window.addEventListener('beforeprint', () => markForPrint(workbench.get().step === 'results'));
  window.addEventListener('afterprint', () => markForPrint(false));
  // History was just switched on: the review on screen is the first one saved.
  qs('#workspace')?.addEventListener('wb:history', (event) => {
    if (event.detail?.enabled) remember(workbench.get().result);
  });

  workbench.select((state) => state.result, (result, previous) => {
    tab = 'findings';
    render();
    if (result && result !== previous) remember(result);
  });
  workbench.select((state) => state.files, () => {
    // Cited lines open from the files in the tab: redraw when they change under a kept result.
    if (workbench.get().result) render();
  });
  view.select((state) => state.history, () => {
    tab = 'findings';
    render();
  });
  render();
}
