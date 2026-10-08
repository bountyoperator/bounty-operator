#!/usr/bin/env node
// Draw the social card.
//
//   node web/site/social/render.mjs
//
// Writes card.html next to this file (the HTML source of the image) and
// renders it to web/public/social-v3.png at 1200 x 630. Needs a global
// Playwright with Chromium (`npm i -g playwright`), like scripts/build-icons.mjs.

import { execSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CARD, cardDocument } from './card.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(here, 'card.html');
const output = path.resolve(here, '..', '..', 'public', 'social-v3.png');

function loadPlaywright() {
  const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
  return createRequire(`${globalRoot}${path.sep}`)('playwright');
}

await writeFile(source, cardDocument());

const { chromium } = loadPlaywright();
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: CARD, deviceScaleFactor: 1, colorScheme: 'dark' });
  await page.goto(pathToFileURL(source).href, { waitUntil: 'load' });
  await page.screenshot({ path: output, clip: { x: 0, y: 0, ...CARD } });
} finally {
  await browser.close();
}

console.log(`wrote    ${path.relative(process.cwd(), source)}`);
console.log(`wrote    ${path.relative(process.cwd(), output)} (${CARD.width} x ${CARD.height})`);
