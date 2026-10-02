// Report check: fourteen text checks on a draft bug bounty report.
//
// Pure functions. No DOM, no network, no model. Every finding states what the
// text contains ("No commit hash found"); none of them says whether the bug is
// real. The privacy check reuses the scanner the workbench runs before a
// review, so both report the same lines.

import { splitLines } from '../review-core.mjs';
import { scanFile } from './secret-check-core.mjs';

/**
 * @typedef {'pass' | 'missing' | 'flagged'} Status
 * @typedef {{ line: number, quote: string | null, note?: string }} Evidence
 * @typedef {{ id: string, label: string, source: string, test: string, fix: string }} CheckDefinition
 * @typedef {CheckDefinition & { status: Status, finding: string, evidence: Evidence[], more: number }} CheckResult
 * @typedef {{ empty: boolean, checks: CheckResult[], passed: number, missing: number, flagged: number, total: number, lines: number }} ReportCheck
 */

export const DRAFT_NAME = 'draft-report.md';

const MAX_EVIDENCE = 6;
const MAX_QUOTE = 220;
// The text checks read at most this much of one line, so no pattern ever runs
// over a longer string. A report line a triager reads is far shorter. The
// privacy scan and the local-path check still cover the whole line.
const MAX_LINE = 4000;

// The seven phrases that concede the point a triager closes on.
const PHRASES = Object.freeze([
  {
    phrase: 'closest impact',
    pattern: /\b(?:closest|nearest)(?: matching| available| applicable)? impact\b/i,
    note: 'Says the selected impact row does not fit.',
  },
  {
    phrase: 'if compromised',
    pattern: /\bif\b[^.\n]{0,60}\bcompromised\b|\b(?:is|are|were|gets?|becomes?) compromised\b/i,
    note: 'Makes a trusted party the attacker.',
  },
  {
    phrase: 'assuming',
    pattern: /\bassuming\b|\bassum(?:e|es|ed) that\b/i,
    note: 'States a precondition with no route to it from live state.',
  },
  {
    phrase: 'could potentially',
    pattern: /\b(?:could|may|might|can) potentially\b/i,
    note: 'Describes an outcome the proof did not produce.',
  },
  {
    phrase: 'currently zero',
    pattern: /\bcurrently (?:zero|0\b|nil|none|empty)|\bis zero today\b/i,
    note: 'Says nothing is at risk today.',
  },
  {
    phrase: 'can be avoided by',
    pattern: /\bcan be avoided by\b|\bcan avoid (?:this|it|the loss) by\b/i,
    note: 'Names an action that removes the loss.',
  },
  {
    phrase: 'does not establish',
    pattern: /\b(?:does|do|did) not establish\b|\bnot (?:yet )?established\b/i,
    note: 'Concedes the claim is unproven.',
  },
]);

export const SELF_NEGATING_PHRASES = Object.freeze(PHRASES.map((entry) => entry.phrase));

/** The phrases with what each one concedes, for the page that explains them. */
export const PHRASE_NOTES = Object.freeze(PHRASES.map((entry) => Object.freeze({ phrase: entry.phrase, note: entry.note })));

