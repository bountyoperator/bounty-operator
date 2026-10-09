/**
 * A review the provider blocked under its usage policy: what to call it, what
 * to tell the user and what to do next. One place, so the single run, the
 * result view, the gauntlet, the panel, the history list and a pasted reply
 * all say the same thing.
 *
 * A block reaches the app in three shapes:
 *   - a finished result with `blocked` set (the provider answered with a block);
 *   - an ApiError with code `provider_policy` (the provider sent it as an error);
 *   - a pasted reply that is the provider's notice and not a review.
 * None of them is counted against the allowance.
 *
 * Exports
 *   BLOCKS                         the block ids the app knows
 *   REFUSES_GUIDE                  the guide entry the notice links to
 *   blockOf(value)                 -> '' | one of BLOCKS                                    pure, tested
 *   blockedCopy(value, options)    -> { block, title, body, said, line, link, step, short } | null   pure, tested
 *   blockedNotice(value, options)  -> HTMLElement | null   the notice, with its link
 *   pastedBlock(text)              -> '' | 'anthropic-cyber'   a pasted reply that is a notice
 *   alternateAfter(value, chosen)  -> { id, label } | null   the model to offer after a block   pure, tested
 */

import { PROVIDERS, policyBlock } from '../providers.mjs';
import { el, notice } from './ui.mjs';

const TITLES = Object.freeze({
  'anthropic-cyber': "Anthropic's cyber safeguards blocked this review",
  'anthropic-reasoning': 'Anthropic declined a request for the model to write out its reasoning',
  'openai-cyber': "OpenAI's cyber safeguards blocked this review",
  guardrail: 'A guardrail on the key or its account blocked this review',
  policy: 'The provider blocked this review under its usage policy',
});

export const BLOCKS = Object.freeze(Object.keys(TITLES));
export const REFUSES_GUIDE = Object.freeze({ label: 'When the model refuses', href: '/guide#model-refuses' });

const NOT_COUNTED = 'It did not count against your allowance.';
const NEXT_STEP = 'Run it again on another model or provider: your files and draft go through unchanged.';
// Two blocks another model does not get past, so the way on is theirs alone.
//   guardrail            it reads the request before any model does: the key is what to change.
//   anthropic-reasoning  the request asks for the model's reasoning as text: the wording is what to change.
// `short` is the same step for a status line or a row, with no full stop.
const OWN_STEPS = Object.freeze({
  guardrail: Object.freeze({
    step: 'It reads the request before any model does, so another model on the same key is stopped too. Use a key with no such guardrail, or another provider.',
    short: 'Use another key or provider',
  }),
  'anthropic-reasoning': Object.freeze({
    step: 'Anthropic does this when the request asks the model to show its reasoning or thinking. Take that wording out of the focus text, or run it on another provider.',
    short: 'Use another provider',
  }),
});
// A reply pasted from a chat app never touches the allowance, and the way on is in that app.
const PASTED_STEP = 'Paste the same prompt into another model.';
const SAID_CHARS = 300;
// Models to offer after a block, best first, for a provider that serves more
// than one vendor's models. In the gauntlet measurement of 9 October 2026
// each of these ran the proof stage, where OpenAI's safeguards stopped
// GPT-6.1 Sol on every draft. The first one from another vendor than the
// blocked model is offered.
const AFTER_BLOCK = Object.freeze({
  openrouter: Object.freeze(['anthropic/claude-sonnet-5.5', 'deepseek/deepseek-v4.1-flash']),
});
const vendorOf = (modelId) => String(modelId).split('/')[0];

/**
 * The block a value carries, or '' when it carries none. Takes a block id, a
 * result (`blocked`), a stored record, or an ApiError (`provider_policy`).
 * Anything that is not one of BLOCKS is not a block, so a stored value can
 * never smuggle text into the notice.
 *
 * @param {unknown} value
 * @returns {'' | 'anthropic-cyber' | 'anthropic-reasoning' | 'openai-cyber' | 'guardrail' | 'policy'}
 */
export function blockOf(value) {
  if (typeof value === 'string') return BLOCKS.includes(value) ? /** @type {any} */ (value) : '';
  if (!value || typeof value !== 'object') return '';
  const record = /** @type {Record<string, any>} */ (value);
  if (typeof record.blocked === 'string' && BLOCKS.includes(record.blocked)) return record.blocked;
  if (record.code === 'provider_policy') {
    const named = record.data?.blocked;
    return typeof named === 'string' && BLOCKS.includes(named) ? /** @type {any} */ (named) : 'policy';
  }
  return '';
}

