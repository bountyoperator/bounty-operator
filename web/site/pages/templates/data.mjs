// Content for the report-template pages: one entry per platform.
//
// This module has no default export, so the generator treats it as a helper.
// Every rule stated here comes from a page listed in that platform's `sources`,
// read on the date in CHECKED. When a platform changes its rules, update the
// entry, bump CHECKED, and run `node web/site/pages/templates/write-md.mjs`.
// A source read on a later day carries its own `checked` label, and a source
// its platform has retired carries `dated` saying so.
//
// Template bodies use a small Markdown subset: paragraphs, "- " and "1. " lists,
// fenced code, `inline code` and {placeholders}. Never nest braces.

export const CHECKED = { iso: '2026-10-02', label: '2 Oct 2026' };

const LIMITS_BODY = `- Not claimed: {what this report does not say, for example no loss beyond the funds held at this address}
- Mocked or assumed: {each mock and assumption, or "nothing: every step runs the deployed code"}
- Stops working when: {the condition that breaks the path}`;

// ---------------------------------------------------------------------------
// Immunefi
// ---------------------------------------------------------------------------

const immunefi = {
  id: 'immunefi',
  name: 'Immunefi',
  path: '/templates/immunefi',
  title: 'Immunefi bug report template | Bounty Operator',
  h1: 'Immunefi bug report template',
  description:
    'Immunefi report template in Markdown: title rule, impact quoted from the programme list, runnable PoC with output, and the rules that get reports closed.',
  lede: 'Ten sections in the order Immunefi asks for them, with the impact quoted from the programme and a proof of concept that runs on a local fork. Copy it, fill every placeholder, then send the draft to the workbench before the triager sees it.',
  card: 'Bug bounties and audit competitions. Impact is picked from the programme’s own list.',
  cardClosed: ['No runnable PoC where the programme requires one', 'An impact that is not on the programme’s list', 'Known issues and unfixed audit findings'],
  file: 'immunefi.md',
  download: 'immunefi-report-template.md',
  formNote:
    'Immunefi’s form takes the title, the asset and the impact as separate fields. The first line below goes in the title field. The rest goes in the description.',
  focus: 'Immunefi report draft. Check the impact against the programme’s Impacts in Scope, the PoC rule and the known-issue list.',
  sections: [
    {
      id: 'title',
      heading: 'Title',
      origin: 'platform',
      rule: 'One sentence: the vulnerability class, the function, the consequence. Immunefi’s own examples follow that shape. Take the consequence from the programme’s impact list so the title and the selected impact agree.',
      body: '{Vulnerability class} in `{function}` lets {actor} {consequence, worded as the programme words the impact}',
    },
    {
      id: 'intro',
      heading: 'Brief/Intro',
      origin: 'platform',
      rule: 'One paragraph. What is broken and what happens if it is used on mainnet. The triager decides here whether to read the rest.',
      body: '{What is broken, in which contract, and what an attacker does with it. Then the consequence: whose funds, how much, at which block.}',
    },
    {
      id: 'details',
      heading: 'Vulnerability Details',
      origin: 'platform',
      rule: 'Pin the code. The asset has to be on the programme’s list, and the lines have to exist at the commit the deployed contract was built from. Number the attack steps and name the actor on each one.',
      body: `- Asset in scope: {name and address, exactly as listed under Assets in Scope}
- Source: {repository URL} at commit \`{40-character commit}\`
- Location: \`{path/Contract.sol}\` lines {start}-{end}, function \`{name}\`
- Deployed code matches this commit: {how you checked: verified source, bytecode hash or release tag}

Root cause: {the one line or missing check that opens the path, and why the surrounding checks do not stop it}

\`\`\`solidity
{The smallest excerpt that shows the root cause, with its line numbers}
\`\`\`

Attack path:

1. {Actor} calls \`{function}\` with {concrete arguments}. {State after the call.}
2. {Actor} calls \`{function}\` with {concrete arguments}. {State after the call.}
3. {Final state: the balance, owner or record that is now wrong, with the number.}

Every step is a public call from an account that holds no role. {If a step needs a role, a signature or an action by the victim, name it here.}`,
    },
    {
      id: 'impact',
      heading: 'Impact',
      origin: 'platform',
      rule: 'Quote the impact from the programme’s Impacts in Scope, word for word. Immunefi lists selecting an impact that does not apply as prohibited behaviour. Put the measured loss next to the quote.',
      body: `- Impact selected, quoted from the programme: "{exact text of the impact}"
- Severity that impact sits under in the programme's table: {Critical, High, Medium or Low}
- Who loses: {users, the protocol or liquidity providers} lose {amount and token} of {total at risk at the fork block}
- Loss measured by the PoC: {the number from the output below}
- Recovery: {whether a pause, an upgrade or an admin action returns the funds, and how long that takes}`,
    },
    {
      id: 'risk',
      heading: 'Risk Breakdown',
      origin: 'platform',
      rule: 'How hard the attack is to carry out. Immunefi asks for its own severity classification here in place of a CVSS score. Read the programme’s feasibility limits and downgrade clauses before you claim the tier.',
      body: `- Difficulty: {capital needed, timing, number of transactions}
- Preconditions, and how each is reached from live state: {list}
- Privileges or user interaction needed: {none, or which}
- Programme downgrade clauses checked: {the clause, and why it does or does not apply}`,
    },
    {
      id: 'recommendation',
      heading: 'Recommendation',
      origin: 'platform',
      rule: 'The fix, as a diff where it fits. A concrete fix shows the root cause is understood.',
      body: `{The change, in the file and function it belongs to.}

\`\`\`diff
- {vulnerable line}
+ {fixed line}
\`\`\``,
    },
    {
      id: 'poc',
      heading: 'Proof of Concept',
      origin: 'platform',
      rule: 'Runnable code on a local fork, the command, and the pasted output. A numbered list of steps or pseudocode does not count as a PoC on Immunefi. Running the exploit against mainnet or a public testnet is grounds for a permanent ban.',
      body: `Runs on a local fork. No transaction was sent to mainnet or a public testnet.

- File: \`{test/ImpactPoC.t.sol}\`
- Fork: {chain} at block {number}
- Command: \`{forge test --match-path test/ImpactPoC.t.sol -vvv}\`

\`\`\`solidity
{The full test file}
\`\`\`

Output:

\`\`\`text
{Pasted output, with the final assertion and the measured numbers}
\`\`\`

Control: {the same sequence without the bug step, and its output: no loss}
After the fix: {the same test on the patched build, and its failing line}`,
    },
    {
      id: 'limits',
      heading: 'Limits and non-claims',
      origin: 'added',
      rule: 'State what the report does not claim before the triager asks. Immunefi lists misrepresenting severity as prohibited behaviour. Writing the limits yourself keeps the claim inside what the PoC asserts.',
      body: LIMITS_BODY,
    },
    {
      id: 'known',
      heading: 'Known issues checked',
      origin: 'added',
      rule: 'Programmes exclude issues they have acknowledged and unfixed findings from the audits they link. Name the nearest one and say why this is a different root cause.',
      body: `- Programme known issues and acknowledged risks: {date checked, the nearest item, why this differs}
- Audits linked by the programme: {report and finding id, why the root cause or the fix differs}
- Public issues, pull requests and team branches: {what you searched, the nearest match, the difference}`,
    },
    {
      id: 'references',
      heading: 'References',
      origin: 'platform',
      rule: 'Links only: the code at the pinned commit, the documentation that defines expected behaviour, the deployed contract.',
      body: `- {Code at the pinned commit}
- {Documentation or specification the expected behaviour comes from}
- {Deployed contract on the block explorer}`,
    },
  ],
  closed: [
    {
      title: 'No PoC, or one that does not run',
      body: 'Submitting without a PoC, or with an incomplete one, where the programme requires it is on Immunefi’s list of prohibited behaviour. Programme terms add that such a report gets no reward. Immunefi’s guide says what a PoC is not:',
      quote: { text: 'Not a list of steps', source: 'guide' },
      sources: ['rules', 'guide', 'program'],
    },
    {
      title: 'Testing on mainnet or a public testnet',
      body: 'Grounds for an immediate and permanent ban. Every PoC runs on a local fork.',
      sources: ['rules'],
    },
    {
      title: 'An impact, asset or severity that does not apply',
      body: 'Claiming an asset that is not in scope, selecting an impact that does not apply, or rating a bug Critical when it is not are each listed as prohibited behaviour. Quote the impact row and match every clause of it to something the PoC shows.',
      sources: ['rules'],
    },
    {
      title: 'Known issues and unfixed audit findings',
      body: 'Programmes publish the issues they have acknowledged and link their audits. A finding already listed there, or left unfixed in a linked audit, is not eligible. Reporting a bug that is already public is prohibited.',
      sources: ['program', 'rules'],
    },
    {
      title: 'Default out-of-scope impacts',
      body: 'Unless the programme says otherwise: attacks that need a privileged address or leaked keys, wrong data supplied by a third-party oracle, 51% and Sybil attacks, lack of liquidity, centralisation risks, and best-practice recommendations. Oracle manipulation and flash-loan attacks are not excluded by that list.',
      sources: ['severity'],
    },
    {
      title: 'Severity qualifiers',
      body: 'Severity follows the consequence. When the exploit needs elevated privileges or uncommon user interaction, the level drops or the report is rejected. Programmes add feasibility limits of their own, such as a one-level downgrade when the attack depends on another protocol.',
      sources: ['severity', 'program'],
    },
    {
      title: 'Placeholder and scanner reports',
      body: 'A vague title, few details and no reproducible steps is a placeholder submission. AI-generated or scanner output that does not show the impact on the reported asset is prohibited, and so is a second report of your own bug filed to claim another reward.',
      sources: ['rules'],
    },
    {
      title: 'Penalties',
      body: 'The rules page publishes no submission fee. Breaking the rules costs a temporary suspension or a permanent ban, loss of access to the report, and zero payout.',
      sources: ['rules'],
    },
  ],
  sources: [
    { id: 'rules', label: 'Immunefi Rules', href: 'https://immunefi.com/rules/', note: 'Prohibited behaviour for whitehats and the penalties.' },
    {
      id: 'guide',
      label: 'How to Submit Bug Reports That Get Paid',
      href: 'https://immunefi.com/blog/security-guides/how-to-submit-bug-reports-that-get-paid/',
      note: 'The report sections and what counts as a PoC.',
      dated: 'Published 10 Feb 2023',
    },
    {
      id: 'severity',
      label: 'Vulnerability Severity Classification System v2.3',
      href: 'https://immunefi.com/immunefi-vulnerability-severity-classification-system-v2-3/',
      note: 'Impact levels, default out-of-scope impacts, prohibited activities.',
    },
    {
      id: 'program',
      label: 'Immunefi’s own bug bounty programme terms',
      href: 'https://immunefi.com/bug-bounty/immunefi/information/',
      note: 'A live example of programme terms: PoC requirement, known issues, previous audits, feasibility limits.',
      dated: 'Updated 9 Sep 2026',
    },
    {
      id: 'poc-rules',
      label: 'Proof of Concept (PoC) Guidelines and Rules',
      href: 'https://immunefisupport.zendesk.com/hc/en-us/articles/9946217628561-Proof-of-Concept-PoC-Guidelines-and-Rules',
      note: 'Help-centre article behind an Immunefi sign-in. Linked for reference. Nothing on this page is taken from it.',
    },
  ],
};

