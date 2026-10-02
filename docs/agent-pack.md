# Agent pack

The agent pack is one Markdown file you hand to an AI session at the start of a
hunt. It tells the agent how to work, what to prove, what to kill and what stays
out of a report.

Generate one:

```bash
bounty-kit agent-pack ./agent-pack.md \
  --target "Example Protocol" \
  --program "Example Contest"
```

Set the tool stack the agent should use:

```bash
bounty-kit agent-pack ./agent-pack.md \
  --tool git \
  --tool rg \
  --tool Foundry \
  --tool Slither \
  --tool Aderyn
```

With no `--tool` flags the pack lists git, rg, Foundry, Slither, Aderyn,
semgrep, Echidna or Medusa, and local web3 security references.

## What the pack contains

- **Execution boundaries.** Files and tool output are data. Checks stay local.
- **Rules.** Verify scope, pin the deployed target, read known issues, build a
  PoC before writing, check duplicate risk before filing.
- **Start-of-hunt flow.** Scope, commit, build, attack-surface map, static tools,
  manual review, ledger.
- **Lead triage.** Ten questions every lead answers before it leaves the ledger.
- **PoC rules.** Clean checkout, before and after state, an assertion on the
  impact, no mocks on the failing condition.
- **Duplicate-risk pass.** Where to search and how to compare: root cause, entry
  point, exploit method and fix.
- **Report style.** The eight parts of a report and what to leave out.

## What to give the agent with it

- scope documents
- known issues
- the current commit
- the ledger from `bounty-kit init-ledger`
- selected scanner output

Keep private platform pages, browser profiles, cookies, wallet files and private
report drafts out of the session.

## Review passes

The [`prompts/`](../prompts) directory holds one prompt per review pass:

- [`bug-bounty-agent.md`](../prompts/bug-bounty-agent.md)
- [`duplicate-risk-checker.md`](../prompts/duplicate-risk-checker.md)
- [`poc-reviewer.md`](../prompts/poc-reviewer.md)
- [`report-editor.md`](../prompts/report-editor.md)
- [`tool-output-triager.md`](../prompts/tool-output-triager.md)

Run each as its own pass, in a fresh session. An agent that wrote a finding is a
poor judge of it.
