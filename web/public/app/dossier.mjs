/**
 * Composite results: the gauntlet dossier and the panel review.
 *
 * A gauntlet run and a panel run each end as one workbench result whose
 * `stages` hold the reviews it was built from. This module shapes those
 * results, reads the decision out of the final stage, and draws them in the
 * Result step: the verdict with its blocker, cheapest action and filing
 * deadline, the stage strip, and every stage or model review behind a
 * disclosure. It also opens the stored runs of the bundled examples.
 *
 * Model output is untrusted here as everywhere: nodes are built with
 * createElement and textContent, through ./ui.mjs and ./results.mjs.
 *
 * Exports
 *   initDossier()                               register the result bodies and wire #wb-result. Call before initResults().
 *   openExampleRun(kind, id?)                   -> Promise<boolean>   show an example's stored 'gauntlet' or 'panel' run
 *   stageStrip(entries)                         -> <ol class="rn-pipe">   shared with the Run step
 *   Pure helpers (tested)
 *     STAGE_LABELS, STOP_VERDICTS, VERDICT_LABELS
 *     stageLabel(profileId)                     -> 'Prior art'
 *     stageFileName(number, profileId)          -> 'stage-3-prior-art.md'
 *     panelFileName(number, model)              -> 'panel-2-openai-gpt-6-astra.md'
 *     stopsRun(verdict)                         -> boolean   drop and hold-duplicate end a run
 *     stageRecord({ number, profileId, review, model, usage, elapsed, truncated, sent })
 *     seatRecord({ number, provider, model, review, usage, elapsed, sent })
 *     sumUsage(records)                         -> { input, output }
 *     gauntletResult({ stages, manifest, provider, timestamp })   -> WorkbenchResult, source 'gauntlet'
 *     panelResult({ seats, judge, manifest, timestamp, profile }) -> WorkbenchResult, source 'panel'
 *     fullStages(result)                        -> the stage records with the main review put back
 *     isComplete(result)                        -> boolean   the verdict stage ran
 *     decisionOf(parsed)                        -> { why, rule, blocker, action, severity, deadline, firstReproduced }
 *     gateDecision(stage)                       -> the same shape, for a run a gate ended
 *     agreementOf(parsed)                       -> [{ finding, k, n, kept, status, settledBy, reviewers }]   status: kept, unproven or dropped
 *     matchAgreement(findings, rows)            -> (row | null)[]   one per finding
 *     exampleGauntletResult(example)            -> Promise<WorkbenchResult>
 *     examplePanelResult(example)               -> Promise<WorkbenchResult>
 *
 * A stage record is what the packet lists: { number, profileId, name, file,
 * model, verdict, headline, review, usage, elapsed }. In a result the stage
 * whose review is the result's own `review` carries no `review`, so the packet
 * prints it once. `sent` is set when the text that travelled to later stages
 * differs from the answer (summarised to fit, or a line masked).
 *
 * DOM this module owns: the nodes it returns for #panel-findings, the buttons
 * it adds to .wb-next, [data-dossier], [data-open-review].
 */

import { extractRefs, parseReview } from '../parse.mjs';
import { GAUNTLET, reviewProfile } from '../profiles.mjs';
import { PROVIDERS } from '../providers.mjs';
import { manifestFor } from '../review-core.mjs';
import { inlineNodes, onResultDrawn, registerResultBody, reviewNodes, sectionKey } from './results.mjs';
import { workbench } from './state.mjs';
import { button, el, formatDate, formatElapsed, on, qs } from './ui.mjs';
import { enterExample, say, setStep, view } from './workbench.mjs';

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** The stage names the method page uses, by profile id. */
export const STAGE_LABELS = Object.freeze({
  scope: 'Scope',
  provenance: 'Provenance',
  'prior-art': 'Prior art',
  poc: 'Proof',
  severity: 'Severity',
  triage: 'Triager',
  report: 'Report',
  verdict: 'Verdict',
});

/** A stage that returns one of these ends the report: the later stages would not change it. */
export const STOP_VERDICTS = Object.freeze(['drop', 'hold-duplicate']);

export const VERDICT_LABELS = Object.freeze({
  submit: 'Submit',
  'rewrite-then-submit': 'Rewrite, then submit',
  'prove-first': 'Prove first',
  'hold-duplicate': 'Hold: duplicate',
  drop: 'Drop',
  'fix-before-deploy': 'Fix before deploy',
  'no-blocking-issues': 'No blocking issues',
});