// ---------------------------------------------------------------------------
// Sherlock
// ---------------------------------------------------------------------------

const sherlock = {
  id: 'sherlock',
  name: 'Sherlock',
  path: '/templates/sherlock',
  // Its sources were re-pointed and re-read after CHECKED: see `checked` on each.
  lastmod: '2026-10-09',
  title: 'Sherlock audit contest report template | Bounty Operator',
  h1: 'Sherlock audit contest report template',
  description:
    'Sherlock report template in Markdown: root cause, pre-conditions, attack path and impact against the High and Medium thresholds, plus what judges invalidate.',
  lede: 'Sherlock’s own headings, in its order, with the loss thresholds a judge reads the Impact section against. Two sections are added at the end for the objections that close reports: limits and known issues.',
  card: 'Audit contests and bounties. Only High and Medium score, against written loss thresholds.',
  cardClosed: ['Loss below the Medium threshold', 'Trusted admin or a design decision', 'Issues the README or a linked audit already lists'],
  file: 'sherlock.md',
  // Sherlock's own template sets its section headings at level three.
  headingLevel: 3,
  download: 'sherlock-report-template.md',
  formNote:
    'The headings from Summary to Mitigation are the ones in Sherlock’s published report template. Keep them as they are. One issue per submission, even when two issues share a line.',
  focus: 'Sherlock contest report draft. Check root cause, pre-conditions and the High or Medium loss threshold against the judging criteria.',
  // Read at docs.sherlock.xyz on 9 Oct 2026: the five audit contest pages cited
  // below moved under /audit-contests-deprecated-replaced-by-audit-engine/. The
  // rules on this page are those contest rules. Audit Engine sets judging
  // guidelines and severity weights per engagement and publishes no fixed
  // thresholds, so there is nothing to re-point the rules at.
  sourcesNote: 'Sherlock now files its audit contest pages as deprecated, replaced by Audit Engine. The contest rules on this page are those earlier rules, as Sherlock still publishes them. An Audit Engine engagement sets its own judging guidelines and severity weights: read the ones published for your engagement first. The bug bounty sources are current.',
  sections: [
    {
      id: 'title',
      heading: 'Title',
      origin: 'platform',
      rule: 'Sherlock’s template builds the title from three parts: the actor, the impact, the affected party.',
      body: '{Actor} will {impact} {affected party}',
    },
    {
      id: 'summary',
      heading: 'Summary',
      origin: 'platform',
      rule: 'One sentence that chains root cause, impact, affected party and path. When that sentence cannot be written, the finding is not ready.',
      body: '{Root cause, with the file} will cause {impact} for {affected party} as {actor} will {the path in a few words}.',
    },
    {
      id: 'root-cause',
      heading: 'Root Cause',
      origin: 'platform',
      rule: 'Link the exact lines on the contest commit. Judges group duplicates by root cause, so name the mistake and not its symptom. A design decision that causes no loss is informational.',
      body: `In \`{path/File.sol}\` lines {start}-{end} at the contest commit \`{commit}\` ({permalink}), {the mistake: the missing check, the wrong order, the unsafe cast}.

\`\`\`solidity
{The smallest excerpt that shows it}
\`\`\``,
    },
    {
      id: 'internal',
      heading: 'Internal pre-conditions',
      origin: 'platform',
      rule: 'Numbered. Each one names who sets which variable to which value. Admin functions are assumed to be used correctly and internal roles are trusted unless the README says otherwise, so a pre-condition that needs an admin to act against users ends the report.',
      body: `1. {Role} needs to call \`{function}\` to set \`{variable}\` to be {at least, at most or exactly} \`{value}\`
2. {Contract state that has to hold, with the number}

{Write "None" when the path works from any state.}`,
    },
    {
      id: 'external',
      heading: 'External pre-conditions',
      origin: 'platform',
      rule: 'Changes outside the protocol: an oracle price, gas, another protocol’s state. High needs a loss without extensive external conditions, so every line here moves the finding toward Medium.',
      body: `1. {External condition with numbers, for example a 12% price move inside one block}

{Write "None" when the path needs nothing outside the protocol.}`,
    },
    {
      id: 'attack-path',
      heading: 'Attack Path',
      origin: 'platform',
      rule: 'Numbered calls, one actor per step, concrete values. A report is only grouped with a valid issue when it shows a valid path. On a chain with a private mempool, a path that depends on front-running drops one level, and Medium becomes invalid.',
      body: `1. {Actor} calls \`{function}\` with {arguments}. {State after the call.}
2. {Actor} calls \`{function}\` with {arguments}. {State after the call.}
3. {Final state, with the number.}`,
    },
    {
      id: 'impact',
      heading: 'Impact',
      origin: 'platform',
      rule: 'Name the affected party and the loss as a number. High: more than 1% and more than $10 of principal, yield or fees, without extensive external conditions. Medium: more than 0.01% and more than $10, or broken core functionality. Likelihood is not weighed. For a denial of service, state the lock duration: the bar is more than a week, or a time-sensitive function.',
      body: `{Affected party} lose {amount}, which is {percentage} of their {principal, yield or fees}. The attacker gains {amount, or nothing when this is griefing}.

Severity claimed: {High or Medium}, because {the threshold the number clears}.`,
    },
    {
      id: 'poc',
      heading: 'PoC',
      origin: 'platform',
      rule: 'Sherlock recommends a coded PoC for complex paths, non-trivial input constraints, precision loss, reentrancy, and gas or revert attacks. A report that cannot be understood without a PoC is invalid without one. Paste the test, the command and the output.',
      body: `Command: \`{forge test --match-test test_name -vvv}\` on the contest commit.

\`\`\`solidity
{The test}
\`\`\`

\`\`\`text
{Pasted output, with the final assertion and the measured loss}
\`\`\``,
    },
    {
      id: 'mitigation',
      heading: 'Mitigation',
      origin: 'platform',
      rule: 'The fix. Judges separate issues whose fixes differ, so a precise fix also marks where your root cause ends.',
      body: `{The change, in the file and function it belongs to.}

\`\`\`diff
- {vulnerable line}
+ {fixed line}
\`\`\``,
    },
    {
      id: 'limits',
      heading: 'Limits and non-claims',
      origin: 'added',
      rule: 'State the constraints yourself. The criteria ask Watsons to specify every condition needed to trigger the issue, and additional constraints lower the severity.',
      body: LIMITS_BODY,
    },
    {
      id: 'known',
      heading: 'Known issues checked',
      origin: 'added',
      rule: 'Invalid on Sherlock: issues labelled `wont fix` in an earlier contest, and acknowledged findings in the audits the README links. Name the nearest one and state the difference in root cause.',
      body: `- Contest README, known issues and acceptable risks: {the nearest item, why this differs}
- Earlier contests, \`wont fix\` issues: {issue link, or "none on this code"}
- Audits linked in the README, acknowledged findings: {report and finding id, why the root cause differs}`,
    },
  ],
  closed: [
    {
      title: 'Loss below the written thresholds',
      body: 'Only High and Medium score in a contest. High is a direct loss above 1% and $10 without extensive external conditions. Medium is a loss above 0.01% and $10 that needs conditions, or broken core functionality. Likelihood is not considered.',
      sources: ['criteria', 'points'],
    },
    {
      title: 'Denial of service that does not last',
      body: 'A DoS counts when funds are locked for more than a week or a time-sensitive function is affected. One of the two is Medium, both is High. A repeatable attack is judged on a single occurrence.',
      sources: ['criteria'],
    },
    {
      title: 'Trusted roles and design decisions',
      body: 'Admin functions are assumed to be used correctly. Internal roles are trusted unless the README names them untrusted. A design decision that causes no loss is informational. The README outranks code comments, and past judging decisions carry no weight:',
      quote: { text: 'Historical decisions are not considered sources of truth.', source: 'criteria' },
      sources: ['criteria'],
    },
    {
      title: 'Known issues',
      body: 'Issues labelled `wont fix` in a previous contest and acknowledged findings in the audits linked from the README are invalid. On bounties, publicly known bugs and bugs from a previous audit are never eligible for a payout.',
      sources: ['criteria', 'bounty-rules'],
    },
    {
      title: 'The listed invalid categories',
      body: 'Gas optimisations, wrong event values, zero-address checks, user and admin input validation, blacklisting, initializer front-running, non-standard tokens the README does not name, stale-price recommendations, re-orgs, sequencer downtime, future integrations, and wrong values in view functions that nothing else consumes.',
      sources: ['criteria'],
    },
    {
      title: 'No PoC where one is needed',
      body: 'A PoC is recommended for complex paths, non-trivial input constraints, precision loss, reentrancy and gas or revert attacks. A report that cannot be understood without one is invalid without one.',
      sources: ['criteria'],
    },
    {
      title: 'Duplicates',
      body: 'A report is grouped with a valid issue only when it identifies the root cause, shows at least Medium impact and gives a valid path. Duplicates share the points: each of n submissions is weighted by 0.9 to the power n − 1, divided by n. On bounties the earlier timestamp wins and the duplicate is not rewarded.',
      sources: ['criteria', 'points', 'bounty-criteria'],
    },
    {
      title: 'Penalties and fees',
      body: 'Contest payouts are withheld until the account has two valid issues and at least 20% of everything it has submitted is valid. An escalation costs Signal Score that is not refunded, and the window is 24 hours. On bounties, escalating a decision to the claims committee costs $1,000.',
      sources: ['payout', 'discussion', 'judging', 'dispute'],
    },
  ],
  sources: [
    {
      id: 'criteria',
      label: 'Criteria for Issue Validity',
      href: 'https://docs.sherlock.xyz/audit-contests-deprecated-replaced-by-audit-engine/judging/guidelines',
      note: 'Severity thresholds, invalid categories, PoC recommendation, duplication rules.',
      dated: 'Earlier contest rules · Version 1.12, 24 Jun 2025',
      checked: '9 Oct 2026',
    },
    {
      id: 'template',
      label: 'Report template in the Sherlock docs repository',
      href: 'https://github.com/sherlock-protocol/sherlock-v2-docs/blob/main/.report/README.md',
      note: 'The headings from Title to Mitigation.',
    },
    { id: 'judging', label: 'Judging', href: 'https://docs.sherlock.xyz/audit-contests-deprecated-replaced-by-audit-engine/judging', note: 'The four judging phases and the 24-hour escalation period.', dated: 'Earlier contest rules', checked: '9 Oct 2026' },
    { id: 'discussion', label: 'Discussion', href: 'https://docs.sherlock.xyz/audit-contests-deprecated-replaced-by-audit-engine/judging/discussion', note: 'Escalations and their Signal cost.', dated: 'Earlier contest rules', checked: '9 Oct 2026' },
    {
      id: 'points',
      label: 'How to Score Issue Points in a Contest',
      href: 'https://docs.sherlock.xyz/audit-contests-deprecated-replaced-by-audit-engine/watsons/how-to-score-issue-points-in-a-contest',
      note: 'High and Medium weighting, and how duplicates share points.',
      dated: 'Earlier contest rules',
      checked: '9 Oct 2026',
    },
    {
      id: 'payout',
      label: 'Meeting the Payout Criteria',
      href: 'https://docs.sherlock.xyz/audit-contests-deprecated-replaced-by-audit-engine/watsons/meeting-the-payout-criteria',
      note: 'Two valid issues and the 20% issues ratio.',
      dated: 'Earlier contest rules',
      checked: '9 Oct 2026',
    },
    {
      id: 'audit-engine',
      label: 'Audit Engine: For Participants',
      href: 'https://docs.sherlock.xyz/audit-engine/for-participants',
      note: 'What replaced audit contests: invited engagements, the Issues Ratio, and judging guidelines set per engagement.',
      checked: '9 Oct 2026',
    },
    {
      id: 'bounty-criteria',
      label: 'Criteria for Bug Bounty reports validity',
      href: 'https://docs.sherlock.xyz/bug-bounties/criteria-for-bug-bounty-reports-validity',
      note: 'Bounty standards, invalid categories and duplicates.',
      dated: 'Updated 18 Mar 2026',
    },
    {
      id: 'bounty-rules',
      label: 'Bug bounty Platform Rules',
      href: 'https://docs.sherlock.xyz/bug-bounties/post-launch-bounty/platform-rules',
      note: 'Local forks only, and the known-bug rule.',
    },
    {
      id: 'dispute',
      label: 'Dispute Resolution',
      href: 'https://docs.sherlock.xyz/bug-bounties/post-launch-bounty/dispute-resolution',
      note: 'The three levels and what each escalation costs.',
    },
  ],
};

