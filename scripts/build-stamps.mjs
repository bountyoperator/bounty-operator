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
// pressed with real ink, taken from scans of real 1980s rubber-stamp imprints
// (CC0, scripts/ink/SOURCES.md): the voids, mottle and fibre come from real
// solid ink quilted over the box, and the pressure across the face is that of
// one real framed impression, so strokes thin where it was pressed lightly.
// No noise function is involved. Every stamp has its own seed and its own
// impression's pressure, so no two share a texture, and the same seed gives
// the same file. The files are black ink on transparent and are used as CSS
// masks: the page shows the chip colour through them, so day and night share
// one asset.
//
// A maintainer tool, like scripts/build-icons.mjs: it rasterises with a global
// Playwright (npm i -g playwright) and encodes WebP with ffmpeg. Re-run it when
// a label, the stamp geometry or the font changes. scripts/extract-ink.py
// remakes scripts/ink/ from the scans.

import { execFileSync, execSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'web', 'public');
const OUT_DIR = path.join(PUBLIC_DIR, 'stamps');
const INK_DIR = path.join(ROOT, 'scripts', 'ink');

// The layout of scripts/ink/, as scripts/extract-ink.py writes it.
const INK = Object.freeze({ patchSize: 16, patchColumns: 32, patchCount: 384, pressureW: 192, pressureH: 64, pressureRows: 12 });

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
 * Press one crisp proof with real ink. Runs in the page. The proof comes in
 * as a PNG data URL and the impression goes out as one.
 *
 *   patches    scripts/ink/patches.png: real solid ink from the CC0 scans,
 *              16 x 16 patches, white is full ink
 *   pressure   scripts/ink/pressure.png: twelve real impressions' pressure
 *              across the face, 192 x 64 rows
 *   row        which impression's pressure this stamp is pressed with
 *   seed       which patches, in which order and turn, cover this stamp
 *
 * The ink is quilted from the real patches (each next patch picked to match
 * the ink it overlaps, joined along the seam where they differ least), then
 * laid on the proof: thinned where that real impression was pressed lightly,
 * bitten wherever the real ink has a void.
 */
