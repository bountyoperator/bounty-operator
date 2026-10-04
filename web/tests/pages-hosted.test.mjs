// What the pages and the documents say about core and hosted profiles, held
// against what the engine, the Worker and the MCP endpoint do.
//
// Three profiles are core: their method is public, and they run hosted, as an
// exported prompt, or prepared over MCP. Every other profile is hosted: its
// method is added on the server and it runs there only. These tests keep the
// statements about that split, about the data flow of a hosted review and
// about the two plans in step with the code.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { renderSite } from '../../scripts/build-site.mjs';
import { CORE_PROFILE_IDS, GAUNTLET, PROFILES, reviewProfile } from '../public/profiles.mjs';
import { ERROR_CODES, HOSTED_REFUSAL } from '../site/pages/docs/mcp.mjs';
import { handleMcpMessage } from '../src/mcp.ts';
import { FREE_CONCURRENCY, FREE_DAILY_REVIEWS, PAID_CONCURRENCY } from '../src/quota.mjs';

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_DIR = path.resolve(WEB_DIR, '..');

const site = await renderSite();
const pages = new Map([...site.outputs].filter(([file]) => file.endsWith('.html')).map(([file, markup]) => [file.replace(/\\/g, '/'), markup]));

const read = (...parts) => readFile(path.join(REPO_DIR, ...parts), 'utf8');
const [llms, readme, mcpReadme, websiteDoc, changelog] = await Promise.all([
  read('web', 'public', 'llms.txt'),
  read('README.md'),
  read('mcp', 'README.md'),
  read('docs', 'website.md'),
  read('CHANGELOG.md'),
]);
const release = changelog.slice(changelog.indexOf('## 0.7.0'), changelog.indexOf('## 0.6.0'));
// Markdown is hard-wrapped; a sentence is compared on one line.
const flat = (text) => text.replace(/\s+/g, ' ');

/** Visible text of a page body: no scripts, tags removed, entities decoded. */
function textOf(markup) {
  const body = markup.slice(markup.indexOf('<body'));
  return body
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    // An element at the end of a sentence leaves a space before the punctuation.
    .replace(/ ([.,;:])/g, '$1');
}

const text = (file) => textOf(pages.get(file));
const description = (file) => /<meta name="description" content="([^"]*)"/.exec(pages.get(file))[1].replace(/&#39;/g, "'");

const LISTED = PROFILES.filter((profile) => profile.listed);
const CORE = LISTED.filter((profile) => !profile.hosted);
const HOSTED = LISTED.filter((profile) => profile.hosted);
const HOSTED_STAGES = GAUNTLET.filter((id) => reviewProfile(id).hosted);

const rpc = async (method, params) => (await handleMcpMessage({ jsonrpc: '2.0', id: 1, method, params }, {})).body.result;
const callTool = (name, args) => rpc('tools/call', { name, arguments: args });

test('the split the documents describe is the split the engine has', () => {
  assert.deepEqual([...CORE_PROFILE_IDS], ['general', 'solidity', 'report']);
  assert.deepEqual(CORE.map((profile) => profile.name), ['Code security review', 'Solidity review', 'Challenge a draft report']);
  assert.deepEqual(HOSTED.map((profile) => profile.id), ['scope', 'provenance', 'prior-art', 'poc', 'severity', 'triage', 'report-edit', 'scanner']);
  assert.equal(LISTED.length, 11);
  // Seven of the eight stages are hosted; the report stage is the one an agent's own model answers.
  assert.equal(GAUNTLET.length, 8);
  assert.equal(HOSTED_STAGES.length, 7);
  assert.deepEqual(GAUNTLET.filter((id) => !reviewProfile(id).hosted), ['report']);
  // The plans the pages state.
  assert.deepEqual([FREE_DAILY_REVIEWS, FREE_CONCURRENCY, PAID_CONCURRENCY], [1, 1, 4]);
});

