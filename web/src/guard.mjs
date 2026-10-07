// Keeps a hosted profile's method out of its own output.
//
// The method text is cut into runs of eight words (shingles) and each run is
// hashed once, when the module that holds the text loads. A scanner then reads
// the model's answer word by word. Text is released only once it is known not
// to open a verbatim run, so nothing of a run that crosses the limit has left
// when the answer is stopped.
//
// Two limits, both in words of the method:
//   RUN_WORDS    one unbroken verbatim run this long stops the answer
//   TOTAL_WORDS  this many method words across the whole answer, in runs of any
//                length, stop it too (an answer that breaks the text into pieces)
// A short method gets smaller limits: see limitsFor.
//
// A review repeats headings, field labels and fixed values from its output
// format, and now and then a clause of its method. Measured on stored
// reviews, that is at most 22 words in one run and 40 in a whole answer.

export const SHINGLE_WORDS = 8;
export const RUN_WORDS = 48;
export const TOTAL_WORDS = 200;

/**
 * The limits for a method of `methodWords` words: half of it in one run and
 * three quarters of it in total, capped at RUN_WORDS and TOTAL_WORDS.
 *
 * @param {number} methodWords
 * @returns {{ runWords: number, totalWords: number }}
 */
export function limitsFor(methodWords) {
  return {
    runWords: Math.max(SHINGLE_WORDS + 4, Math.min(RUN_WORDS, Math.floor(methodWords / 2))),
    totalWords: Math.max(SHINGLE_WORDS * 3, Math.min(TOTAL_WORDS, Math.floor(methodWords * 0.75))),
  };
}

// A word starts with a letter or digit and may carry invisible format
// characters (zero-width spaces and joiners, soft hyphens, bidi marks) and
// combining marks inside it, which `canonical` then drops. So a copy with an
// invisible character between every letter still reads as the same words.
const WORD = /[\p{L}\p{N}][\p{L}\p{N}\p{Cf}\p{M}]*/gu;
const INVISIBLE = /[\p{Cf}\p{M}]/gu;

// Letters from other scripts that look like Latin ones, as a copy disguised
// with them would use. Only the common look-alikes; anything else stays as it is.
const LOOK_ALIKES = new Map(Object.entries({
  а: 'a', в: 'b', е: 'e', ё: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x',
  ѕ: 's', і: 'i', ї: 'i', ј: 'j', ԁ: 'd', ԛ: 'q', ԝ: 'w', һ: 'h', ӏ: 'l',
  α: 'a', β: 'b', ε: 'e', η: 'n', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', ω: 'w',
}));

/** One word as the guard compares it: NFKC, no invisible marks, lower case, look-alikes folded. */
function canonical(word) {
  const plain = word.normalize('NFKC').replace(INVISIBLE, '').toLowerCase();
  let out = '';
  for (const char of plain) out += LOOK_ALIKES.get(char) ?? char;
  return out;
}

// A run of at least this many one-letter words is read as one word, so a
// letter-spaced copy ("p r o f i l e", "t o") reads as the word it spells.
// Two lone letters one space apart hardly occur in a review.
const SPELLED_LETTERS = 2;

/** FNV-1a over the eight words, twice with different offsets, joined into one 53-bit number. */
function hashShingle(ring, first) {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let index = 0; index < SHINGLE_WORDS; index += 1) {
    const word = ring[(first + index) % SHINGLE_WORDS];
    for (let at = 0; at < word.length; at += 1) {
      const code = word.charCodeAt(at);
      a = Math.imul(a ^ code, 0x01000193);
      b = Math.imul(b ^ code, 0x85ebca6b);
    }
    // The word boundary is part of the shingle: "ab c" and "a bc" differ.
    a = Math.imul(a ^ 0x20, 0x01000193);
    b = Math.imul(b ^ 0x20, 0x85ebca6b);
  }
  return (a >>> 0) * 0x200000 + ((b >>> 0) >>> 11);
}

/**
 * Joins one-letter words that spell a word. Letters one separator apart
 * ("p r o f i l e") belong to the same word; a wider gap ("p r o  m p t", two
 * spaces) starts the next one. A group of SPELLED_LETTERS or more letters
 * becomes one word at the offset of its first letter; a shorter group stays
 * as it is. Each entry is `{ word, offset, end }`, offsets in the source text.
 *
 * @param {{ word: string, offset: number, end: number }[]} letters
 * @returns {{ word: string, offset: number }[]}
 */
function spelled(letters) {
  const out = [];
  let group = [];
  const flush = () => {
    if (group.length >= SPELLED_LETTERS) out.push({ word: group.map((entry) => entry.word).join(''), offset: group[0].offset });
    else out.push(...group);
    group = [];
  };
  for (const entry of letters) {
    if (group.length && entry.offset - group[group.length - 1].end > 1) flush();
    group.push(entry);
  }
  flush();
  return out;
}

/**
 * The words of a text as the guard compares them: letters and digits in lower
 * case, with invisible marks dropped, look-alike letters folded and spelled-out
 * runs joined (see canonical and spelled). Punctuation, markup and line breaks
 * do not count, so a quoted, bulleted or re-wrapped copy still matches.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function words(text) {
  const out = [];
  let letters = [];
  // A fresh pattern: matchAll would start at the lastIndex a scanner left on WORD.
  for (const match of String(text).matchAll(new RegExp(WORD))) {
    const word = canonical(match[0]);
    if (!word) continue;
    if (word.length === 1 && /\p{L}/u.test(word)) {
      letters.push({ word, offset: match.index, end: match.index + match[0].length });
      continue;
    }
    out.push(...spelled(letters).map((entry) => entry.word), word);
    letters = [];
  }
  out.push(...spelled(letters).map((entry) => entry.word));
  return out;
}

/**
 * The shingle hashes of one or more texts.
 *
 * @param {readonly string[]} texts
 * @returns {Set<number>}
 */
