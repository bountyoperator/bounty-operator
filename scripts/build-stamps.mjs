#!/usr/bin/env node
// Inks the stamp impressions the site shows.
//
//   node scripts/build-stamps.mjs
//
// Writes into web/public/stamps:
//   verdict-<id>.webp   one per verdict: the large rubber stamp (.verdict--lg)
//   sev-<id>.webp       one per severity: the hand-stamped severity (.sev--stamp)
//   strike.svg          the pen stroke that strikes a claimed severity
//
// Each impression starts as the live stamp box from base.css, rendered crisp
// in Chromium (.stamp--proof: black, flat, untilted), so the words, the rules
// and the proportions are exactly the ones the page lays out. Then it is
// pressed once: pressure that falls away across the face, voids where the
// paper's fibre took no ink, ink pooled along the edges of each stroke, edges
// that wander a little and a slight bleed. Every stamp has its own seed, so no
// two impressions share a texture, and the same seed gives the same file.
// The files are black ink on transparent and are used as CSS masks: the page
// shows the chip colour through them, so day and night share one asset.
//
// A maintainer tool, like scripts/build-icons.mjs: it rasterises with a global
// Playwright (npm i -g playwright) and encodes WebP with ffmpeg. Re-run it when
// a label, the stamp geometry or the font changes.

import { execFileSync, execSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'web', 'public');
const OUT_DIR = path.join(PUBLIC_DIR, 'stamps');

/** Labels exactly as the site and the app print them (components.mjs, app/results.mjs). */
export const VERDICT_STAMPS = Object.freeze([
  ['submit', 'Submit'],
  ['rewrite-then-submit', 'Rewrite, then submit'],
  ['prove-first', 'Prove first'],
  ['hold-duplicate', 'Hold: duplicate'],
  ['drop', 'Drop'],
  ['fix-before-deploy', 'Fix before deploy'],
  ['no-blocking-issues', 'No blocking issues'],
]);

export const SEVERITY_STAMPS = Object.freeze([
  ['critical', 'Critical'],
  ['high', 'High'],
  ['medium', 'Medium'],
  ['low', 'Low'],
  ['info', 'Info'],
]);

// The size the proofs are drawn at. The hero prints the verdict at 24px; the
// file is drawn at twice that, so it stays sharp on a 2x screen.
const PROOF_FONT_PX = 24;
const PROOF_SCALE = 2;

function loadPlaywright() {
  const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
  return createRequire(`${globalRoot}${path.sep}`)('playwright');
}