/** @type {readonly CheckDefinition[]} */
export const CHECKS = Object.freeze([
  {
    id: 'title',
    label: 'Title states mechanism and consequence',
    source: 'Report form',
    test: 'The first heading or Title line names what the code does wrong and what is lost, locked, read, bypassed or blocked.',
    fix: 'Write the title as one sentence: what the code does wrong, then what the attacker gains or the user loses.',
  },
  {
    id: 'scope',
    label: 'Scoped asset named',
    source: 'Asset and version binding',
    test: 'A scope, asset or target line carries an address, a repository link or a file.',
    fix: 'Name the asset exactly as the programme lists it: the contract address or the repository path.',
  },
  {
    id: 'revision',
    label: 'Pinned revision',
    source: 'Asset and version binding',
    test: 'A commit hash, or a code link that contains one. A link to a branch is flagged.',
    fix: 'State the commit the finding was reproduced on and link every code reference at that commit.',
  },
  {
    id: 'impact',
    label: 'Impact row quoted verbatim',
    source: 'Literal impact and exclusion fit',
    test: 'An impact line with the programme’s row in quotation marks or in a quote block.',
    fix: 'Copy the impact row from the programme page word for word and put it in quotation marks.',
  },
  {
    id: 'severity',
    label: 'Severity stated once and consistent',
    source: 'Severity against the written scale',
    test: 'One severity level. A range, or two different levels, is flagged.',
    fix: 'State one severity, at the row the body argues, and remove every other level.',
  },
  {
    id: 'roles',
    label: 'Trusted roles in the attack path',
    source: 'Actor trace',
    test: 'Numbered attack steps that name owner, admin, keeper, operator or governance.',
    fix: 'Label who performs each step; a decisive step by a trusted role ends the report.',
  },
  {
    id: 'proof',
    label: 'Proof inline with command and output',
    source: 'Executed end-state proof',
    test: 'A run command and the output it printed, in the report body. A link alone is flagged.',
    fix: 'Paste the exact command and the output it printed into the report body.',
  },
  {
    id: 'assertion',
    label: 'Final assertion on a balance, owner or stored record',
    source: 'Executed end-state proof',
    test: 'An assertion in the proof that reads a balance, an owner or a stored value.',
    fix: 'End the proof with an assertion that reads the object the impact row names.',
  },
  {
    id: 'mocks',
    label: 'Mocks and pranks of privileged roles',
    source: 'Production reachability',
    test: 'A prank of a role-named address, a mock, or a forced state write in the proof.',
    fix: 'Reach each state through public calls from live state, or name the mocked step and its route.',
  },
  {
    id: 'prior-art',
    label: 'Known-issue and prior-audit comparison',
    source: 'Prior-art sweep',
    test: 'A line that names a known issue, an audit note or an earlier report.',
    fix: 'Name the nearest known issue or audit note and say in one sentence how the root cause differs.',
  },
  {
    id: 'limits',
    label: 'Limits and non-claims stated',
    source: 'Report form',
    test: 'A limits section, or a sentence that says what the report does not claim.',
    fix: 'Add two or three lines that say what the proof does not show and what you are not claiming.',
  },
  {
    id: 'phrases',
    label: 'Self-negating phrases',
    source: 'Triager read',
    test: `Sentences that contain: ${SELF_NEGATING_PHRASES.join(', ')}.`,
    fix: 'Prove the condition each sentence concedes, or cut the claim that depends on it.',
  },
  {
    id: 'secrets',
    label: 'Secrets and private report links',
    source: 'Report hygiene',
    test: 'Keys, tokens, seed phrases, private platform links, email addresses and public IP addresses.',
    fix: 'Remove each listed line and rotate any key that was pasted anywhere.',
  },
  {
    id: 'paths',
    label: 'Local paths',
    source: 'Report hygiene',
    test: 'Home-directory paths such as /home/name/ or C:\\Users\\name\\.',
    fix: 'Replace each local path with a repository-relative path.',
  },
]);

// ---------------------------------------------------------------------------
// Reading the draft
// ---------------------------------------------------------------------------

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Lines of the draft, each tagged with whether it sits inside a fenced code block. */
function readLines(text) {
  const lines = [];
  let fence = null;
  splitLines(text).forEach((raw, index) => {
    const marker = raw.match(FENCE);
    let code = fence !== null;
    let isFence = false;
    if (marker && fence === null) {
      fence = marker[1][0];
      code = true;
      isFence = true;
    } else if (marker && marker[1][0] === fence) {
      fence = null;
      isFence = true;
    }
    lines.push({ n: index + 1, text: raw.length > MAX_LINE ? raw.slice(0, MAX_LINE) : raw, raw, code, fence: isFence });
  });
  return lines;
}

/** `text` without the given characters at its end, in one pass. */
function stripEnd(text, characters) {
  let end = text.length;
  while (end > 0 && characters.includes(text[end - 1])) end -= 1;
  return text.slice(0, end);
}

