## What changed

<!-- The problem and the smallest complete change that fixes it. -->

## Checks

Tick the blocks for the parts you touched.

**Python kit** (`bounty_operator_kit/`, `tests/`, `prompts/`)

- [ ] `python -m compileall -q bounty_operator_kit tests`
- [ ] `python -m unittest discover -s tests -v`

**Web app** (`web/`, `scripts/build-site.mjs`), run from `web/`

- [ ] `node ../scripts/select-profiles.mjs --stub`
- [ ] `npm test`
- [ ] `npx --no-install tsc --noEmit`
- [ ] `node ../scripts/build-site.mjs --check`
- [ ] Changed pages checked in a browser at desktop and phone width, dark and light theme.
- [ ] No `innerHTML`, no inline script, no inline style.

**MCP server** (`mcp/`), run from `mcp/`

- [ ] `npm test`
- [ ] `node ../scripts/build-mcp.mjs --check`

## Before you open it

- [ ] `python -m bounty_operator_kit sanitize` on the files you changed reports nothing new.
- [ ] No private report, credential, local path or target-specific PoC is included.
- [ ] Prompt and profile text is original. Nothing is copied from another project.
- [ ] A new dataset states its source, licence and sample size.
- [ ] `CHANGELOG.md` has a line for any change a user will notice.