// ---------------------------------------------------------------------------
// Cantina
// ---------------------------------------------------------------------------

const cantina = {
  id: 'cantina',
  name: 'Cantina',
  path: '/templates/cantina',
  title: 'Cantina finding report template | Bounty Operator',
  h1: 'Cantina finding report template',
  description:
    'Cantina finding template in Markdown: impact and likelihood stated separately, a PoC that compiles on the audit branch, and the rules that invalidate findings.',
  lede: 'Built around the five things Cantina’s documentation says a good finding explains, with impact and likelihood argued separately because that is how severity is set. The PoC section follows the mandatory PoC rule line by line.',
  card: 'Competitions and bounties. Severity is impact × likelihood, and High and Medium need a coded PoC.',
  cardClosed: ['High or Medium without a PoC that compiles', 'Findings acknowledged in a previous report', 'Admin error, user error and design choices'],
  file: 'cantina.md',
  download: 'cantina-finding-template.md',
  formNote:
    'Cantina’s form has its own fields for severity, likelihood, impact and title, and offers a structured template for the description. In competitions the documentation tells you to pick the Detailed one. Paste these sections under its headings.',
  focus: 'Cantina finding draft. Check impact and likelihood against the severity matrix, the mandatory PoC rule and the capped categories.',
  sections: [
    {
      id: 'title',
      heading: 'Title',
      origin: 'platform',
      rule: 'The form asks for a title that conveys the essence of the vulnerability. Mechanism and consequence, one sentence.',
      body: '{Mechanism} in `{function}` lets {actor} {consequence}',
    },
    {
      id: 'summary',
      heading: 'Summary',
      origin: 'platform',
      rule: 'What the issue is, in two or three sentences. The first thing Cantina’s documentation asks of a good finding is that it states the issue before any code.',
      body: '{What is wrong and what it leads to. Name the function and the affected party.}',
    },
    {
      id: 'description',
      heading: 'Finding Description',
      origin: 'platform',
      rule: 'Why it happens, and where. Highlight the exact lines on the audit branch with the code-highlighting feature, then explain which logic they connect to.',
      body: `- Location: \`{path/File.sol}\` lines {start}-{end} on \`{audit branch}\` at commit \`{commit}\`
- Root cause: {the mistake, and why the surrounding checks do not stop it}

\`\`\`solidity
{The smallest excerpt that shows the root cause}
\`\`\`

Path:

1. {Actor} calls \`{function}\` with {arguments}. {State after the call.}
2. {Actor} calls \`{function}\` with {arguments}. {State after the call.}
3. {Final state, with the number.}`,
    },
    {
      id: 'impact',
      heading: 'Impact Explanation',
      origin: 'platform',
      rule: 'Severity on Cantina is impact × likelihood. State the impact level and the fact that puts it there. Loss of user funds or broken core functionality is High. A temporary disruption or minor fund exposure is Medium. Dust lost to rounding is capped at Low.',
      body: `Impact: {High, Medium or Low}. {Affected party} lose {amount}, or {the core function that stops working and for how long}.

Measured by the PoC: {the number from the output below}.`,
    },
    {
      id: 'likelihood',
      heading: 'Likelihood Explanation',
      origin: 'platform',
      rule: 'Who triggers it and what it takes. Any user at any time is High. Capital, planning or other users’ actions is Medium. Rare conditions or admin action is Low, and a finding that needs admin access is capped at Low.',
      body: `Likelihood: {High, Medium or Low}. {Who triggers it, what they need, and how each precondition is reached from the current state.}

Severity claimed: {High, Medium or Low}, from the matrix on {the competition or programme page you used}.`,
    },
    {
      id: 'poc',
      heading: 'Proof of Concept',
      origin: 'platform',
      rule: 'In a competition, High and Medium need a coded PoC before the competition ends unless your reputation score is 80 or above. It has to compile and demonstrate the impact. Name the test file, confirm it runs on the audit branch, list anything else it needs, paste the output, and set the output against what was expected.',
      body: `- Test file: \`{test/path/File.t.sol}\`, added to the project's own suite
- Branch and commit: \`{audit branch}\` at \`{commit}\`
- Extra setup: {none, or what the reviewer installs or sets}
- Command: \`{forge test --match-test test_name -vvv}\`

\`\`\`solidity
{The test}
\`\`\`

Output:

\`\`\`text
{Pasted output}
\`\`\`

Expected against actual: {what a correct implementation prints, and what this prints}`,
    },
    {
      id: 'recommendation',
      heading: 'Recommendation',
      origin: 'platform',
      rule: 'Cantina’s criteria recommend a mitigation with every finding. A fix that goes against the protocol’s design philosophy marks the finding as informational at most, so propose one the team would merge.',
      body: `{The change, in the file and function it belongs to.}

\`\`\`diff
- {vulnerable line}
+ {fixed line}
\`\`\``,
    },
    {
      id: 'limits',
      heading: 'Limits and non-claims',
      origin: 'added',
      rule: 'A PoC that relies on unrealistic assumptions gets the finding downgraded or invalidated. List the assumptions yourself and show that each one holds.',
      body: LIMITS_BODY,
    },
    {
      id: 'known',
      heading: 'Known issues checked',
      origin: 'added',
      rule: 'A finding acknowledged in a previous report is invalid, and so is one the team already knows about. The competition README is the reference for how the protocol is meant to behave.',
      body: `- Competition README or programme page, known issues: {the nearest item, why this differs}
- Previous reports on this code: {report and finding id, why the root cause differs}
- Intended behaviour per the README: {the sentence that shows this is not by design}`,
    },
  ],
  closed: [
    {
      title: 'High or Medium without a coded PoC',
      body: 'By default every competition has a mandatory PoC rule: High and Medium submissions carry a coded PoC before the competition ends. Researchers with a reputation score of 80 or above are exempt, and so are missing-function findings. The bar for the PoC is one sentence:',
      quote: { text: 'the PoC must compile and demonstrate the impact of the issue', source: 'severity-comp' },
      sources: ['severity-comp', 'guidelines'],
    },
    {
      title: 'A PoC that does not prove the claim',
      body: 'A PoC that cannot be executed, does not demonstrate the stated impact, or relies on unrealistic assumptions gets the finding downgraded or invalidated. So does a description that does not connect root cause to impact.',
      sources: ['guidelines'],
    },
    {
      title: 'Known issues',
      body: 'A finding acknowledged in a previous report is invalid. Known issues the team already has are invalid in competitions and out of scope on bounties.',
      sources: ['severity-comp', 'guidelines', 'severity-bounty'],
    },
    {
      title: 'Capped categories',
      body: 'Low at most: dust lost to rounding, non-standard ERC20 behaviour, findings that need admin access. Informational at most: admin error, malicious admin unless the scope includes it, user error that harms nobody else, design choices. Invalid: speculation about future code, and approval race conditions.',
      sources: ['guidelines', 'severity-comp'],
    },
    {
      title: 'Two matrices, one cell apart',
      body: 'The severity criteria page rates high likelihood with medium impact as High. The submission guidelines rate the same cell Medium. Say which page your severity comes from.',
      sources: ['severity-comp', 'guidelines'],
    },
    {
      title: 'Duplicates',
      body: 'A duplicate is the same root cause with the same realistic path to the same impact. Bounties do not pay duplicates. Competitions split the points: a High is worth 10, and when three researchers find it each receives 2.7.',
      sources: ['statuses', 'competitions', 'judging'],
    },
    {
      title: 'Unvalidated AI output and off-platform contact',
      body: 'Submitting AI-generated findings without validating them leads to disqualification or a permanent ban. Contacting the client about a finding outside Cantina gets it rejected with no reward and the account banned.',
      sources: ['severity-comp', 'competitions'],
    },
    {
      title: 'Fees and penalties',
      body: 'An invalid escalation costs $100, deducted from future competition earnings. Bounties that show a deposit requirement refund it for valid findings and for honest invalid ones, and slash it for spam, low-effort or AI submissions and for over-inflated severity.',
      sources: ['judging', 'deposits'],
    },
  ],
  sources: [
    {
      id: 'guidelines',
      label: 'Submission Guidelines',
      href: 'https://docs.cantina.security/researchers/participation/submission-guidelines',
      note: 'Form fields, PoC validity criteria, duplication rules, capped severities.',
    },
    {
      id: 'severity-comp',
      label: 'Competition Finding Severity Criteria',
      href: 'https://docs.cantina.security/standards/severity/competition',
      note: 'Severity matrix, mandatory PoC rule, acknowledged findings.',
    },
    {
      id: 'severity-bounty',
      label: 'Bug Bounty Severity Classification',
      href: 'https://docs.cantina.security/standards/severity/bug-bounty',
      note: 'Bounty severity levels and the out-of-scope list.',
    },
    {
      id: 'examples',
      label: 'Finding Submission Examples',
      href: 'https://docs.cantina.security/researchers/participation/examples',
      note: 'The five things a good finding explains.',
    },
    {
      id: 'competitions',
      label: 'Competition Participation',
      href: 'https://docs.cantina.security/researchers/participation/competitions',
      note: 'Statuses, scoring, escalation, off-platform contact.',
    },
    { id: 'judging', label: 'Judging Processes', href: 'https://docs.cantina.security/standards/judging', note: 'Points, duplicate scaling, the escalation penalty.' },
    {
      id: 'statuses',
      label: 'Bug Bounty Finding Statuses',
      href: 'https://docs.cantina.security/researchers/participation/bug-bounty-statuses',
      note: 'What Duplicate, Rejected and Spam mean on a bounty.',
    },
    {
      id: 'deposits',
      label: 'Deposits for Bounty Submissions',
      href: 'https://docs.cantina.security/researchers/participation/deposits',
      note: 'When a deposit is refunded and when it is slashed.',
    },
  ],
};