function clip(text, limit = MAX_QUOTE) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1).trimEnd()}…`;
}

/** The sentence of `text` that contains the character at `index`. */
function sentenceAt(text, index) {
  let start = 0;
  let end = text.length;
  for (const boundary of text.matchAll(/[.!?](?=\s|$)/g)) {
    if (boundary.index < index) start = boundary.index + 1;
    else {
      end = boundary.index + 1;
      break;
    }
  }
  return text.slice(start, end);
}

function quoteOf(line, note) {
  const evidence = { line: line.n, quote: clip(line.text) };
  if (note) evidence.note = note;
  return evidence;
}

function result(status, finding, evidence = []) {
  return { status, finding, evidence: evidence.slice(0, MAX_EVIDENCE), more: Math.max(0, evidence.length - MAX_EVIDENCE) };
}

const plural = (count, word, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;

// ---------------------------------------------------------------------------
// Title
// ---------------------------------------------------------------------------

// Each pattern below runs in one pass over the line. A trailing run of spaces,
// hashes or emphasis marks is removed in code, never by a second quantifier.
const HEADING_OPEN = /^ {0,3}(#{1,6})\s+(\S.*)$/;
const TITLE_LABEL = /^[\s>*_#-]*title[*_]*\s*[:：]\s*[*_]*(\S.*)$/i;

/** An ATX heading as `{ level, text }`, without its closing hashes; null for any other line. */
function headingOf(raw) {
  const open = raw.trimEnd().match(HEADING_OPEN);
  if (!open) return null;
  let text = open[2];
  const bare = stripEnd(text, '#');
  // A closing run of hashes counts only when a space comes before it.
  if (bare.length < text.length && (bare === '' || /\s$/.test(bare.slice(-1)))) text = bare.trimEnd();
  return text ? { level: open[1].length, text } : null;
}

const isHeading = (raw) => headingOf(raw) !== null;
// A heading that names a section of the report, not the report.
const SECTION_NAME = /^(?:summary|description|overview|introduction|intro|brief|details?|(?:bug|finding|vulnerability) (?:description|details?)|root cause|attack path|steps to reproduce|(?:internal |external )?pre-?conditions?|risk breakdown|impact|severity|proof of concept|poc|recommendations?|mitigation|references?|scope|target|asset|background|context)\b[\s:]*$/i;
// "Severity: High", "Target: …": a labelled field, not a title.
const FIELD_LINE = /^[\s>*_#-]*(?:severity|risk|target|asset|scope|impact|program(?:me)?|platform|date|author|reporter|researcher|status|type|category)[*_]*\s*[:：]/i;
// "[High]", "[H-01]" or "High:" in front of the sentence.
const SEVERITY_TAG = /^(?:\[[^\]\n]{1,16}\]\s*[:\-–—]?\s*|(?:critical|high|medium|low|[HMLC]-\d+)\s*[:\-–—]\s*)/i;

const CONSEQUENCE = /\b(?:steal\w*|stolen|theft|drain\w*|siphon\w*|loss(?:es)?|los(?:e|es|ing)|lock(?:s|ed|ing)?|freez\w*|frozen|stuck|brick\w*|insolven\w*|bad debt|denial[- ]of[- ]service|dos|halt\w*|revert(?:s|ing)? (?:forever|permanently|for (?:all|every))|block(?:s|ed|ing)? (?:all|every|withdraw\w*|deposit\w*|liquidat\w*|redemption\w*)|inflat\w*|dilut\w*|mint\w*|bypass\w*|take\s?over|hijack\w*|unauthori[sz]ed|escalat\w*|grief\w*|liquidat\w*|underpa\w*|overpa\w*|manipulat\w*|leak\w*|disclos\w*|double[- ]spen\w*|unbacked|undercollaterali[sz]\w*|censor\w*|for free|without paying|more than (?:their|its|his|her) share|read(?:s|ing)?|access(?:es|ing)?(?! control)|exfiltrat\w*|expos\w*|overwrit\w*|delet\w*|execut\w*|impersonat\w*|forg(?:e|es|ed|ing|ery)|spoof\w*)\b/i;
const LINK_WORD = /\b(?:allow(?:s|ing)?|let(?:s|ting)?|enabl(?:e|es|ing)|leads? to|leading to|caus(?:e|es|ing)|results? in|resulting in|so that|permit(?:s|ting)?|mak(?:es|ing)|can|to (?:steal|drain|mint|bypass|lock|freeze|withdraw|claim|block|brick|inflate|avoid|take|liquidate|grief))\b|→|->|=>/i;
const MECHANISM = /`[^`]+`|\b\w+\(\)|\b[a-z]+[A-Z]\w*\b|\b(?:missing|unchecked|unvalidated|incorrect|wrong|stale|reentran\w*|overflow\w*|underflow\w*|rounding|precision|truncat\w*|race|front-?run\w*|replay\w*|signature\w*|oracle|access control|validation|check|update[sd]?|order(?:ing)?|accounting|initiali[sz]\w*|uninitiali[sz]\w*|delegatecall|approval|allowance|slippage|decimals?|cast|off-by-one|not (?:updated|checked|reset|cleared|validated|verified))\b/i;

function findTitle(lines) {
  const head = lines.slice(0, 40);
  for (const line of head) {
    if (line.code) continue;
    const labelled = line.text.trimEnd().match(TITLE_LABEL);
    if (labelled) {
      const text = stripEnd(labelled[1], '*_').trim();
      if (text) return { line, text };
    }
  }
  for (const line of head) {
    if (line.code || !line.text.trim()) continue;
    const heading = headingOf(line.text);
    const text = stripEnd((heading ? heading.text : line.text.trim()).replace(/^[*_]+/, ''), '*_').trim();
    if (SECTION_NAME.test(text) || FIELD_LINE.test(line.text)) continue;
    if (heading && heading.level <= 2) return { line, text };
    // Without a top-level heading, only a short opening line stands as the title.
    return text.length <= 160 && !/[.!?]\s+\S/.test(text) ? { line, text } : null;
  }
  return null;
}

function checkTitle(lines) {
  const title = findTitle(lines);
  if (!title) return result('missing', 'No title line found.');
  const evidence = [quoteOf(title.line)];
  const text = title.text.replace(SEVERITY_TAG, '');
  const words = text.split(/\s+/).filter(Boolean).length;

  if (words < 5) return result('flagged', `Title is ${plural(words, 'word')}.`, evidence);
  if (!CONSEQUENCE.test(text)) return result('flagged', 'Title names no consequence: nothing lost, locked, read, bypassed or blocked.', evidence);
  if (!LINK_WORD.test(text) && !MECHANISM.test(text)) return result('flagged', 'Title names no mechanism.', evidence);
  return result('pass', 'Title names a mechanism and a consequence.', evidence);
}

// ---------------------------------------------------------------------------
// Scope and revision
// ---------------------------------------------------------------------------

const SCOPE_LABEL = /\b(?:in[- ]scope|scope|asset|target|affected (?:contract|asset|component|file)s?|contract address|deployed at)\b/i;
const ASSET_TOKEN = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])|https?:\/\/\S+|\b[\w./-]+\.(?:sol|vy|rs|go|ts|js|py|move|cairo|fc|tact|java|kt|c|cpp|rb|php)\b/;

