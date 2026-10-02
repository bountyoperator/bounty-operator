// Review profiles. A profile adds its own method and its own output sections
// to the shared review contract in review-core.mjs.
//
// Three profiles are core profiles: general, solidity and report carry their
// full method here, and any model can run them from an exported prompt. Every
// other profile is hosted: this file holds what a form needs to offer it (name,
// description, what it reads, the titles of its sections) and nothing of its
// method. The server adds the method when it runs the review; see the
// `instructionsFor` option of prepareReview.
//
// Profile ids are stored with every review and never change. Add a profile by
// adding an entry here; nothing else in the engine switches on the id.

/**
 * @typedef {object} Profile
 * @property {string} id
 * @property {string} name
 * @property {string} tagline
 * @property {string} description
 * @property {'bounty' | 'own-code' | 'either'} mode  Fixed mode, or `either` when the caller chooses.
 * @property {readonly string[]} needs  What the profile reads, most decisive first: `input:<kind>` for a file to supply (see INPUT_KINDS) and `context:<key>` for a Context field to fill.
 * @property {string} defaultFocus  The request used when the user leaves it blank.
 * @property {boolean} hosted  True when the server adds the method at run time. `instructions` and `extraFormat` are then empty.
 * @property {string} instructions  The profile's method, appended to the review contract. Empty for a hosted profile.
 * @property {string} extraFormat  Output sections this profile adds. Empty for a hosted profile.
 * @property {readonly string[]} sections  Titles of the sections the profile adds, in order.
 * @property {readonly string[]} next  Profile ids that usefully follow this one.
 * @property {boolean} listed  False for profiles only the gauntlet and the panel use.
 *
 * @typedef {{ label: string, hint: string }} InputKind
 */

/**
 * The kinds of file a profile asks for. A profile names them in `needs` as
 * `input:<kind>`; the form shows `label` and `hint`.
 *
 * @type {Readonly<Record<string, InputKind>>}
 */
export const INPUT_KINDS = Object.freeze({
  source: Object.freeze({ label: 'Source files', hint: 'The code under review, or the code the finding cites, at the scoped revision.' }),
  draft: Object.freeze({ label: 'Draft report', hint: 'Your draft report or finding notes, as one file.' }),
  poc: Object.freeze({ label: 'Proof', hint: 'The proof source and its captured output.' }),
  'project-docs': Object.freeze({ label: 'Project evidence', hint: 'Tests, docs, changelog, audit notes and commit history for the cited lines.' }),
  'prior-material': Object.freeze({ label: 'Prior material', hint: 'Known-issue list, every audit with its fix-review notes, issues, pull requests, branch and commit lists.' }),
  'tool-output': Object.freeze({ label: 'Tool output', hint: 'Static-analysis or fuzzing output as text, JSON or SARIF.' }),
  'stage-outputs': Object.freeze({ label: 'Stage outputs', hint: 'The earlier stage reviews, as stage-N-<profile>.md.' }),
  'panel-reviews': Object.freeze({ label: 'Panel reviews', hint: 'Each model review, as panel-<n>-<model>.md.' }),
});

const GENERAL = {
  id: 'general',
  name: 'Code security review',
  tagline: 'Authorization, data handling and failure paths in any codebase.',
  description: 'Traces every reachable handler from input to effect and reports the access-control, injection, data-exposure and failure-path bugs the code proves, each with file and line.',
  mode: 'either',
  needs: ['input:source', 'context:target', 'context:scope', 'context:version'],
  defaultFocus: 'Review these files for security vulnerabilities. Report what the code proves, with exact lines, and the fix for each.',
  instructions: `
Profile: code security review.
Read the code as an attacker who controls every input it accepts. Work in this order.

Before you name any bug class, put each assumption the code relies on into plain words and ask who can make it false. Reread every path that looked clean from its last line back to its first. This is working method: it never appears in the output.

1. Entry points. List every externally reachable handler, route, job, command or exported function, and who can reach it: anyone, an authenticated user, a named role, another service.
2. Trace each one from input to effect. Follow the data into queries, shell commands, file paths, templates, deserialisers, outbound requests and cryptographic calls.
3. Check each entry point for: authentication; authorization on every object lookup, where the tenant or owner predicate belongs inside the query and not after it; who can grant or change roles; validation where data crosses a trust boundary; injection; secrets and personal data in responses, logs and errors; failure paths that fail open; replay, races and check-then-use gaps on state changes; resource exhaustion from attacker-sized input.
4. Sibling diff. Compare each handler with the handlers beside it. A check that one handler performs and its sibling skips is a finding when both guard the same asset.

Code with no reachable caller in the supplied files goes to Hardening. A control that an unsupplied layer may provide is Basis depends-on-unsupplied-code, naming that layer.
List at most 12 entry points, the ones that change or return sensitive data first.
`.trim(),
  extraFormat: `
## Entry points
- <handler> | <ref> | <anyone|authenticated|role:NAME|internal> | <what it changes or returns>
`.trim(),
  next: ['poc', 'report'],
  listed: true,
};

