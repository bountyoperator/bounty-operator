/**
 * "Use my chat subscription": copy or download the checked prompt, paste the
 * model's reply back, and get the same result view and packet as a hosted run.
 * Everything happens in this tab. No account, no allowance, nothing sent.
 *
 * Exports
 *   initPasteback()                       wire #wb-copy-prompt, #wb-download-prompt, #wb-reply, #wb-reply-build
 *   pastedResult({ reply, model, files, profile, mode, manifest, now })   -> WorkbenchResult   pure, tested
 *   cleanReply(text)                      -> string   the reply without the chat wrapper around it; pure, tested
 *   pastedLine(result, parsedOk)          -> { message, tone, hold }   the status line for a pasted reply; pure, tested
 *
 * DOM this module owns: #wb-copy-prompt, #wb-download-prompt, #wb-prompt-size,
 * #wb-reply, #wb-reply-model, #wb-reply-build.
 */

import { parseReview } from '../parse.mjs';
import { reviewProfile } from '../profiles.mjs';
import { manifestFor, promptExport } from '../review-core.mjs';
import { track } from './api.mjs';
import { blockedCopy, pastedBlock } from './blocked.mjs';
import { EVENTS } from './events.mjs';
import { workbench } from './state.mjs';
import { copyText, download, on, qs, setBusy } from './ui.mjs';
import { buildPrompt, hostedLine, isHosted, prepare, promptFileName, say, scan, setStep, view, warningsAccepted } from './workbench.mjs';

const REPLY_MAX_CHARS = 600000;
const MODEL_ID = /^[\x21-\x7e]{1,200}$/;

/**
 * A pasted reply as the model wrote it. Line endings are normalised and a
 * byte-order mark is dropped; the text itself is not edited, because the
 * packet records what the model said.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function cleanReply(text) {
  return String(text ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
}

/**
 * What the status line says about a pasted reply. A reply that is the
 * provider's notice gets the block, not "no Verdict line".
 *
 * @param {{ blocked?: string }} result
 * @param {boolean} parsedOk
 * @returns {{ message: string, tone: 'success' | 'warn', hold: boolean }}
 */
export function pastedLine(result, parsedOk) {
  const blocked = blockedCopy(result);
  if (blocked) return { message: blocked.line, tone: 'warn', hold: true };
  if (parsedOk) return { message: 'Result built from the pasted reply.', tone: 'success', hold: false };
  return { message: 'The reply has no Verdict line in the review format, so it is shown as written.', tone: 'warn', hold: true };
}

/**
 * The result object for a pasted reply. The same shape a hosted run stores,
 * with source 'pasted'.
 *
 * @param {{ reply: string, model?: string, profile: { id: string, name: string, mode: string }, mode: string, manifest: object[], now?: Date }} input
 * @returns {import('./state.mjs').WorkbenchResult}
 */
export function pastedResult({ reply, model = '', profile, mode, manifest, now = new Date() }) {
  const named = String(model).trim();
  const review = cleanReply(reply);
  // The chat app answered with the provider's notice: a block, not a review.
  const blocked = pastedBlock(review);
  return {
    review,
    manifest,
    profile: { id: profile.id, name: profile.name },
    mode: profile.mode === 'either' ? mode : profile.mode,
    provider: '',
    model: MODEL_ID.test(named) ? named : '',
    truncated: false,
    refused: Boolean(blocked),
    ...(blocked ? { blocked } : {}),
    usage: { input: null, output: null },
    source: 'pasted',
    timestamp: now.toISOString(),
  };
}

// The prompt for the inputs on screen, built ahead of the click. Safari only
// lets a page write to the clipboard inside the click itself, and building the
// prompt hashes every file, which is asynchronous.
const INPUT_FIELDS = ['files', 'focus', 'context', 'profile', 'mode'];
let warmed = null;
let warmTimer = null;

function sameInputs(a, b) {
  return INPUT_FIELDS.every((field) => Object.is(a[field], b[field]));
}

async function warm() {
  const state = workbench.get();
  if (view.get().via !== 'export' || state.step !== 'review' || !state.files.length) return;
  // A hosted profile has no prompt to keep ready.
  if (isHosted(state.profile)) {
    warmed = null;
    return;
  }
  if (warmed && sameInputs(warmed.state, state)) return;
  const { coverage, error } = scan(state);
  if (error || coverage.blocking > 0 || (coverage.warnings > 0 && !warningsAccepted(coverage))) return;
  try {
    const text = promptExport(await prepare({ acknowledge: true }));
    // The inputs may have changed while the files were hashed.
    if (!sameInputs(state, workbench.get())) return;
    warmed = { state, text };
    showSize(text);
  } catch {
    warmed = null;
  }
}

