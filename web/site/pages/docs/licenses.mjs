// /licenses — the product's own licence and the third-party notices that apply.
//
// Built from the files that decide the answer, read when the site is generated:
//   LICENSE                 the product licence
//   web/package-lock.json   packages bundled into the Worker
//   mcp/package-lock.json   packages the MCP server depends on
//
// The pages a browser loads contain no third-party code: no framework, no
// font files, no icon set, no analytics. That is stated once, below.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { chip, codeBlock, html, inline } from '../../components.mjs';
import { SITE, breadcrumbsLd } from '../../layout.mjs';
import { DOCS_STYLES, UPDATED, docPage, ext } from './_shared.mjs';

const PATH = '/licenses';
const ROOT = new URL('../../../../', import.meta.url);
const DATA_SOURCE = 'https://github.com/holistis/bug-bounty-intelligence-mcp/blob/main/vulnerability-acceptance-rates.json';

const readText = (relative) => readFileSync(new URL(relative, ROOT), 'utf8').replace(/\r\n?/g, '\n').trim();

/** Join hard-wrapped lines so each paragraph flows to the width of the screen. */
const unwrap = (text) =>
  text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\s*\n\s*/g, ' '))
    .join('\n\n');

/**
 * Production packages in an npm lockfile (v2 or v3), grouped by licence.
 * Returns { direct: string[], groups: [{ licence, packages: [{ name, version }] }], total }.
 */
function lockfilePackages(relative) {
  const file = new URL(relative, ROOT);
  if (!existsSync(fileURLToPath(file))) return null;

  const lock = JSON.parse(readFileSync(file, 'utf8'));
  const entries = Object.entries(lock.packages ?? {}).filter(([location, entry]) => location && !entry.dev && !entry.devOptional);
  // The same package at the same version can sit under several parents. List it once.
  const seen = new Set();
  const packages = [];
  for (const [location, entry] of entries) {
    const name = location.replace(/^.*node_modules\//, '');
    const key = `${name}@${entry.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    packages.push({ name, version: entry.version, licence: entry.license ?? 'See package' });
  }

  const byLicence = new Map();
  for (const item of packages) {
    if (!byLicence.has(item.licence)) byLicence.set(item.licence, []);
    byLicence.get(item.licence).push(item);
  }
  const groups = [...byLicence.entries()]
    .map(([licence, list]) => ({ licence, packages: list.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version)) }))
    .sort((a, b) => b.packages.length - a.packages.length || a.licence.localeCompare(b.licence));

  return { direct: Object.keys(lock.packages?.['']?.dependencies ?? {}).sort(), groups, total: packages.length };
}

function packageGroups(result) {
  return result.groups.map(
    (group) => html`<div class="pkg-group">
<h3 class="pkg-group__title">${group.licence}${chip(`${group.packages.length} ${group.packages.length === 1 ? 'package' : 'packages'}`)}</h3>
<ul class="pkg-list">${group.packages.map((item) => html`<li>${item.name} <span class="pkg-list__version">${item.version}</span></li>`)}</ul>
</div>`,
  );
}

const codeList = (names) => names.map((name, index) => html`${index > 0 && (index === names.length - 1 ? ' and ' : ', ')}<code>${name}</code>`);

const worker = lockfilePackages('web/package-lock.json');
const mcp = lockfilePackages('mcp/package-lock.json');

const product = html`
<div class="prose">
<p>The site, the review engine with its three core profiles, the free tools, the MCP server and the command-line kit are released under the MIT licence. ${ext('The source is on GitHub', SITE.source)}. The gauntlet stages and the panel cross-examination run on the hosted service.</p>
</div>
${codeBlock({ code: unwrap(readText('LICENSE')), name: 'LICENSE', numbers: false, wrap: true, copy: true })}`;

const browser = html`
<p>Every script, stylesheet and icon this site sends to your browser was written for it. Nothing in the browser is bundled from a third party: no framework, no font files, no icon set and no analytics library. Text is set in the fonts already on your device.</p>`;

const workerSection =
  worker &&
  html`
<div class="prose">
<p>The API runs on a Cloudflare Worker. It is built with ${codeList(worker.direct)}, which bring in ${worker.total} packages in all. They run on the server and are not sent to your browser.</p>
</div>
${packageGroups(worker)}`;

// The MCP server is written without runtime dependencies. If it ever gains one, the list comes back by itself.
const mcpHasPackages = Boolean(mcp) && mcp.total > 0;

const mcpSection =
  mcp &&
  (mcpHasPackages
    ? html`
<div class="prose">
<p>The <a href="/mcp">MCP server</a> depends on ${codeList(mcp.direct)}, ${mcp.total} packages in all once their own dependencies are counted.</p>
</div>
${packageGroups(mcp)}`
    : html`
<div class="prose">
<p>The <a href="/mcp">MCP server</a> has no runtime dependencies. The package holds its own code and a copy of the review engine with the three core profiles, all under the MIT licence above. It needs Node 22 or later and installs nothing else.</p>
</div>`);

const data = html`
<p>${inline('The acceptance-rate figures in the `pattern-stats` command and the acceptance rates tool come from a snapshot of public Sherlock contest judging.')} The snapshot is published under CC0, which asks for no attribution. ${ext('This is the source file', DATA_SOURCE)}.</p>`;

const notices = html`
<p>Each package above carries its full licence text and copyright notice in its own distribution, and those texts apply as written. To report a missing or wrong notice, email <a href="mailto:${SITE.support}">${SITE.support}</a>.</p>`;

const sections = [
  { id: 'bounty-operator', title: 'Bounty Operator: MIT', label: 'Bounty Operator', body: product, prose: false },
  { id: 'browser', title: 'What your browser loads', label: 'In the browser', body: browser },
  worker && { id: 'worker', title: 'Worker dependencies', label: 'Worker', body: workerSection, prose: false },
  mcp && { id: 'mcp-server', title: mcpHasPackages ? 'MCP server dependencies' : 'MCP server: no dependencies', label: 'MCP server', body: mcpSection, prose: false },
  { id: 'data', title: 'Data', body: data },
  { id: 'notices', title: 'Notices', body: notices },
].filter(Boolean);

const body = docPage({
  head: {
    crumbs: [{ label: 'Bounty Operator', href: '/' }, { label: 'Licences' }],
    title: 'Open-source licences and third-party notices',
    lede: `The open core of Bounty Operator is MIT-licensed. The pages your browser loads contain no third-party code. ${
      mcpHasPackages ? 'The Worker and the MCP server use the open-source packages listed here.' : 'The Worker uses the open-source packages listed here. The MCP server has no dependencies.'
    }`,
  },
  sections,
});

export default {
  path: PATH,
  title: 'Open-source licences and third-party notices | Bounty Operator',
  label: 'Licences',
  description: mcpHasPackages
    ? 'The MIT licence Bounty Operator is released under, and the open-source packages its Worker and MCP server depend on, grouped by licence.'
    : 'The MIT licence Bounty Operator is released under, and the open-source packages its Worker depends on, grouped by licence.',
  styles: DOCS_STYLES,
  jsonld: [breadcrumbsLd([{ name: 'Licences', path: PATH }])],
  lastmod: UPDATED,
  body,
};
