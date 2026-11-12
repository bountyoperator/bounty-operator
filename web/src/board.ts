// The bounty board's data, as new as the daily build has made it.
//
// The site is deployed with one day's data (web/public/board/data). A
// scheduled workflow in the source repository builds the data again every day
// and commits it to the `board-data` branch. This route serves that newer day
// when it can be read and is well formed, and the deployed copy otherwise, so
// the board stays current between deploys and never depends on GitHub being
// up. The page asks this origin only; no visitor's browser is sent to GitHub.

import type { Env } from './env.ts';
import { ApiError } from './http.ts';

export const BOARD_SOURCE = 'https://raw.githubusercontent.com/bountyoperator/bounty-operator/board-data';
export const BOARD_FILES = ['snapshot', 'programs'] as const;
type BoardFile = (typeof BOARD_FILES)[number];

const MAX_BYTES = 2_000_000;
const KEEP_MS = 30 * 60 * 1000;
const READ_TIMEOUT_MS = 6000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

interface BoardDoc { v: 1; day: string; at: string; [key: string]: unknown }
interface Kept { at: number; day: string; text: string }

// One read per file and isolate every half hour, however many visitors ask.
const kept = new Map<BoardFile, Kept>();

/** For tests: forget what was read. */
export function clearBoardData(): void {
  kept.clear();
}

/** The document, when the text is one of ours: version 1, a day, and for the list an array of programs. */
function parse(name: BoardFile, text: string): BoardDoc | null {
  if (text.length > MAX_BYTES) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
  const value = doc as Record<string, unknown>;
  if (value.v !== 1 || typeof value.day !== 'string' || !DAY.test(value.day) || typeof value.at !== 'string') return null;
  if (name === 'programs' && !Array.isArray(value.programs)) return null;
  if (name === 'snapshot' && (!Array.isArray(value.platforms) || typeof value.totals !== 'object' || value.totals === null)) return null;
  return value as BoardDoc;
}

async function deployed(env: Env, name: BoardFile): Promise<Kept | null> {
  try {
    const response = await env.ASSETS.fetch(new Request(`${env.SITE_ORIGIN}/board/data/${name}.json`));
    if (!response.ok) return null;
    const text = await response.text();
    const doc = parse(name, text);
    return doc ? { at: Date.now(), day: doc.day, text } : null;
  } catch {
    return null;
  }
}

async function newest(name: BoardFile): Promise<Kept | null> {
  try {
    // Workers do not implement the Fetch standard's 'error' redirect mode: passing
    // it throws, which for a day made every read fail and the board serve its
    // deployed copy. 'manual' returns a redirect as a 3xx, which is not ok here.
    const response = await fetch(`${BOARD_SOURCE}/${name}.json`, { redirect: 'manual', signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      console.warn('Board data branch not read', { file: name, status: response.status });
      return null;
    }
    const text = await response.text();
    const doc = parse(name, text);
    if (!doc) console.warn('Board data branch not read', { file: name, reason: 'malformed' });
    return doc ? { at: Date.now(), day: doc.day, text } : null;
  } catch (error) {
    console.warn('Board data branch not read', { file: name, reason: error instanceof Error ? error.name : 'unknown' });
    return null;
  }
}

/** GET /api/board/<name>: the newest well-formed day of one board file. */
export async function boardData(env: Env, name: BoardFile): Promise<Response> {
  let found = kept.get(name) ?? null;
  if (!found || Date.now() - found.at > KEEP_MS) {
    const [fresh, own] = await Promise.all([newest(name), deployed(env, name)]);
    // The later day wins; a deploy can be newer than the branch, and the branch
    // newer than the deploy. On the same day the branch wins: it is read later.
    const best = fresh && own ? (fresh.day >= own.day ? fresh : own) : fresh ?? own;
    // A failed read is not kept, so the next request tries again; the last good one stands meanwhile.
    if (best) kept.set(name, best);
    found = best ?? found;
  }
  if (!found) throw new ApiError('The board data is not available right now.', 503, 'board_unavailable', { retryAfter: 300 });
  return new Response(found.text, {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Board-Day': found.day },
  });
}

export const boardRoute = (name: BoardFile) => ({ env }: { env: Env }): Promise<Response> => boardData(env, name);
