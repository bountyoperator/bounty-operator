// The Context block that travels with a review, and the packet a finished
// review is saved as.

import { INPUT_KINDS, reviewProfile } from './profiles.mjs';
import { defang, defangInline, shiftHeadings } from './parse.mjs';

/**
 * @typedef {object} Context
 * @property {string} [target]
 * @property {string} [scope]
 * @property {string} [version]  Deployed revision: commit, tag or address the files come from.
 * @property {'none' | 'local' | 'deployment' | ''} [proof]
 * @property {'unchecked' | 'searched' | 'overlap' | 'distinct' | ''} [prior]
 * @property {string} [notes]
 * @property {string} [rules]  Pasted programme rules or severity table.
 * @property {string} [impactList]  The programme's impact list, verbatim.
 * @property {string} [impactRow]  The impact row selected on the form, verbatim.
 * @property {string} [exclusions]  Out-of-scope list and trust statements.
 * @property {string} [proofRevision]  Repository, commit or address the proof ran on.
 * @property {'full' | 'shallow' | ''} [cloneDepth]  How much history the prior-art search covered.
 * @property {string} [ownHistory]  The hunter's earlier reports and notes on this programme.
 * @property {string} [actors]  Each attack step and precondition, with the actor behind it.
 * @property {string} [loss]  Measured loss: attacker net, victim loss against a control, duration.
 * @property {string} [proofLog]  Command, commit and captured output of the proof run.
 * @property {string} [mocks]  Every mock, fixture and impersonation the proof uses.
 * @property {string} [economics]  Fee, duplicate rule, programme age, date first reproduced.
 * @property {string} [readBack]  The stored submission as the platform renders it.
 *
 * @typedef {'target' | 'scope' | 'version' | 'proof' | 'prior' | 'notes' | 'rules'} BaseContextKey
 * @typedef {Required<Pick<Context, BaseContextKey>> & Omit<Context, BaseContextKey>} NormalizedContext
 *
 * @typedef {object} ContextField
 * @property {string} key
 * @property {string} label  The label the Context block prints.
 * @property {'line' | 'text' | 'choice'} kind  One line, pasted text, or one of `options`.
 * @property {number} [maxChars]
 * @property {readonly { value: string, label: string }[]} [options]
 * @property {string} hint  What to paste, for the form.
 * @property {string} noun  How the status line names the field.
 *
 * @typedef {object} PacketStage
 * @property {string} [profileId]
 * @property {string} [name]
 * @property {string} [model]
 * @property {string} [verdict]
 * @property {string} [headline]
 * @property {string} [review]
 *
 * @typedef {object} PacketInput
 * @property {string} review
 * @property {{ label: string, bytes: number, sha256: string, lines?: number }[]} [manifest]
 * @property {Context} [context]
 * @property {string} [provider]
 * @property {string} [model]
 * @property {string} [timestamp]
 * @property {'ai' | 'pasted' | 'example' | 'panel' | 'gauntlet'} [source]
 * @property {string} [profileId]
 * @property {{ ok: boolean, verdict: string, mode: string, headline: string }} [parsed]
 * @property {{ ref: { label: string, start: number, end: number }, problem: string }[]} [refProblems]
 * @property {PacketStage[]} [stages]
 */

export const VERIFY_URL = 'https://bountyoperator.com/tools/verify';

const PROOF_LABELS = Object.freeze({
  none: 'none supplied',
  local: 'local test or trace supplied',
  deployment: 'local proof, matched to the deployed version',
});

const PRIOR_LABELS = Object.freeze({
  unchecked: 'not checked',
  searched: 'searched, no match found',
  overlap: 'overlap found: same root cause, or a prior fix that covers it',
  distinct: 'related issue found, root cause differs',
});

const CLONE_LABELS = Object.freeze({
  full: 'full history, every branch, tag and pull request',
  shallow: 'shallow or single-branch clone',
});