test('every document names the three core profiles and lists every hosted one as hosted', () => {
  // The profile table in the README: one row per listed profile, with where it runs.
  const rows = new Map([...readme.matchAll(/^\| \*\*([^*]+)\*\* \|.*\| (Core|Hosted) \|$/gm)].map((match) => [match[1], match[2]]));
  assert.equal(rows.size, LISTED.length);
  for (const profile of LISTED) assert.equal(rows.get(profile.name), profile.hosted ? 'Hosted' : 'Core', profile.name);

  // The MCP README and llms.txt name each id on the right side.
  for (const [name, body] of [['mcp/README.md', mcpReadme], ['llms.txt', llms]]) {
    for (const profile of CORE) assert.ok(body.includes(`\`${profile.id}\``), `${name}: ${profile.id}`);
    for (const profile of HOSTED) assert.ok(body.includes(`\`${profile.id}\``), `${name}: ${profile.id}`);
  }
  const hostedLine = /Every other profile is hosted: ([^.]+)\./.exec(mcpReadme)[1];
  assert.deepEqual([...hostedLine.matchAll(/`([a-z-]+)`/g)].map((match) => match[1]), HOSTED.map((profile) => profile.id));

  // The pricing page lists them by name, read from the engine.
  const pricing = text('pricing.html');
  assert.ok(pricing.includes('Code security review, Solidity review and Challenge a draft report are the three core profiles'));
  for (const profile of HOSTED) assert.ok(pricing.toLowerCase().includes(profile.name.toLowerCase()), profile.name);
  assert.ok(pricing.includes('The other eight run hosted only, in the workbench or through run_review'));
});

test('no page or document offers prompt export, paste-back or prepare_review for a hosted profile', () => {
  const names = PROFILES.filter((profile) => profile.hosted).map((profile) => profile.name.toLowerCase());
  const offer = /\bexport|paste-back|paste the answer back|prepare_review|\bprepared?\b/i;
  const refusal = /refus|hosted_profile|fails with|failed call|no prompt|"error"\s*:/i;

  // Separate blocks are separate claims. Otherwise an unpunctuated Free-plan
  // bullet is joined to an unrelated hosted feature in the Operator card.
  const pageClaims = (markup) => textOf(markup.replace(/<\/(?:p|li|h[1-6]|th|td|summary)>/g, '. '));
  const sources = [...[...pages].map(([file, markup]) => [file, pageClaims(markup)]), ['README.md', flat(readme)], ['mcp/README.md', flat(mcpReadme)], ['llms.txt', llms], ['CHANGELOG.md 0.7.0', flat(release)], ['docs/website.md', flat(websiteDoc)]];
  const hits = [];
  for (const [file, body] of sources) {
    for (const sentence of body.split(/(?<=[.?!])\s+/)) {
      const lower = sentence.toLowerCase();
      if (!offer.test(sentence) || refusal.test(sentence)) continue;
      const named = names.filter((name) => lower.includes(name));
      if (named.length) hits.push(`${file}: "${sentence.slice(0, 160)}"`);
    }
  }
  assert.deepEqual(hits, []);

  // The two hosted landing pages say where the review runs and how an agent reaches it.
  for (const file of ['triager-simulation.html', 'prior-art-check.html']) {
    const body = text(file);
    assert.match(body, /It runs as a hosted review: one per UTC day on Free, unlimited on Operator\. From a coding agent it runs through run_review over MCP, on the same allowance\./, file);
    assert.match(body, /Through our server to the model provider you choose, with your key, for that one request\. The server adds the method of this profile on the way\./, file);
    assert.doesNotMatch(body, /prepare_review/, file);
  }
  // The three core ones offer all three routes.
  for (const file of ['solidity-review.html', 'challenge-report.html', 'code-security-review.html']) {
    const body = text(file);
    assert.match(body, /export the prompt, paste it into your chat app and paste the answer back/, file);
    assert.match(body, /prepare_review hands the same request to the agent’s own model over MCP/, file);
  }
});

