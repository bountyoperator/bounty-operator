#!/usr/bin/env node
// Draws the site icons from the "b/" mark in web/site/components.mjs.
//
//   node scripts/build-icons.mjs
//
// Writes into web/public: icon.svg, favicon.ico (16, 32, 48), apple-touch-icon.png
// (180), icon-192.png, icon-512.png and site.webmanifest.
//
// A maintainer tool, not part of the site build. It rasterises with Playwright,
// which is not a dependency of this repo: install it globally (npm i -g playwright)
// or locally before running. Re-run it only when the mark changes.

import { execSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BRAND_MARK } from '../web/site/components.mjs';
import { SITE } from '../web/site/layout.mjs';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'public');

// The mark as the header prints it: a tile of the hot ink, the b in black, the
// slash in bone. Vermilion reads on light and dark tab bars alike.
const TILE = '#ff4d2e';
const TILE_RING = '#ff4d2e';
const GLYPH = '#09090a';
const SLASH = '#f4f1ea';

function markPaths() {
  return [
    `<path fill="${GLYPH}" d="${BRAND_MARK.stem}"/>`,
    `<path fill="${GLYPH}" fill-rule="evenodd" d="${BRAND_MARK.bowl}"/>`,
    `<path fill="${SLASH}" d="${BRAND_MARK.slash}"/>`,
  ].join('');
}

/** The browser-tab icon: the tile, with a ring in its own colour. */
function tileSvg() {
  const radius = BRAND_MARK.tileRadius;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${BRAND_MARK.viewBox}">`,
    `<rect width="64" height="64" rx="${radius}" fill="${TILE}"/>`,
    `<rect x="0.75" y="0.75" width="62.5" height="62.5" rx="${radius - 0.75}" fill="none" stroke="${TILE_RING}" stroke-width="1.5"/>`,
    markPaths(),
    '</svg>',
  ].join('');
}

/**
 * A full-bleed square for home screens. Launchers crop it to their own shape,
 * so the mark is scaled into the central safe zone (a circle 80% of the width).
 */
function fullBleedSvg(scale) {
  const offset = (32 * (1 - scale)).toFixed(3);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${BRAND_MARK.viewBox}">`,
    `<rect width="64" height="64" fill="${TILE}"/>`,
    `<g transform="translate(${offset} ${offset}) scale(${scale})">${markPaths()}</g>`,
    '</svg>',
  ].join('');
}

function loadPlaywright() {
  const localRequire = createRequire(import.meta.url);
  try {
    return localRequire('playwright');
  } catch {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    return createRequire(`${globalRoot}${path.sep}`)('playwright');
  }
}

async function rasterise(browser, svg, size) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  const encoded = Buffer.from(svg).toString('base64');
  await page.goto(`data:image/svg+xml;base64,${encoded}`);
  const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  await page.close();
  return png;
}

/** Pack PNG images into one .ico file (PNG-in-ICO, readable by every current browser). */
function packIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;
  images.forEach(({ size, png }, index) => {
    const entry = index * 16;
    directory.writeUInt8(size === 256 ? 0 : size, entry);
    directory.writeUInt8(size === 256 ? 0 : size, entry + 1);
    directory.writeUInt8(0, entry + 2);
    directory.writeUInt8(0, entry + 3);
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(png.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, directory, ...images.map((image) => image.png)]);
}

function webManifest() {
  const manifest = {
    name: SITE.name,
    short_name: 'Operator',
    description: SITE.summary,
    start_url: '/',
    scope: '/',
    display: 'minimal-ui',
    background_color: SITE.themeColor.dark,
    theme_color: SITE.themeColor.dark,
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    ],
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function main() {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  const write = (name, data) => writeFile(path.join(PUBLIC_DIR, name), data);

  try {
    const tile = tileSvg();
    await write('icon.svg', `${tile}\n`);

    const icoSizes = [16, 32, 48];
    const icoImages = [];
    for (const size of icoSizes) icoImages.push({ size, png: await rasterise(browser, tile, size) });
    await write('favicon.ico', packIco(icoImages));

    await write('apple-touch-icon.png', await rasterise(browser, fullBleedSvg(0.92), 180));
    await write('icon-192.png', await rasterise(browser, fullBleedSvg(0.82), 192));
    await write('icon-512.png', await rasterise(browser, fullBleedSvg(0.82), 512));
    await write('site.webmanifest', webManifest());
  } finally {
    await browser.close();
  }
  console.log('Wrote icon.svg, favicon.ico, apple-touch-icon.png, icon-192.png, icon-512.png, site.webmanifest');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