const SOLIDITY = {
  id: 'solidity',
  name: 'Solidity review',
  tagline: 'Entry points, invariants and value flow in Solidity contracts.',
  description: 'Maps who can call what, compares sibling functions, checks every writer of each accounting invariant, then sweeps rounding, checkpoints, external calls, signatures, oracles, upgrade paths and edge inputs.',
  mode: 'either',
  needs: ['input:source', 'context:target', 'context:scope', 'context:version'],
  defaultFocus: 'Review these contracts. Map the entry points and invariants, then report every way value or control can be taken, with exact lines.',
  instructions: `
Profile: Solidity review.
Work through the contracts in this order before writing anything.

Frame. Name the protocol type from the code: lending market, vault, exchange, bridge, staking, governance or another. Name the adversaries that type draws and the invariants it always carries, and test those invariants in step 3 whether or not the code states them. For each parameter a privileged role can change, ask what the change does to an operation already in flight. Record which privileged actions take effect at once and which functions a pause stops.

Assumptions. Before you name any bug class, put each assumption the code relies on into plain words and ask who can make it false. Reread every path that looked clean from its last line back to its first. Frame and Assumptions are working method: neither appears in the output.

1. Entry points. List every external or public function that changes state. Leave out view and pure functions, interfaces, library internals, mocks and tests. Decide from each function body who can call it: anyone, a named role, or the owner or admin. A caller check written inside the body counts the same as a modifier. A reentrancy guard is not access control: record it on its own, as guard=yes when the function carries one and guard=no when it does not. Note whether value moves in, out or not at all.

2. Sibling diff. Put each function next to the functions that do the same kind of work: the other setters, the other paths that pay out, the other paths that mint or burn. Compare four more pairs: the branches inside one function, the single-item path against its batch version, the user version against the admin version, and a preview function against the function it previews. A modifier, pause check, checkpoint or validation that one side has and the other lacks is a finding when both touch the same asset.

3. Invariants. Write down each property the accounting depends on: conservation (the sum of balances equals the total), ratio (shares to assets), ordering (state-machine steps), bounds (caps and minimums). Tag each one stated when a comment, a doc or a test in the supplied files says it, and inferred when you derived it from the code. For each property, find every line that writes the variables involved. One write site that skips the update or the check breaks the invariant. For each accounting variable, list every function that writes it and every function that reads it: the writer with the fewest checks is the protection the variable really has. A stored total that one path increases and no path decreases is a lead. Mark each flag one-way or reversible, and check what a one-way flag leaves stuck. A time value is compared before it is overwritten, never after. A require on an argument protects one call; it is not an invariant. A broken stated invariant is a finding. A broken inferred invariant is a finding only when a Path shows who loses what; otherwise it goes to Hardening with the check that settles it.

4. Sweep. Cite lines for each item that applies.
- Value flow and rounding: which way every division rounds and who gains from it; division before multiplication; the first deposit into an empty pool; direct transfers to the contract that move a price or a share ratio.
- Checkpoint before balance change: reward, fee, vote and interest accumulators must update for an account before its balance, stake or delegation changes. Check the zero-balance case and transfers, not only deposit and withdraw.
- External calls: which state is stale at the moment of each call, token transfer, hook or callback; whether a function without the guard can be entered from that call, including view functions other protocols read; unchecked return values; tokens that charge a fee, rebase or call back.
- Accounting versus balance: every place the code trusts its own token balance or a stored total, and what happens when the two differ.
- Signatures and replay: nonce, deadline, chain id and contract address inside the signed data; the zero address returned for a bad signature; one signature valid for more than one action.
- Oracle and time: stale or zero prices, decimals, a spot price movable inside one transaction, block timestamp or number used as a deadline or as randomness.
- Privileged paths: what the owner, a role or an upgrader can take or freeze, and whether that privilege can be gained through an unprotected setter or initialiser.
- Upgrade and initialisation: initialisers callable twice or by anyone, an implementation left uninitialised, storage layout changes, delegatecall or selfdestruct reachable with a supplied address.
- Edge inputs, on every external call and every payable function: a call target with no code; a token that returns nothing; an amount of zero and the maximum amount; a placeholder address, zero or the native-asset marker, reaching a token call; sent value that differs from the amount argument.

5. Repeats. Once a flaw is confirmed, search every other supplied contract for the same construction. Report the worst instance and list the others in its Location.

6. Crossings. Last, make one more pass for bugs that exist only where two sweep items meet: rounding inside a callback, a stale checkpoint behind a signature path, an oracle read in the middle of an upgrade.

A path that needs the owner, an admin or another trusted role to act is a finding only when an ordinary caller performs a named step that triggers the damage or makes it larger; name that step in Path. With no such step it is Hardening, unless Context puts privileged roles in scope.
List at most 12 entry points, value-moving ones first.
`.trim(),
  extraFormat: `
## Entry points
- <function> | <ref> | <anyone|role:NAME|admin> | guard=<yes|no> | value=<in|out|none>

## Invariants
- <property> | <stated|inferred> | <holds|broken> | <F-n or ref>
`.trim(),
  next: ['poc', 'report'],
  listed: true,
};