async function press({ proof, patches, pressure, row, seed, patchSize, patchColumns, patchCount, pressureW, pressureH }) {
  const load = (src) =>
    new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = src;
    });
  const pixels = (image) => {
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    return context.getImageData(0, 0, image.width, image.height);
  };
  const [proofImage, patchImage, pressureImage] = await Promise.all([load(proof), load(patches), load(pressure)]);
  const proofData = pixels(proofImage);
  const W = proofData.width;
  const H = proofData.height;
  const shape = new Float32Array(W * H);
  for (let i = 0; i < W * H; i += 1) shape[i] = proofData.data[i * 4 + 3] / 255;

  const atlasData = pixels(patchImage);
  const atlasW = atlasData.width;
  const atlas = new Float32Array(atlasData.width * atlasData.height);
  for (let i = 0; i < atlas.length; i += 1) atlas[i] = atlasData.data[i * 4] / 255;

  const pressureData = pixels(pressureImage);
  const field = new Float32Array(pressureW * pressureH);
  for (let y = 0; y < pressureH; y += 1) {
    for (let x = 0; x < pressureW; x += 1) {
      field[y * pressureW + x] = pressureData.data[((row * pressureH + y) * pressureData.width + x) * 4] / 255;
    }
  }

  // A seeded choice, so the same stamp always gets the same impression.
  let state = seed >>> 0;
  const rand = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // 1. Quilt the real ink over the stamp's box.
  const P = patchSize;
  const O = 4;
  const step = P - O;
  const cols = Math.ceil((W - O) / step);
  const rows = Math.ceil((H - O) / step);
  const TW = cols * step + O;
  const TH = rows * step + O;
  const ink = new Float32Array(TW * TH);
  const patchPixel = (index, turn, x, y) => {
    let u = x;
    let v = y;
    if (turn & 4) [u, v] = [v, u];
    if (turn & 1) u = P - 1 - u;
    if (turn & 2) v = P - 1 - v;
    const pr = Math.floor(index / patchColumns);
    const pc = index % patchColumns;
    return atlas[(pr * P + v) * atlasW + pc * P + u];
  };
  const candidates = 48;
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const ox = c * step;
      const oy = r * step;
      let best = null;
      let bestError = Infinity;
      for (let k = 0; k < candidates; k += 1) {
        const index = Math.floor(rand() * patchCount);
        const turn = Math.floor(rand() * 8);
        let error = 0;
        if (c > 0) {
          for (let y = 0; y < P; y += 1) {
            for (let x = 0; x < O; x += 1) {
              const d = patchPixel(index, turn, x, y) - ink[(oy + y) * TW + ox + x];
              error += d * d;
            }
          }
        }
        if (r > 0) {
          for (let y = 0; y < O; y += 1) {
            for (let x = c > 0 ? O : 0; x < P; x += 1) {
              const d = patchPixel(index, turn, x, y) - ink[(oy + y) * TW + ox + x];
              error += d * d;
            }
          }
        }
        if (error < bestError) {
          bestError = error;
          best = { index, turn };
        }
      }
      // Join along the seam of least difference: old ink before it, the new patch after.
      const keepOld = new Uint8Array(P * P);
      if (c > 0) {
        const cost = new Float32Array(P * O);
        for (let y = 0; y < P; y += 1) {
          for (let x = 0; x < O; x += 1) {
            const d = patchPixel(best.index, best.turn, x, y) - ink[(oy + y) * TW + ox + x];
            cost[y * O + x] = d * d;
          }
        }
        for (let y = 1; y < P; y += 1) {
          for (let x = 0; x < O; x += 1) {
            let m = cost[(y - 1) * O + x];
            if (x > 0) m = Math.min(m, cost[(y - 1) * O + x - 1]);
            if (x < O - 1) m = Math.min(m, cost[(y - 1) * O + x + 1]);
            cost[y * O + x] += m;
          }
        }
        let x = 0;
        for (let i = 1; i < O; i += 1) if (cost[(P - 1) * O + i] < cost[(P - 1) * O + x]) x = i;
        for (let y = P - 1; y >= 0; y -= 1) {
          for (let i = 0; i < x; i += 1) keepOld[y * P + i] = 1;
          if (y > 0) {
            let next = x;
            for (const dx of [-1, 1]) {
              const nx = x + dx;
              if (nx >= 0 && nx < O && cost[(y - 1) * O + nx] < cost[(y - 1) * O + next]) next = nx;
            }
            x = next;
          }
        }
      }
      if (r > 0) {
        const cost = new Float32Array(O * P);
        for (let y = 0; y < O; y += 1) {
          for (let x = 0; x < P; x += 1) {
            const d = patchPixel(best.index, best.turn, x, y) - ink[(oy + y) * TW + ox + x];
            cost[x * O + y] = d * d;
          }
        }
        for (let x = 1; x < P; x += 1) {
          for (let y = 0; y < O; y += 1) {
            let m = cost[(x - 1) * O + y];
            if (y > 0) m = Math.min(m, cost[(x - 1) * O + y - 1]);
            if (y < O - 1) m = Math.min(m, cost[(x - 1) * O + y + 1]);
            cost[x * O + y] += m;
          }
        }
        let y = 0;
        for (let i = 1; i < O; i += 1) if (cost[(P - 1) * O + i] < cost[(P - 1) * O + y]) y = i;
        for (let x = P - 1; x >= 0; x -= 1) {
          for (let i = 0; i < y; i += 1) keepOld[i * P + x] = 1;
          if (x > 0) {
            let next = y;
            for (const dy of [-1, 1]) {
              const ny = y + dy;
              if (ny >= 0 && ny < O && cost[(x - 1) * O + ny] < cost[(x - 1) * O + next]) next = ny;
            }
            y = next;
          }
        }
      }
      for (let y = 0; y < P; y += 1) {
        for (let x = 0; x < P; x += 1) {
          if (!keepOld[y * P + x]) ink[(oy + y) * TW + ox + x] = patchPixel(best.index, best.turn, x, y);
        }
      }
    }
  }

  // 2. The real pressure across the face, stretched to this stamp.
  const pressureAt = (x, y) => {
    const fx = (x / (W - 1)) * (pressureW - 1);
    const fy = (y / (H - 1)) * (pressureH - 1);
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(pressureW - 1, x0 + 1);
    const y1 = Math.min(pressureH - 1, y0 + 1);
    const tx = fx - x0;
    const ty = fy - y0;
    const top = field[y0 * pressureW + x0] * (1 - tx) + field[y0 * pressureW + x1] * tx;
    const bottom = field[y1 * pressureW + x0] * (1 - tx) + field[y1 * pressureW + x1] * tx;
    return top * (1 - ty) + bottom * ty;
  };

  // 3. Lay the ink on the proof. Real rubber leaves a soft edge, about two
  // pixels of spread at this scale (measured on the scans), and the edge moves
  // with the ink: where the real impression was light the stroke thins, where
  // the real ink is heavy it spreads a little, and wherever the real ink has a
  // void, the void bites.
  const box = (source, width, height, stride, radius) => {
    const result = new Float32Array(width * height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let sum = 0;
        let n = 0;
        for (let dy = -radius; dy <= radius; dy += 1) {
          const yy = y + dy;
          if (yy < 0 || yy >= height) continue;
          for (let dx = -radius; dx <= radius; dx += 1) {
            const xx = x + dx;
            if (xx < 0 || xx >= width) continue;
            sum += source[yy * stride + xx];
            n += 1;
          }
        }
        result[y * width + x] = sum / n;
      }
    }
    return result;
  };
  const soft = box(shape, W, H, W, 2);
  const local = box(ink, W, H, TW, 2);
  const smooth = (a, b, v) => {
    const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  const out = new ImageData(W, H);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = y * W + x;
      if (soft[i] <= 0.002) continue;
      const p = pressureAt(x, y);
      const t = Math.min(0.74, Math.max(0.28, 0.5 + 0.6 * (0.84 - p) + 0.3 * (0.82 - local[i])));
      const edge = smooth(t - 0.2, t + 0.2, soft[i]);
      const real = ink[y * TW + x];
      const value = edge * Math.min(1, Math.max(0, Math.pow(real, 0.8) * (0.38 + 0.62 * Math.pow(p, 1.3)) * 1.12));
      out.data[i * 4 + 3] = Math.round(255 * value);
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  canvas.getContext('2d').putImageData(out, 0, 0);
  return canvas.toDataURL('image/png');
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
      const dataUrl = async (file) => `data:image/png;base64,${(await readFile(path.join(INK_DIR, file))).toString('base64')}`;
      const patches = await dataUrl('patches.png');
      const pressure = await dataUrl('pressure.png');
      const stamps = [
        ...VERDICT_STAMPS.map(([id], index) => ({ file: `verdict-${id}`, selector: `#verdict-${id}`, seed: 101 + index * 13, row: index })),
        ...SEVERITY_STAMPS.map(([id], index) => ({ file: `sev-${id}`, selector: `#sev-${id}`, seed: 307 + index * 17, row: VERDICT_STAMPS.length + index })),
      ];
      for (const stamp of stamps) {
        const shot = await tab.locator(stamp.selector).screenshot({ omitBackground: true });
        const proof = `data:image/png;base64,${shot.toString('base64')}`;
        const inked = await tab.evaluate(press, { proof, patches, pressure, row: stamp.row % INK.pressureRows, seed: stamp.seed, ...INK });
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