function scheduleWarm() {
  clearTimeout(warmTimer);
  warmTimer = setTimeout(warm, 200);
}

async function copyPrompt() {
  const control = qs('#wb-copy-prompt');
  const ready = warmed && sameInputs(warmed.state, workbench.get()) ? warmed.text : '';
  setBusy(control, true);
  try {
    const text = ready || (await buildPrompt())?.text;
    if (!text) return;
    const copied = await copyText(text);
    if (!copied) {
      say('The browser refused the copy. Download the prompt instead.', { tone: 'warn' });
      return;
    }
    track(EVENTS.PROMPT_EXPORTED);
    showSize(text);
    say('Prompt copied. Paste it into your model, then paste the reply below.', { tone: 'success', hold: true });
    qs('#wb-reply')?.focus({ preventScroll: true });
  } finally {
    setBusy(control, false);
  }
}

async function downloadPrompt() {
  const built = await buildPrompt();
  if (!built) return;
  download(promptFileName(workbench.get().profile), built.text, 'text/markdown');
  track(EVENTS.PROMPT_EXPORTED);
  showSize(built.text);
  say('Prompt downloaded. Attach or paste it in your model, then paste the reply below.', { tone: 'success', hold: true });
}

function showSize(text) {
  const target = qs('#wb-prompt-size');
  if (target) target.textContent = `${text.length.toLocaleString('en-US')} characters, about ${Math.round(text.length / 4).toLocaleString('en-US')} tokens.`;
}

async function buildResult() {
  const field = qs('#wb-reply');
  const control = qs('#wb-reply-build');
  if (!field) return;
  const state = workbench.get();
  const reply = cleanReply(field.value);

  field.removeAttribute('aria-invalid');
  if (!state.files.length) {
    say('Add the files the reply is about first. The result cites them by line.', { error: true });
    setStep('files');
    return;
  }
  // No prompt was handed out for a hosted profile, so there is no reply to build from.
  if (isHosted(state.profile)) {
    say(hostedLine(state.profile), { tone: 'warn', hold: true });
    return;
  }
  if (!reply) {
    field.setAttribute('aria-invalid', 'true');
    say("Paste the model's reply first.", { error: true });
    field.focus();
    return;
  }
  if (reply.length > REPLY_MAX_CHARS) {
    field.setAttribute('aria-invalid', 'true');
    say(`The reply is ${reply.length.toLocaleString('en-US')} characters. A review is a few thousand: paste only the model's answer.`, { error: true });
    field.focus();
    return;
  }

  setBusy(control, true);
  try {
    const profile = reviewProfile(state.profile);
    const manifest = await manifestFor(state.files);
    const result = pastedResult({ reply, model: qs('#wb-reply-model')?.value, profile, mode: state.mode, manifest });
    const parsed = parseReview(result.review, { labels: manifest.map((entry) => entry.label) });

    view.set({ history: null });
    workbench.set({ result });
    track(EVENTS.REPLY_PASTED);
    setStep('results');
    const line = pastedLine(result, parsed.ok);
    say(line.message, { tone: line.tone, hold: line.hold });
    field.value = '';
  } catch (error) {
    say(error instanceof Error ? error.message : 'The reply could not be read.', { error: true });
  } finally {
    setBusy(control, false);
  }
}

/** Wires the chat-subscription rows. Call after initWorkbench(). */
export function initPasteback() {
  if (!qs('#wb-reply-build')) return;
  on(qs('#wb-copy-prompt'), 'click', copyPrompt);
  on(qs('#wb-download-prompt'), 'click', downloadPrompt);
  on(qs('#wb-reply-build'), 'click', buildResult);
  on(qs('#wb-reply'), 'input', (event) => event.target.removeAttribute('aria-invalid'));

  // Keep a prompt ready while the chat-subscription rows are on screen.
  qs('#workspace')?.addEventListener('wb:step', scheduleWarm);
  view.select((state) => state.via, scheduleWarm);
  workbench.subscribe((state, previous) => {
    if (!sameInputs(state, previous)) scheduleWarm();
  });
  scheduleWarm();

  qs('#workspace')?.addEventListener('wb:clear', () => {
    warmed = null;
    for (const id of ['#wb-reply', '#wb-reply-model']) {
      const field = qs(id);
      if (field) field.value = '';
    }
    const size = qs('#wb-prompt-size');
    if (size) size.textContent = '';
  });
}