const REPORT = {
  id: 'report',
  name: 'Challenge a draft report',
  tagline: 'Every claim in your draft, checked against the code.',
  description: 'Splits the draft into claims and marks each one confirmed, overstated, contradicted or unverifiable with the line that decides it, then checks that the proof sits inline, that form and body agree and that no passage reads as generic. A correct report gets confirmed.',
  mode: 'bounty',
  needs: ['input:draft', 'input:source', 'input:poc', 'context:version', 'context:impactRow', 'context:proofLog', 'context:readBack'],
  defaultFocus: 'Challenge this draft report against the supplied code. Mark each claim and give the verdict.',
  instructions: `
Profile: challenge a draft report. One supplied file is the draft; the rest is the evidence it relies on. Context carries the row selected on the form, the proof run and the read-back of the stored submission when the hunter gave them.

Read the draft as the triager who has to pay for it. Split it into its claims: the root cause, each step of the attack path, the stated preconditions, the impact, the severity and the fix. Check each claim against the code. List at most 10 claims, the ones that decide the report first.

- Agreeing with the draft is a valid result. When the code and the supplied proof support a claim, mark it confirmed and move on. A draft whose decisive claims are all confirmed and whose submission checks pass gets Verdict submit. Do not manufacture objections to look thorough, and do not ask for evidence the draft already contains.
- Never lower or withhold a severity that the code and a supplied test demonstrate. In the claim row for the draft's severity, state the severity the evidence supports and the one assumption that would move it.
- F-1 is the finding the code supports, at the severity it supports. For a correct draft that is the draft's own finding. For a draft that overclaims it is the smaller finding that survives, and each overclaim goes under Claims as overstated or contradicted, with the line that limits it.
- The draft's own steps and test stand in for Path and Test. Write Path only for the steps the draft gets wrong or leaves out, and Test only for the assertion its proof lacks. Otherwise both are none.
- When the code contradicts the root cause and no smaller finding survives, cite the line, set Verdict drop and write no F-n block.
- Check the draft's fix and its proof: does the fix close the path, does the test assert the claimed end state, and would that assertion fail once the fix is applied.
- List only gaps that change the decision. Skip any gap the draft already discloses.

Submission checks. These close reports whose finding is real. Mark each pass, fail or not-supplied.
- proof-inline: the proof source, the command and the captured output sit in the report body and in the proof field. A proof that exists only behind a link is read as no proof.
- form-matches-body: the severity and the impact row on the form are the ones the body argues. not-supplied when Context holds no selected row.
- limits-stated: the draft says where the finding stops: the bound on the loss, the preconditions, what was not tested. One sentence is enough.
- title: the title states mechanism and consequence in one sentence.
- steps-separate: the attack path is a numbered list of its own, apart from the test code.
- read-back: the stored submission in Context equals the draft field by field. An empty or link-only proof field fails. not-supplied when Context holds no read-back.
- concrete-detail: the root cause, the path and the proof each name something a reader can check: an identifier, a value, a command, an output line. fail when one of the three holds none.

Generic passages. A report with no reproduction detail and no concrete value is closed as spam, without a rebuttal. Quote each passage that reads as generic or machine-written: security background that fits any project, impact stated with no figure, a step with no function name or value, a claimed result with no command or output. Beside each, name the concrete value, command or output from the supplied files that replaces it. List at most 5. Listing a passage does not change the Verdict; a failed check does.

When stage outputs are supplied, the draft must say what they settled: the row from the scope stage, the level from the severity stage, the nearest known issue from the prior-art stage. Where the draft and a stage disagree, the code decides.

Verdict, the first that fits: drop when nothing reportable survives: the code contradicts the root cause and no smaller finding remains, or the behaviour is documented as intended. hold-duplicate when the supplied material contains prior art with the same root cause. prove-first when the decisive claim is unverifiable from what was supplied. rewrite-then-submit when a finding holds and the draft misstates its root cause, severity, impact, preconditions or fix, or a submission check fails. submit when every decisive claim is confirmed and no submission check fails.
Write Rewritten report only when the Verdict is rewrite-then-submit.
`.trim(),
  extraFormat: `
## Claims
- C1 | <confirmed|overstated|contradicted|unverifiable> | <ref> | <the claim in a few words, and why>

## Submission checks
- <proof-inline|form-matches-body|limits-stated|title|steps-separate|read-back|concrete-detail> | <pass|fail|not-supplied> | <ref, or the change to make>

## Generic passages
- "<passage, shortened>" | <ref> | <the concrete value, command or output that replaces it>

## Rewritten report
Title: <mechanism and consequence, one sentence>
Severity: <value>
Summary: <two sentences>
Impact: <who loses what, with the bound>
Limits: <what the finding does not reach>
`.trim(),
  next: ['scope', 'provenance', 'prior-art'],
  listed: true,
};