function checkScope(lines) {
  let labelLine = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.code || !SCOPE_LABEL.test(line.text) || /\bout[- ]of[- ]scope\b/i.test(line.text)) continue;
    labelLine ??= line;
    // The asset sits on the label line or on one of the next three lines.
    const named = lines.slice(index, index + 4).find((entry) => !entry.fence && ASSET_TOKEN.test(entry.text));
    if (named) return result('pass', 'A scope line names an address, a repository or a file.', [quoteOf(named)]);
  }
  if (labelLine) {
    return result('missing', 'A scope line was found. It names no address, repository or file.', [quoteOf(labelLine)]);
  }
  return result('missing', 'No line names the asset in scope.');
}

const PERMALINK = /github\.com\/[\w.-]+\/[\w.-]+\/(?:blob|tree|commit|pull\/\d+\/commits)\/[0-9a-f]{7,40}(?![0-9A-Za-z])/i;
const BRANCH_LINK = /github\.com\/[\w.-]+\/[\w.-]+\/(?:blob|tree)\/(?:main|master|dev|develop|development|staging|HEAD)\//;
const HEX_TOKEN = /(?<![0-9A-Za-z])[0-9a-f]{7,40}(?![0-9A-Za-z])/g;
const REVISION_WORD = /\b(?:commit|revision|rev|sha|checkout|pinned|tag)\b/i;

function hasCommitHash(text) {
  if (PERMALINK.test(text)) return true;
  for (const match of text.matchAll(HEX_TOKEN)) {
    const token = match[0];
    if (!/[a-f]/.test(token) || !/\d/.test(token)) continue;
    // A full hash stands alone. A short one needs a word that says what it is.
    if (token.length === 40 || REVISION_WORD.test(text.slice(Math.max(0, match.index - 60), match.index))) return true;
  }
  return false;
}

function checkRevision(lines) {
  const branchLinks = lines.filter((line) => BRANCH_LINK.test(line.text));
  if (branchLinks.length) {
    return result(
      'flagged',
      `${plural(branchLinks.length, 'code link points', 'code links point')} at a branch, which moves.`,
      branchLinks.map((line) => quoteOf(line)),
    );
  }
  const pinned = lines.find((line) => hasCommitHash(line.text));
  if (pinned) return result('pass', 'Commit hash found.', [quoteOf(pinned)]);
  return result('missing', 'No commit hash found.');
}

// ---------------------------------------------------------------------------
// Impact row and severity
// ---------------------------------------------------------------------------

const IMPACT_WORD = /\bimpact\b/i;
const IMPACT_LABEL = /^[\s#>*_-]*(?:(?:selected|chosen|claimed|programme|program)\s+)?impact(?:\s+(?:row|category|in scope|selected|claimed))?[*_]*\s*(?:[:：]\s*)?$/i;
const QUOTED_TEXT = /["“]([^"”\n]{12,400})["”]/;
const QUOTE_BLOCK = /^\s*>\s*\S/;
// Opening words of the impact rows most programmes copy from the public classification.
const STANDARD_ROW = /\b(?:direct theft of any user (?:funds|nfts)|permanent freezing of (?:funds|nfts|unclaimed)|temporary freezing of (?:funds|nfts)|protocol insolvency|theft of unclaimed (?:yield|royalties)|theft of gas|unbounded gas consumption|block stuffing|smart contract unable to operate due to lack of token funds|contract fails to deliver promised returns|unauthori[sz]ed minting of nfts)\b/i;

function hasQuotedRow(text) {
  const match = text.match(QUOTED_TEXT);
  return Boolean(match) && match[1].trim().split(/\s+/).length >= 3;
}

function checkImpact(lines) {
  let impactLine = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.code) continue;
    if (STANDARD_ROW.test(line.text)) return result('pass', 'Impact row wording found.', [quoteOf(line)]);
    if (!IMPACT_WORD.test(line.text)) continue;
    impactLine ??= line;
    if (hasQuotedRow(line.text)) return result('pass', 'Quoted impact row found.', [quoteOf(line)]);
    if (!IMPACT_LABEL.test(line.text)) continue;
    // Under an Impact heading, the row is the first thing quoted.
    const below = lines.slice(index + 1, index + 6).filter((entry) => !entry.code && entry.text.trim());
    const quoted = below.find((entry) => hasQuotedRow(entry.text) || QUOTE_BLOCK.test(entry.text));
    if (quoted) return result('pass', 'Quoted impact row found.', [quoteOf(quoted)]);
  }
  if (impactLine) return result('missing', 'Impact section found. No impact row in quotation marks.', [quoteOf(impactLine)]);
  return result('missing', 'No impact section found.');
}

