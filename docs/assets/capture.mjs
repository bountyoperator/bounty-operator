#!/usr/bin/env node
// Captures the two README images from the local build.
//
//   node docs/assets/capture.mjs
//
// Serves web/public on a throwaway local port, runs the bundled example in the
// workbench and writes, next to this file:
//
//   review.png     the example review: the verdict, then each claim of the draft
//   gauntlet.png   the example gauntlet dossier: verdict, blocker, the eight stages
//
// Both are 1600 px wide, in the day theme. The example is a stored answer, so
// nothing here needs the Worker, an account or a model key. Needs a global
// Playwright with Chromium (`npm i -g playwright`), like scripts/build-icons.mjs.
// Run `node scripts/build-site.mjs` first so the pages are current.

import { execSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(HERE, '..', '..', 'web', 'public');

// The page is laid out 1000 CSS px wide and captured at 1.6 device pixels each.
const CSS_WIDTH = 1000;
const IMAGE_WIDTH = 1600;
const MARGIN = 28;
// Space kept above the "Result" heading. The status line sits just above it.
const TITLE_MARGIN = 16;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

// The policy the Worker sends, so the capture runs under the rules the site runs under.
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://api.github.com https://openrouter.ai; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

async function isFile(file) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/** web/public as the Worker serves it: extensionless pages, and no API behind it. */
async function serve() {
  const server = createServer(async (request, response) => {
    const { pathname } = new URL(request.url, 'http://localhost');
    const headers = { 'Content-Security-Policy': CSP, 'Cache-Control': 'no-store' };
    if (pathname.startsWith('/api/')) {
      response.writeHead(404, { ...headers, 'Content-Type': TYPES['.json'] });
      response.end('{"error":"No Worker behind this capture server.","code":"not_found"}');
      return;
    }
    const relative = path.normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
    let file = path.join(PUBLIC, relative || 'index.html');
    if (!file.startsWith(PUBLIC)) file = path.join(PUBLIC, 'index.html');
    if (!(await isFile(file)) && (await isFile(`${file}.html`))) file = `${file}.html`;
    if (!(await isFile(file))) {
      response.writeHead(404, { ...headers, 'Content-Type': TYPES['.html'] });
      response.end('Not found');
      return;
    }
    response.writeHead(200, { ...headers, 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    response.end(await readFile(file));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://localhost:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

function loadPlaywright() {
  const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
  return createRequire(`${globalRoot}${path.sep}`)('playwright');
}

/** Top and bottom of the first element matching each selector, in page coordinates. */
function edges(page, selectors) {
  return page.evaluate((list) => {
    const out = {};
    for (const [name, selector] of Object.entries(list)) {
      const node = document.querySelector(selector);
      if (!node) throw new Error(`The page has no ${selector}.`);
      const box = node.getBoundingClientRect();
      out[name] = { top: box.top + window.scrollY, bottom: box.bottom + window.scrollY };
    }
    return out;
  }, selectors);
}

async function capture(page, name, top, bottom) {
  const file = path.join(HERE, name);
  // A viewport as tall as the page: nothing scrolls, so the sticky status line stays where it is laid out.
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: CSS_WIDTH, height });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);
  await page.screenshot({
    path: file,
    clip: { x: 0, y: Math.round(top - MARGIN), width: CSS_WIDTH, height: Math.round(bottom - top + 2 * MARGIN) },
    animations: 'disabled',
  });
  console.log(`wrote    ${path.relative(process.cwd(), file)}`);
}

const site = await serve();
const { chromium } = loadPlaywright();
const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: { width: CSS_WIDTH, height: 1200 },
    deviceScaleFactor: IMAGE_WIDTH / CSS_WIDTH,
    colorScheme: 'light',
    // The times in the images are UTC, whatever the clock of the machine that captures them.
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => {
    throw error;
  });

  await page.goto(`${site.origin}/`, { waitUntil: 'networkidle' });
  await page.click('[data-demo]');
  await page.waitForSelector('#wb-result[data-source="example"]', { state: 'visible' });
  await page.waitForTimeout(600);

  // The review: from the "Result" heading to the fifth claim of the draft. The
  // frame ends on the row's own border, so the table reads as continuing.
  const review = await edges(page, { title: '#wb-results-title', lastRow: '#wb-result .wb-section tbody tr:nth-child(5)' });
  await capture(page, 'review.png', review.title.top + MARGIN - TITLE_MARGIN, review.lastRow.bottom - MARGIN);

  // The gauntlet on the same example: from the heading to the eight stages.
  await page.setViewportSize({ width: CSS_WIDTH, height: 1200 });
  await page.getByRole('button', { name: 'Show the gauntlet on this example' }).click();
  await page.waitForSelector('#wb-result[data-source="gauntlet"]', { state: 'visible' });
  await page.waitForTimeout(600);
  const dossier = await edges(page, { title: '#wb-results-title', stages: '#wb-result .rn-pipe' });
  await capture(page, 'gauntlet.png', dossier.title.top + MARGIN - TITLE_MARGIN, dossier.stages.bottom);
} finally {
  await browser.close();
  await site.close();
}