// ---------------------------------------------------------------------------
// Hosted profiles: what a form shows. The server adds the method when a review runs.
// ---------------------------------------------------------------------------

const SCOPE = {
  id: 'scope',
  name: 'Scope and impact fit',
  tagline: 'Asset, revision, exclusions and the impact row, clause by clause.',
  description: 'Binds the cited code to the scoped asset at the deployed revision, tests the finding against every exclusion, then splits the selected impact row into clauses and names the artefact behind each one.',
  mode: 'bounty',
  needs: ['input:draft', 'input:source', 'context:target', 'context:scope', 'context:version', 'context:proofRevision', 'context:impactList', 'context:impactRow', 'context:exclusions'],
  defaultFocus: 'Check that this finding is in scope: bind the code to the scoped asset and revision, test every exclusion, and match the selected impact row clause by clause.',
  sections: ['Binding', 'Exclusions', 'Impact row', 'Row to claim'],
  next: ['provenance', 'prior-art'],
  listed: true,
};

const PROVENANCE = {
  id: 'provenance',
  name: 'Design intent and actors',
  tagline: 'Who performs each step, and whether the project meant it.',
  description: 'Labels who performs every step and supplies every decisive value, reads comments, tests and history for design intent, reruns the path without the bug step and traces each precondition back to live state.',
  mode: 'bounty',
  needs: ['input:draft', 'input:source', 'input:project-docs', 'input:poc', 'context:actors', 'context:exclusions', 'context:mocks', 'context:version'],
  defaultFocus: 'Decide whether this behaviour is intended and whether an unprivileged actor reaches it: actor table, intent evidence, counterfactual and preconditions.',
  sections: ['Actors', 'Intent', 'Counterfactual', 'Preconditions'],
  next: ['prior-art', 'poc'],
  listed: true,
};

const PRIOR_ART = {
  id: 'prior-art',
  name: 'Prior-art overlap',
  tagline: 'Same root cause, or only the same symptom.',
  description: 'Fingerprints the root cause and its one-line fix, classes each known issue, audit note, branch or earlier report of your own as same-root, same-symptom-different-root or unrelated, and prints the duplicate clock.',
  mode: 'bounty',
  needs: ['input:draft', 'input:source', 'input:prior-material', 'context:prior', 'context:cloneDepth', 'context:ownHistory', 'context:economics'],
  defaultFocus: 'Compare this finding with the supplied prior material and your own earlier reports. Fingerprint the root cause, class every prior item and print the duplicate clock.',
  sections: ['Fingerprint', 'Overlap', 'Own reports', 'Duplicate clock', 'Search strings'],
  next: ['poc', 'severity'],
  listed: true,
};

