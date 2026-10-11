// CVSS 3.1 base-score arithmetic, independently implemented from FIRST's
// specification, sections 7.1, 7.4 and Appendix A:
// https://www.first.org/cvss/v3.1/specification-document
// This checks supplied numbers, never whether a metric describes a real bug.

const VALUES = Object.freeze({
  AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 },
  AC: { L: 0.77, H: 0.44 },
  PR: { N: 0.85, L: 0.62, H: 0.27 },
  UI: { N: 0.85, R: 0.62 },
  S: { U: 0, C: 1 },
  C: { N: 0, L: 0.22, H: 0.56 },
  I: { N: 0, L: 0.22, H: 0.56 },
  A: { N: 0, L: 0.22, H: 0.56 },
});
const EXTENDED = new Set(['E', 'RL', 'RC', 'CR', 'IR', 'AR', 'MAV', 'MAC', 'MPR', 'MUI', 'MS', 'MC', 'MI', 'MA']);

function roundup(value) {
  const scaled = Math.round(value * 100000);
  return scaled % 10000 === 0 ? scaled / 100000 : (Math.floor(scaled / 10000) + 1) / 10;
}

/** A base score, an invalid base vector, or an explicitly unsupported vector. */
export function cvss31BaseScore(vector) {
  if (typeof vector !== 'string' || !vector.startsWith('CVSS:3.1/')) {
    return { kind: 'unsupported', reason: 'Only CVSS:3.1 base vectors are checked.' };
  }
  if (vector.length > 300) return { kind: 'invalid', reason: 'CVSS 3.1 vector is too long.' };
  const metrics = Object.create(null);
  const parts = vector.slice(9).split('/');
  // A displayed score may be Temporal or Environmental. Do not compare it
  // with a Base calculation, even when all the Base metrics are present.
  if (parts.some((part) => EXTENDED.has(part.split(':', 1)[0]))) {
    return { kind: 'unsupported', reason: 'Temporal and Environmental CVSS scores are not checked.' };
  }
  for (const part of parts) {
    const [name, value, extra] = part.split(':');
    if (extra !== undefined || !Object.hasOwn(VALUES, name) || !Object.hasOwn(VALUES[name], value)) {
      return { kind: 'invalid', reason: 'CVSS 3.1 base vector has an unknown metric or value.' };
    }
    if (Object.hasOwn(metrics, name)) return { kind: 'invalid', reason: `CVSS 3.1 vector repeats ${name}.` };
    metrics[name] = value;
  }
  const missing = Object.keys(VALUES).filter((name) => !Object.hasOwn(metrics, name));
  if (missing.length) return { kind: 'invalid', reason: `CVSS 3.1 vector is missing ${missing.join(', ')}.` };

  const value = (name) => VALUES[name][metrics[name]];
  const changed = metrics.S === 'C';
  const iss = 1 - (1 - value('C')) * (1 - value('I')) * (1 - value('A'));
  const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15 : 6.42 * iss;
  const privileges = changed && metrics.PR !== 'N' ? (metrics.PR === 'L' ? 0.68 : 0.5) : value('PR');
  const exploitability = 8.22 * value('AV') * value('AC') * privileges * value('UI');
  const score = impact <= 0 ? 0 : roundup(Math.min((impact + exploitability) * (changed ? 1.08 : 1), 10));
  return { kind: 'base', score };
}

const VECTOR = /\bCVSS:\d+\.\d+\/[^\s`<>()[\]{},;|"'!?]+/g;
const NUMBER = '-?\\d+(?:\\.\\d+)?';
const BEFORE_SCORE = new RegExp(`\\bCVSS(?:\\s+v?3\\.1)?(?:\\s+(?:base(?:\\s+score)?|score))?\\s*[:=]\\s*(${NUMBER})(?:\\s*\\/\\s*10)?(?:\\s*\\(?(?:critical|high|medium|low|none)\\)?)?\\s*[([:-]*\\s*$`, 'i');
const AFTER_SCORE = new RegExp(`^[\\s\\]})]*(?:\\(\\s*)?(?:(?:=|:)\\s*|(?:base\\s+)?score\\s*[:=]?\\s*)(${NUMBER})(?:\\s*\\/\\s*10)?(?=$|[\\s)\\],;])`, 'i');

/**
 * Inspect explicit vectors in report prose. A number is associated only when
 * labelled CVSS before the vector, or marked =, : or score immediately after.
 * No inference from severity words, other numbers, or a different line.
 */
export function inspectCvss(lines) {
  const issues = [];
  const notes = [];
  let checked = 0;
  for (const line of lines) {
    if (line.code || !line.text.includes('CVSS:')) continue;
    const vectors = [...line.text.matchAll(VECTOR)];
    if (!vectors.length) continue;
    const quote = (note) => ({ line: line.n, quote: null, note });
    if (line.raw.length > line.text.length || vectors.length !== 1) {
      notes.push(quote('CVSS not checked: use one complete vector per line.'));
      continue;
    }
    const match = vectors[0];
    const vector = match[0].replace(/\.+$/, '');
    const parsed = cvss31BaseScore(vector);
    if (parsed.kind === 'unsupported') {
      notes.push(quote(parsed.reason));
      continue;
    }
    if (parsed.kind === 'invalid') {
      issues.push(quote(parsed.reason));
      continue;
    }
    const before = line.text.slice(0, match.index).replace(/[*_`]/g, '');
    const after = line.text.slice(match.index + match[0].length).replace(/[*_`]/g, '');
    // A labelled non-Base score elsewhere on the same line makes pairing
    // ambiguous. Preserve it for a human instead of guessing which number fits.
    if (/\b(?:temporal|environmental)\b/i.test(before + after)) {
      notes.push(quote('CVSS score not compared: the line names a Temporal or Environmental score.'));
      continue;
    }
    const prior = before.match(BEFORE_SCORE);
    const following = after.match(AFTER_SCORE);
    if ((prior && following) || (!prior && !following)) {
      notes.push(quote(`CVSS base vector calculates to ${parsed.score.toFixed(1)}; no single labelled score on the same line was compared.`));
      continue;
    }
    const rawScore = (prior ?? following)[1];
    const stated = Number(rawScore);
    if (!Number.isFinite(stated) || stated < 0 || stated > 10 || !/^\d+(?:\.\d)?$/.test(rawScore)) {
      issues.push(quote('CVSS score must be between 0.0 and 10.0, with at most one decimal place.'));
    } else if (stated !== parsed.score) {
      issues.push(quote(`Stated CVSS score ${stated.toFixed(1)} differs from the vector's Base score ${parsed.score.toFixed(1)}. Check the score and the chosen metrics.`));
    } else {
      checked += 1;
      notes.push(quote(`CVSS 3.1 Base score ${parsed.score.toFixed(1)} matches its vector. Metric choices are not verified.`));
    }
  }
  return { issues, notes, checked };
}
