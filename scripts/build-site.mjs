#!/usr/bin/env node
// Static page generator for bountyoperator.com.
//
//   node scripts/build-site.mjs           build web/public/*.html and sitemap.xml
//   node scripts/build-site.mjs --dev     also build pages marked dev: true; unresolved links only warn
//   node scripts/build-site.mjs --check   write nothing; exit 1 if the output on disk is out of date
//
// Every module under web/site/pages/** that default-exports a page (or an array
// of pages) becomes one HTML file. The generator refuses to write markup the
// site CSP would block, and it only ever deletes files it wrote itself: the
// list lives in web/site/.generated.json.

import { existsSync, statSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isHtml } from '../web/site/components.mjs';
import { NAV, SITE, renderPage } from '../web/site/layout.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SITE_DIR = path.join(REPO_ROOT, 'web', 'site');
const DEFAULT_PUBLIC_DIR = path.join(REPO_ROOT, 'web', 'public');

const MANIFEST_NAME = '.generated.json';
const MANIFEST_COMMENT = 'Written by scripts/build-site.mjs. Lists generated files so stale ones can be removed. Do not edit.';

const DESCRIPTION_MIN = 50;
const DESCRIPTION_MAX = 160;
const PAGE_PATH = /^\/(?:[a-z0-9_-]+(?:\/[a-z0-9_-]+)*)?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const URL_ATTRIBUTES = ['href', 'src', 'action', 'poster'];

// ---------------------------------------------------------------------------
// Loading page modules
// ---------------------------------------------------------------------------

async function findModules(directory) {
  if (!existsSync(directory)) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const found = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await findModules(full)));
    else if (entry.isFile() && entry.name.endsWith('.mjs')) found.push(full);
  }
  return found;
}

/**
 * Import every page module. A module may default-export one page or an array
 * of pages. Modules without a default export are treated as shared helpers.
 */
export async function loadPages(pagesDir) {
  const pages = [];
  for (const file of await findModules(pagesDir)) {
    const module = await import(pathToFileURL(file).href);
    if (module.default === undefined) continue;
    const source = path.relative(pagesDir, file).split(path.sep).join('/');
    const exported = Array.isArray(module.default) ? module.default : [module.default];
    for (const page of exported) pages.push({ ...page, source });
  }
  return pages;
}

/** '/' -> index.html, '/guide' -> guide.html, '/tools/report-check' -> tools/report-check.html */
export function outputFile(pagePath) {
  return pagePath === '/' ? 'index.html' : `${pagePath.slice(1)}.html`;
}

// ---------------------------------------------------------------------------
// Markup scanning
// ---------------------------------------------------------------------------

const RAW_TEXT_ELEMENTS = new Set(['script', 'style']);

function readAttributes(markup, from) {
  const attributes = new Map();
  let index = from;

  while (index < markup.length) {
    while (/[\s/]/.test(markup[index] ?? '')) index += 1;
    if (index >= markup.length || markup[index] === '>') break;

    const nameStart = index;
    while (index < markup.length && !/[\s=>/]/.test(markup[index])) index += 1;
    const name = markup.slice(nameStart, index).toLowerCase();

    while (/\s/.test(markup[index] ?? '')) index += 1;
    let value = '';
    if (markup[index] === '=') {
      index += 1;
      while (/\s/.test(markup[index] ?? '')) index += 1;
      const quote = markup[index];
      if (quote === '"' || quote === "'") {
        const close = markup.indexOf(quote, index + 1);
        const end = close === -1 ? markup.length : close;
        value = markup.slice(index + 1, end);
        index = end + 1;
      } else {
        const valueStart = index;
        while (index < markup.length && !/[\s>]/.test(markup[index])) index += 1;
        value = markup.slice(valueStart, index);
      }
    }
    if (name) attributes.set(name, value);
  }
  return { attributes, end: index + 1 };
}

/**
 * List the start tags of a document. Text is skipped: the html template escapes
 * every "<" in text, so a literal "<" followed by a letter always opens a tag.
 */
