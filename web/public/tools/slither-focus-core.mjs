// Slither focus: filter Slither's JSON output to the detectors worth a manual
// pass and format them as a triage queue.
//
// A port of bounty_operator_kit/slither_focus.py. formatText and
// formatMarkdown return, for the same input, the same text as format_text and
// format_markdown there. rankDetectors is the one addition: the browser tool
// orders the queue by impact and confidence before formatting it.

export const DEFAULT_CHECKS = Object.freeze([
  'arbitrary-send-erc20',
  'arbitrary-send-eth',
  'calls-loop',
  'controlled-delegatecall',
  'delegatecall-loop',
  'incorrect-equality',
  'low-level-calls',
  'reentrancy-benign',
  'reentrancy-eth',
  'reentrancy-no-eth',
  'unchecked-transfer',
  'uninitialized-local',
  'unused-return',
]);

/** The largest Slither file the Python loader reads. */
export const MAX_INPUT_BYTES = 20_000_000;

const DEFAULT_LIMIT = 8;
const SHORT_LIMIT = 1800;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasKey = (object, key) => Object.hasOwn(object, key);

/** What Python's str() prints for a JSON value. */
function pyStr(value) {
  if (value === null || value === undefined) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return JSON.stringify(value);
}

/** Python's `a or b`: the first value that is not None, false, 0, '' or an empty container. */
function truthy(value) {
  if (value === null || value === undefined || value === false || value === 0 || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isObject(value)) return Object.keys(value).length > 0;
  return true;
}

function firstTruthy(...values) {
  return values.find(truthy);
}

function asCheckSet(checks) {
  return checks instanceof Set ? checks : new Set(checks);
}

/**
 * Parses Slither JSON text and validates its shape.
 *
 * @param {string} text
 * @returns {object}
 */
export function parseSlither(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Slither input is not valid JSON');
  }
  // Slither leaves the "detectors" key out of "results" when a successful run
  // has no detector result. That file is a clean scan, so it reads as an empty
  // list here. Only a file that says "success": true gets this reading.
  if (isObject(data) && data.success === true && isObject(data.results) && !hasKey(data.results, 'detectors')) {
    data = { ...data, results: { ...data.results, detectors: [] } };
  }
  detectors(data, new Set());
  return data;
}

/**
 * The detector results whose `check` is in `checks`, after validating every
 * result in the file. Throws on a failed run or a malformed file, so an empty
 * list always means "nothing matched" and never "the scan did not run".
 *
 * @param {unknown} data
 * @param {Iterable<string>} checks
 * @returns {object[]}
 */
export function detectors(data, checks) {
  if (!isObject(data) || data.success === false) {
    throw new Error('Slither input is invalid or the scanner failed; no clean result can be inferred');
  }
  const results = data.results;
  if (!isObject(results) || !Array.isArray(results.detectors)) {
    throw new Error('Slither input must contain results.detectors as a list');
  }
  for (const detector of results.detectors) {
    if (!isObject(detector) || typeof detector.check !== 'string') {
      throw new Error('Slither input contains an invalid detector');
    }
    if (hasKey(detector, 'description') && typeof detector.description !== 'string') {
      throw new Error('Slither detector description must be text');
    }
    const elements = hasKey(detector, 'elements') ? detector.elements : [];
    if (!Array.isArray(elements) || elements.some((element) => !isObject(element))) {
      throw new Error('Slither detector elements must be objects');
    }
    for (const element of elements) {
      const mapping = firstTruthy(element.source_mapping) ?? {};
      const lines = isObject(mapping) && hasKey(mapping, 'lines') ? mapping.lines : [];
      if (!isObject(mapping) || !Array.isArray(lines)) {
        throw new Error('Slither source mapping is malformed');
      }
    }
  }
  const wanted = asCheckSet(checks);
  return results.detectors.filter((detector) => wanted.has(detector.check));
}

function sourceLine(element) {
  const source = firstTruthy(element.source_mapping) ?? {};
  const filename = firstTruthy(source.filename_relative, source.filename_absolute) ?? '?';
  const lines = firstTruthy(source.lines) ?? [];
  if (lines.length) return `${pyStr(filename)}:${lines.slice(0, 4).map(pyStr).join(',')}`;
  return pyStr(filename);
}