test('the MCP page prints the refusal the endpoint returns for a hosted profile', async () => {
  const refused = await callTool('prepare_review', { profile: HOSTED_REFUSAL.profile, files: [{ name: 'draft.md', content: '# Draft\n\nA finding.\n' }] });
  assert.equal(refused.isError, true);
  assert.equal(refused.structuredContent, undefined);
  assert.deepEqual(JSON.parse(refused.content[0].text), HOSTED_REFUSAL);

  // Refused before any file is read: the same answer with no files at all.
  const unread = await callTool('prepare_review', { profile: HOSTED_REFUSAL.profile });
  assert.deepEqual(JSON.parse(unread.content[0].text), HOSTED_REFUSAL);

  const mcp = text('mcp.html');
  for (const value of Object.values(HOSTED_REFUSAL)) assert.ok(mcp.includes(JSON.stringify(value)), value);
  assert.match(mcp, /It is refused before any file is read\./);
  assert.match(mcp, /It is not in the local package or in the public repository, and no tool or prompt returns it\./);

  // The local server words its refusal the way its README prints it.
  const local = await read('mcp', 'src', 'tools.mjs');
  assert.ok(local.includes('`${profile.name} runs on the server. Call run_review with profile "${profile.id}": it needs ${TOKEN_VAR} and the provider key in this server\'s environment.`'));
  const blocks = [...mcpReadme.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => match[1]);
  const example = JSON.parse(blocks.find((block) => block.includes('"hosted_profile"')));
  const shown = reviewProfile(example.profile);
  assert.equal(shown.hosted, true);
  assert.deepEqual(example, {
    profile: shown.id,
    error: `${shown.name} runs on the server. Call run_review with profile "${shown.id}": it needs BOUNTY_OPERATOR_TOKEN and the provider key in this server's environment.`,
    code: 'hosted_profile',
  });
});

test('list_profiles marks every profile the way the documents say', async () => {
  const { profiles } = (await callTool('list_profiles', {})).structuredContent;
  assert.equal(profiles.length, LISTED.length);
  for (const profile of profiles) {
    assert.equal(profile.hosted, reviewProfile(profile.id).hosted, profile.id);
    assert.equal(Object.hasOwn(profile, 'instructions'), false, `${profile.id}: metadata only`);
  }
  const mcp = text('mcp.html');
  assert.match(mcp, /Every profile carries hosted: false for a core profile, true for a hosted one\./);
  assert.match(mcp, /hosted: false is one of the three core profiles/);
  assert.match(mcp, /hosted: true is a hosted profile: the service adds its method when run_review runs and sends it with your files to the provider you named, under your key\./);
  assert.match(mcpReadme, /`list_profiles` returns it with `hosted: true`\./);
  assert.match(llms, /`list_profiles` returns every profile with `hosted`: false for a core profile, true for a hosted one\./);
});