function proofPage() {
  const css = pathToFileURL(path.join(PUBLIC_DIR, 'css', 'base.css')).href;
  const verdicts = VERDICT_STAMPS.map(
    ([id, label]) => `<p><span id="verdict-${id}" class="chip verdict verdict--lg stamp--proof" data-verdict="${id}">${label}</span></p>`,
  ).join('\n');
  const severities = SEVERITY_STAMPS.map(
    ([id, label]) => `<p><span id="sev-${id}" class="chip sev sev--stamp stamp--proof" data-sev="${id}">${label}</span></p>`,
  ).join('\n');
  // The proof page is never served: inline style is fine here.
  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="${css}">
<style>
  html, body { background: transparent; }
  body { padding: 24px; font-size: 16px; }
  p { margin: 0 0 24px; }
  .stamp--proof { --chip: #000; transform: none; font-size: ${PROOF_FONT_PX}px; }
  .sev--stamp.stamp--proof { font-size: ${Math.round(PROOF_FONT_PX * 0.875)}px; }
</style>
</head>
<body>
${verdicts}
${severities}
</body>
</html>`;
}

/**
 * Press one crisp proof into an impression. Runs in the page: the proof comes
 * in as a PNG data URL and the impression goes out as one. `seed` decides the
 * texture; `style` sets how hard the stamp was pressed.
 */
function press({ proof, seed, pressure }) {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      const W = image.width;
      const H = image.height;
      const canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, 0, 0);
      const source = context.getImageData(0, 0, W, H);
      const A0 = new Float32Array(W * H);
      for (let i = 0; i < W * H; i += 1) A0[i] = source.data[i * 4 + 3] / 255;

      // Seeded PRNG and gradient noise.
      function mulberry32(a) {
        return function () {
          a |= 0;
          a = (a + 0x6d2b79f5) | 0;
          let t = Math.imul(a ^ (a >>> 15), 1 | a);
          t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
      }
      function makeNoise(s) {
        const rand = mulberry32(s);
        const perm = new Uint16Array(512);
        const p = Array.from({ length: 256 }, (_, i) => i);
        for (let i = 255; i > 0; i -= 1) {
          const j = Math.floor(rand() * (i + 1));
          [p[i], p[j]] = [p[j], p[i]];
        }
        for (let i = 0; i < 512; i += 1) perm[i] = p[i & 255];
        const gx = new Float32Array(256);
        const gy = new Float32Array(256);
        for (let i = 0; i < 256; i += 1) {
          const angle = rand() * Math.PI * 2;
          gx[i] = Math.cos(angle);
          gy[i] = Math.sin(angle);
        }
        return function (x, y) {
          const xi = Math.floor(x);
          const yi = Math.floor(y);
          const xf = x - xi;
          const yf = y - yi;
          const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
          const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
          const g = (ix, iy, dx, dy) => {
            const h = perm[(perm[ix & 255] + iy) & 255];
            return gx[h] * dx + gy[h] * dy;
          };
          const n00 = g(xi, yi, xf, yf);
          const n10 = g(xi + 1, yi, xf - 1, yf);
          const n01 = g(xi, yi + 1, xf, yf - 1);
          const n11 = g(xi + 1, yi + 1, xf - 1, yf - 1);
          return ((n00 * (1 - u) + n10 * u) * (1 - v) + (n01 * (1 - u) + n11 * u) * v) * 1.41;
        };
      }
      function fbm(noise, x, y, octaves) {
        let sum = 0;
        let amp = 0.5;
        let freq = 1;
        let norm = 0;
        for (let i = 0; i < octaves; i += 1) {
          sum += amp * noise(x * freq, y * freq);
          norm += amp;
          amp *= 0.5;
          freq *= 2.03;
        }
        return sum / norm;
      }
      const smooth = (a, b, x) => {
        const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
        return t * t * (3 - 2 * t);
      };
      const clamp = (x) => Math.min(1, Math.max(0, x));
      const at = (field, x, y) => {
        const cx = Math.min(W - 1, Math.max(0, x));
        const cy = Math.min(H - 1, Math.max(0, y));
        const x0 = Math.floor(cx);
        const y0 = Math.floor(cy);
        const x1 = Math.min(W - 1, x0 + 1);
        const y1 = Math.min(H - 1, y0 + 1);
        const fx = cx - x0;
        const fy = cy - y0;
        const top = field[y0 * W + x0] * (1 - fx) + field[y0 * W + x1] * fx;
        const bottom = field[y1 * W + x0] * (1 - fx) + field[y1 * W + x1] * fx;
        return top * (1 - fy) + bottom * fy;
      };
      function blur(field, radius) {
        const tmp = new Float32Array(W * H);
        const out = new Float32Array(W * H);
        const span = radius * 2 + 1;
        for (let y = 0; y < H; y += 1) {
          let acc = 0;
          for (let x = -radius; x <= radius; x += 1) acc += field[y * W + Math.min(W - 1, Math.max(0, x))];
          for (let x = 0; x < W; x += 1) {
            tmp[y * W + x] = acc / span;
            const add = Math.min(W - 1, x + radius + 1);
            const drop = Math.max(0, x - radius);
            acc += field[y * W + add] - field[y * W + drop];
          }
        }
        for (let x = 0; x < W; x += 1) {
          let acc = 0;
          for (let y = -radius; y <= radius; y += 1) acc += tmp[Math.min(H - 1, Math.max(0, y)) * W + x];
          for (let y = 0; y < H; y += 1) {
            out[y * W + x] = acc / span;
            const add = Math.min(H - 1, y + radius + 1);
            const drop = Math.max(0, y - radius);
            acc += tmp[add * W + x] - tmp[drop * W + x];
          }
        }
        return out;
      }

      const wanderX = makeNoise(seed * 7 + 1);
      const wanderY = makeNoise(seed * 7 + 2);
      const face = makeNoise(seed * 7 + 3);
      const fibre = makeNoise(seed * 7 + 4);
      const blotch = makeNoise(seed * 7 + 5);
      const rand = mulberry32(seed * 7 + 6);

      // 1. The rubber's edge wanders: sample the proof through a slow displacement.
      const wander = 1.25 * pressure.scale;
      const A1 = new Float32Array(W * H);
      for (let y = 0; y < H; y += 1) {
        for (let x = 0; x < W; x += 1) {
          const dx = fbm(wanderX, x / 15, y / 15, 2) * wander;
          const dy = fbm(wanderY, x / 15, y / 15, 2) * wander;
          A1[y * W + x] = at(A0, x + dx, y + dy);
        }
      }

      // 2. Ink bleeds a little into the paper, then the edge settles.
      const bled = blur(A1, 1);
      const A2 = new Float32Array(W * H);
      for (let i = 0; i < W * H; i += 1) A2[i] = smooth(0.28, 0.66, bled[i]);

      // 3. Ink pools along the edges of every stroke.
      const inner = blur(A2, 3);
      const rim = new Float32Array(W * H);
      for (let i = 0; i < W * H; i += 1) rim[i] = clamp((A2[i] - inner[i]) * 2.4);

      // 4. Pressure: a slow wash across the face, and one side pressed lighter.
      const angle = rand() * Math.PI * 2;
      const ca = Math.cos(angle);
      const sa = Math.sin(angle);
      const out = context.createImageData(W, H);
      for (let y = 0; y < H; y += 1) {
        for (let x = 0; x < W; x += 1) {
          const i = y * W + x;
          if (A2[i] <= 0.002) continue;
          const lean = ((x / W - 0.5) * ca + (y / H - 0.5) * sa) * pressure.lean;
          const wash = fbm(face, x / 70, y / 70, 2) * pressure.wash;
          const P = clamp(pressure.base + wash + lean);
          const light = 1 - P;
          // 5. The paper's fibre: fine voids, more where the stamp was light.
          const grain = fbm(fibre, x / 1.9, y / 1.9, 3);
          const voids = smooth(0.34 - light * 0.55, 0.44 - light * 0.55, grain);
          // 6. Larger thin patches where the pad ran dry.
          const patch = smooth(0.2, 0.45, fbm(blotch, x / 11, y / 11, 2)) * light * 0.9;
          const ink = clamp((0.62 + 0.38 * P) * (1 - 0.94 * voids) * (1 - patch) + 0.32 * rim[i] * P);
          out.data[i * 4 + 3] = Math.round(255 * A2[i] * ink);
        }
      }
      context.putImageData(out, 0, 0);
      resolve(canvas.toDataURL('image/png'));
    };
    image.src = proof;
  });
}

/** How hard each stamp was pressed: varied, so the set reads as five impressions, not one. */
function pressureFor(index) {
  const presets = [
    { base: 0.9, wash: 0.16, lean: 0.34, scale: 1 },
    { base: 0.84, wash: 0.2, lean: 0.42, scale: 1.1 },
    { base: 0.93, wash: 0.12, lean: 0.28, scale: 0.9 },
    { base: 0.86, wash: 0.18, lean: 0.4, scale: 1.05 },
    { base: 0.91, wash: 0.14, lean: 0.36, scale: 1 },
  ];
  return presets[index % presets.length];
}

/** The pen stroke: a filled outline around a slightly curved line, tapered at both ends. */
function strikeSvg() {
  const width = 240;
  const height = 32;
  const points = [];
  const steps = 48;
  // A quick left-to-right stroke through the middle of the word: it rises a
  // little, bows, and hooks at the end. Thin enough that the word reads under it.
  const curve = (t) => ({
    x: 4 + t * (width - 10),
    y: 18.5 - t * 4 + Math.sin(t * Math.PI) * -1.6 + (t > 0.92 ? (t - 0.92) * 18 : 0),
  });
  const thickness = (t) => 1.1 + 3.3 * Math.sin(Math.min(1, t * 1.1) * Math.PI) ** 0.6;
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const p = curve(t);
    const q = curve(Math.min(1, t + 0.001));
    const r = curve(Math.max(0, t - 0.001));
    const dx = q.x - r.x;
    const dy = q.y - r.y;
    const length = Math.hypot(dx, dy) || 1;
    points.push({ x: p.x, y: p.y, nx: -dy / length, ny: dx / length, w: thickness(t) / 2 });
  }
  const top = points.map((p) => `${(p.x + p.nx * p.w).toFixed(2)} ${(p.y + p.ny * p.w).toFixed(2)}`);
  const bottom = points.reverse().map((p) => `${(p.x - p.nx * p.w).toFixed(2)} ${(p.y - p.ny * p.w).toFixed(2)}`);
  const d = `M${top[0]} L${top.slice(1).join(' L')} L${bottom.join(' L')} Z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none"><path fill="#000" d="${d}"/></svg>\n`;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const work = await mkdtemp(path.join(os.tmpdir(), 'bo-stamps-'));
  try {
    const page = path.join(work, 'proofs.html');
    await writeFile(page, proofPage());

    const { chromium } = loadPlaywright();
    const browser = await chromium.launch();
    try {
      const tab = await browser.newPage({ viewport: { width: 1400, height: 1600 }, deviceScaleFactor: PROOF_SCALE });
      await tab.goto(pathToFileURL(page).href, { waitUntil: 'load' });
      await tab.evaluate(() => document.fonts.ready);
      const stamps = [
        ...VERDICT_STAMPS.map(([id], index) => ({ file: `verdict-${id}`, selector: `#verdict-${id}`, seed: 101 + index * 13, pressure: pressureFor(index) })),
        ...SEVERITY_STAMPS.map(([id], index) => ({ file: `sev-${id}`, selector: `#sev-${id}`, seed: 307 + index * 17, pressure: pressureFor(index + 2) })),
      ];
      for (const stamp of stamps) {
        const shot = await tab.locator(stamp.selector).screenshot({ omitBackground: true });
        const proof = `data:image/png;base64,${shot.toString('base64')}`;
        const inked = await tab.evaluate(press, { proof, seed: stamp.seed, pressure: stamp.pressure });
        const png = path.join(work, `${stamp.file}.png`);
        await writeFile(png, Buffer.from(inked.split(',')[1], 'base64'));
        const webp = path.join(OUT_DIR, `${stamp.file}.webp`);
        execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', png, '-c:v', 'libwebp', '-pix_fmt', 'yuva420p', '-lossless', '0', '-q:v', '82', '-compression_level', '6', webp]);
        console.log(`wrote    web/public/stamps/${stamp.file}.webp`);
      }
    } finally {
      await browser.close();
    }

    await writeFile(path.join(OUT_DIR, 'strike.svg'), strikeSvg());
    console.log('wrote    web/public/stamps/strike.svg');
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