/**
 * The words for a block.
 *   title   the heading of the notice
 *   body    that it was not counted, and the next step
 *   said    the provider's own words, when an error carried them
 *   line    title and body as one sentence run, for a status line or a row
 *   link    the guide entry
 *   step    the way on that only this block has, or '' when another model is the way on
 *   short   that step for a status line or a row, without its full stop, or ''
 * `context` says where the block landed (a gauntlet stage, a panel seat) and
 * what to do there. It follows the allowance line and replaces the next step,
 * so the notice gives one instruction, not two. A caller that writes a
 * `context` reads `step` first: where it is set, another model does not get
 * past the block, and the context must not say to pick one. A result with
 * source 'pasted' came from a chat app: its body is the one step that applies
 * there, with no allowance line, and `context` is not used for it.
 *
 * @param {unknown} value
 * @param {{ context?: string }} [options]
 */
export function blockedCopy(value, { context = '' } = {}) {
  const block = blockOf(value);
  if (!block) return null;
  const title = TITLES[block];
  const detail = /** @type {any} */ (value)?.data?.detail;
  const said = typeof detail === 'string' && detail.trim() ? detail.trim().slice(0, SAID_CHARS) : '';
  const pasted = /** @type {any} */ (value)?.source === 'pasted';
  const { step = '', short = '' } = OWN_STEPS[block] ?? {};
  const body = pasted ? PASTED_STEP : `${NOT_COUNTED} ${context || step || NEXT_STEP}`;
  return { block, title, body, said, line: pasted ? `${title}. ${PASTED_STEP}` : `${title}. ${NOT_COUNTED}`, link: REFUSES_GUIDE, step, short };
}

/**
 * The notice for a block: a warning with the title, the next step and a link
 * to the guide. The link is an ordinary anchor, so it is in the tab order. It
 * opens in a new tab: the files and the draft live in this one. `extra` holds
 * what the place the block landed adds: a button that acts on it, or one more
 * line. It sits between the provider's words and the link.
 *
 * @param {unknown} value
 * @param {{ context?: string, extra?: (Node | null)[] }} [options]
 * @returns {HTMLElement | null}
 */
export function blockedNotice(value, options = {}) {
  const copy = blockedCopy(value, options);
  if (!copy) return null;
  const node = notice('warn', copy.title, el('div', { class: 'stack stack--8' },
    el('p', { text: copy.body }),
    copy.said ? el('p', { class: 'fine', text: `The provider said: ${copy.said}` }) : null,
    ...(options.extra ?? []),
    el('p', {}, el('a', { class: 'link', href: copy.link.href, target: '_blank', text: copy.link.label }))));
  node.dataset.blocked = copy.block;
  return node;
}

/**
 * The model to offer in place of the one a provider blocked: a listed model of
 * another vendor that the same key reaches. Null when the value is no block,
 * when the block is one another model does not get past (it has a step of its
 * own), and for a provider that serves one vendor only, where another key is
 * the way on.
 *
 * @param {unknown} value  a block id, a result or an ApiError, as blockOf takes
 * @param {{ provider?: string, model?: string }} chosen  what the blocked call ran on
 * @returns {{ id: string, label: string } | null}
 */
export function alternateAfter(value, { provider = '', model = '' } = {}) {
  const block = blockOf(value);
  if (!block || OWN_STEPS[block]) return null;
  const listed = PROVIDERS.find((entry) => entry.id === provider)?.models ?? [];
  const id = (AFTER_BLOCK[provider] ?? []).find((candidate) => vendorOf(candidate) !== vendorOf(model) && listed.some((entry) => entry.id === candidate));
  const entry = listed.find((candidate) => candidate.id === id);
  return entry ? { id: entry.id, label: entry.label } : null;
}

/**
 * The block a pasted reply is, when the chat app answered with the provider's
 * notice instead of a review. The same classifier the hosted run uses.
 *
 * @param {unknown} text
 * @returns {'' | 'anthropic-cyber'}
 */
export function pastedBlock(text) {
  return policyBlock(text) ?? '';
}