const LINE_CHARS = 500;
const TEXT_CHARS = 16000;

function line(key, label, hint, noun = label.toLowerCase()) {
  return Object.freeze({ key, label, kind: 'line', maxChars: LINE_CHARS, hint, noun });
}

function text(key, label, hint, noun = label.toLowerCase()) {
  return Object.freeze({ key, label, kind: 'text', maxChars: TEXT_CHARS, hint, noun });
}

function choice(key, label, labels, hint, noun = label.toLowerCase()) {
  const options = Object.freeze(Object.entries(labels).map(([value, name]) => Object.freeze({ value, label: name })));
  return Object.freeze({ key, label, kind: 'choice', options, hint, noun });
}

/**
 * Every Context key, in the order the Context block prints them. The form asks
 * for a field with `label` and `hint`; `kind` says which control it takes.
 * `target`, `scope`, `version`, `proof`, `prior` and `notes` always print. Every
 * other field prints only when it was given.
 *
 * @type {readonly ContextField[]}
 */
export const CONTEXT_FIELDS = Object.freeze([
  line('target', 'Target', 'Programme or project, and the asset under review.'),
  line('scope', 'Scope', 'The scope line or asset-list entry that covers this code.'),
  line('version', 'Version', 'Deployed revision: the commit, tag or address the files come from.'),
  line('proofRevision', 'Proof revision', 'Repository, commit or address the proof ran on.'),
  choice('proof', 'Proof', PROOF_LABELS, 'What proof exists today.'),
  choice('prior', 'Prior art', PRIOR_LABELS, 'Where the prior-art search stands.', 'prior-art search'),
  choice('cloneDepth', 'Clone depth', CLONE_LABELS, 'Whether the search covered the full history or a shallow clone.'),
  text('notes', 'Notes', 'Anything else the reviewer should know.'),
  text('rules', 'Programme rules', 'Severity scale with thresholds, downgrade clauses, interaction bounds and the lowest paid tier.'),
  text('impactList', 'Impact list', "The programme's impact list, pasted verbatim."),
  line('impactRow', 'Selected impact row', 'The row ticked on the form, verbatim, with its severity.'),
  text('exclusions', 'Exclusions and trusted roles', 'The out-of-scope list and every trust statement.'),
  text('actors', 'Actors', 'Each attack step and precondition, with the actor behind it.'),
  text('loss', 'Measured loss', 'Attacker net after costs, victim loss against a control run, duration, recovery path.'),
  text('proofLog', 'Proof run', 'Command, commit and captured output. Fork or local.'),
  text('mocks', 'Mocks and fixtures', 'Every mock, fixture, impersonation and harness-set value in the proof.'),
  text('ownHistory', 'Own history', 'Your earlier reports on this programme with their closure reasons, and any earlier hold, severity or condition note.'),
  text('economics', 'Economics and clock', 'Fee per report, duplicate rule, programme age, date first reproduced.'),
  text('readBack', 'Read-back', 'The stored submission as the platform renders it, and the report id.'),
]);

const FIELD_BY_KEY = Object.freeze(Object.fromEntries(CONTEXT_FIELDS.map((field) => [field.key, field])));

/**
 * Context keys that hold free text. These are what the privacy scan reads.
 * @type {readonly string[]}
 */
export const CONTEXT_TEXT_KEYS = Object.freeze(
  CONTEXT_FIELDS.filter((field) => field.kind !== 'choice').map((field) => field.key),
);

// The keys every normalised Context carries, whatever was given.
const BASE_KEYS = new Set(['target', 'scope', 'version', 'proof', 'prior', 'notes', 'rules']);
const CHOICE_DEFAULTS = Object.freeze({ proof: 'none', prior: 'unchecked' });

const PROBLEM_LABELS = Object.freeze({
  'unknown-file': 'file was not supplied',
  'line-out-of-range': 'line is outside the file',
});