test('the gauntlet over MCP is seven hosted reviews and one stage on the agent’s own model, as stated', async () => {
  const prompt = (await rpc('prompts/get', { name: 'gauntlet' })).messages[0].content.text;
  const stages = [...prompt.matchAll(/^\d+\. ([a-z-]+): [^(]+\((run_review|prepare_review)\)$/gm)].map((match) => [match[1], match[2]]);
  assert.deepEqual(stages.map(([id]) => id), [...GAUNTLET]);
  assert.equal(stages.filter(([, tool]) => tool === 'run_review').length, 7);
  assert.deepEqual(stages.filter(([, tool]) => tool === 'prepare_review').map(([id]) => id), ['report']);

  const mcp = text('mcp.html');
  assert.match(mcp, /gauntlet lists the eight stages with the tool that runs each one\. Seven are hosted and run through run_review\./);
  assert.match(mcp, /The run needs an account token and your provider key, and it uses seven hosted reviews\. Free covers one hosted review per UTC day, so a full run takes Operator\./);
  assert.match(mcp, /A gauntlet run over MCP uses seven hosted reviews, one for every stage but the report stage, so a full run takes Operator\./);
  assert.match(flat(mcpReadme), /A run uses seven hosted reviews\. Free covers one hosted review per UTC day, so a full run takes Operator\./);
  assert.match(llms, /seven hosted through `run_review`, and the report stage through `prepare_review` on the agent's own model/);
  assert.match(flat(release), /The `gauntlet` prompt runs seven stages through `run_review` and the report stage on your agent's own model, so a full run over MCP takes Operator\./);
  assert.match(text('pricing.html'), /The gauntlet from a coding agent over MCP uses seven hosted reviews, so it runs on Operator too\./);
  assert.match(text('gauntlet.html'), /seven hosted reviews through run_review with a connection token, and the report stage on your agent’s own model/);
});

test('the tool counts are five on the remote endpoint and six on the local server, wherever they are stated', async () => {
  const remote = (await rpc('tools/list')).tools.map((tool) => tool.name);
  assert.equal(remote.length, 5);
  const local = [...(await read('mcp', 'src', 'tools.mjs')).matchAll(/^\s{4}name: '([a-z_]+)',$/gm)].map((match) => match[1]);
  assert.equal(local.length, 6);

  assert.match(llms, /The remote endpoint has five tools\./);
  assert.match(llms, /It has six tools: it adds `run_gauntlet_plan`/);
  assert.match(flat(readme), /The remote endpoint has five tools and the local server six\./);
  assert.match(mcpReadme, /Six tools here, five on the remote endpoint: `run_gauntlet_plan` is local only\./);
  assert.equal([...mcpReadme.matchAll(/^\| `([a-z_]+)` \| (?:When|Before|For|After|To) /gm)].length, 6, 'the tool table of the MCP README');
  for (const name of local) for (const [file, body] of [['mcp/README.md', mcpReadme], ['README.md', readme]]) assert.ok(body.includes(`\`${name}\``), `${file}: ${name}`);
});

test('every install line is the one that works today', () => {
  const remote = 'claude mcp add --transport http bounty-operator https://bountyoperator.com/api/mcp';
  const codex = 'codex mcp add bounty-operator --url https://bountyoperator.com/api/mcp';
  const local = 'npx -y https://bountyoperator.com/dl/bounty-operator-mcp.tgz';
  for (const [file, body] of [['README.md', readme], ['mcp/README.md', mcpReadme], ['llms.txt', llms], ['mcp.html', text('mcp.html')]]) {
    assert.ok(body.includes(remote), `${file}: remote endpoint`);
    assert.ok(body.includes(codex), `${file}: Codex`);
    assert.ok(body.includes(local), `${file}: local server`);
    // The package is not on npm yet: no line installs it by its bare name.
    assert.doesNotMatch(body, /npx -y bounty-operator-mcp\b/, file);
    assert.doesNotMatch(body, /npm (?:i|install) (?:-g )?bounty-operator-mcp\b/, file);
  }
  assert.match(pages.get('index.html'), /href="\/mcp"/, 'the home page links to the install instructions');
  assert.ok(release.includes(remote) && release.includes(local));
  assert.ok(readme.includes('pip install "git+https://github.com/bountyoperator/bounty-operator@v0.7.4"'));
});

test('the error codes the documents list are codes the service raises', async () => {
  const sources = (await Promise.all(['web/src/review.ts', 'web/public/review-core.mjs', 'web/public/profiles.mjs'].map((file) => read(...file.split('/'))))).join('\n');
  assert.deepEqual(
    ERROR_CODES.map(([code]) => code),
    ['hosted_profile', 'privacy_block', 'privacy_warn', 'daily_used', 'operator_only', 'review_running', 'provider', 'output_withheld'],
  );
  const mcp = text('mcp.html');
  for (const [code] of ERROR_CODES) {
    assert.ok(sources.includes(`'${code}'`), `${code} is raised`);
    assert.ok(mcp.includes(code), `/mcp: ${code}`);
    assert.ok(mcpReadme.includes(`\`${code}\``), `mcp/README.md: ${code}`);
    assert.ok(llms.includes(`\`${code}\``), `llms.txt: ${code}`);
  }
  assert.ok(websiteDoc.includes('`output_withheld`') && websiteDoc.includes('`hosted_profile`'));

  // What the documents say about output_withheld is what the Worker does: the answer is stopped and the review counts.
  const review = await read('web', 'src', 'review.ts');
  assert.match(review, /if \(scanner\.leaked\) \{\s+settle\(true\);\s+throw withheld\(\);/);
  // One sentence for the code, wherever it is rendered: the Worker's message, the /mcp table, the package README and llms.txt.
  const sentence = 'The model repeated its instructions instead of reviewing, so the answer was stopped and the call used one review. Run it again or choose a stronger model.';
  assert.ok(review.includes(`'${sentence}'`), 'web/src/review.ts');
  assert.ok(mcp.includes(sentence), '/mcp');
  assert.ok(mcpReadme.includes(`| \`output_withheld\` | ${sentence} |`), 'mcp/README.md');
  assert.match(llms, /`output_withheld`: the model repeated its instructions instead of reviewing, so the answer was stopped and the call used one review; run it again or choose a stronger model\./);
  // Nothing tells the user to change the files: an echoed template is the model's doing.
  for (const [name, body] of [['review.ts', review], ['/mcp', mcp], ['mcp/README.md', mcpReadme], ['llms.txt', llms]]) {
    assert.doesNotMatch(body, /asks (?:the model )?for (?:its|the) instructions, then run|Take out the text|Remove any text in the files/, name);
  }

  // operator_only: the two gauntlet and panel profiles, refused before the provider is called.
  assert.match(review, /403,\s+'operator_only',/);
  assert.match(mcp, /run_review was called with verdict or panel on an account without Operator\./);
  assert.match(mcpReadme, /\| `operator_only` \| `run_review` was called with `verdict` or `panel` on an account without Operator\./);
  assert.match(text('terms.html'), /an answer that repeats the method is stopped and counts as a review\./);
  assert.match(text('security.html'), /An answer that repeats the method of the profile is stopped and the call ends with the code output_withheld\./);
});

test('the health check is documented with the field that tells a hosted build from a community one', async () => {
  const worker = await read('web', 'src', 'worker.ts');
  assert.match(worker, /profiles: METHOD_SOURCE === 'private' && missingMethods\(\)\.length === 0 \? 'hosted' : 'community'/);
  assert.match(text('mcp.html'), /profiles reads hosted when the service carries the full method of every hosted profile\. A Worker built from the public repository reads community/);
  assert.match(text('security.html'), /its \/api\/health reads "profiles": "community"\. On this site it reads "profiles": "hosted"\./);
  assert.match(llms, /https:\/\/bountyoperator\.com\/api\/health returns `status`, `version`, `reviews` and `profiles` \(`hosted` on this site\)/);
  assert.match(websiteDoc, /\| `GET \/api\/health` \| Version, the state of billing, reviews and D1, and `profiles`: `hosted` or `community`\./);
  assert.match(websiteDoc, /\| `GET \/api\/profiles` \|/);
});

test('the data flow of a hosted review is stated the way the Worker runs it', async () => {
  // Browser, our server, the provider: the method is added in the middle and nothing is stored.
  const security = text('security.html');
  assert.match(security, /The privacy check runs here, and the preview shows the request before it leaves the tab\./);
  assert.match(security, /Adds the review method of the profile you chose, sends the request with your API key to one fixed endpoint of your provider and streams the answer back\./);
  assert.match(security, /Holds the files, the key and the answer in memory for that one request\. Writes none of them to storage or logs\./);
  assert.match(security, /Receives your files, your request, our review instructions and your API key\./);
  assert.match(security, /For a hosted profile it is the request: your focus, your context and the files, line by line\./);

  const own = text('your-model-your-key.html');
  assert.match(own, /Your files and your key pass through our server in memory\. It adds the review method and sends the request to that provider\. Bounty Operator stores no code, no prompts, no keys and no results\./);
  assert.match(own, /Receives your files, your request and your API key\./);
  assert.match(own, /Adds the review method of the profile you picked and sends the request, with your key, to one fixed endpoint of the provider you chose\./);
  assert.match(own, /Streams the review back\. Writes none of it to the database or to logs\./);
  assert.match(own, /Receives your files, your request and our review instructions\./);
  assert.match(own, /Every other profile is hosted: the preview shows the request that leaves your tab, with your focus, your context and the files, and the server adds the method before it goes to your provider\./);

  const privacy = text('privacy.html');
  assert.match(privacy, /The Worker adds the review method of the profile and holds everything in memory for that one request\./);
  assert.match(privacy, /Your files, your instructions and your key are never written to our database or our logs, and neither is the review that comes back\./);

  assert.match(text('index.html'), /Your files and API key pass through our server to your provider\. The server adds the review instructions and stores no files, prompts, keys or results\./);
  assert.match(text('terms.html'), /A hosted review sends your files and your key through our server to that provider\. Our server adds the review method and stores none of the request or the answer\./);
  assert.match(text('compare.html'), /Through our server to the model provider you choose, on your key\./);
  assert.match(llms, /A hosted review sends the user's files and provider key through bountyoperator\.com to the provider the user chose\. The server adds the review method and stores no files, prompts, keys or results\./);
  assert.match(flat(readme), /A hosted review passes your files and your key through bountyoperator\.com to that provider\./);
  assert.match(flat(mcpReadme), /The service adds the method of the profile, passes the request and the key to the provider for that one request and returns the review\. It stores no files, keys or review text\./);

  // No page sends a hosted review past our server.
  for (const [file, markup] of pages) {
    assert.doesNotMatch(textOf(markup), /(?:directly|straight) (?:to|from your browser to) (?:your|the) (?:model )?provider/i, file);
  }

  // The Worker: the method is resolved on the server, and the request is built there.
  const review = await read('web', 'src', 'review.ts');
  assert.match(review, /instructionsFor: hosted \? instructionsFor : undefined/);
  assert.match(review, /export function prepareChecked\(input: ReviewInputs\): Promise<Prepared> \{\s+return prepare\(input, true\);/);
});

test('the two plans read the same wherever they are summarised', () => {
  // Operator: unlimited reviews, the full gauntlet, panel review, four at once.
  const home = text('index.html');
  for (const line of ['Operator US$10 per week', 'Unlimited hosted reviews, four at once', 'Gauntlet: eight checks and a final verdict', 'Panel review: compare two to four models']) {
    assert.ok(home.includes(line), `home: ${line}`);
  }
  const operator = 'Operator is US$10 per week for unlimited reviews, the Gauntlet, Panel review and four reviews at once.';
  assert.ok(description('pricing.html').includes(operator));
  assert.ok(llms.includes(operator));
  assert.match(readme, /\*\*Operator: US\$10\/week\*\* for unlimited hosted reviews, the Gauntlet, Panel review and four reviews at once\./);
  assert.match(text('terms.html'), /Unlimited hosted reviews, the Gauntlet, Panel review and four reviews at once\. Renews weekly until you cancel\./);
  const pricing = text('pricing.html');
  for (const line of ['Unlimited hosted reviews', 'Gauntlet: eight stages, one verdict dossier', 'Panel review: two to four models, then cross-examination', '4 hosted reviews running at once']) {
    assert.ok(pricing.includes(line), line);
  }

  // Free: one hosted review per UTC day, any single profile.
  assert.ok(pricing.includes('Any of the eleven single profiles'));
  assert.ok(pricing.includes('Any single profile, all eleven.'));
  assert.ok(home.includes('Any of the eleven single review types'));
  assert.ok(home.includes('1 hosted review per UTC day'));
  assert.ok(text('terms.html').includes('1 per UTC day, any single profile'));
  assert.ok(llms.includes('Free gives 1 hosted review per UTC day, any single profile.'));
  assert.ok(readme.includes('**Free:** one hosted review per UTC day, any single profile.'));
  assert.match(flat(release), /A free account runs any single profile as its hosted review of the day\./);

  // What counts: stated once on the pricing page and once in the terms, as the Worker settles it.
  assert.ok(pricing.includes('A review the provider fails, refuses or cuts off at the start does not use the day’s allowance.'));
  assert.ok(text('terms.html').includes('A review the provider fails, refuses or cuts off at the start is not counted.'));
});

test('the panel page names the keys the workbench takes', async () => {
  // A seat picks any provider; one that is not the provider keyed above takes its own key in the row.
  const panel = await read('web', 'public', 'app', 'panel.mjs');
  assert.match(panel, /PROVIDERS\.map\(\(entry\) => el\('option', \{ value: entry\.id, text: entry\.label \}\)\)/);
  assert.match(panel, /dataset: \{ seatKey: provider\.id \}/);

  const page = text('panel-review.html');
  assert.match(page, /One OpenRouter key reaches models from several labs, so a panel of different models runs on a single key\. A panel model on Anthropic, OpenAI, Google Gemini, xAI, DeepSeek, Mistral or Groq takes that provider’s own key\./);
  assert.match(page, /A panel of three is four hosted reviews\. Each goes through our server to your provider and is billed to your key\./);
  assert.match(page, /The cross-examination is a hosted profile: its method is added on our server/);
  assert.doesNotMatch(page, /on your own OpenRouter key|billed by OpenRouter/);
  assert.equal(reviewProfile('panel').hosted, true);
});