// ---------------------------------------------------------------------------
// HackerOne
// ---------------------------------------------------------------------------

const hackerone = {
  id: 'hackerone',
  name: 'HackerOne',
  path: '/templates/hackerone',
  title: 'HackerOne bug report template | Bounty Operator',
  h1: 'HackerOne bug report template',
  description:
    'HackerOne report template in Markdown: numbered reproduction steps, expected against actual, impact, a CVSS vector, and the report states that cost reputation.',
  lede: 'The parts HackerOne’s quality guide asks for, in its order, with the asset, weakness and severity the form wants up front. The preview is the last edit you get, so the draft has to be right before it is pasted.',
  card: 'Web, API, mobile and open-source programmes. Outcomes are report states, and each state moves reputation.',
  cardClosed: ['Impact not demonstrated: Not Applicable', 'Core ineligible findings', 'Duplicates and issues on the policy page'],
  file: 'hackerone.md',
  download: 'hackerone-report-template.md',
  formNote:
    'HackerOne’s form takes the asset, the weakness and the severity as separate fields before the write-up. The title line goes in the title field. Videos are attached as files.',
  focus: 'HackerOne report draft. Check reproduction steps, demonstrated impact, the CVSS vector and the core ineligible list.',
  sections: [
    {
      id: 'title',
      heading: 'Title',
      origin: 'platform',
      rule: 'Vulnerability type, where it is, what it allows. HackerOne’s own example sets a stored XSS in a named field, with its effect, against a bare vulnerability class.',
      body: '{Vulnerability type} in {feature or endpoint} allows {what the attacker does}',
    },
    {
      id: 'summary',
      heading: 'Summary',
      origin: 'platform',
      rule: 'The form asks for asset, weakness and severity before the write-up. Since 21 September 2026 a severity is required on every programme that has not opted out. Use the calculator the programme lists: CVSS 3.0, 3.1, 4.0 or manual.',
      body: `- Asset: {the in-scope asset, exactly as the programme lists it}
- Weakness: {the weakness you selected on the form}
- Severity: {None, Low, Medium, High or Critical}, vector \`{CVSS vector in the version the programme uses}\`
- Tested on: {URL or build}, {version, release or commit}, {date and time in UTC}

{One paragraph: what the vulnerability is and what an attacker gets from it.}`,
    },
    {
      id: 'steps',
      heading: 'Steps to Reproduce',
      origin: 'platform',
      rule: 'Numbered steps a triager follows without asking a question. Give the URL, the parameter and the role of every account. A report left in Needs More Info for more than 30 days closes as Informative.',
      body: `Accounts: {attacker account and its role}, {victim account and its role}. Both are test accounts you own.

1. {Log in as the attacker account and open the URL.}
2. {Send this request, with the parameter and the value.}
3. {Observe the response or the state change, with the exact value.}`,
    },
    {
      id: 'expected',
      heading: 'Expected vs Actual Behavior',
      origin: 'platform',
      rule: 'One line each. The expected line cites where the rule comes from: documentation, the permission model, the programme’s own policy.',
      body: `- Expected: {what the application should do, and the source of that rule}
- Actual: {what it does}`,
    },
    {
      id: 'impact',
      heading: 'Impact',
      origin: 'platform',
      rule: 'What an attacker does with it, to whom, at what scale. Not Applicable is the state for a report whose security implications were not demonstrated, and it costs 5 reputation. Argue each CVSS metric you set: self sign-up means Privileges Required is None, and an unpredictable ID means Attack Complexity is High until you show how the ID is obtained.',
      body: `{What the attacker reads, changes or takes over, for which users, and how many.}

- Preconditions: {none, or what the attacker needs first}
- User interaction: {none, or what the victim has to do}
- Mitigations already in place that do not stop it: {list}`,
    },
    {
      id: 'material',
      heading: 'Supporting Material',
      origin: 'platform',
      rule: 'The request and the response, or the command and its output, in code blocks. Attach screenshots and recordings as files. A link to a hosted video is not accepted.',
      body: `\`\`\`http
{The request}
\`\`\`

\`\`\`http
{The response, trimmed to the part that proves the point}
\`\`\`

Attached: {file names of screenshots or the recording}`,
    },
    {
      id: 'remediation',
      heading: 'Remediation',
      origin: 'platform',
      rule: 'Optional on HackerOne. Include it when you know where the check belongs.',
      body: '{The check that is missing and where it belongs.}',
    },
    {
      id: 'limits',
      heading: 'Limits and non-claims',
      origin: 'added',
      rule: 'Say where testing stopped. The platform standards require testing to stop the moment sensitive personal data is exposed, and the core ineligible list closes findings that rest on unlikely interaction.',
      body: `- Testing stopped at: {the point you stopped, for example after reading one record of your own second account}
- Not claimed: {what this report does not say, for example no access to other tenants}
- Depends on: {browser, configuration or feature flag the behaviour needs}`,
    },
    {
      id: 'known',
      heading: 'Known issues checked',
      origin: 'added',
      rule: 'A report on something the programme already knows closes as Duplicate, or as Informative when the issue is listed on its security page. Name the nearest known item and state the difference.',
      body: `- Programme policy, exclusions and known issues: {date checked, the nearest item, why this differs}
- Disclosed reports on this programme: {the nearest report, why the root cause or the endpoint differs}
- Core ineligible findings: {the nearest category, and the demonstrated impact that takes this out of it}`,
    },
  ],
  closed: [
    {
      title: 'Impact not demonstrated',
      body: 'Not Applicable is the closed state for a report with no valid reproducible issue or no demonstrated security implication. It costs 5 reputation. Spam costs 10.',
      sources: ['states', 'reputation'],
    },
    {
      title: 'Core ineligible findings',
      body: 'Closed as invalid unless the report shows clear security impact: self-XSS, tabnabbing, content spoofing, clickjacking on pages with no sensitive action, logout CSRF, permissive CORS, version disclosure, CSV injection, open redirects, TLS and cookie-flag findings, SPF, DKIM and DMARC settings, and most rate-limit issues. DoS and social engineering are never to be tested without authorisation.',
      sources: ['ineligible'],
    },
    {
      title: 'Duplicates',
      body: 'Duplicate covers an issue already reported or otherwise known, and several reports that one fix resolves. A duplicate of a resolved report filed before it went public earns 2 reputation. A duplicate of a Not Applicable report, or of a report that was already public, costs 5.',
      sources: ['states', 'reputation'],
    },
    {
      title: 'Known and accepted risks',
      body: 'Informative is used for out-of-scope submissions, for issues listed on the programme’s security page, and for accepted risk. It leaves reputation unchanged.',
      sources: ['states'],
    },
    {
      title: 'One systemic issue filed as many reports',
      body: 'The platform standard rewards the first three reports that establish a systemic issue, then a single discretionary bonus. Later instances that the same fix resolves are treated as duplicates or paid a reduced bonus. Put the variants in one report.',
      sources: ['standards'],
    },
    {
      title: 'A severity the vector does not support',
      body: 'Severity is required at submission on programmes that have not opted out. The standards fix some metrics: Privileges Required is None when anyone can sign up, Attack Complexity is High for an IDOR with unpredictable IDs until the report shows how they are obtained, and deleting data counts against Integrity, not Availability.',
      sources: ['submitting', 'severity', 'standards'],
    },
    {
      title: 'A report that cannot be edited',
      body: 'Review the preview before you submit. The help centre is direct about it:',
      quote: { text: 'You won’t be able to edit your details after submitting the report.', source: 'submitting' },
      sources: ['submitting'],
    },
    {
      title: 'Penalties',
      body: 'No fee is published. The cost is reputation: a profile starts at 100, a low reputation limits how many reports you can file in a period, and programmes set Signal requirements measured over your last 365 days.',
      sources: ['reputation', 'signal'],
    },
  ],
  sources: [
    { id: 'quality', label: 'Quality Reports', href: 'https://docs.hackerone.com/en/articles/8475116-quality-reports', note: 'The parts of a report and the pre-submission checks.', dated: 'Updated 5 Feb 2025' },
    {
      id: 'submitting',
      label: 'Submitting Reports',
      href: 'https://docs.hackerone.com/en/articles/8473994-submitting-reports',
      note: 'The form fields, the severity requirement from 21 Sep 2026, attachments, no edits after submission.',
      dated: 'Updated Sep 2026',
    },
    { id: 'states', label: 'Report States', href: 'https://docs.hackerone.com/en/articles/8475030-report-states', note: 'What each closed state means.', dated: 'Updated 15 Jul 2024' },
    { id: 'reputation', label: 'Reputation', href: 'https://docs.hackerone.com/en/articles/8369865-reputation', note: 'Points gained and lost per report state.', dated: 'Updated 1 Dec 2025' },
    { id: 'signal', label: 'Signal & Impact', href: 'https://docs.hackerone.com/en/articles/8369891-signal-impact', note: 'How Signal is calculated and what it gates.', dated: 'Updated 17 Jul 2024' },
    {
      id: 'ineligible',
      label: 'Core Ineligible Findings',
      href: 'https://docs.hackerone.com/en/articles/8494488-core-ineligible-findings',
      note: 'Findings closed as invalid without demonstrated impact.',
      dated: 'Updated 19 May 2025',
    },
    {
      id: 'standards',
      label: 'Detailed Platform Standards',
      href: 'https://docs.hackerone.com/en/articles/8369826-detailed-platform-standards',
      note: 'Systemic issues, bug chains, CVSS clarifications, sensitive data.',
      dated: 'Updated 21 Jan 2026',
    },
    { id: 'severity', label: 'Severity', href: 'https://docs.hackerone.com/en/articles/8475343-severity', note: 'Severity ratings and the CVSS versions offered.', dated: 'Updated Sep 2026' },
    {
      id: 'post',
      label: 'Post-Submission Guide',
      href: 'https://docs.hackerone.com/en/articles/15518592-post-submission-guide',
      note: 'What happens after submission and how to request mediation.',
      dated: 'Updated 16 Jun 2026',
    },
  ],
};

