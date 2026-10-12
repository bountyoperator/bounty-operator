#!/usr/bin/env node
// Responsive encodings of the approved portrait; no crop or visual changes.
// node scripts/prepare-spec-media.mjs /absolute/path/to/spec-mascot.png
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const sharp = createRequire(new URL('../web/package.json', import.meta.url))('sharp');
const source = process.argv[2];
if (!source) throw new Error('Pass the original spec-mascot.png path.');
const directory = fileURLToPath(new URL('../web/public/brand/', import.meta.url));
await mkdir(directory, { recursive: true });
for (const width of [640, 960]) {
  await sharp(source).resize(width, width, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 84, effort: 6 }).toFile(`${directory}/spec-${width}.webp`);
}
console.log('Wrote the 640px and 960px Spec portrait encodings.');
