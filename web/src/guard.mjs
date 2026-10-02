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

const WORD = /[\p{L}\p{N}]+/gu;

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
 * The words of a text as the guard compares them: lower case, letters and
 * digits only. Punctuation, markup and line breaks do not count, so a quoted,
 * bulleted or re-wrapped copy still matches.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function words(text) {
  return (String(text).match(WORD) ?? []).map((word) => word.toLowerCase());
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

  /** Reads the complete words in the held text. With `final`, a word at the very end is complete too. */
  function scan(final) {
    const text = held.slice(scanAt - heldAt);
    WORD.lastIndex = 0;
    let consumed = 0;
    for (let match = WORD.exec(text); match && !leaked; match = WORD.exec(text)) {
      const end = match.index + match[0].length;
      // A word that touches the end of the text may continue in the next piece.
      if (end === text.length && !final) break;
      take(match[0].toLowerCase(), scanAt + match.index);
      consumed = end;
    }
    scanAt += consumed;
  }

  /** The offset up to which text can leave: nothing that might open a verbatim run. */
  function safeUpTo() {
    if (hits > 0) return runStart;
    if (wordCount < SHINGLE_WORDS - 1) return wordCount ? starts[0] : scanAt;
    // The last seven words may be the start of a run the next word completes.
    return Math.min(starts[(wordCount - (SHINGLE_WORDS - 1)) % SHINGLE_WORDS], scanAt);
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
