// The hosted profiles on the server: where their method comes from, how an id
// an earlier release stored resolves, and the guard that keeps a method out
// of its own output.
//
// The method arrives through operator-profiles.generated.mjs, which
// scripts/select-profiles.mjs writes: the private module in production, the
// community stub in a checkout without it. Nothing in this file, and nothing
// any route returns, hands the text to a client. It goes to the provider as
// part of the system message and nowhere else.

import { PROFILES, reviewProfile } from '../public/profiles.mjs';

import { createScanner, fingerprint, limitsFor, words } from './guard.mjs';
import { OPERATOR_PROFILES, PROFILE_SOURCE } from './operator-profiles.generated.mjs';

export interface Method {
  instructions: string;
  extraFormat: string;
}

/** 'private' for the production method, 'stub' for the community edition. */
export const METHOD_SOURCE: string = PROFILE_SOURCE;

/**
 * The current id for an id a client or a stored row carries. An earlier
 * release stored the Solidity profile under a prefixed id; the engine resolves
 * any id of that shape, so no old id is spelled out here or anywhere else.
 * Unknown ids are returned unchanged.
 */
export function currentProfileId(id: string): string {
  try {
    return reviewProfile(id).id;
  } catch {
    return id;
  }
}

const METHODS: Readonly<Record<string, Method>> = OPERATOR_PROFILES;

/** The method of a hosted profile, or null when this server has none for it. Passed to prepareReview. */
export function instructionsFor(profile: { id: string }): Method | null {
  return Object.hasOwn(METHODS, profile.id) ? METHODS[profile.id] : null;
}

/** Ids of the hosted profiles this server has no method for. Empty on a healthy build. */
export function missingMethods(): string[] {
  return PROFILES.filter((profile) => profile.hosted && !instructionsFor(profile)?.instructions.trim()).map((profile) => profile.id);
}

// ---------------------------------------------------------------------------
// Output guard
// ---------------------------------------------------------------------------

interface Guard {
  fingerprints: Set<number>;
  limits: { runWords: number; totalWords: number };
}

// Prepared once, when the Worker starts: about five thousand words in all.
//
// The fingerprints come from the method text alone. The output format of a
// profile (its section titles, field labels and placeholders) is left out: a
// review is meant to repeat it, and a model that returns the template unfilled
// has written a poor answer, not handed over the method.
const GUARDS: ReadonlyMap<string, Guard> = new Map(
  Object.entries(METHODS).map(([id, method]) => {
    const texts = [method.instructions];
    return [id, { fingerprints: fingerprint(texts), limits: limitsFor(words(method.instructions).length) }];
  }),
);

export type OutputScanner = ReturnType<typeof createScanner>;

/**
 * A scanner for the answer to a review of this profile, or null for a core
 * profile, whose method is public. Feed it every piece of the answer and send
 * on only what it returns.
 */
export function outputScanner(profileId: string): OutputScanner | null {
  const guard = GUARDS.get(reviewProfile(profileId).id);
  return guard ? createScanner(guard.fingerprints, guard.limits) : null;
}