const LEVEL = '(critical|high|medium|low|informational|info)';
const RANGE = `(?:\\s*(?:/|or|to|-|–|—)\\s*${LEVEL}\\b)?`;
const SEVERITY_INLINE = new RegExp(`\\b(?:severity|risk rating|risk level)\\b[^A-Za-z\\n]{0,12}(?:(?:is|rating|level|of|rated|as)\\W{1,4}){0,2}${LEVEL}\\b${RANGE}`, 'i');
const SEVERITY_PREFIX = new RegExp(`\\b${LEVEL}[- ]severity\\b`, 'i');
const SEVERITY_HEADING = /^[\s#>*_-]*(?:severity|risk rating|risk level)[*_]*\s*(?:[:：]\s*)?$/i;
const LEADING_LEVEL = new RegExp(`^[\\s>*_\`-]*${LEVEL}\\b${RANGE}`, 'i');
const TITLE_TAG = new RegExp(`^[\\s#>*_]*(?:title[*_]*\\s*[:：]\\s*)?\\[${LEVEL}\\]`, 'i');

const normalLevel = (level) => (level.toLowerCase() === 'info' ? 'informational' : level.toLowerCase());

function checkSeverity(lines) {
  const statements = [];
  const add = (line, first, second) => {
    statements.push({ line, levels: [first, second].filter(Boolean).map(normalLevel) });
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.code) continue;
    const inline = line.text.match(SEVERITY_INLINE);
    if (inline) {
      add(line, inline[1], inline[2]);
      continue;
    }
    const tag = line.text.match(TITLE_TAG) ?? line.text.match(SEVERITY_PREFIX);
    if (tag) {
      add(line, tag[1]);
      continue;
    }
    if (SEVERITY_HEADING.test(line.text)) {
      const next = lines.slice(index + 1, index + 4).find((entry) => entry.text.trim());
      const level = next && !next.code ? next.text.match(LEADING_LEVEL) : null;
      if (level) add(next, level[1], level[2]);
    }
  }

  if (!statements.length) return result('missing', 'No severity statement found.');

  const ranges = statements.filter((statement) => new Set(statement.levels).size > 1);
  if (ranges.length) {
    return result('flagged', 'Severity is given as two levels on one line.', ranges.map((statement) => quoteOf(statement.line)));
  }
  const levels = [...new Set(statements.flatMap((statement) => statement.levels))];
  if (levels.length > 1) {
    return result(
      'flagged',
      `Severity is stated as ${levels.join(' and ')}.`,
      statements.map((statement) => quoteOf(statement.line, statement.levels[0])),
    );
  }
  return result('pass', `Severity stated: ${levels[0]}.`, [quoteOf(statements[0].line)]);
}

// ---------------------------------------------------------------------------
// Attack path
// ---------------------------------------------------------------------------

const PATH_HEADING = /\b(?:attack (?:path|scenario|steps|flow|vector)|exploit(?:ation)? (?:path|steps|scenario|flow)|steps to reproduce|reproduction steps|attack)\b/i;
const OTHER_LIST_HEADING = /\b(?:recommend\w*|mitigation\w*|remediation|fix(?:es)?|references?|limit\w*|non-claims?|timeline|tools? used)\b/i;
const NUMBERED_STEP = /^\s*(?:\d{1,2}[.)]|step\s+\d{1,2}\b[:.)]?)\s+\S/i;
const TRUSTED_ROLE = /\b(owner|admin|administrator|keeper|operator|governance|governor|multisig|guardian|timelock)s?\b/i;

function attackSteps(lines) {
  const prose = lines.filter((line) => !line.code);
  const start = prose.findIndex((line) => isHeading(line.text) && PATH_HEADING.test(line.text));
  if (start !== -1) {
    const steps = [];
    for (const line of prose.slice(start + 1)) {
      if (isHeading(line.text)) break;
      if (NUMBERED_STEP.test(line.text)) steps.push(line);
    }
    if (steps.length) return steps;
  }
  // No attack heading: every numbered line counts, except under a section that lists fixes or sources.
  const steps = [];
  let skipping = false;
  for (const line of prose) {
    if (isHeading(line.text)) skipping = OTHER_LIST_HEADING.test(line.text);
    else if (!skipping && NUMBERED_STEP.test(line.text)) steps.push(line);
  }
  return steps;
}

function checkRoles(lines) {
  const steps = attackSteps(lines);
  if (!steps.length) return result('missing', 'No numbered attack path found.');
  const named = steps
    .map((line) => ({ line, role: line.text.match(TRUSTED_ROLE) }))
    .filter((entry) => entry.role);
  if (named.length) {
    return result(
      'flagged',
      `${plural(named.length, 'attack step names', 'attack steps name')} a trusted role.`,
      named.map((entry) => quoteOf(entry.line, `names “${entry.role[1].toLowerCase()}”`)),
    );
  }
  return result('pass', `${plural(steps.length, 'numbered step')}. None names owner, admin, keeper, operator or governance.`);
}