const POC = {
  id: 'poc',
  name: 'Proof review',
  tagline: 'Checks that the proof shows the impact and not only the defect.',
  description: 'Checks a proof of concept the way a triager runs it: production code on every step, live state, the assertion that reads the object the impact row names, measured numbers and the run log. With no PoC supplied, it plans one.',
  mode: 'bounty',
  needs: ['input:draft', 'input:source', 'input:poc', 'context:proof', 'context:version', 'context:proofRevision', 'context:impactRow', 'context:proofLog', 'context:mocks', 'context:loss'],
  defaultFocus: 'Review this proof of concept as the triager who will run it once. If there is no PoC, plan one.',
  sections: ['Steps', 'PoC checklist', 'End state', 'PoC plan'],
  next: ['severity', 'triage'],
  listed: true,
};

const SEVERITY = {
  id: 'severity',
  name: 'Severity calibration',
  tagline: 'One level, graded on the programme\'s own table.',
  description: 'Grades the finding against the severity table you paste, read literally: criterion by criterion, with victim actions counted, the loss placed and recovery applied. Names the one fact that would move it a step.',
  mode: 'bounty',
  needs: ['input:draft', 'input:source', 'input:poc', 'context:rules', 'context:impactList', 'context:impactRow', 'context:loss'],
  defaultFocus: 'Grade this finding against the programme severity table in Context. Give one level and the fact that would move it.',
  sections: ['Severity grid', 'Calibration'],
  next: ['triage', 'report-edit'],
  listed: true,
};

const TRIAGE = {
  id: 'triage',
  name: 'Triager simulation',
  tagline: 'The three reasons a triager closes this report, ranked.',
  description: 'Reads the draft as the programme triager, writes the one sentence that closes it in ten minutes, ranks the three likeliest rejection reasons, quotes the sentence that triggers each and names the evidence that flips it.',
  mode: 'bounty',
  needs: ['input:draft', 'input:source', 'context:rules', 'context:scope', 'context:exclusions', 'context:impactRow', 'context:prior'],
  defaultFocus: 'Act as the programme triager. Give the three likeliest reasons to reject this report and what flips each one.',
  sections: ['Closing sentence', 'Rejection reasons'],
  next: ['report', 'report-edit'],
  listed: true,
};

const REPORT_EDIT = {
  id: 'report-edit',
  name: 'Report editor',
  tagline: 'Your report with everything a triager distrusts removed.',
  description: 'Returns your report cleaned of unproven claims, private links, local paths, tool credit, generic passages and filler, with every limit you wrote kept and a list of every claim removed and what would let it back in.',
  mode: 'bounty',
  needs: ['input:draft', 'input:source', 'input:poc', 'context:impactRow', 'context:proofLog'],
  defaultFocus: 'Edit this report so a triager can verify it in one pass. Return the cleaned report and list what you removed.',
  sections: ['Cleaned report', 'Removed claims', 'Open questions'],
  next: ['triage', 'report'],
  listed: true,
};

const SCANNER = {
  id: 'scanner',
  name: 'Scanner triage',
  tagline: 'Static-analysis output, grouped by root cause and ranked.',
  description: 'Turns Slither, Aderyn, Semgrep or similar output into a short manual-review queue: grouped by root cause, ranked by what each lead could cost, with the noise counted and dropped.',
  mode: 'either',
  needs: ['input:tool-output', 'input:source', 'context:scope', 'context:rules'],
  defaultFocus: 'Triage this scanner output into a ranked manual-review queue, grouped by root cause.',
  sections: ['Queue', 'Dropped', 'Needs context'],
  next: ['solidity', 'general'],
  listed: true,
};

