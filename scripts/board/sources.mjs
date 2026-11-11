// Reads each platform's public program list. One polite request per list (a
// few for the paged ones), with a client name that says who is asking and
// where the result is shown. Nothing here needs an account or a key.

const CLIENT = 'bounty-operator-board/1 (+https://bountyoperator.com/board)';
const DATASET = 'https://raw.githubusercontent.com/arkadiyt/bounty-targets-data/main/data';
const MB = 1024 * 1024;

/**
 * One JSON document, or a thrown Error naming the source. `fetchImpl` is the
 * fetch to use, so a test can stand in for the network.
 */
export async function readJson(url, { fetchImpl = fetch, maxBytes = 8 * MB, timeoutMs = 60000, method = 'GET', body = null, tries = 3 } = {}) {
  let last = null;
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method,
        body: body === null ? undefined : JSON.stringify(body),
        headers: { 'User-Agent': CLIENT, Accept: 'application/json', ...(body === null ? {} : { 'Content-Type': 'application/json' }) },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      if (text.length > maxBytes) throw new Error(`answer larger than ${maxBytes} bytes`);
      return JSON.parse(text);
    } catch (error) {
      last = error;
      // A refusal is not repaired by asking again at once.
      if (/HTTP 4\d\d/.test(String(error?.message)) && !/HTTP (408|429)/.test(String(error?.message))) break;
      if (attempt < tries) await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    }
  }
  throw new Error(`${new URL(url).host}: ${last instanceof Error ? last.message : String(last)}`);
}

const dataset = (name, options) => readJson(`${DATASET}/${name}_data.json`, { maxBytes: 64 * MB, timeoutMs: 180000, ...options });

const H1_TEAMS = `query Board($after: String) {
  teams(first: 100, after: $after, where: { _and: [{ submission_state: { _eq: open } }, { state: { _eq: public_mode } }] }) {
    pageInfo { endCursor hasNextPage }
    edges { node {
      handle launched_at maximum_bounty_table_value resolved_report_count reports_received_last_90_days formatted_bounties_paid_last_90_days
      most_recent_sla_snapshot { average_time_to_first_program_response average_time_to_bounty_awarded average_time_to_report_resolved }
    } }
  }
}`;

/** HackerOne's public program directory: launch date, reward ceiling and 90-day figures per program. */
export async function hackeroneTeams(options) {
  const teams = [];
  let after = null;
  for (let page = 0; page < 40; page += 1) {
    const answer = await readJson('https://hackerone.com/graphql', { ...options, method: 'POST', body: { query: H1_TEAMS, variables: { after } } });
    const list = answer?.data?.teams;
    if (!list || !Array.isArray(list.edges)) throw new Error('hackerone.com: the directory answer has no program list');
    teams.push(...list.edges.map((edge) => edge?.node).filter(Boolean));
    if (!list.pageInfo?.hasNextPage) return teams;
    after = list.pageInfo.endCursor;
  }
  throw new Error('hackerone.com: the directory did not end within 40 pages');
}

/** YesWeHack's public program list: the currency of each reward grid and its report count. */
export async function yeswehackPrograms(options) {
  const items = [];
  for (let page = 1; page <= 20; page += 1) {
    const answer = await readJson(`https://api.yeswehack.com/programs?page=${page}&resultsPerPage=50`, options);
    if (!Array.isArray(answer?.items)) throw new Error('api.yeswehack.com: the answer has no program list');
    items.push(...answer.items);
    if (page >= (answer.pagination?.nb_pages ?? 1)) return items;
  }
  throw new Error('api.yeswehack.com: the list did not end within 20 pages');
}

/** Bugcrowd's public list of vulnerability disclosure engagements (the data set carries the paying ones only). */
export async function bugcrowdDisclosure(options) {
  const items = [];
  for (let page = 1; page <= 60; page += 1) {
    const answer = await readJson(`https://bugcrowd.com/engagements.json?category=vdp&page=${page}`, options);
    if (!Array.isArray(answer?.engagements)) throw new Error('bugcrowd.com: the answer has no engagement list');
    items.push(...answer.engagements);
    if (!answer.engagements.length || items.length >= (answer.paginationMeta?.totalCount ?? 0)) return items;
  }
  throw new Error('bugcrowd.com: the list did not end within 60 pages');
}

async function sherlockPages(path, options) {
  const items = [];
  for (let page = 1; page <= 20; page += 1) {
    const answer = await readJson(`https://mainnet-contest.sherlock.xyz/${path}?per_page=100&page=${page}`, options);
    if (!Array.isArray(answer?.items)) throw new Error('mainnet-contest.sherlock.xyz: the answer has no list');
    items.push(...answer.items);
    if (!answer.has_next) return items;
  }
  throw new Error('mainnet-contest.sherlock.xyz: the list did not end within 20 pages');
}

/**
 * What each platform published, keyed by platform. A platform whose read
 * fails is reported under `failed` with the reason, and the others still come
 * back: one platform's outage must not empty the board.
 *
 * @returns {Promise<{ raw: Record<string, unknown>, failed: Record<string, string> }>}
 */
export async function readAll(options = {}) {
  const jobs = {
    hackerone: async () => ({ targets: await dataset('hackerone', options), teams: await hackeroneTeams(options) }),
    bugcrowd: async () => ({ targets: await dataset('bugcrowd', options), disclosure: await bugcrowdDisclosure(options) }),
    intigriti: async () => ({ targets: await dataset('intigriti', options), programs: await readJson('https://app.intigriti.com/api/core/public/programs', options) }),
    yeswehack: async () => ({ targets: await dataset('yeswehack', options), programs: await yeswehackPrograms(options) }),
    immunefi: async () => readJson('https://immunefi.com/public-api/bounties.json', { maxBytes: 32 * MB, ...options }),
    cantina: async () => readJson('https://cantina.xyz/api/v0/opportunities?limit=200', { maxBytes: 16 * MB, ...options }),
    sherlock: async () => ({ bounties: await sherlockPages('bug_bounties', options), contests: await sherlockPages('contests', options) }),
    code4rena: async () => readJson('https://code4rena.com/api/v1/audits', options),
  };
  const raw = {};
  const failed = {};
  await Promise.all(Object.entries(jobs).map(async ([id, job]) => {
    try {
      raw[id] = await job();
    } catch (error) {
      failed[id] = error instanceof Error ? error.message : String(error);
    }
  }));
  return { raw, failed };
}