/** @param {string} profileId */
export function stageLabel(profileId) {
  if (Object.hasOwn(STAGE_LABELS, profileId)) return STAGE_LABELS[profileId];
  try {
    return reviewProfile(profileId).name;
  } catch {
    return String(profileId);
  }
}

/** The name a stage's answer travels under: stage-<n>-<profile>.md */
export function stageFileName(number, profileId) {
  return `stage-${number}-${String(profileId).replace(/[^a-z0-9-]/gi, '') || 'review'}.md`;
}

/** The name a panel seat's answer travels under: panel-<n>-<model>.md, with the model id made safe for a file name. */
export function panelFileName(number, model) {
  const safe = String(model ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80);
  return `panel-${number}-${safe || 'model'}.md`;
}

/** @param {string} verdict */
export function stopsRun(verdict) {
  return STOP_VERDICTS.includes(verdict);
}

// ---------------------------------------------------------------------------
// Records and results
// ---------------------------------------------------------------------------

function usageOf(usage) {
  const number = (value) => (Number.isFinite(value) ? value : null);
  return { input: number(usage?.input), output: number(usage?.output) };
}

/**
 * The record of one finished gauntlet stage.
 *
 * @param {{ number: number, profileId: string, review: string, model?: string, usage?: object, elapsed?: number | null, truncated?: boolean, sent?: string }} stage
 */
export function stageRecord({ number, profileId, review, model = '', usage = null, elapsed = null, truncated = false, sent = '' }) {
  const profile = reviewProfile(profileId);
  const parsed = parseReview(review);
  return {
    number,
    profileId: profile.id,
    name: profile.name,
    file: stageFileName(number, profile.id),
    model,
    verdict: parsed.ok ? parsed.verdict : '',
    headline: parsed.headline,
    review,
    usage: usageOf(usage),
    elapsed: Number.isFinite(elapsed) ? elapsed : null,
    ...(truncated ? { truncated: true } : {}),
    ...(sent && sent !== review ? { sent } : {}),
  };
}

/**
 * The record of one finished panel seat. `name` is the model, which is how the
 * packet lists it.
 *
 * @param {{ number: number, provider?: string, model: string, review: string, usage?: object, elapsed?: number | null, sent?: string }} seat
 */
export function seatRecord({ number, provider = '', model, review, usage = null, elapsed = null, sent = '' }) {
  const parsed = parseReview(review);
  return {
    number,
    name: model,
    provider,
    model,
    file: panelFileName(number, model),
    verdict: parsed.ok ? parsed.verdict : '',
    headline: parsed.headline,
    review,
    usage: usageOf(usage),
    elapsed: Number.isFinite(elapsed) ? elapsed : null,
    ...(sent && sent !== review ? { sent } : {}),
  };
}

/** Token counts added up; null when no record carries a count. */
export function sumUsage(records) {
  const total = { input: null, output: null };
  for (const record of records) {
    for (const side of ['input', 'output']) {
      const value = record?.usage?.[side];
      if (Number.isFinite(value)) total[side] = (total[side] ?? 0) + value;
    }
  }
  return total;
}

function withoutReview(record) {
  const { review, ...rest } = record;
  return rest;
}

/**
 * The result a gauntlet run ends as. Its review is the last stage's: the
 * verdict stage of a full run, or the gate that ended the report.
 *
 * @param {{ stages: ReturnType<typeof stageRecord>[], manifest: object[], provider?: string, timestamp?: string }} run
 */
export function gauntletResult({ stages, manifest, provider = '', timestamp = new Date().toISOString() }) {
  const last = stages[stages.length - 1];
  return {
    review: last.review,
    manifest,
    profile: { id: last.profileId, name: last.name },
    mode: 'bounty',
    provider,
    model: last.model,
    truncated: last.truncated === true,
    refused: false,
    usage: sumUsage(stages),
    source: 'gauntlet',
    timestamp,
    stages: stages.map((stage) => (stage === last ? withoutReview(stage) : stage)),
  };
}

/**
 * The result a panel run ends as: the cross-examination, with the model
 * reviews as its stages.
 *
 * @param {{ seats: ReturnType<typeof seatRecord>[], judge: { review: string, model: string, provider?: string, usage?: object, truncated?: boolean }, manifest: object[], mode: string, profile?: { id: string, name: string }, timestamp?: string }} run
 */