export function scanTags(markup) {
  const tags = [];
  let index = 0;

  while (index < markup.length) {
    const open = markup.indexOf('<', index);
    if (open === -1) break;

    if (markup.startsWith('<!--', open)) {
      const close = markup.indexOf('-->', open + 4);
      index = close === -1 ? markup.length : close + 3;
      continue;
    }
    const nameMatch = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(markup.slice(open + 1, open + 64));
    if (!nameMatch) {
      // Closing tag, doctype, or a stray character.
      index = open + 1;
      continue;
    }

    const name = nameMatch[0].toLowerCase();
    const { attributes, end } = readAttributes(markup, open + 1 + nameMatch[0].length);
    const tag = { name, attributes, content: null };
    index = end;

    if (RAW_TEXT_ELEMENTS.has(name)) {
      const closeAt = markup.toLowerCase().indexOf(`</${name}`, end);
      const contentEnd = closeAt === -1 ? markup.length : closeAt;
      tag.content = markup.slice(end, contentEnd);
      index = contentEnd;
    }
    tags.push(tag);
  }
  return tags;
}

function decodeEntities(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validatePageFields(page) {
  const errors = [];
  const fail = (message) => errors.push(message);

  if (typeof page.path !== 'string' || !PAGE_PATH.test(page.path)) {
    fail(`path must be extensionless, lower-case and start with "/" (got ${JSON.stringify(page.path)})`);
  }
  if (typeof page.title !== 'string' || !page.title.trim()) {
    fail('title is required');
  }
  if (typeof page.description !== 'string') {
    fail('description is required');
  } else if (page.description.length < DESCRIPTION_MIN || page.description.length > DESCRIPTION_MAX) {
    fail(`description must be ${DESCRIPTION_MIN}-${DESCRIPTION_MAX} characters (it is ${page.description.length})`);
  }
  if (!isHtml(page.body)) {
    fail('body must be the result of the html`` template from web/site/components.mjs');
  }
  if (page.overlays !== undefined && !isHtml(page.overlays)) {
    fail('overlays must be the result of the html`` template');
  }
  if (page.nav !== undefined && !NAV.some((item) => item.id === page.nav)) {
    fail(`nav must be one of ${NAV.map((item) => item.id).join(', ')} (got ${JSON.stringify(page.nav)})`);
  }
  for (const key of ['styles', 'scripts', 'preload']) {
    const list = page[key];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.some((entry) => typeof entry !== 'string' || !entry.startsWith('/'))) {
      fail(`${key} must be an array of root-relative paths such as "/css/home.css"`);
    }
  }
  if (page.jsonld !== undefined && (!Array.isArray(page.jsonld) || page.jsonld.some((entry) => !entry || typeof entry !== 'object'))) {
    fail('jsonld must be an array of objects');
  }
  if (page.lastmod !== undefined && !ISO_DATE.test(page.lastmod)) {
    fail(`lastmod must be YYYY-MM-DD (got ${JSON.stringify(page.lastmod)})`);
  }
  return errors;
}

function isExternal(url) {
  return /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//');
}

/**
 * Check one rendered document against the CSP and the linking rules.
 * `resolves(pathname)` answers whether an internal path exists.
 */
