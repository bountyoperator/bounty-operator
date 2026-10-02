# AI agent flow

How to run an AI agent through a hunt so that what comes out the other end
survives triage.

## The gate

A lead becomes a report only after it passes every one of these:

- scope
- current code
- known issues
- by-design behaviour
- duplicate risk
- a concrete PoC
- impact mapped to the programme's rules

## Set up the agent

Write a brief for one target or surface:

```bash
bounty-kit agent-brief ./agent-brief.md \
  --target "Example Protocol" \
  --program "Example Contest" \
  --repo "https://github.com/example/protocol" \
  --commit "abcdef1234" \
  --focus "core accounting" \
  --focus "oracle boundaries"
```

Give the brief to the agent with the scope and the current ledger.

For a reusable instruction file that covers the whole hunt, generate an agent
pack:

```bash
bounty-kit agent-pack ./agent-pack.md --target "Example Protocol" --program "Example Contest"
```

## Review selected files with a model

`bounty-kit ai-review` sends the files you name, and nothing else, to an
OpenAI-compatible API. Before the request it runs the sanitizer, strips absolute
paths from the labels, rejects binary and non-UTF-8 files, enforces the size
limits and requires HTTPS for every host except loopback.

Set the key in your shell:

```bash
export BOUNTY_KIT_AI_API_KEY="..."
```

PowerShell:

```powershell
$env:BOUNTY_KIT_AI_API_KEY = "..."
```

Run a pass from the prompt library:

```bash
bounty-kit ai-review ./agent-brief.md ./ledger.md --prompt ./prompts/poc-reviewer.md
```

Use another provider or a local model:

```bash
bounty-kit ai-review ./ledger.md \
  --base-url "https://openrouter.ai/api/v1" \
  --model "anthropic/claude-sonnet-5.5"
```

Keep private reports, cookies, wallet files, browser profiles and secrets out of
the file list. The sanitizer blocks the ones it recognises. `--allow-sensitive`
overrides that one check for material you have read and mean to send. The
transport and size checks still apply.

## Work an agent does well

- map the attack surface of the scoped files
- turn scanner output into a triage queue
- attack a finding on scope and known-issue grounds
- compare a PoC with the impact it claims
- rewrite a report to remove local notes and vague claims

## Work to keep with the human

- submitting the report
- deciding impact when no PoC exists
- anything that touches private reports or platform pages
- anything that reads a home directory or a browser profile
- declaring a finding unique

## The loop

1. Read scope and rules.
2. Build a ledger.
3. Map value flow.
4. Run tools.
5. Triage leads.
6. Build PoCs for the leads that survive.
7. Run duplicate-risk checks. Hold any candidate that shares a root cause with
   prior art, or that a prior fix would also fix, even when the new PoC is
   stronger.
8. Draft the strongest reports.
9. Sanitize artifacts before sharing.

A finished report is short, direct and backed by commands.
