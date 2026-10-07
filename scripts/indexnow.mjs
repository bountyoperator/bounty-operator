#!/usr/bin/env node
// Tells the IndexNow search engines (Bing, Yandex, Seznam, Naver, Yep) which
// pages of the live site changed, so they crawl them now instead of whenever
// they next pass. Run it after a deploy that changes public pages.
//
//   node scripts/indexnow.mjs                 every URL in web/public/sitemap.xml
//   node scripts/indexnow.mjs / /pricing      only these paths
//   node scripts/indexnow.mjs --dry-run       print what would be sent
//
// The key is public by design: IndexNow checks that the site serves it at
// https://bountyoperator.com/<key>.txt, the file in web/public named after it.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = 'https://bountyoperator.com';
const ENDPOINT = 'https://api.indexnow.org/indexnow';
const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'public');
const KEY_FILE = /^([0-9a-f]{32})\.txt$/;

/** The key whose file holds exactly its own name. */
function siteKey() {
  for (const name of readdirSync(PUBLIC_DIR)) {
    const match = name.match(KEY_FILE);
    if (match && readFileSync(join(PUBLIC_DIR, name), 'utf8').trim() === match[1]) return match[1];
  }
  throw new Error('No IndexNow key file in web/public: a <32 hex characters>.txt file that contains its own name.');
}

function sitemapUrls() {
  const xml = readFileSync(join(PUBLIC_DIR, 'sitemap.xml'), 'utf8');
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
}

function parseArguments(argv) {
  const options = { dryRun: false, paths: [] };
  for (const argument of argv) {
    if (argument === '--dry-run') options.dryRun = true;
    else if (argument.startsWith('/')) options.paths.push(argument);
    else throw new Error(`Unknown argument: ${argument}. Paths start with /.`);
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const key = siteKey();
  const urlList = options.paths.length > 0 ? options.paths.map((path) => `${SITE}${path}`) : sitemapUrls();
  const body = { host: new URL(SITE).host, key, keyLocation: `${SITE}/${key}.txt`, urlList };

  if (options.dryRun) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  // IndexNow fetches the key file to prove the site owns the key; check it is live first.
  const served = await fetch(body.keyLocation);
  if (!served.ok || (await served.text()).trim() !== key) {
    throw new Error(`${body.keyLocation} does not serve the key yet. Deploy first.`);
  }

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });
  // 200 and 202 both mean accepted; 202 while the key is still being verified.
  if (response.status !== 200 && response.status !== 202) {
    throw new Error(`IndexNow answered HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  console.log(`IndexNow accepted ${urlList.length} URL(s) (HTTP ${response.status}).`);
}

try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