export function validateMarkup(markup, resolves) {
  const errors = [];
  const warnings = [];
  const unresolved = [];
  const tags = scanTags(markup);
  const ids = new Map();

  for (const tag of tags) {
    const { name, attributes } = tag;

    if (name === 'style') errors.push('inline <style> element (style-src is \'self\'; put the rules in a stylesheet)');
    if (name === 'script') {
      const type = (attributes.get('type') ?? '').toLowerCase();
      if (!attributes.has('src')) {
        if (type !== 'application/ld+json') {
          errors.push('inline <script> (script-src is \'self\'; only application/ld+json blocks may be inline)');
        } else {
          try {
            JSON.parse(tag.content);
          } catch (error) {
            errors.push(`JSON-LD block does not parse: ${error.message}`);
          }
        }
      } else if (isExternal(attributes.get('src'))) {
        errors.push(`external script ${attributes.get('src')} (script-src is 'self')`);
      }
    }
    if (name === 'link' && /\bstylesheet\b/i.test(attributes.get('rel') ?? '') && isExternal(attributes.get('href') ?? '')) {
      errors.push(`external stylesheet ${attributes.get('href')} (style-src is 'self')`);
    }
    if (name === 'img') {
      if (!attributes.has('alt')) errors.push(`<img src="${attributes.get('src') ?? ''}"> has no alt attribute`);
      const source = attributes.get('src') ?? '';
      if (isExternal(source) && !source.startsWith('data:')) errors.push(`external image ${source} (img-src is 'self' data:)`);
    }

    for (const [attribute, value] of attributes) {
      if (attribute === 'style') errors.push(`style attribute on <${name}> (use a class)`);
      if (/^on[a-z]+$/.test(attribute)) errors.push(`inline event handler ${attribute} on <${name}>`);
      if (attribute === 'id') ids.set(value, (ids.get(value) ?? 0) + 1);
    }

    for (const attribute of URL_ATTRIBUTES) {
      if (!attributes.has(attribute)) continue;
      const url = decodeEntities(attributes.get(attribute)).trim();
      if (/^javascript:/i.test(url)) {
        errors.push(`javascript: URL in ${attribute} on <${name}>`);
        continue;
      }
      if (!url || isExternal(url)) continue;
      if (url.startsWith('#')) continue;
      if (!url.startsWith('/')) {
        errors.push(`relative link "${url}" on <${name}> (use a root-relative path such as "/guide")`);
        continue;
      }

      const pathname = url.split('#')[0].split('?')[0];
      if (/\.html?$/i.test(pathname)) {
        errors.push(`internal link "${url}" ends in .html (URLs are extensionless)`);
        continue;
      }
      if (pathname.length > 1 && pathname.endsWith('/')) {
        errors.push(`internal link "${url}" has a trailing slash (it would redirect)`);
        continue;
      }
      if (!resolves(pathname)) unresolved.push(url);
    }
  }

  for (const [id, count] of ids) {
    if (count > 1) errors.push(`id "${id}" is used ${count} times`);
  }
  for (const tag of tags) {
    const href = tag.attributes.get('href');
    if (tag.name === 'a' && href?.startsWith('#') && href.length > 1 && !ids.has(decodeEntities(href.slice(1)))) {
      warnings.push(`link "${href}" has no matching id on the page`);
    }
  }
  const headings = tags.filter((tag) => tag.name === 'h1').length;
  if (headings !== 1) warnings.push(`page has ${headings} <h1> elements (expected one)`);

  return { errors, warnings, unresolved: [...new Set(unresolved)] };
}

// ---------------------------------------------------------------------------
// Module preloads
// ---------------------------------------------------------------------------

const STATIC_IMPORT = /(?:^|[\s;}])(?:import|export)\s+(?:[^'"()]*?\bfrom\s*)?['"]([^'"\n]+)['"]/g;

/**
 * Follow the static import graph of the page's entry modules and return the
 * dependencies as root-relative URLs, so the browser fetches them in parallel
 * instead of discovering them one level at a time.
 */
export async function modulePreloads(entries, publicDir) {
  const seen = new Set(entries);
  const queue = [...entries];
  const dependencies = [];

  while (queue.length) {
    const current = queue.shift();
    const file = path.join(publicDir, current);
    if (!existsSync(file)) continue;

    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(STATIC_IMPORT)) {
      const specifier = match[1];
      if (!/^(?:\.{1,2}\/|\/)/.test(specifier)) continue;
      const resolved = path.posix.normalize(specifier.startsWith('/') ? specifier : path.posix.join(path.posix.dirname(current), specifier));
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      dependencies.push(resolved);
      queue.push(resolved);
    }
  }
  return dependencies;
}

