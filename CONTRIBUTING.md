# Contributing

## Good first contributions

Three kinds of change are self-contained and easy to review.

### A new review profile

A core profile is one entry in [`web/public/profiles.mjs`](web/public/profiles.mjs):
an id, a name, a one-line tagline, the inputs it needs, its instructions and any
extra output sections. The browser, the Worker and the MCP server all read that
file, so one entry ships everywhere. The gauntlet stages and the panel
cross-examination run on the hosted service; their method is not in this
repository and is not open to pull requests.

Good candidates are narrow and have a clear verdict: a profile for one bug class
(oracle staleness, signature replay, ERC-4626 share accounting), one platform's
judging rules, or one language. Open an issue with a sample of the output you
expect before writing the instructions. Add a test in `web/tests/` that checks
the profile loads and that its output parses.

### A new prompt pass

A prompt pass is one Markdown file in [`prompts/`](prompts). It does one job and
ends with a fixed output block, so two runs can be compared. Look at
[`poc-reviewer.md`](prompts/poc-reviewer.md) for the shape: what to check, the
output format, and the one thing the pass must leave alone.

Add the file, add a row with its outcome to the prompt table in the README, and
run it once against real material with `bounty-kit ai-review --prompt`. Paste
the redacted output in the pull request.

### A scanner adapter

[`bounty_operator_kit/slither_focus.py`](bounty_operator_kit/slither_focus.py)
turns Slither JSON into a short review queue with `file:line`. Adapters for
other scanners follow the same pattern: validate the input strictly, keep a
curated set of high-signal checks, and print a text and a Markdown queue. Wire
the adapter into `bounty_operator_kit/cli.py` as its own subcommand and add
tests with a small fixture, as in `tests/test_slither_focus.py`.

## Ground rules

- Explain the problem and make the smallest complete change.
- Behaviour changes come with tests.
- The Python kit has no runtime dependencies. Keep it that way.
- Prompt and profile text is original. Do not copy text from other projects.
- No private reports, live exploit details, credentials, local paths, browser
  data or target-specific PoCs, in code, tests or fixtures.
- A new network call, upload or paid-service call needs an issue first, and the
  user must see what is sent before it is sent.
- A new dataset states its source, licence and sample size.

## Checks

Python kit:

```bash
python -m compileall -q bounty_operator_kit tests
python -m unittest discover -s tests -v
python -m bounty_operator_kit sanitize <files you changed>
```

Web app, from `web/`:

```bash
npm ci --ignore-scripts
node ../scripts/select-profiles.mjs --stub
npm test
npm run smoke:stream
npx --no-install tsc --noEmit
node ../scripts/build-site.mjs --check
```

Pages are generated from `web/site/pages/`. Edit the source module, run
`node ../scripts/build-site.mjs`, and commit the generated HTML with it. Check
changed pages in a browser. [docs/website.md](docs/website.md) covers the layout
and local development.

`web/wrangler.jsonc` is a template with no account, route or live database:
`npm run dev` and the tests run from it as it is. A few tests compare the
repository with lists and a production configuration that are not in it. In
your checkout those tests are skipped. A test never spells a name the copy
must not use: add no such pattern to a test file.

MCP server, from `mcp/`, after `npm ci --ignore-scripts` in `web/`:

```bash
npm ci --ignore-scripts
npm test
node ../scripts/build-mcp.mjs --check
```

## Security reports

A vulnerability in Bounty Operator goes through [SECURITY.md](SECURITY.md), not
a public issue or pull request.