const VERDICT = {
  id: 'verdict',
  name: 'Final verdict',
  tagline: 'One verdict, one blocker, the cheapest action that removes it.',
  description: 'Reads every earlier stage of the gauntlet against the source and produces the dossier: one verdict, the rule that decides it, one blocker, the cheapest action that removes it, the filing deadline and the ordered to-do list.',
  mode: 'bounty',
  needs: ['input:draft', 'input:source', 'input:stage-outputs', 'context:ownHistory', 'context:economics', 'context:rules', 'context:readBack'],
  defaultFocus: 'Read the stage outputs against the source and give the final verdict: one blocker, the cheapest action that removes it, the filing deadline and the ordered to-do list.',
  sections: ['Stages', 'Decision', 'To do'],
  next: [],
  listed: false,
};

const PANEL = {
  id: 'panel',
  name: 'Panel cross-examination',
  tagline: 'Several model reviews, reduced to what the code proves.',
  description: 'Merges independent reviews from several models, tests every finding against the cited lines and keeps only what survives, with the agreement count for each.',
  mode: 'either',
  needs: ['input:source', 'input:panel-reviews'],
  defaultFocus: 'Cross-examine the panel reviews against the source. Keep only the findings the code proves and record how many reviewers reported each.',
  sections: ['Agreement'],
  next: [],
  listed: false,
};

/** Titles of the `## ` headings in a format template, in order. */
function sectionTitles(format) {
  return format.split('\n').filter((line) => line.startsWith('## ')).map((line) => line.slice(3).trim());
}

function coreProfile(profile) {
  return Object.freeze({
    ...profile,
    hosted: false,
    sections: Object.freeze(sectionTitles(profile.extraFormat)),
    needs: Object.freeze([...profile.needs]),
    next: Object.freeze([...profile.next]),
  });
}

function hostedProfile(profile) {
  return Object.freeze({
    ...profile,
    hosted: true,
    instructions: '',
    extraFormat: '',
    sections: Object.freeze([...profile.sections]),
    needs: Object.freeze([...profile.needs]),
    next: Object.freeze([...profile.next]),
  });
}

/** @type {readonly Profile[]} */
export const PROFILES = Object.freeze([
  ...[GENERAL, SOLIDITY, REPORT].map(coreProfile),
  ...[SCOPE, PROVENANCE, PRIOR_ART, POC, SEVERITY, TRIAGE, REPORT_EDIT, SCANNER, VERDICT, PANEL].map(hostedProfile),
]);

/** Ids of the profiles whose prompt can be exported and run on any model. */
export const CORE_PROFILE_IDS = Object.freeze(PROFILES.filter((profile) => !profile.hosted).map((profile) => profile.id));

/**
 * Ordered profile ids of the gauntlet; each stage receives the earlier stage
 * outputs as files. The gates that end a report run before the stages that
 * cost work.
 * @type {readonly string[]}
 */
export const GAUNTLET = Object.freeze(['scope', 'provenance', 'prior-art', 'poc', 'severity', 'triage', 'report', 'verdict']);

// An earlier release stored the Solidity profile under a prefixed id. Saved
// settings, links and history entries that carry such an id still resolve.
const PREFIXED_SOLIDITY = /^[a-z0-9]{1,24}-solidity$/;

/**
 * @param {string} [id]
 * @returns {Profile}
 */
export function reviewProfile(id = 'general') {
  const resolved = typeof id === 'string' && PREFIXED_SOLIDITY.test(id) ? 'solidity' : id;
  const profile = PROFILES.find((candidate) => candidate.id === resolved);
  if (!profile) throw new Error('Choose a supported review profile.');
  return profile;
}

/**
 * The error for a hosted profile asked for its method where none is available.
 *
 * @param {Profile} profile
 * @returns {Error & { code: 'hosted_profile', profile: string }}
 */
export function hostedProfileError(profile) {
  const open = CORE_PROFILE_IDS.map((id) => reviewProfile(id).name).join(', ');
  const error = new Error(`${profile.name} runs as a hosted review: our server adds its method and sends it with your files to the provider you chose, under your key. No page, tool or download returns it. The core profiles are ${open}.`);
  return Object.assign(error, { code: 'hosted_profile', profile: profile.id });
}

/**
 * The method text of a core profile. A hosted profile has none here: the
 * error carries `code: 'hosted_profile'`.
 *
 * @param {string} [id]
 * @returns {string}
 */
export function profileInstructions(id = 'general') {
  const profile = reviewProfile(id);
  if (profile.hosted) throw hostedProfileError(profile);
  return profile.instructions;
}
