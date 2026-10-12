#!/usr/bin/env node
// Draws the site icons from Spec in web/site/components.mjs.
//
//   node scripts/build-icons.mjs
//
// Writes into web/public: icon.svg, favicon.ico (16, 32, 48), apple-touch-icon.png
// (180), icon-192.png, icon-512.png and site.webmanifest.
//
// A maintainer tool, not part of the site build. Uses the existing web sharp
// installation to rasterise the shared SVG. Re-run only when the mark changes.

import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BRAND_MARK, specMarkPaths } from '../web/site/components.mjs';
import { SITE } from '../web/site/layout.mjs';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'public');

const TILE = BRAND_MARK.cream;
const TILE_RING = BRAND_MARK.cream;
const sharp = createRequire(path.join(PUBLIC_DIR, '..', 'package.json'))('sharp');

function markPaths() {
  return String(specMarkPaths());
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

async function rasterise(svg, size) {
  return sharp(Buffer.from(svg)).resize(size, size).png().toBuffer();
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
  const iconPath = (file) => `${file}?v=${SITE.iconVersion}`;
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
      { src: iconPath('/icon-192.png'), sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: iconPath('/icon-512.png'), sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: iconPath('/icon-192.png'), sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: iconPath('/icon-512.png'), sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: iconPath('/icon.svg'), sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    ],
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function main() {
  const write = (name, data) => writeFile(path.join(PUBLIC_DIR, name), data);

  const tile = tileSvg();
  await write('icon.svg', `${tile}\n`);

  const icoSizes = [16, 32, 48];
  const icoImages = [];
  for (const size of icoSizes) icoImages.push({ size, png: await rasterise(tile, size) });
  await write('favicon.ico', packIco(icoImages));

  await write('apple-touch-icon.png', await rasterise(fullBleedSvg(0.82), 180));
  await write('icon-192.png', await rasterise(fullBleedSvg(0.82), 192));
  await write('icon-512.png', await rasterise(fullBleedSvg(0.82), 512));
  await write('site.webmanifest', webManifest());
  console.log('Wrote icon.svg, favicon.ico, apple-touch-icon.png, icon-192.png, icon-512.png, site.webmanifest');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