export function panelResult({ seats, judge, manifest, mode, profile = null, timestamp = new Date().toISOString() }) {
  const merge = reviewProfile('panel');
  return {
    review: judge.review,
    manifest,
    profile: { id: merge.id, name: profile ? `${merge.name}: ${profile.name}` : merge.name },
    mode,
    provider: judge.provider ?? '',
    model: judge.model,
    truncated: judge.truncated === true,
    refused: false,
    usage: sumUsage([...seats, judge]),
    source: 'panel',
    timestamp,
    stages: seats,
    ...(profile ? { reviewed: { id: profile.id, name: profile.name } } : {}),
  };
}

/** The stage records of a gauntlet result, with the main review put back on the last one. */
export function fullStages(result) {
  const stages = Array.isArray(result?.stages) ? result.stages : [];
  return stages.map((stage, index) => (index === stages.length - 1 && typeof stage.review !== 'string' ? { ...stage, review: result.review } : stage));
}

/** True when the run reached the verdict stage. */
export function isComplete(result) {
  const stages = Array.isArray(result?.stages) ? result.stages : [];
  return stages.length > 0 && stages[stages.length - 1].profileId === GAUNTLET[GAUNTLET.length - 1];
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

const DECISION_FIELDS = Object.freeze({
  why: 'why',
  rule: 'rule',
  blocker: 'blocker',
  'cheapest action': 'action',
  'severity to claim': 'severity',
  deadline: 'deadline',
  'first reproduced': 'firstReproduced',
});

const DECISION_LINE = /^\s*(?:[-*]\s+)?\**([A-Za-z][A-Za-z ]{0,30}?)\**\s*[:：]\**\s*(.*)$/;
const EMPTY = /^(?:none|n\/a|not given|not stated|-)\.?$/i;
const NONE_MEANS_STATED = new Set(['blocker', 'action', 'deadline']);

function blankDecision() {
  return { why: '', rule: '', blocker: '', action: '', severity: '', deadline: '', firstReproduced: '' };
}

/**
 * The Decision section of a verdict review as fields. Missing or unknown
 * fields are ''. An explicit "none" remains for blocker, action and deadline
 * so the dossier can distinguish it from an unanswered field.
 *
 * @param {{ sections?: { title: string, text: string }[] } | null} parsed
 */
export function decisionOf(parsed) {
  const decision = blankDecision();
  const section = parsed?.sections?.find((entry) => sectionKey(entry.title) === 'decision');
  if (!section) return decision;

  let current = '';
  for (const line of String(section.text ?? '').split('\n')) {
    const match = DECISION_LINE.exec(line);
    const field = match ? DECISION_FIELDS[match[1].trim().toLowerCase()] : undefined;
    if (field) {
      decision[field] = match[2].trim();
      current = field;
    } else if (current && line.trim()) {
      decision[current] += ` ${line.trim()}`;
    }
  }
  for (const field of Object.keys(decision)) {
    const value = decision[field].trim();
    const statedNone = NONE_MEANS_STATED.has(field) && /^none\.?$/i.test(value);
    if (!statedNone && EMPTY.test(value)) decision[field] = '';
  }
  return decision;
}

/**
 * The decision of a run that a gate ended: the gate's own headline is the
 * blocker, and the action is the one the verdict rules name for that verdict.
 *
 * @param {{ number: number, profileId: string, verdict: string, headline: string }} stage
 */
export function gateDecision(stage) {
  return {
    ...blankDecision(),
    why: stage.headline ?? '',
    rule: `Stage ${stage.number}, ${stageLabel(stage.profileId)}, returned ${stage.verdict || 'no verdict'}.`,
    blocker: stage.headline ?? '',
    action: stage.verdict === 'hold-duplicate' ? 'Add the new evidence to the existing report.' : stage.verdict === 'drop' ? 'Stop work on this finding.' : '',
  };
}

// ---------------------------------------------------------------------------
// Agreement
// ---------------------------------------------------------------------------

/**
 * The Result cell of an Agreement row: kept, unproven (open for want of
 * evidence, not refuted) or dropped. Any other value reads as dropped, as
 * every value but kept did before unproven existed.
 *
 * @param {string} cell
 * @returns {'kept' | 'unproven' | 'dropped'}
 */
function agreementStatus(cell) {
  const value = String(cell ?? '').trim();
  if (/^kept\b/i.test(value)) return 'kept';
  if (/^unproven\b/i.test(value)) return 'unproven';
  return 'dropped';
}

/** The chip tone of each Agreement result. */
const AGREEMENT_TONES = Object.freeze({ kept: 'observed', unproven: 'unproven', dropped: 'danger' });

/**
 * The Agreement rows of a panel cross-examination.
 *
 * @param {{ sections?: { title: string, rows: string[][] | null }[] } | null} parsed
 * @returns {{ finding: string, k: number | null, n: number | null, kept: boolean, status: 'kept' | 'unproven' | 'dropped', settledBy: string, reviewers: string }[]}
 */
export function agreementOf(parsed) {
  const section = parsed?.sections?.find((entry) => sectionKey(entry.title) === 'agreement');
  return (section?.rows ?? []).filter((row) => row.length >= 3).map((row) => {
    const count = /(\d{1,2})\s*\/\s*(\d{1,2})/.exec(row[1] ?? '');
    const status = agreementStatus(row[2]);
    return {
      finding: row[0] ?? '',
      k: count ? Number(count[1]) : null,
      n: count ? Number(count[2]) : null,
      kept: status === 'kept',
      status,
      settledBy: row[3] ?? '',
      reviewers: row.slice(4).join(' | '),
    };
  });
}

function words(text) {
  return new Set(String(text ?? '').toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []);
}

function overlaps(a, b) {
  return a.label === b.label && a.start <= b.end && b.start <= a.end;
}

/**
 * Pairs each surviving finding with its Agreement row: by a shared cited line,
 * then by shared words, then by position when both lists have the same length.
 * A finding card is a kept row, or an unproven one when nothing was kept; a
 * dropped row never pairs with a card.
 *
 * @param {{ title: string, locations: { label: string, start: number, end: number }[] }[]} findings
 * @param {ReturnType<typeof agreementOf>} rows
 * @returns {(ReturnType<typeof agreementOf>[number] | null)[]}
 */
export function matchAgreement(findings, rows) {
  const kept = rows.filter((row) => row.kept || row.status === 'unproven');
  const taken = new Set();
  const scores = findings.map((finding) => {
    const title = words(finding.title);
    return kept.map((row) => {
      const rowWords = words(row.finding);
      let shared = 0;
      for (const word of rowWords) if (title.has(word)) shared += 1;
      const wordScore = rowWords.size && title.size ? shared / Math.min(rowWords.size, title.size) : 0;
      const refScore = extractRefs(row.settledBy).some((ref) => finding.locations.some((location) => overlaps(location, ref))) ? 0.5 : 0;
      return wordScore + refScore;
    });
  });

  // Best pairs first, so an early finding does not take the row a later one fits better.
  const pairs = [];
  scores.forEach((row, f) => row.forEach((score, r) => pairs.push({ f, r, score })));
  pairs.sort((a, b) => b.score - a.score);
  const matched = findings.map(() => null);
  for (const { f, r, score } of pairs) {
    if (score < 0.34 || matched[f] || taken.has(r)) continue;
    matched[f] = kept[r];
    taken.add(r);
  }
  if (kept.length === findings.length) {
    matched.forEach((row, index) => {
      if (!row && !taken.has(index)) {
        matched[index] = kept[index];
        taken.add(index);
      }
    });
  }
  return matched;
}

// ---------------------------------------------------------------------------
// The stored runs of an example
// ---------------------------------------------------------------------------

function sentFile(record) {
  return { name: record.file, content: record.sent ?? record.review ?? '' };
}

/**
 * The stored gauntlet of an example as a result: the same records and the
 * same assembly a hosted run produces.
 *
 * @param {{ id: string, files: { name: string, content: string }[], gauntlet: { generatedAt?: string, stages: { profileId: string, review: string, model?: string, usage?: object }[] } }} example
 */
export async function exampleGauntletResult(example) {
  const stages = example.gauntlet.stages.map((stage, index) => stageRecord({
    number: index + 1,
    profileId: stage.profileId,
    review: stage.review,
    model: stage.model ?? example.gauntlet.model ?? '',
    usage: stage.usage,
  }));
  const files = [...example.files.map((file) => ({ name: file.name, content: file.content })), ...stages.slice(0, -1).map(sentFile)];
  return {
    ...gauntletResult({ stages, manifest: await manifestFor(files), timestamp: example.gauntlet.generatedAt }),
    example: example.id,
  };
}

/**
 * The stored panel of an example as a result.
 *
 * @param {{ id: string, profile: string, mode?: string, files: { name: string, content: string }[], panel: { generatedAt?: string, profileId?: string, judge: { model: string, review: string, usage?: object }, seats: { model: string, review: string, usage?: object }[] } }} example
 */
export async function examplePanelResult(example) {
  const seats = example.panel.seats.map((seat, index) => seatRecord({ number: index + 1, model: seat.model, review: seat.review, usage: seat.usage }));
  const files = [...example.files.map((file) => ({ name: file.name, content: file.content })), ...seats.map(sentFile)];
  const profile = reviewProfile(example.panel.profileId ?? example.profile);
  return {
    ...panelResult({
      seats,
      judge: { review: example.panel.judge.review, model: example.panel.judge.model, usage: example.panel.judge.usage },
      manifest: await manifestFor(files),
      mode: example.mode === 'own-code' ? 'own-code' : 'bounty',
      profile: { id: profile.id, name: profile.name },
      timestamp: example.panel.generatedAt,
    }),
    example: example.id,
  };
}

let examplesPromise = null;

function examples() {
  examplesPromise ??= import('../example.mjs').then((module) => (Array.isArray(module.EXAMPLES) ? module.EXAMPLES : []), () => []);
  return examplesPromise;
}

/**
 * Shows the stored gauntlet or panel run of a bundled example. When that
 * example is not the one loaded, it is loaded first; the user's own work is
 * put aside exactly as for any example.
 *
 * @param {'gauntlet' | 'panel'} kind
 * @param {string} [id]  Empty picks the first example that has such a run.
 * @returns {Promise<boolean>}
 */
export async function openExampleRun(kind, id = '') {
  if (workbench.get().busy) {
    say('A review is running. Cancel it to open the example.', { tone: 'warn' });
    return false;
  }
  const list = await examples();
  const example = list.find((entry) => entry.id === id && entry[kind]) ?? list.find((entry) => entry[kind]);
  if (!example) {
    say('This example has no stored run of that kind.', { tone: 'warn' });
    return false;
  }
  const result = kind === 'panel' ? await examplePanelResult(example) : await exampleGauntletResult(example);
  if (view.get().example === example.id) {
    workbench.set({ result });
    setStep('results');
  } else {
    enterExample(example, result);
  }
  const count = result.stages.length;
  say(kind === 'panel'
    ? `The panel on the example: ${count} stored model reviews and their cross-examination.`
    : `The gauntlet on the example: ${count} stored stages, each a real model answer.`, { tone: 'success' });
  return true;
}

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

function chip(text, tone = 'neutral', extra = '') {
  return el('span', { class: ['chip', extra], dataset: { tone }, text });
}

function verdictChip(verdict, { large = false } = {}) {
  if (!verdict) return el('span', { class: 'chip chip--dashed', text: 'No verdict' });
  return el('span', { class: ['chip verdict', large && 'verdict--lg'], dataset: { verdict }, text: VERDICT_LABELS[verdict] ?? verdict });
}

const STATE_CHIPS = Object.freeze({
  waiting: () => el('span', { class: 'chip chip--dashed', text: 'Waiting' }),
  running: () => el('span', { class: 'chip status', dataset: { status: 'running' }, text: 'Running' }),
  stopped: () => el('span', { class: 'chip chip--dashed', text: 'Not run' }),
  failed: () => el('span', { class: 'chip status', dataset: { status: 'failed' }, text: 'Failed' }),
});

/**
 * The stage strip: one cell per stage with its number, its name and its state.
 * A finished stage shows its verdict. An entry with `onOpen` is a button.
 *
 * @param {{ number: number, label: string, state: 'waiting' | 'running' | 'done' | 'stopped' | 'failed', verdict?: string, title?: string, onOpen?: (() => void) | null }[]} entries
 * @param {{ label?: string, id?: string }} [options]
 */
export function stageStrip(entries, { label = 'Stages', id } = {}) {
  return el('ol', { class: 'rn-pipe', id, 'aria-label': label }, entries.map((entry) => {
    const state = entry.state === 'done' ? verdictChip(entry.verdict) : (STATE_CHIPS[entry.state] ?? STATE_CHIPS.waiting)();
    const content = [
      el('span', { class: 'rn-pipe__n num', 'aria-hidden': 'true', text: String(entry.number) }),
      el('span', { class: 'rn-pipe__name', text: entry.label }),
      el('span', { class: 'rn-pipe__state' }, state),
    ];
    const attributes = { class: 'rn-pipe__stage', title: entry.title ?? null, dataset: { state: entry.state, verdict: entry.verdict || null } };
    const cell = entry.onOpen
      ? el('button', { ...attributes, type: 'button', 'aria-label': `Stage ${entry.number}, ${entry.label}: open it`, onClick: entry.onOpen }, content)
      : el('div', attributes, content);
    return el('li', { class: 'rn-pipe__item', 'aria-current': entry.state === 'running' ? 'step' : null }, cell);
  }));
}

function tokensText(usage) {
  if (!usage || !Number.isFinite(usage.output)) return '';
  return `${Number(usage.input ?? 0).toLocaleString('en-US')} in · ${usage.output.toLocaleString('en-US')} out tokens`;
}

function providerLabel(id) {
  return PROVIDERS.find((entry) => entry.id === id)?.label ?? '';
}

/**
 * One review behind a disclosure. The body is built the first time it opens:
 * eight stages of cards are not drawn until somebody asks for them.
 */
function reviewDisclosure({ id, number, title, verdict, headline, build }) {
  const body = el('div', { class: 'disclosure__body gd-stage__body' });
  const details = el('details', { class: 'disclosure gd-stage', id, dataset: { review: String(number) } },
    el('summary', { class: 'disclosure__summary' },
      el('span', { class: 'gd-stage__n num', 'aria-hidden': 'true', text: String(number) }),
      el('span', { class: 'wb-sum gd-stage__name', text: title }),
      verdictChip(verdict),
      headline ? el('span', { class: 'disclosure__hint gd-stage__headline', text: headline }) : null),
    body);
  let built = false;
  details.addEventListener('toggle', () => {
    if (!details.open || built) return;
    built = true;
    body.append(...build());
  });
  return details;
}

function recordMeta(record) {
  const parts = [[providerLabel(record.provider), record.model].filter(Boolean).join(' / '), tokensText(record.usage), Number.isFinite(record.elapsed) ? formatElapsed(record.elapsed) : ''].filter(Boolean);
  if (record.sent) parts.push('later stages read a shortened copy');
  return parts.length ? el('p', { class: 'fine gd-stage__meta', text: parts.join(' · ') }) : null;
}

function openReview(prefix, number) {
  const node = qs(`#${prefix}-${number}`);
  if (!node) return;
  node.open = true;
  node.scrollIntoView({ block: 'start' });
  node.querySelector('summary')?.focus({ preventScroll: true });
}

function fact(name, label, value, source, fallback, extra = null) {
  return el('div', { class: 'gd__fact', dataset: { fact: name, empty: value ? null : true } },
    el('dt', { class: 'gd__label', text: label }),
    el('dd', { class: 'gd__value' }, value ? inlineNodes(value, source) : fallback, extra));
}

function exampleChip(result) {
  return result.example ? el('span', { class: 'chip status', dataset: { status: 'example' }, text: 'Example' }) : null;
}

/** The Findings tab of a gauntlet result. */
function gauntletBody(result, shown) {
  const stages = fullStages(result);
  if (!stages.length) return null;

  const last = stages[stages.length - 1];
  const complete = isComplete(result);
  const manifest = result.manifest ?? [];
  const baseCount = Math.max(0, manifest.length - (stages.length - 1));
  // Cited lines open from the user's files and, for a stage file, from the answer that travelled.
  const files = shown.files ? [...shown.files.slice(0, baseCount), ...stages.slice(0, -1).map(sentFile)] : null;
  const { parsed } = shown.analysis;
  const source = { analysis: shown.analysis, files, manifest };

  const main = reviewNodes(result, { files, analysis: shown.analysis, idPrefix: 'gd', skip: complete ? ['stages', 'decision'] : [] });
  const head = parsed.ok ? main.nodes.shift() : null;
  const decision = complete ? decisionOf(parsed) : gateDecision(last);

  const facts = el('dl', { class: 'gd__facts' },
    fact('blocker', 'Blocker', decision.blocker, source, 'Not stated in this review.'),
    fact('action', 'Cheapest action', decision.action, source, 'Not stated in this review.'),
    fact('deadline', 'Filing deadline', decision.deadline, source, 'Not stated in this review.',
      decision.firstReproduced ? el('span', { class: 'gd__aside', text: `First reproduced: ${decision.firstReproduced}` }) : null));

  const more = [
    decision.severity ? ['Severity to claim', decision.severity] : null,
    decision.rule ? ['Decided by', decision.rule] : null,
    decision.why && decision.why !== decision.blocker ? ['Why', decision.why] : null,
  ].filter(Boolean);

  const strip = stageStrip(GAUNTLET.map((profileId, index) => {
    const stage = stages[index];
    return {
      number: index + 1,
      label: stageLabel(profileId),
      state: stage ? 'done' : 'stopped',
      verdict: stage?.verdict,
      title: stage?.headline,
      onOpen: stage ? () => openReview('gd-stage', index + 1) : null,
    };
  }), { label: 'Gauntlet stages' });

  const nodes = [
    el('section', { class: 'gd', 'aria-label': 'Gauntlet dossier', dataset: { complete: complete ? 'true' : 'false' } },
      el('p', { class: 'gd__meta meta' },
        complete ? `Gauntlet · ${stages.length} stages` : `Gauntlet · ended at stage ${stages.length} of ${GAUNTLET.length}, ${stageLabel(last.profileId)}`,
        exampleChip(result)),
      head,
      facts,
      more.length ? el('dl', { class: 'kv gd__more' }, more.map(([label, value]) => el('div', { class: 'kv__row' }, el('dt', { text: label }), el('dd', {}, inlineNodes(value, source))))) : null),
    strip,
    ...main.nodes,
    el('section', { class: 'wb-section', dataset: { section: 'gauntlet-stages' } },
      el('h4', { class: 'wb-section__title', text: 'Stage by stage' }),
      el('div', { class: 'gd-stages' }, stages.map((stage, index) => reviewDisclosure({
        id: `gd-stage-${index + 1}`,
        number: index + 1,
        title: stage.name,
        verdict: stage.verdict,
        headline: stage.headline,
        build: () => {
          const stageResult = { review: stage.review, manifest: manifest.slice(0, baseCount + index) };
          const drawn = reviewNodes(stageResult, { files: files ? files.slice(0, baseCount + index) : null, idPrefix: `gd-s${index + 1}`, head: false, scope: `Stage ${index + 1}` });
          return [recordMeta(stage), ...drawn.nodes].filter(Boolean);
        },
      })))),
  ];
  return nodes;
}

/** The Findings tab of a panel result. */
function panelBody(result, shown) {
  const seats = Array.isArray(result.stages) ? result.stages : [];
  if (!seats.length) return null;

  const manifest = result.manifest ?? [];
  const baseCount = Math.max(0, manifest.length - seats.length);
  const files = shown.files ? [...shown.files.slice(0, baseCount), ...seats.map(sentFile)] : null;
  const { parsed } = shown.analysis;
  const source = { analysis: shown.analysis, files, manifest };

  const main = reviewNodes(result, { files, analysis: shown.analysis, idPrefix: 'pn', skip: ['agreement'] });
  const head = parsed.ok ? main.nodes.shift() : null;
  const rows = parsed.ok ? agreementOf(parsed) : [];

  // Each surviving finding carries how many reviewers reported it.
  const matched = parsed.ok ? matchAgreement(parsed.findings, rows) : [];
  const cards = main.nodes.flatMap((node) => (node.classList?.contains('findings') ? [...node.children] : []));
  cards.forEach((card, index) => {
    const row = matched[index];
    if (!row || row.k === null) return;
    card.querySelector('.finding__tags')?.append(
      el('span', { class: 'chip pn-agree', dataset: { tone: row.k === row.n ? 'observed' : 'neutral' }, text: `${row.k} of ${row.n} models` }));
  });

  const seatButtons = (text) => {
    const numbers = [...String(text).matchAll(/panel-(\d{1,2})-/g)].map((match) => Number(match[1])).filter((number) => seats.some((seat) => seat.number === number));
    if (!numbers.length) return [text];
    return [...new Set(numbers)].map((number) => {
      const seat = seats.find((entry) => entry.number === number);
      return el('button', { class: 'pn-seat', type: 'button', title: `Open the review by ${seat.model}`, dataset: { openReview: `pn-seat-${number}` } },
        el('span', { class: 'pn-seat__n num', text: String(number) }), el('span', { class: 'pn-seat__model', text: seat.model }));
    });
  };

  const agreement = rows.length
    ? el('section', { class: 'wb-section', dataset: { section: 'agreement' } },
      el('h4', { class: 'wb-section__title', text: 'Agreement' }),
      el('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Agreement' },
        el('table', { class: 'table table--dense' },
          el('thead', {}, el('tr', {}, ['Finding', 'Reported by', 'Result', 'Settled by', 'Reviews'].map((name) => el('th', { scope: 'col', text: name })))),
          el('tbody', {}, rows.map((row) => el('tr', {},
            el('th', { scope: 'row' }, inlineNodes(row.finding, source)),
            el('td', { class: 'num nowrap', text: row.k === null ? '' : `${row.k} of ${row.n}` }),
            el('td', {}, chip(row.status, AGREEMENT_TONES[row.status])),
            el('td', {}, inlineNodes(row.settledBy, source)),
            el('td', {}, el('span', { class: 'pn-seats' }, seatButtons(row.reviewers)))))))))
    : null;

  const judge = [providerLabel(result.provider), result.model].filter(Boolean).join(' / ');
  return [
    el('section', { class: 'gd', 'aria-label': 'Panel review' },
      el('p', { class: 'gd__meta meta' },
        `Panel · ${seats.length} models${result.reviewed?.name ? ` · ${result.reviewed.name}` : ''}${judge ? ` · cross-examined by ${judge}` : ''}`,
        exampleChip(result)),
      head),
    agreement,
    ...main.nodes,
    el('section', { class: 'wb-section', dataset: { section: 'panel-reviews' } },
      el('h4', { class: 'wb-section__title', text: 'Model reviews' }),
      el('div', { class: 'gd-stages' }, seats.map((seat) => reviewDisclosure({
        id: `pn-seat-${seat.number}`,
        number: seat.number,
        title: seat.model,
        verdict: seat.verdict,
        headline: seat.headline,
        build: () => {
          // Each model saw the user's files only.
          const seatResult = { review: seat.review, manifest: manifest.slice(0, baseCount) };
          const drawn = reviewNodes(seatResult, { files: files ? files.slice(0, baseCount) : null, idPrefix: `pn-s${seat.number}`, head: false, scope: `Review ${seat.number}` });
          return [recordMeta(seat), ...drawn.nodes].filter(Boolean);
        },
      })))),
  ].filter(Boolean);
}

