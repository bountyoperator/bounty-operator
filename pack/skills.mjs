// The agent pack: which skills ship, under which permanent names, and what
// each SKILL.md is built from. scripts/build-pack.mjs reads this file.
//
// Open core. Only the three core profiles (general, solidity, report) carry
// their method in the public engine, so only they become method skills. The
// hosted profiles reach an agent only through the Bounty Operator MCP server:
// `gauntlet` and `hunt-with-gate` orchestrate tool calls and hold no method.
//
// Skill names are permanent. They follow the Agent Skills naming rule and avoid
// names an agent already ships: `code-review` is a bundled Claude Code command
// that a skills-directory install would replace, so the general profile ships
// as `code-security-review`, the name of its page on the site.

export const SITE = 'https://bountyoperator.com';
export const REPOSITORY = 'https://github.com/bountyoperator/bounty-operator';
export const MCP_ENDPOINT = `${SITE}/api/mcp`;

/** The variables the plugin's MCP declaration reads. Both are names of our own, so no client treats them as its own credential. */
export const TOKEN_VAR = 'BOUNTY_OPERATOR_TOKEN';
export const PROVIDER_KEY_VAR = 'BOUNTY_OPERATOR_PROVIDER_KEY';

/**
 * @typedef {object} SkillSpec
 * @property {string} name          Permanent skill name; also the folder under skills/.
 * @property {'core' | 'orchestrator'} kind  core: generated from a core profile. orchestrator: a hand-written body that only calls tools.
 * @property {string} [profile]     The core profile id a core skill is generated from.
 * @property {string} [body]        The hand-written body under pack/, for an orchestrator.
 * @property {string} [wrapper]     The hand-written wrapper under pack/wrappers/, for a core skill.
 * @property {string} title         The heading of the SKILL.md body.
 * @property {string} description   Frontmatter description: what it does, then exactly when to use it.
 * @property {boolean} [manualOnly] True when the agent must never start it on its own.
 * @property {string} [shortDescription] The one-line label Codex shows for a manual-only skill.
 */

/** @type {readonly SkillSpec[]} */
export const SKILLS = Object.freeze([
  {
    name: 'challenge-report',
    kind: 'core',
    profile: 'report',
    wrapper: 'wrappers/challenge-report.md',
    title: 'Challenge a draft report',
    description:
      'Checks a draft bug bounty report against the code it cites before it is filed. Marks every claim confirmed, overstated, contradicted or unverifiable with the line that decides it, runs the submission checks and ends in one verdict: submit, rewrite-then-submit, prove-first, hold-duplicate or drop. Use before filing a bug bounty or audit-contest report on Immunefi, Cantina, Sherlock, HackerOne or a similar platform, and whenever the user asks whether a finding write-up is ready to submit. Runs on your own model with no account.',
  },
  {
    name: 'solidity-review',
    kind: 'core',
    profile: 'solidity',
    wrapper: 'wrappers/solidity-review.md',
    title: 'Solidity review',
    description:
      'Security review of Solidity contracts. Maps who can call what, compares sibling functions, checks every writer of each accounting invariant, then sweeps rounding, checkpoints, external calls, signatures, oracles, upgrade paths and edge inputs, citing file and line for every finding. Use when asked to review Solidity or other EVM smart contracts for security issues, before deploying a contract, or to test a suspected smart-contract finding against the code. Runs on your own model with no account.',
  },
  {
    name: 'code-security-review',
    kind: 'core',
    profile: 'general',
    wrapper: 'wrappers/code-security-review.md',
    title: 'Code security review',
    description:
      'Security review of any codebase that is not Solidity. Traces each reachable handler from input to effect and reports the access-control, injection, data-exposure and failure-path bugs the code proves, each with file, line and fix. Use when asked to review a web app, API, service, CLI or library for security vulnerabilities, before a release, or to test a suspected web or backend finding against the code. Runs on your own model with no account.',
  },
  {
    name: 'gauntlet',
    kind: 'orchestrator',
    body: 'gauntlet.md',
    title: 'Gauntlet',
    description:
      "Runs a security finding through Bounty Operator's eight pre-submission stages in order (scope, provenance, prior art, proof, severity, triager, report, verdict) on the bounty-operator MCP server, stops at a drop or duplicate gate, then builds the evidence packet and reports the verdict, the blocker and the cheapest action that removes it. Use when the user wants the full pre-submission check on a bug bounty finding and has a Bounty Operator connection token and a provider key. Without them, use challenge-report.",
  },
  {
    name: 'hunt-with-gate',
    kind: 'orchestrator',
    body: 'hunt-with-gate.md',
    title: 'Hunt with a gate',
    shortDescription: 'Gate a finding before any report is written',
    manualOnly: true,
    description:
      'Manual invocation only: run it when the user calls hunt-with-gate by name. Puts a gate between a finding and its report: before any report is written it runs challenge-report on the finding, and the hosted gauntlet when a Bounty Operator token is configured, and stops at the first drop or duplicate. Works on a finding from the user or from any other tool. It never submits, posts or sends a report anywhere and ships no bug-finding prompts.',
  },
]);

/** The core profiles the pack may carry. Anything else is hosted and never reaches the pack. */
export const CORE_PROFILES = Object.freeze(['general', 'solidity', 'report']);