// ---------------------------------------------------------------------------
// Proof
// ---------------------------------------------------------------------------

// Runner commands that are unmistakable wherever they start a line.
const RUNNER = /^\s*(?:\$\s+)?(?:forge\s+(?:test|script)|cast\s+(?:call|send|run|storage)|npx\s+hardhat|hardhat\s+test|yarn\s+(?:test|hardhat)|npm\s+test|pnpm\s+test|bun\s+test|pytest\b|cargo\s+test|go\s+test|brownie\s+(?:test|run)|ape\s+(?:test|run)|truffle\s+test|echidna\b|medusa\s+fuzz|halmos\b|sui\s+move\s+test|aptos\s+move\s+test|anchor\s+test|scarb\s+test|snforge\s+test|dotnet\s+test|mvn\s+test|gradle\s+test)\b/;
// Commands that double as ordinary words, counted only inside code or after a "$" prompt.
const SHELL = /^\s*(?:\$\s+)?(?:anvil\b|npm\s+run\s|pnpm\s+(?:run|exec)\s|python3?\s+\S|cargo\s+run\b|make\s+\w|node\s+\S|curl\s+\S|docker\s+(?:run|compose)\b|git\s+(?:clone|checkout)\s|\.\/[\w./-]+)/;
const PROMPT = /^\s*\$\s+\S/;
const OUTPUT = /\[(?:PASS|FAIL)[^\]\n]{0,80}\]|\bRan \d+ tests?\b|\bSuite result:|\btest result:|\b\d+ (?:passing|passed|failing|failed)\b|[✓✔]|^\s*ok\s+\S|--- (?:PASS|FAIL)|^\s*(?:PASSED|FAILED)\b|^\s*(?:Logs|Traces):|\(gas: \d+\)|\bTests?:\s+\d+ passed|\bTest Suites:|^\s*(?:< )?HTTP\/\d(?:\.\d)? \d{3}\b/;
const PROOF_LINK = /https?:\/\/(?:gist\.github\.com|github\.com|pastebin\.com|hackmd\.io|drive\.google\.com|gitlab\.com)\/\S+/i;
const PROOF_WORD = /\b(?:poc|proof|test|reproduc\w*|exploit|script)\b/i;

