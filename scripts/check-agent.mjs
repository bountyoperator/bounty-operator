// The name the release checks send as their User-Agent. The Worker reads it
// (OWN_CHECK_AGENT in web/src/funnel.ts) and leaves these requests out of its
// counters, so a release is never counted as visits or as tool calls.

export const CHECK_AGENT = 'bounty-operator-check/1';

/** `init` for fetch with the check's User-Agent added to whatever headers it holds. */
export function asCheck(init = {}) {
  return { ...init, headers: { ...init.headers, 'User-Agent': CHECK_AGENT } };
}