export function fingerprint(texts) {
  const hashes = new Set();
  for (const text of texts) {
    const list = words(text);
    const ring = new Array(SHINGLE_WORDS);
    for (let index = 0; index < list.length; index += 1) {
      ring[index % SHINGLE_WORDS] = list[index];
      if (index >= SHINGLE_WORDS - 1) hashes.add(hashShingle(ring, (index + 1) % SHINGLE_WORDS));
    }
  }
  return hashes;
}

/**
 * Reads an answer piece by piece.
 *
 *   push(text)  -> the text that may be sent on now ('' while it is held)
 *   finish()    -> the rest, once the answer has ended
 *   leaked      true from the moment a limit is crossed; push and finish then return ''
 *
 * @param {Set<number>} fingerprints
 * @param {{ runWords?: number, totalWords?: number }} [limits]
 */
export function createScanner(fingerprints, { runWords = RUN_WORDS, totalWords = TOTAL_WORDS } = {}) {
  const ring = new Array(SHINGLE_WORDS);
  // Start offset, in the whole answer, of each of the last eight words.
  const starts = new Array(SHINGLE_WORDS).fill(0);
  let wordCount = 0;

  let held = ''; // text not released yet
  let heldAt = 0; // offset of held[0] in the whole answer
  let scanAt = 0; // offset where the next word search begins
  let hits = 0; // consecutive shingle hits ending at the last word
  let runStart = -1; // offset where the current verbatim run began
  let matchedWords = 0; // method words seen so far, across all runs
  let leaked = false;

  /** Takes one complete word that starts at `offset`. */
  function take(word, offset) {
    const slot = wordCount % SHINGLE_WORDS;
    ring[slot] = word;
    starts[slot] = offset;
    wordCount += 1;
    if (wordCount < SHINGLE_WORDS) return;

    const first = wordCount % SHINGLE_WORDS; // the oldest of the eight
    if (fingerprints.has(hashShingle(ring, first))) {
      if (hits === 0) {
        runStart = starts[first];
        matchedWords += SHINGLE_WORDS;
      } else {
        matchedWords += 1;
      }
      hits += 1;
      if (SHINGLE_WORDS + hits - 1 >= runWords || matchedWords >= totalWords) leaked = true;
    } else {
      hits = 0;
      runStart = -1;
    }
  }

  // One-letter words read but not taken yet: the next ones may spell a word.
  let letters = [];

  function takeLetters() {
    for (const entry of spelled(letters)) {
      if (leaked) break;
      take(entry.word, entry.offset);
    }
    letters = [];
  }

  /** Reads the complete words in the held text. With `final`, a word at the very end is complete too. */
  function scan(final) {
    const text = held.slice(scanAt - heldAt);
    WORD.lastIndex = 0;
    let consumed = 0;
    for (let match = WORD.exec(text); match && !leaked; match = WORD.exec(text)) {
      const end = match.index + match[0].length;
      // A word that touches the end of the text may continue in the next piece.
      if (end === text.length && !final) break;
      consumed = end;
      const word = canonical(match[0]);
      if (!word) continue;
      const offset = scanAt + match.index;
      if (word.length === 1 && /\p{L}/u.test(word)) {
        letters.push({ word, offset, end: scanAt + end });
        continue;
      }
      takeLetters();
      if (!leaked) take(word, offset);
    }
    scanAt += consumed;
    if (final && !leaked) takeLetters();
  }

  /** The offset up to which text can leave: nothing that might open a verbatim run. */
  function safeUpTo() {
    let upTo;
    if (hits > 0) upTo = runStart;
    else if (wordCount < SHINGLE_WORDS - 1) upTo = wordCount ? starts[0] : scanAt;
    // The last seven words may be the start of a run the next word completes.
    else upTo = Math.min(starts[(wordCount - (SHINGLE_WORDS - 1)) % SHINGLE_WORDS], scanAt);
    // Waiting one-letter words may spell the word that opens a run.
    return letters.length ? Math.min(upTo, letters[0].offset) : upTo;
  }

  function release(upTo) {
    const length = Math.max(0, upTo - heldAt);
    const out = held.slice(0, length);
    held = held.slice(length);
    heldAt += length;
    return out;
  }

  return {
    get leaked() {
      return leaked;
    },

    push(text) {
      if (leaked) return '';
      held += text;
      scan(false);
      if (leaked) return '';
      return release(safeUpTo());
    },

    finish() {
      if (leaked) return '';
      scan(true);
      if (leaked) return '';
      return release(heldAt + held.length);
    },
  };
}

/**
 * True when a whole answer crosses a limit.
 *
 * @param {Set<number>} fingerprints
 * @param {string} text
 * @param {{ runWords?: number, totalWords?: number }} [limits]
 */
export function leaks(fingerprints, text, limits) {
  const scanner = createScanner(fingerprints, limits);
  scanner.push(text);
  scanner.finish();
  return scanner.leaked;
}
