// The three prompts. Names, titles, descriptions and arguments match the
// remote endpoint; the steps name files by path, which only this server reads.

import { GAUNTLET } from '../lib/profiles.mjs';

const PRIVACY_STEP =
  'If the privacy check stops the call, show me each file, line and kind of match. For a block, wait until I have redacted it. For a warning, ask me whether to send the files as they are.';
const ANSWER_STEP =
  'Answer the returned request yourself, as the reviewer the instructions describe. Read the files from disk, cite every location as <label>:<line> with the labels from the manifest, start at "# Review" and follow the output format exactly.';
const CONTEXT_STEP =
  'a context object holding only what I have told you: target, scope, version, proof (none, local or deployment), prior (unchecked, searched, overlap or distinct) and any programme rules';

function platformLine(platform) {
  return platform ? ` The report is for ${platform}.` : '';
}

/**
 * @typedef {object} Prompt
 * @property {string} name
 * @property {string} title
 * @property {string} description
 * @property {{ name: string, description: string, required: boolean }[]} arguments
 * @property {(args: Record<string, string>) => string} text
 */

/** @type {readonly Prompt[]} */
export const PROMPTS = Object.freeze([
  {
    name: 'challenge-report',
    title: 'Challenge a draft report',
    description: 'Checks every claim in a draft report against the code it cites, then builds the evidence packet.',
    arguments: [{ name: 'platform', description: 'Where the report will be submitted, such as Immunefi, Cantina, Sherlock or HackerOne.', required: false }],
    text: ({ platform }) =>
      [
        `Challenge my draft report before I submit it.${platformLine(platform)}`,
        '',
        '1. Find the draft report and every source file it cites. Name them as paths under the working directory and put the draft first.',
        `2. Call prepare_review with profile "report", those paths, and ${CONTEXT_STEP}.`,
        `3. ${PRIVACY_STEP}`,
        `4. ${ANSWER_STEP}`,
        '5. Call build_packet with your review text, the manifest and the same context.',
        '6. Show me the verdict, the headline, every open counterargument and every reference problem. Then give me the packet.',
      ].join('\n'),
  },
  {
    name: 'solidity-review',
    title: 'Review Solidity contracts',
    description: 'Maps entry points and invariants in the contracts you name and reports what the code proves, with file and line.',
    arguments: [{ name: 'mode', description: 'own-code for contracts you ship (default), bounty for a finding you plan to report.', required: false }],
    text: ({ mode }) =>
      [
        'Review the Solidity contracts I name.',
        '',
        '1. Find the contracts in scope and the interfaces, libraries and tokens they call. Name them as paths under the working directory.',
        `2. Call prepare_review with profile "solidity", mode "${mode === 'bounty' ? 'bounty' : 'own-code'}", those paths, and ${CONTEXT_STEP}.`,
        `3. ${PRIVACY_STEP}`,
        `4. ${ANSWER_STEP}`,
        '5. Call build_packet with your review text, the manifest and the same context.',
        '6. Show me the verdict, each finding with its location and gap, and every reference problem. Then give me the packet.',
      ].join('\n'),
  },
  {
    name: 'gauntlet',
    title: 'Run the gauntlet',
    description: `Takes a finding through the ${GAUNTLET.length} pre-submission stages in order and ends with one verdict.`,
    arguments: [{ name: 'platform', description: 'Where the report will be submitted, such as Immunefi, Cantina, Sherlock or HackerOne.', required: false }],
    text: ({ platform }) =>
      [
        `Run the gauntlet on my finding before I submit it.${platformLine(platform)}`,
        '',
        '1. Find the draft report, the source files it cites and any proof I have. Name them as paths under the working directory and put the draft first.',
        `2. Call run_gauntlet_plan with ${CONTEXT_STEP}.`,
        '3. Ask me once for the fields the plan lists under "ask". I will leave out what I do not have.',
        '4. Follow the plan: run each stage in order with its instruction and keep every review under its saveAs name. A run_review stage runs on the Bounty Operator server with my connection token and my provider key, so ask me once which provider and model to use. A prepare_review stage you answer yourself.',
        `5. ${PRIVACY_STEP}`,
        '6. If a stage ends in drop or hold-duplicate, show me why and ask whether to continue.',
        '7. After the last stage, call build_packet with the arguments the plan gives under "finish".',
        '8. Show me the final verdict, what each stage decided in one line, every open counterargument and every reference problem. Then give me the packet.',
      ].join('\n'),
  },
]);

export function findPrompt(name) {
  if (typeof name !== 'string') return undefined;
  // Some clients turn hyphens into underscores when they list a prompt as a command.
  const wanted = name.replace(/_/g, '-');
  return PROMPTS.find((prompt) => prompt.name === wanted);
}

export function promptArguments(value) {
  const result = {};
  if (!value || typeof value !== 'object') return result;
  for (const [key, raw] of Object.entries(value)) {
    // An argument lands inside a sentence of the prompt: one short line of plain text.
    if (typeof raw === 'string') result[key] = raw.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 80);
  }
  return result;
}