export const PLATFORMS = [immunefi, sherlock, cantina, hackerone];

/** The eight parts every template carries, and why each one is there. */
export const PARTS = [
  ['Title rule', 'Mechanism and consequence in one sentence, in the platform’s own title shape.'],
  ['Summary', 'What breaks and who loses, before any code.'],
  ['Exact location', 'File and lines on a pinned commit, or the URL, parameter and build.'],
  ['Impact, mapped', 'The programme’s impact row or severity threshold, quoted, with the measured number beside it.'],
  ['Proof of concept', 'The code, the command and the pasted output.'],
  ['Recommended fix', 'The change, as a diff where it fits.'],
  ['Limits and non-claims', 'What the report does not say, what was mocked, when the path stops working.'],
  ['Known-issue comparison', 'The nearest known issue, named, and the difference in root cause.'],
];

/** Hub comparison: one row per question, one cell per platform, in PLATFORMS order. */
export const COMPARISON = [
  {
    question: 'Proof of concept',
    cells: [
      'Runnable code where the programme requires one. No reward without it.',
      'Recommended for complex issues. Invalid when the issue cannot be understood without one.',
      'Coded PoC for High and Medium in competitions, unless reputation is 80 or above.',
      'Reproduction steps and supporting material. Not Applicable when impact is not demonstrated.',
    ],
  },
  {
    question: 'Severity scale',
    cells: [
      'The programme’s Impacts in Scope, on a four-level scale.',
      'High and Medium only, against written loss thresholds.',
      'Impact × likelihood matrix, with capped categories.',
      'CVSS 3.0, 3.1 or 4.0, or manual, as the programme lists.',
    ],
  },
  {
    question: 'Known issues',
    cells: [
      'Acknowledged issues and unfixed audit findings are not eligible.',
      '`wont fix` issues and acknowledged audit findings are invalid.',
      'Findings acknowledged in a previous report are invalid.',
      'Closed as Informative or Duplicate.',
    ],
  },
  {
    question: 'Duplicates',
    cells: [
      'Previously discovered bugs are not eligible. Refiling your own is prohibited.',
      'Grouped by root cause. Points are shared. Bounties pay the earliest.',
      'Bounties pay none. Competitions scale the points down.',
      'Closed as Duplicate. Reputation moves between +2 and −5.',
    ],
  },
  {
    question: 'Fee or penalty',
    cells: [
      'Suspension or permanent ban, and zero payout.',
      'Payouts withheld below a 20% valid ratio. Escalation costs Signal.',
      '$100 for an invalid escalation. Deposits slashed for spam.',
      '−5 for Not Applicable, −10 for Spam.',
    ],
  },
];
