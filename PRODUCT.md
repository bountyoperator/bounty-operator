# Product

<!-- impeccable:product-schema 1 -->

Written 2026-10-08 for the bountyoperator.com redesign. The owner delegated every
decision and skipped the interview, so facts marked *(inferred)* come from the
repository, the live site and the owner's standing instructions, not from an
answer round.

## Platform

web

## Users

- **Bug bounty hunters and smart-contract auditors** with a finding written up and
  not yet submitted: a draft report, the source files it cites at the scoped
  revision, often a Foundry PoC, and the programme's rules. They submit to
  Immunefi, Cantina, Sherlock, HackerOne and similar platforms, where
  an invalid or overstated report costs reputation, signal and time.
- **Developers checking their own code** before shipping (the own-code mode of
  the code security and Solidity reviews). *(inferred: secondary audience)*
- **Coding agents acting for either**: Claude Code, Codex and Cursor reach the
  product over MCP and the agent pack, so agent-readable pages (llms.txt, /mcp)
  are part of the audience.

## Product Purpose

Pre-submission review. The hunter adds the draft and its files; the review argues
against the finding, checks every claim against the code it cites, and returns one
verdict (submit, rewrite then submit, prove first, hold as a duplicate, or drop)
with file-and-line citations and what to fix. The hunter writes the report; the
AI never does. Success is fewer invalid, overstated or duplicate submissions and
stronger evidence on the ones that go out.

Promise: "Find the hole in your report before the triager does."

## Positioning

- The review is adversarial by design: it plays the triager and argues the
  finding down, and the verdict can be "drop".
- Bring your own model: the visitor's own API key (OpenRouter, Anthropic, OpenAI,
  Google Gemini, xAI, DeepSeek, Mistral, Groq), a copy-paste prompt in their
  ChatGPT or Claude chat, or their coding agent's own model over MCP.
- Every claim in a result cites `label:line` in the supplied files; the parser
  marks citations that do not resolve.
- Paydirt, the product's own published benchmark, scores models on held
  report/code pairs with frozen results.
- Built by a working hunter (Tradi3) with public leaderboard results.

## Operating Context

The visitor arrives with a report in progress, usually late in the cycle, often
from a coding agent or a terminal. They paste text, drop files or a folder, or
import from GitHub; pick a review type and a model; read a result that shows the
verdict, findings with severity, cited locations and fixes; and export a review
packet. Free tools (report check, secret check, Slither focus, packet verify,
acceptance rates) and report templates (write-up, Foundry PoC, per-platform)
serve the same moment. Pricing is read by someone deciding whether US$10 a week
beats their current workflow.

## Capabilities and Constraints

- Free: 1 review a day on the visitor's API key, any of the 11 review types;
  resets 00:00 UTC. Unlimited copy-paste chat reviews and coding-agent reviews
  for the three core types (code security, Solidity, draft report).
- Operator: US$10 per week, billed weekly through Stripe, cancel any time.
  Unlimited reviews, 4 at once, the Gauntlet (eight stages on one finding, then
  a verdict) and Panel review (2 to 4 models compared).
- File limits: 120 KB per file; 240 KB, 50 files and 20,000 lines per review.
- The server passes files and keys to the provider and stores no files, prompts,
  keys or results. Copy-paste prompts never leave the browser.
- MCP server (remote endpoint and npm package), agent pack and skills.
  Works alongside Immunefi Studio's own MCP server.
- Static site generated from `web/site` by `scripts/build-site.mjs`; a Cloudflare
  Worker serves it. Strict CSP: no inline styles or scripts, fonts and images
  from self only. Dark and light themes.
- Open-core: only the general, Solidity and report profiles are public. Gauntlet
  stage and panel instructions never appear in public pages or code.

## Brand Commitments

- Name: Bounty Operator. Public identity of the builder: Tradi3, never a personal
  name.
- Voice: plain, direct, confident; no hedging, no hype, no "AI slop". Claims are
  checkable or they are cut.
- No third-party method or skill names in UI or marketing; legally required
  notices live on /licenses only.
- The "b/" mark (tile with a slash) is the existing brand mark. *(inferred: kept
  as the identity anchor; its rendering may change)*

## Evidence on Hand

- Leaderboards, read 2026-10-08 (ENS and Firelight again 2026-10-09): 2nd of
  133 in Immunefi's Firelight competition (133 is the last rank; the board
  lists two more rows as disqualified); 8th of 65 in Quantus; 15th of 186 in
  ENS.
  ENS credits 23 valid submissions: 1 Chief and 22 duplicates, plus 1 separate
  Insight. 17 of the 23 are rated Critical (1 High, 4 Medium, 1 Low), the
  most Critical submissions on that board. Short proof lines say "17 valid
  Critical submissions in Immunefi's ENS competition, the most of 186
  researchers"; this fuller sentence stays here and in the README. Links in
  `web/site/pages/method/_shared.mjs`. These are the builder's results, not
  results of the tool.
- Paydirt benchmark release 2026-10: 22 models on 18 held pairs
  (`web/public/bench/2026-10.json`). Frozen; never regraded. /benchmark ranks
  the models on the raw arm, the model alone. The release's profile arms stay
  in the results file and are not shown as a comparison on the site.
- Saved examples: `web/public/example.mjs` (Tessera Staking, an invented
  protocol: a draft claiming Critical cut to Medium with file-and-line citations;
  a confirmed Critical). Render through `web/site/social/example.mjs`.
- No testimonials, customer names, logos, user counts or revenue figures exist.
  Never invent them.

## Product Principles

1. Prove, don't claim: show a real result, a real citation, a real number.
2. The hunter stays the author; the product is the adversary that makes the
   report survive triage.
3. The visitor's model, key and files stay theirs; say exactly where data goes.
4. One verdict, stated plainly, beats a hedge.
5. Free must be genuinely useful; Operator is for volume and depth.

## Accessibility & Inclusion

WCAG 2.2 AA contrast in both themes, 44 px touch targets, full keyboard paths
through the workbench, visible focus, `prefers-reduced-motion` honoured, no text
below 12 px, source code shown in a face that keeps every character distinct.