function normalizeChoice(field, value) {
  if (value == null || value === '') return CHOICE_DEFAULTS[field.key] ?? '';
  const values = field.options.map((option) => option.value);
  if (!values.includes(value)) {
    const listed = values.length > 2 ? `${values.slice(0, -1).join(', ')} or ${values.at(-1)}` : values.join(' or ');
    throw new Error(`Context ${field.key} must be ${listed}.`);
  }
  return value;
}

function normalizeText(field, value) {
  if (typeof value !== 'string') throw new Error(`Context ${field.key} must be text.`);
  if (value.length > field.maxChars) throw new Error(`Context ${field.key} exceeds ${field.maxChars} characters.`);
  // A one-line field stays one line, so it cannot pass for the field printed below it.
  return field.kind === 'line' ? value.trim().replace(/\s*[\r\n]+\s*/g, ' ') : value.trim();
}

/**
 * Returns the Context with defaults filled in. `target`, `scope`, `version`,
 * `proof`, `prior`, `notes` and `rules` are always present. Every other key is
 * present only when it was given a value. Unknown keys are left out.
 * Throws when a field has the wrong type, an unknown option or is too long.
 *
 * @param {Context | null} [context]
 * @returns {NormalizedContext}
 */
export function normalizeContext(context) {
  /** @type {Record<string, unknown>} */
  const source = context && typeof context === 'object' ? context : {};
  /** @type {Record<string, string>} */
  const normalized = {};

  for (const field of CONTEXT_FIELDS) {
    const value = field.kind === 'choice'
      ? normalizeChoice(field, source[field.key])
      : normalizeText(field, source[field.key] ?? '');
    if (value || BASE_KEYS.has(field.key)) normalized[field.key] = value;
  }
  return /** @type {NormalizedContext} */ (normalized);
}

/** One field as it prints: its label, then the value on the same line or on the lines below. */
function fieldText(field, value) {
  if (field.kind === 'choice') return `${field.label}: ${field.options.find((option) => option.value === value).label}`;
  if (field.kind === 'line') return `${field.label}: ${value}`;
  return `${field.label}:\n${value}`;
}

/**
 * The parts of the Context block: the heading, then one entry per printed
 * field. `guard` is applied to every entry that carries the user's own text.
 */
function contextParts(context, mode, guard = (entry) => entry) {
  const value = normalizeContext(context);
  const parts = ['## Context'];
  if (mode) parts.push(guard(`Mode: ${mode}`));

  for (const field of CONTEXT_FIELDS) {
    const given = value[field.key];
    if (given) parts.push(guard(fieldText(field, given)));
    else if (field.key === 'notes') parts.push('Notes:\nnone');
    else if (field.kind === 'line' && BASE_KEYS.has(field.key)) parts.push(`${field.label}: not given`);
  }
  return parts;
}

/**
 * The Context block as the model sees it. Pass `mode` to include the Mode line
 * that selects the verdict vocabulary.
 *
 * @param {Context | null} [context]
 * @param {string} [mode]
 * @returns {string}
 */
export function evidenceNotes(context, mode = '') {
  return contextParts(context, mode).join('\n');
}

const CONTEXT_NEED = 'context:';
const INPUT_NEED = 'input:';

/**
 * What a profile asks for, split into the files to supply and the Context
 * fields to fill, each with the label and hint the form shows.
 *
 * @param {string} [profileId]
 * @returns {{ inputs: { id: string, label: string, hint: string }[], context: ContextField[] }}
 */
export function profileNeeds(profileId = 'general') {
  const { needs } = reviewProfile(profileId);
  const inputs = needs
    .filter((need) => need.startsWith(INPUT_NEED))
    .map((need) => need.slice(INPUT_NEED.length))
    .map((id) => ({ id, ...INPUT_KINDS[id] }));
  const context = needs
    .filter((need) => need.startsWith(CONTEXT_NEED))
    .map((need) => FIELD_BY_KEY[need.slice(CONTEXT_NEED.length)]);
  return { inputs, context };
}