function short(text, limit = SHORT_LIMIT) {
  const flat = pyStr(truthy(text) ? text : '').split(/\s+/).filter(Boolean).join(' ');
  // Python counts code points, so a surrogate pair is one character here too.
  const points = Array.from(flat);
  if (points.length <= limit) return flat;
  return `${points.slice(0, limit - 3).join('').trimEnd()}...`;
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' };

/** One table-safe Markdown cell: HTML-escaped, with backticks and pipes as entities. */
function markdownCell(value) {
  return short(pyStr(value))
    .replace(/[&<>"']/g, (character) => HTML_ESCAPES[character])
    .replaceAll('`', '&#96;')
    .replaceAll('|', '&#124;');
}

function assertLimit(limit) {
  if (!Number.isInteger(limit) || limit <= 0) throw new Error('element limit must be greater than zero');
}

function elementsOf(detector, limit) {
  return (hasKey(detector, 'elements') ? detector.elements : []).slice(0, limit);
}

function elementName(element) {
  return firstTruthy(element.name, element.type) ?? '?';
}

/**
 * Plain-text queue, one block per matching detector.
 *
 * @param {unknown} data
 * @param {Iterable<string>} checks
 * @param {number} [limit] elements listed per detector
 * @returns {string}
 */
export function formatText(data, checks, limit = DEFAULT_LIMIT) {
  assertLimit(limit);
  const chunks = [];
  for (const detector of detectors(data, checks)) {
    chunks.push([
      `=== ${pyStr(detector.check)} | impact=${pyStr(detector.impact)} | confidence=${pyStr(detector.confidence)} ===`,
      short(hasKey(detector, 'description') ? detector.description : ''),
    ].join('\n'));
    for (const element of elementsOf(detector, limit)) {
      chunks.push(`  - ${sourceLine(element)} ${pyStr(elementName(element))}`);
    }
  }
  if (!chunks.length) return 'No matching Slither detectors found.\n';
  return `${chunks.join('\n')}\n`;
}

/**
 * Markdown queue: a heading, impact, confidence, description and a location
 * table per matching detector.
 *
 * @param {unknown} data
 * @param {Iterable<string>} checks
 * @param {number} [limit] elements listed per detector
 * @returns {string}
 */
export function formatMarkdown(data, checks, limit = DEFAULT_LIMIT) {
  assertLimit(limit);
  const chunks = ['# Slither Focus\n'];
  const matching = detectors(data, checks);
  if (!matching.length) {
    chunks.push('No matching Slither detectors found.\n');
    return chunks.join('\n');
  }
  for (const detector of matching) {
    chunks.push(`## \`${markdownCell(detector.check)}\``);
    chunks.push('');
    chunks.push(`- Impact: \`${markdownCell(detector.impact)}\``);
    chunks.push(`- Confidence: \`${markdownCell(detector.confidence)}\``);
    chunks.push('');
    chunks.push(markdownCell(hasKey(detector, 'description') ? detector.description : ''));
    chunks.push('');
    chunks.push('| Location | Element |');
    chunks.push('|---|---|');
    for (const element of elementsOf(detector, limit)) {
      chunks.push(`| \`${markdownCell(sourceLine(element))}\` | \`${markdownCell(elementName(element))}\` |`);
    }
    chunks.push('');
  }
  return chunks.join('\n');
}

// ---------------------------------------------------------------------------
// Ranking (browser tool only)
// ---------------------------------------------------------------------------

const IMPACT_ORDER = ['high', 'medium', 'low', 'informational', 'optimization'];
const CONFIDENCE_ORDER = ['high', 'medium', 'low'];

function rank(order, value) {
  const index = order.indexOf(String(value ?? '').toLowerCase());
  return index === -1 ? order.length : index;
}

/**
 * A copy of `data` with its detector results ordered by impact, then by
 * confidence, highest first. Results that tie keep the order Slither gave them.
 *
 * @param {unknown} data
 * @returns {object}
 */
export function rankDetectors(data) {
  detectors(data, new Set());
  const ordered = data.results.detectors
    .map((detector, index) => ({ detector, index }))
    .sort((a, b) =>
      rank(IMPACT_ORDER, a.detector.impact) - rank(IMPACT_ORDER, b.detector.impact)
      || rank(CONFIDENCE_ORDER, a.detector.confidence) - rank(CONFIDENCE_ORDER, b.detector.confidence)
      || a.index - b.index)
    .map((entry) => entry.detector);
  return { ...data, results: { ...data.results, detectors: ordered } };
}

/**
 * The ranked queue and the figures the page shows next to it.
 *
 * @param {unknown} data
 * @param {{ checks?: Iterable<string>, limit?: number }} [options]
 * @returns {{ markdown: string, total: number, kept: number, rows: { check: string, impact: string, confidence: string, locations: number, first: string }[] }}
 */
export function triageQueue(data, { checks = DEFAULT_CHECKS, limit = DEFAULT_LIMIT } = {}) {
  assertLimit(limit);
  const ranked = rankDetectors(data);
  const matching = detectors(ranked, checks);
  return {
    markdown: formatMarkdown(ranked, checks, limit),
    total: ranked.results.detectors.length,
    kept: matching.length,
    rows: matching.map((detector) => {
      const elements = hasKey(detector, 'elements') ? detector.elements : [];
      return {
        check: detector.check,
        impact: pyStr(detector.impact),
        confidence: pyStr(detector.confidence),
        locations: elements.length,
        first: elements.length ? sourceLine(elements[0]) : '',
      };
    }),
  };
}

/** What the workbench receives when the queue is handed over for scanner triage. */
export function workbenchHandoff(markdown) {
  return {
    files: [{ name: 'slither-focus.md', content: markdown }],
    profile: 'scanner',
    focus: 'Triage this Slither queue. Group the leads by root cause, name the ones worth a manual pass and say what would confirm each.',
    context: {},
  };
}