function commandOn(line) {
  if (line.fence) return false;
  if (RUNNER.test(line.text) || PROMPT.test(line.text)) return true;
  if (line.code) return SHELL.test(line.text);
  for (const span of line.text.matchAll(/`([^`\n]{3,200})`/g)) {
    if (RUNNER.test(span[1]) || SHELL.test(span[1])) return true;
  }
  return false;
}

/** In a code block, whatever a "$" prompt line printed: the lines under it, up to the next prompt. */
function printedAfterPrompt(lines) {
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].code || lines[index].fence || !PROMPT.test(lines[index].text)) continue;
    for (const next of lines.slice(index + 1)) {
      if (!next.code || next.fence || PROMPT.test(next.text)) break;
      if (next.text.trim()) return next;
    }
  }
  return null;
}

function checkProof(lines) {
  const command = lines.find(commandOn);
  const output = lines.find((line) => line.code && !line.fence && OUTPUT.test(line.text))
    ?? lines.find((line) => !line.fence && OUTPUT.test(line.text))
    ?? printedAfterPrompt(lines);
  if (command && output) {
    return result('pass', 'Command and captured output found.', [quoteOf(command, 'command'), quoteOf(output, 'output')]);
  }
  if (command) return result('missing', 'Command found. No captured output found.', [quoteOf(command, 'command')]);
  if (output) return result('missing', 'Captured output found. No command found.', [quoteOf(output, 'output')]);

  const link = lines.find((line) => !line.code && PROOF_LINK.test(line.text) && PROOF_WORD.test(line.text));
  if (link) return result('flagged', 'The proof is a link. No command or output is in the report body.', [quoteOf(link)]);
  if (lines.some((line) => line.code && !line.fence)) {
    return result('missing', 'Code block found. No command and no captured output.');
  }
  return result('missing', 'No proof found: no code block, command or output.');
}

const ASSERTION = /\bassert(?:Eq|Gt|Ge|Lt|Le|NotEq|ApproxEqAbs|ApproxEqRel|True|False|Equal|Equals)?\s*\(|\bassert(?:_eq|_ne)?!\s*\(|\bexpect\s*\(|\bassert\s+\S|\bassert\.\w+\s*\(|\.should\./;
const STATE_READ = /balance|owner|supply|totalAssets|assets|shares|allowance|debt|collateral|reserve|deposit|staked?\b|rewards?\b|earned|claimable|hasRole|\brole|admin|implementation|\bslot|vm\.load|storage|nonce|\bget[A-Z]\w*\(|\w+Of\(/i;

function checkAssertion(lines) {
  const assertions = lines.filter((line) => line.code && !line.fence && ASSERTION.test(line.text));
  if (!assertions.length) return result('missing', 'No assertion found in the proof.');
  const reading = assertions.filter((line) => STATE_READ.test(line.text));
  if (reading.length) {
    return result('pass', 'An assertion reads a balance, an owner or a stored value.', [quoteOf(reading[reading.length - 1])]);
  }
  return result(
    'flagged',
    `${plural(assertions.length, 'assertion')} found. None reads a balance, an owner or a stored value.`,
    [quoteOf(assertions[assertions.length - 1])],
  );
}

const PRANK = /\b(?:startPrank|prank|hoax|startHoax|impersonateAccount)\s*\(\s*([^)\n]{0,120})\)?/;
const PRIVILEGED = /owner|admin|governance|governor|\bgov\b|keeper|operator|multisig|guardian|timelock|deployer|manager|treasury|\bdao\b|authority|minter|pauser|upgrader|role/i;
const FORCED_STATE = /\bvm\.(?:store|mockCall|mockCallRevert|mockCalls|mockFunction|etch)\s*\(|\b(?:hardhat|anvil)_(?:setStorageAt|setCode|impersonateAccount)\b|\bsetStorageAt\s*\(|\bnew\s+\w*Mock\w*\s*\(|\bMock[A-Z]\w*\b|\bjest\.mock\s*\(|\bsinon\.stub\s*\(|\bunittest\.mock\b|\bmonkeypatch\b|@patch\b/;
const MOCK_PROSE = /\bmock(?:s|ed|ing)?\b/i;

function checkMocks(lines) {
  const hits = [];
  for (const line of lines) {
    if (line.fence) continue;
    const prank = line.text.match(PRANK);
    if (prank && PRIVILEGED.test(prank[1] ?? '')) {
      hits.push(quoteOf(line, `acts as ${clip(prank[1], 40)}`));
    } else if (FORCED_STATE.test(line.text)) {
      hits.push(quoteOf(line, 'forces state or replaces code'));
    } else if (!line.code && MOCK_PROSE.test(line.text)) {
      hits.push(quoteOf(line, 'mentions a mock'));
    }
  }
  if (hits.length) {
    return result('flagged', `${plural(hits.length, 'line uses', 'lines use')} a prank of a role-named address, a mock or a forced state write.`, hits);
  }
  return result('pass', 'No prank of a role-named address, mock or forced state write found.');
}

// ---------------------------------------------------------------------------
// Prior art, limits, phrases
// ---------------------------------------------------------------------------

const PRIOR_ART = /\bknown issues?\b|\bprior (?:audit|art|report|finding)s?\b|\bprevious(?:ly)? (?:audit\w*|report\w*|findings?|reviews?)\b|\baudit (?:report|finding|note)s?\b|\baudited by\b|\balready (?:reported|known|fixed)\b|\bduplicates?\b|\backnowledged\b|\bwon['’]?t[- ]fix\b|\bfix[- ]review\b|\bdiffers? from\b|\bdistinct from\b|\bnot (?:covered|listed|mentioned|reported) (?:by|in)\b|\bsimilar (?:issue|finding|report)s?\b/i;

function checkPriorArt(lines) {
  const line = lines.find((entry) => !entry.code && PRIOR_ART.test(entry.text));
  if (line) return result('pass', 'A known-issue or prior-audit comparison is present.', [quoteOf(line)]);
  return result('missing', 'No known-issue or prior-audit comparison found.');
}

const LIMITS_HEADING = /^[\s#>*_-]*(?:limitations?|limits|non-claims?|not claimed|caveats|what (?:this|the) (?:report|poc|proof|test) does not (?:show|claim|cover)|limits and non-claims|scope of (?:the )?claim)\b/i;
const LIMITS_PHRASE = /\b(?:do(?:es)? not claim|not claim(?:ed|ing)\b|is not claimed|no claim (?:is|about)|(?:was|were|is|are) not (?:tested|verified|demonstrated|measured|reproduced)|not (?:tested|verified|reproduced) (?:on|against|for|with)|limited to|only affects?|does not affect|(?:is|are) not affected|bounded by|capped at|upper bound)\b/i;

function checkLimits(lines) {
  const line = lines.find((entry) => !entry.code && (LIMITS_HEADING.test(entry.text) || LIMITS_PHRASE.test(entry.text)));
  if (line) return result('pass', 'Limits or non-claims are stated.', [quoteOf(line)]);
  return result('missing', 'No limits or non-claims found.');
}

function checkPhrases(lines) {
  const hits = [];
  for (const line of lines) {
    if (line.code) continue;
    for (const entry of PHRASES) {
      const match = line.text.match(entry.pattern);
      if (!match) continue;
      hits.push({ line: line.n, quote: clip(sentenceAt(line.text, match.index)), note: `“${entry.phrase}”: ${entry.note}` });
    }
  }
  if (hits.length) return result('flagged', `${plural(hits.length, 'sentence contains', 'sentences contain')} a listed phrase.`, hits);
  return result('pass', 'None of the listed phrases found.');
}

// ---------------------------------------------------------------------------
// Hygiene
// ---------------------------------------------------------------------------

function checkSecrets(text) {
  // scanFile reads the draft in pieces, so a draft longer than one review
  // file is still scanned to its last line.
  const scan = scanFile({ name: DRAFT_NAME, content: text });
  if (scan.status === 'skipped') {
    return result('missing', 'The privacy scan did not run: the draft is not plain text.');
  }
  if (!scan.hits.length) {
    return result('pass', 'No key, token, seed phrase, private report link, email address or public IP address found.');
  }
  // The scanner never returns the matched text, and neither does this check.
  const evidence = scan.hits.map((hit) => ({ line: hit.line, quote: null, note: hit.label }));
  const parts = [];
  if (scan.blocking) parts.push(plural(scan.blocking, 'line holds a secret or a private link', 'lines hold a secret or a private link'));
  if (scan.warnings) parts.push(plural(scan.warnings, 'line holds an email or IP address', 'lines hold an email or IP address'));
  return result('flagged', `${parts.join('; ')}.`, evidence);
}

const LOCAL_PATH = /(?:^|[\s"'`(=:<[])(?:\/(?:home|Users)\/[^\s/"'`]+\/|\/root\/|\/mnt\/[a-z]\/Users\/[^\s/"'`]+\/|[A-Za-z]:\\(?:Users|Documents and Settings)\\[^\s\\"'`]+\\|file:\/\/\/)/;

function checkPaths(lines) {
  const hits = lines.filter((line) => !line.fence && LOCAL_PATH.test(line.raw));
  if (hits.length) return result('flagged', `${plural(hits.length, 'line contains', 'lines contain')} a local path.`, hits.map((line) => quoteOf(line)));
  return result('pass', 'No local path found.');
}

const RUNNERS = {
  title: checkTitle,
  scope: checkScope,
  revision: checkRevision,
  impact: checkImpact,
  severity: checkSeverity,
  roles: checkRoles,
  proof: checkProof,
  assertion: checkAssertion,
  mocks: checkMocks,
  'prior-art': checkPriorArt,
  limits: checkLimits,
  phrases: checkPhrases,
  secrets: (lines, text) => checkSecrets(text),
  paths: checkPaths,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Runs the fourteen checks on a draft report.
 *
 * @param {string} text
 * @returns {ReportCheck}
 */
export function checkReport(text) {
  const draft = typeof text === 'string' ? text : '';
  const empty = draft.trim() === '';
  const lines = readLines(draft);
  const checks = CHECKS.map((definition) => {
    const outcome = empty ? result('missing', 'No draft supplied.') : RUNNERS[definition.id](lines, draft);
    return { ...definition, ...outcome };
  });
  const count = (status) => checks.filter((check) => check.status === status).length;
  return {
    empty,
    checks,
    passed: count('pass'),
    missing: count('missing'),
    flagged: count('flagged'),
    total: checks.length,
    lines: lines.length,
  };
}

/** "9 of 14 checks pass" */
export function scoreLine(report) {
  return `${report.passed} of ${report.total} checks pass`;
}

function evidenceText(evidence) {
  const where = `L${evidence.line}`;
  if (evidence.quote === null) return `${where}: ${evidence.note}`;
  // The quote is the user's own text; backticks are swapped so it stays one code span.
  const quote = `\`${evidence.quote.replaceAll('`', "'")}\``;
  return evidence.note ? `${where}: ${quote} (${evidence.note})` : `${where}: ${quote}`;
}

/**
 * The result as a Markdown task list: a ticked box per passing check, and the
 * finding, the quoted lines and the fix under every other one.
 *
 * @param {ReportCheck} report
 * @returns {string}
 */
export function checklistMarkdown(report) {
  const out = [`# Report check: ${scoreLine(report)}`, ''];
  for (const check of report.checks) {
    if (check.status === 'pass') {
      out.push(`- [x] ${check.label}`);
      continue;
    }
    out.push(`- [ ] ${check.label} (${check.status}): ${check.finding}`);
    for (const evidence of check.evidence) out.push(`  - ${evidenceText(evidence)}`);
    if (check.more) out.push(`  - and ${check.more} more`);
    out.push(`  - Fix: ${check.fix}`);
  }
  out.push('', 'Checked in the browser at https://bountyoperator.com/tools/report-check');
  return `${out.join('\n')}\n`;
}

/**
 * What the workbench receives when the draft is handed over: the draft as one
 * file, the report profile, and a focus line that lists the open checks.
 *
 * @param {string} text
 * @param {ReportCheck} [report]
 */
export function workbenchHandoff(text, report = checkReport(text)) {
  const open = report.checks.filter((check) => check.status !== 'pass').map((check) => `${check.label} (${check.status})`);
  const focus = open.length
    ? `Challenge this draft report. A text check left these items open: ${open.join('; ')}. Test each one against the draft and name the sentence a triager would close on.`
    : 'Challenge this draft report. Name the sentence a triager would close on.';
  return { files: [{ name: DRAFT_NAME, content: text }], profile: 'report', focus, context: {} };
}