function isGiven(value, key) {
  if (key === 'proof') return value.proof !== 'none';
  if (key === 'prior') return value.prior !== 'unchecked';
  return Boolean(value[key]);
}

/**
 * The Context keys a profile asks for that are still empty, in form order.
 * `proof` counts as empty while it is `none`, `prior` while it is `unchecked`.
 *
 * @param {Context | null} [context]
 * @param {string} [profileId]
 * @returns {string[]}
 */
export function missingContext(context, profileId = 'general') {
  const value = normalizeContext(context);
  const wanted = new Set(profileNeeds(profileId).context.map((field) => field.key));
  return CONTEXT_FIELDS
    .filter((field) => wanted.has(field.key) && field.key !== 'notes' && !isGiven(value, field.key))
    .map((field) => field.key);
}

/**
 * One line for the form: what the Context still lacks. With `profileId` the
 * line names the fields that profile asks for; without it, the four fields
 * every bounty review reads.
 *
 * @param {Context | null} [context]
 * @param {string} [mode]
 * @param {string} [profileId]
 * @returns {string}
 */
export function evidenceStatus(context, mode = 'bounty', profileId = '') {
  const value = normalizeContext(context);
  if (mode === 'own-code') {
    return value.version ? 'Context complete.' : 'Not yet given: version.';
  }
  if (value.prior === 'overlap') return 'Overlapping prior art recorded. Expect hold-duplicate.';

  const keys = profileId
    ? missingContext(value, profileId)
    : ['scope', 'version', 'proof', 'prior'].filter((key) => !isGiven(value, key));
  const missing = keys.map((key) => FIELD_BY_KEY[key].noun);
  return missing.length ? `Not yet given: ${missing.join(', ')}.` : 'Context complete.';
}

/** `2026-10-02` from an ISO timestamp, or '' when the value is not one. */
function isoDay(timestamp) {
  const match = /^(\d{4}-\d{2}-\d{2})(?:T|$)/.exec(String(timestamp ?? ''));
  return match ? match[1] : '';
}

function producedBy({ source, provider, model, stages, timestamp }) {
  const engine = [provider, model].filter(Boolean).join(' / ');
  const count = Array.isArray(stages) ? stages.length : 0;
  switch (source) {
    case 'example': {
      // A bundled example is a stored model answer: the packet names the model and the day it answered.
      if (!engine) return 'Bundled example, written by hand. No model was called.';
      const day = isoDay(timestamp);
      return `Bundled example: a stored answer generated by ${engine}${day ? ` on ${day}` : ''}. No model was called now.`;
    }
    case 'pasted':
      return engine ? `Reply pasted from the user's own chat model (${engine}).` : "Reply pasted from the user's own chat model.";
    case 'panel':
      return `Panel review: ${count} model reviews, cross-examined by ${engine || 'the merge model'}.`;
    case 'gauntlet':
      // A run that the first gate ended has one stage.
      return `Gauntlet: ${count} ${count === 1 ? 'stage' : 'stages'}, final verdict by ${engine || 'the review model'}.`;
    default:
      return `Hosted review by ${engine || 'the selected model'}.`;
  }
}

// A line that reads as a packet section. After shiftHeadings only a line inside
// a code block can still look like one.
const SECTION_LINE = /^ {0,3}#{1,2}(?=[ \t]|$)/;

/**
 * One Context field for a packet. The text is the user's, so a heading typed
 * into it is pushed down, and a field ends where it ends: a code fence left
 * open in one field is closed before the next field starts. A line inside a
 * code block that reads as a section heading gets a backslash in front, so a
 * reader that looks for "## Files" line by line finds only the packet's own.
 */
function packetField(entry) {
  return defang(shiftHeadings(entry, 2))
    .split('\n')
    .map((line) => (SECTION_LINE.test(line) ? `\\${line}` : line))
    .join('\n');
}