// ---------------------------------------------------------------------------
// Controls added to the result
// ---------------------------------------------------------------------------

function storedNote(result, example) {
  const run = result.source === 'panel' ? example?.panel : example?.gauntlet;
  const when = formatDate(run?.generatedAt);
  const what = result.source === 'panel'
    ? `${result.stages.length} model reviews and their cross-examination`
    : `${result.stages.length} stages, each a model answer to the prompt a hosted run sends`;
  return `Stored with the example: ${what}${when ? `, generated ${when}` : ''}. Nothing was edited.`;
}

function decorate({ target, result, readOnly }) {
  if (!result || readOnly) return;
  // A dossier is the end of the run: the single-profile "Run next" row does not follow it.
  if (result.source === 'gauntlet') target.querySelector('.wb-next:not(.gd-next)')?.remove();
  const loaded = view.get().example;
  if (!loaded) return;

  examples().then((list) => {
    // The result may have been redrawn while the examples loaded.
    if (!target.isConnected || workbench.get().result !== result) return;
    const example = list.find((entry) => entry.id === loaded);
    if (!example) return;

    if (result.source === 'example') {
      const row = target.querySelector('.wb-next .wb-actions');
      // Two draws in a row both land here once the examples are loaded: add the controls once.
      if (!row || row.dataset.extras !== undefined) return;
      row.dataset.extras = '';
      if (example.gauntlet) row.append(button({ label: 'Show the gauntlet on this example', icon: 'play', attrs: { 'data-dossier': 'gauntlet' } }));
      if (example.panel) row.append(button({ label: 'Show the panel on this example', icon: 'play', attrs: { 'data-dossier': 'panel' } }));
      for (const other of list) {
        if (other.id !== example.id) row.append(button({ label: `Example: ${other.title}`, variant: 'quiet', attrs: { 'data-example': other.id } }));
      }
      return;
    }

    if (result.example && !target.querySelector('.gd-next')) {
      const other = result.source === 'panel' ? 'gauntlet' : 'panel';
      target.append(el('div', { class: 'wb-next gd-next no-print' },
        el('p', { class: 'wb-next__text', text: storedNote(result, example) }),
        el('div', { class: 'wb-actions' },
          button({ label: 'Start my own review', variant: 'primary', iconEnd: 'arrow-right', attrs: { 'data-action': 'own' } }),
          button({ label: 'Back to the single review', attrs: { 'data-example': example.id } }),
          example[other] ? button({ label: other === 'panel' ? 'Show the panel on this example' : 'Show the gauntlet on this example', attrs: { 'data-dossier': other } }) : null)));
    }
  }).catch(() => {});
}

/**
 * Registers the gauntlet and panel result bodies and wires the controls this
 * module adds. Call once, before initResults().
 */
export function initDossier() {
  registerResultBody('gauntlet', gauntletBody);
  registerResultBody('panel', panelBody);
  onResultDrawn(decorate);

  const target = qs('#wb-result');
  if (!target) return;
  on(target, 'click', '[data-dossier]', (event, control) => {
    openExampleRun(control.dataset.dossier === 'panel' ? 'panel' : 'gauntlet', view.get().example);
  });
  on(target, 'click', '[data-open-review]', (event, control) => {
    const [, prefix, number] = /^([a-z-]+)-(\d+)$/.exec(control.dataset.openReview) ?? [];
    if (prefix) openReview(prefix, number);
  });
}
