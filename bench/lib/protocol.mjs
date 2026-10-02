// Paydirt protocol hashes: which hash a stored run depends on.
//
// protocol.json is hashed three ways.
//   protocol hash  the whole file, without its own `hashes` block. One value for display: the
//                  plan, the run log and the results print it. It moves when anything moves,
//                  the product's profile texts included.
//   core hash      the file without the parts that only a profile arm uses: the `engine` block
//                  (the hashes of the frozen product texts, the engine commit and files) and
//                  the hash of prompts/profile-bridge.md. It covers everything a raw-arm run
//                  depends on: omp version and flags, routing, time limits, the overlay, the
//                  extensions, the system prompt, the task text, the answer sheet, and the
//                  rest of protocol.json as it always was.
//   arm hash       one per arm. The headline arm runs under the core hash. A profile arm runs
//                  under sha256(core hash, profile id, bridge hash, hash of that profile's
//                  frozen text).
// A run is stored, resumed and counted under the hash of its arm (lib/runs.mjs `resumeKey`).
// So freezing a changed product text again moves the hash of that one profile, and with it
// only that profile's runs: the raw-arm runs and the other profiles' runs stay valid.
//
// `freeze` writes the three kinds of hash into protocol.json as the `hashes` block and into
// METHOD.md. The block is a record for readers; the harness always computes the hashes from
// the content, and `lint` and `run` refuse a block that no longer matches it.
import crypto from 'node:crypto';

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

/** protocol.json `files` entries that only a profile arm sends. They are part of every profile arm's hash and not of the core hash. */
export const PROFILE_ARM_FILES = Object.freeze(['prompts/profile-bridge.md']);

/** JSON with object keys sorted at every level: the form that is hashed and compared. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}

export const headlineArm = (protocol) => protocol?.scoring?.headline_arm ?? 'raw';

/** The profile arms of a protocol, in the order protocol.json lists them. */
export function profileArmIds(protocol) {
  const head = headlineArm(protocol);
  return [...new Set(Object.values(protocol?.arms ?? {}).flat().filter((arm) => arm !== head))];
}

/**
 * { protocol, core, arms: { <arm>: hash } } for a protocol object. `arms` holds the hash each
 * arm runs under: the core hash for the headline arm, and for a profile arm its own hash, or
 * null while protocol.json records no frozen text for it. The stored `hashes` block is never
 * part of what is hashed.
 */
export function protocolHashes(protocol) {
  const { hashes: _stored, ...whole } = protocol ?? {};
  const { engine, ...core } = whole;
  const profileFiles = {};
  if (core.files && typeof core.files === 'object') {
    core.files = { ...core.files };
    for (const rel of PROFILE_ARM_FILES) if (rel in core.files) { profileFiles[rel] = core.files[rel]; delete core.files[rel]; }
  }
  const coreSha = sha256(`paydirt.core/1\n${canonical(core)}`);
  const arms = { [headlineArm(whole)]: coreSha };
  for (const id of profileArmIds(whole)) {
    const text = engine?.profiles?.[id]?.system_sha256;
    arms[id] = typeof text === 'string' && text ? sha256(['paydirt.arm/1', coreSha, id, canonical(profileFiles), text].join('\n')) : null;
  }
  return { protocol: sha256(canonical(whole)), core: coreSha, arms };
}

/** The protocol hash: one value for the whole file, for display. */
export const protocolHash = (protocol) => protocolHashes(protocol).protocol;

/** A copy of the protocol with a fresh `hashes` block as its last key. */
export function stampHashes(protocol) {
  const { hashes: _stored, ...whole } = protocol;
  return { ...whole, hashes: protocolHashes(whole) };
}

/**
 * Which entries of the stored `hashes` block are not the hash of the content: [] when the
 * block is current, ['missing'] when there is none, else names out of "protocol", "core" and
 * the profile arms.
 */
export function hashesDrift(protocol) {
  const kept = protocol?.hashes;
  if (!kept || typeof kept !== 'object') return ['missing'];
  const now = protocolHashes(protocol);
  const head = headlineArm(protocol);
  const names = [];
  if (kept.protocol !== now.protocol) names.push('protocol');
  if (kept.core !== now.core || (kept.arms ?? {})[head] !== now.core) names.push('core');
  for (const arm of new Set([...Object.keys(now.arms), ...Object.keys(kept.arms ?? {})])) {
    if (arm !== head && ((kept.arms ?? {})[arm] ?? null) !== (now.arms[arm] ?? null)) names.push(arm);
  }
  return names;
}

/**
 * The hashes the stored block records: the ones the runs made so far were stored under,
 * because `run` refuses a block that is not current. Where there is no usable block, the
 * hashes of the content. `freeze` reports against these, so that an edit to protocol.json
 * shows up as a change even though the freeze itself adds nothing to it.
 */
export function recordedHashes(protocol) {
  const kept = protocol?.hashes;
  const usable = kept && typeof kept === 'object' && typeof kept.protocol === 'string' && typeof kept.core === 'string' && kept.arms && typeof kept.arms === 'object';
  return usable ? { protocol: kept.protocol, core: kept.core, arms: { ...kept.arms } } : protocolHashes(protocol);
}

// ---------------------------------------------------------------- METHOD.md

export const HASHES_BEGIN = '<!-- hashes:begin (written by "bench.mjs freeze"; do not edit by hand) -->';
export const HASHES_END = '<!-- hashes:end -->';

/** The block of METHOD.md between the hashes markers: the hash each arm runs under. */
export function renderHashesBlock(protocol) {
  const hashes = protocolHashes(protocol);
  const head = headlineArm(protocol);
  const lines = [HASHES_BEGIN, ''];
  lines.push('| Arm | A run of this arm depends on | Hash it is stored and counted under |', '|---|---|---|');
  lines.push(`| \`${head}\` | the core | \`${hashes.core}\` |`);
  for (const arm of profileArmIds(protocol)) lines.push(`| \`${arm}\` | the core, the bridge text and the frozen \`${arm}\` text | ${hashes.arms[arm] ? `\`${hashes.arms[arm]}\`` : 'no text frozen yet'} |`);
  lines.push('', `Protocol hash, over the whole of \`protocol.json\` except this record of hashes in it: \`${hashes.protocol}\`.`, '', HASHES_END);
  return lines.join('\n');
}

/** The hashes block found in a METHOD.md text, or null when the markers are absent. */
export function findHashesBlock(text) {
  const a = text.indexOf(HASHES_BEGIN), b = text.indexOf(HASHES_END);
  return a >= 0 && b > a ? text.slice(a, b + HASHES_END.length) : null;
}

/** METHOD.md text with its hashes block replaced, or null when the markers are absent. */
export function replaceHashesBlock(text, block) {
  const old = findHashesBlock(text);
  return old === null ? null : text.replace(old, () => block);
}