/** The Context block for a packet: the packet's own heading, then every field made safe to print. */
function contextBlock(context, mode) {
  return contextParts(context, mode, packetField).join('\n');
}

/** Caller-supplied text for a single packet line: no line breaks, no live markup, no new block. */
function oneLine(text) {
  return defangInline(String(text));
}

function manifestRow(entry) {
  const lines = Number.isFinite(entry.lines) ? ` · ${entry.lines} lines` : '';
  return `- ${oneLine(`${entry.label} · ${entry.bytes} bytes${lines} · SHA-256 ${entry.sha256}`)}`;
}

function refRow({ ref, problem }) {
  const range = ref.end === ref.start ? `${ref.start}` : `${ref.start}-${ref.end}`;
  const reason = Object.hasOwn(PROBLEM_LABELS, problem) ? PROBLEM_LABELS[problem] : problem;
  return `- ${oneLine(`${ref.label}:${range} · ${reason}`)}`;
}

function stageName(stage, index) {
  if (stage.name) return stage.name;
  if (stage.profileId) return reviewProfile(stage.profileId).name;
  return stage.model || `Stage ${index + 1}`;
}

function stageRow(stage, index) {
  const parts = [`${index + 1}`, stageName(stage, index)];
  if (stage.model && stage.model !== parts[1]) parts.push(stage.model);
  if (stage.verdict) parts.push(stage.verdict);
  if (stage.headline) parts.push(stage.headline);
  return `- ${oneLine(parts.join(' · '))}`;
}

/**
 * Builds the Markdown packet for a finished review.
 *
 * `stages` lists the earlier gauntlet stages or the panel's model reviews as
 * `{ profileId?, name?, model?, verdict?, headline?, review? }`; a stage that
 * carries `review` text is appended in full after the main review.
 *
 * @param {PacketInput} input
 * @returns {string}
 */
export function reviewPacket({
  review,
  manifest = [],
  context,
  provider = '',
  model = '',
  timestamp = new Date().toISOString(),
  source = 'ai',
  profileId = 'general',
  parsed,
  refProblems,
  stages,
}) {
  const profile = reviewProfile(profileId);
  const mode = parsed && parsed.ok ? parsed.mode : '';
  const blocks = [];

  const header = [
    '# Bounty Operator review packet',
    '',
    `Created: ${oneLine(timestamp)}`,
    `Produced by: ${oneLine(producedBy({ source, provider, model, stages, timestamp }))}`,
    `Profile: ${profile.name}`,
  ];
  if (parsed && parsed.ok) {
    header.push(`Verdict: ${oneLine(parsed.verdict)}`);
    if (parsed.headline) header.push(`Headline: ${oneLine(parsed.headline)}`);
  }
  blocks.push(header.join('\n'));

  blocks.push(contextBlock(context, mode));

  blocks.push(['## Files', ...manifest.map(manifestRow)].join('\n'));

  if (Array.isArray(refProblems)) {
    const body = refProblems.length
      ? refProblems.map(refRow)
      : ['Every cited location resolves to a supplied line.'];
    blocks.push(['## Reference check', ...body].join('\n'));
  }

  if (Array.isArray(stages) && stages.length) {
    blocks.push(['## Stages', ...stages.map(stageRow)].join('\n'));
  }

  blocks.push(`## Review\n\n${defang(shiftHeadings(String(review ?? '').trim(), 2))}`);

  if (Array.isArray(stages)) {
    stages.forEach((stage, index) => {
      if (typeof stage.review !== 'string' || !stage.review.trim()) return;
      const title = `## Stage ${index + 1}: ${oneLine(stageName(stage, index))}`;
      blocks.push(`${title}\n\n${defang(shiftHeadings(stage.review.trim(), 2))}`);
    });
  }

  blocks.push(`Verify: ${VERIFY_URL}`);
  return `${blocks.join('\n\n')}\n`;
}
