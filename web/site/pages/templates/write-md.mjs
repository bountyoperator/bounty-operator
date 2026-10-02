// Writes web/public/templates/<platform>.md from data.mjs.
//
//   node web/site/pages/templates/write-md.mjs
//
// Run it after changing a template in data.mjs. web/tests/templates.test.mjs
// fails when a file on disk differs from what this would write. The module has
// no default export and does nothing when the site generator imports it.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PLATFORMS } from './data.mjs';
import { toMarkdown } from './shared.mjs';

const here = fileURLToPath(import.meta.url);
export const TEMPLATE_DIR = path.resolve(path.dirname(here), '..', '..', '..', 'public', 'templates');

export async function writeTemplates(directory = TEMPLATE_DIR) {
  await mkdir(directory, { recursive: true });
  const written = [];
  for (const platform of PLATFORMS) {
    const file = path.join(directory, platform.file);
    await writeFile(file, toMarkdown(platform));
    written.push(file);
  }
  return written;
}

if (process.argv[1] && path.resolve(process.argv[1]) === here) {
  for (const file of await writeTemplates()) console.log(`wrote    ${path.relative(process.cwd(), file)}`);
}