// ---------------------------------------------------------------------------
// Sitemap
// ---------------------------------------------------------------------------

function inSitemap(page) {
  return !page.dev && page.sitemap !== false && !/noindex/i.test(page.robots ?? '');
}

export function sitemapXml(pages) {
  const listed = pages.filter(inSitemap).sort((a, b) => a.path.localeCompare(b.path));
  const urls = listed.map((page) => {
    const lastmod = page.lastmod ? `<lastmod>${page.lastmod}</lastmod>` : '';
    return `  <url><loc>${SITE.origin}${page.path}</loc>${lastmod}</url>`;
  });
  return ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">', ...urls, '</urlset>', ''].join('\n');
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

async function readManifest(siteDir) {
  try {
    const manifest = JSON.parse(await readFile(path.join(siteDir, MANIFEST_NAME), 'utf8'));
    return Array.isArray(manifest.files) ? manifest.files : [];
  } catch {
    return [];
  }
}

function manifestJson(files) {
  return `${JSON.stringify({ comment: MANIFEST_COMMENT, files }, null, 2)}\n`;
}

async function readText(file) {
  try {
    return (await readFile(file, 'utf8')).replace(/\r\n/g, '\n');
  } catch {
    return null;
  }
}

/**
 * Render every page and validate it. Nothing is written.
 * Returns { outputs: Map<relative file, content>, errors, warnings, pages }.
 */
export async function renderSite({ siteDir = DEFAULT_SITE_DIR, publicDir = DEFAULT_PUBLIC_DIR, dev = false } = {}) {
  const errors = [];
  const warnings = [];
  const all = await loadPages(path.join(siteDir, 'pages'));
  const pages = all.filter((page) => dev || !page.dev);

  const byPath = new Map();
  const byTitle = new Map();
  for (const page of pages) {
    for (const message of validatePageFields(page)) errors.push(`${page.source}: ${message}`);
    if (byPath.has(page.path)) errors.push(`${page.source}: path ${page.path} is already used by ${byPath.get(page.path)}`);
    else byPath.set(page.path, page.source);
    if (byTitle.has(page.title)) errors.push(`${page.source}: title "${page.title}" is already used by ${byTitle.get(page.title)}`);
    else byTitle.set(page.title, page.source);
  }
  if (errors.length) return { outputs: new Map(), errors, warnings, pages };

  const pagePaths = new Set(pages.map((page) => page.path));
  const resolves = (pathname) => {
    if (pagePaths.has(pathname) || pathname.startsWith('/api/')) return true;
    // The .html tests cover hand-written pages that have not moved to a page module yet.
    if (pathname === '/') return isFile(path.join(publicDir, 'index.html'));
    const file = path.join(publicDir, pathname);
    return isFile(file) || isFile(`${file}.html`);
  };

  const preloadCache = new Map();
  for (const page of pages) {
    const auto = page.preload === false ? [] : await modulePreloads(page.scripts ?? [], publicDir);
    const extra = Array.isArray(page.preload) ? page.preload : [];
    preloadCache.set(page, [...new Set([...auto, ...extra])]);
  }
  const site = {
    pages,
    has: resolves,
    preloadsFor: (page) => preloadCache.get(page) ?? [],
  };

  const outputs = new Map();
  const unresolved = new Map();
  for (const page of pages) {
    const markup = renderPage(page, site);
    const result = validateMarkup(markup, resolves);
    for (const message of result.errors) errors.push(`${page.source}: ${message}`);
    for (const message of result.warnings) warnings.push(`${page.source}: ${message}`);
    for (const url of result.unresolved) {
      if (!unresolved.has(url)) unresolved.set(url, []);
      unresolved.get(url).push(page.source);
    }
    outputs.set(outputFile(page.path), markup);
  }
  outputs.set('sitemap.xml', sitemapXml(pages));

  // Header and footer links repeat on every page, so each missing target is reported once.
  for (const [url, sources] of unresolved) {
    const where = sources.length > 3 ? `${sources.slice(0, 3).join(', ')} and ${sources.length - 3} more` : sources.join(', ');
    const message = `internal link "${url}" does not resolve to a page or a file in web/public (${where})`;
    // A dev build runs while other pages are still being written, so a missing target only warns.
    if (dev) warnings.push(message);
    else errors.push(message);
  }

  return { outputs, errors, warnings, pages };
}

/**
 * Build the site, or with `check` compare it to disk without writing.
 * Returns { ok, written, removed, problems, errors, warnings }.
 */
export async function buildSite({ siteDir = DEFAULT_SITE_DIR, publicDir = DEFAULT_PUBLIC_DIR, dev = false, check = false } = {}) {
  const { outputs, errors, warnings, pages } = await renderSite({ siteDir, publicDir, dev });
  const summary = { ok: false, written: [], removed: [], unchanged: 0, problems: [], errors, warnings, pages: pages.length };
  if (errors.length) return summary;

  const files = [...outputs.keys()].sort();
  const previous = await readManifest(siteDir);
  const stale = previous.filter((file) => !outputs.has(file) && isFile(path.join(publicDir, file)));
  const manifestPath = path.join(siteDir, MANIFEST_NAME);
  const manifest = manifestJson(files);

  if (check) {
    for (const file of files) {
      const onDisk = await readText(path.join(publicDir, file));
      if (onDisk === null) summary.problems.push(`${file} is missing`);
      else if (onDisk !== outputs.get(file)) summary.problems.push(`${file} is out of date`);
    }
    for (const file of stale) summary.problems.push(`${file} is no longer generated (a dev build leaves dev pages behind)`);
    if ((await readText(manifestPath)) !== manifest) summary.problems.push(`${MANIFEST_NAME} is out of date`);
    summary.ok = summary.problems.length === 0;
    return summary;
  }

  for (const file of files) {
    const target = path.join(publicDir, file);
    if ((await readText(target)) === outputs.get(file)) {
      summary.unchanged += 1;
      continue;
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, outputs.get(file));
    summary.written.push(file);
  }
  for (const file of stale) {
    await rm(path.join(publicDir, file));
    summary.removed.push(file);
  }
  if ((await readText(manifestPath)) !== manifest) await writeFile(manifestPath, manifest);

  summary.ok = true;
  return summary;
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

const USAGE = `Usage: node scripts/build-site.mjs [--dev] [--check]

  --dev     include pages marked dev: true; unresolved internal links warn instead of failing
  --check   write nothing; exit 1 if web/public differs from what the page modules produce
`;

async function main(argv) {
  const flags = new Set(argv);
  if (flags.has('--help') || flags.has('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }
  const unknown = argv.filter((flag) => !['--dev', '--check'].includes(flag));
  if (unknown.length) {
    process.stderr.write(`Unknown option: ${unknown.join(' ')}\n\n${USAGE}`);
    return 2;
  }

  const result = await buildSite({ dev: flags.has('--dev'), check: flags.has('--check') });
  for (const message of result.warnings) console.warn(`warning  ${message}`);
  for (const message of result.errors) console.error(`error    ${message}`);
  for (const message of result.problems) console.error(`stale    ${message}`);

  if (result.errors.length) {
    console.error(`\n${result.errors.length} error(s). Nothing was written.`);
    return 1;
  }
  if (flags.has('--check')) {
    console.log(result.ok ? `Site output is up to date (${result.pages} pages).` : '\nRun node scripts/build-site.mjs and commit the result.');
    return result.ok ? 0 : 1;
  }

  for (const file of result.written) console.log(`wrote    ${file}`);
  for (const file of result.removed) console.log(`removed  ${file}`);
  console.log(`${result.pages} pages: ${result.written.length} written, ${result.unchanged} unchanged, ${result.removed.length} removed.`);
  return 0;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
