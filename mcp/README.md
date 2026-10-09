# Bounty Operator MCP

Find the hole in your report before the triager does, from inside your coding agent.

This is the MCP server for [Bounty Operator](https://bountyoperator.com). Your agent names the files, the server scans them for secrets and returns the review request, your agent's own model writes the review, and the server checks every cited line and builds the evidence packet. Preparing a review and building the packet need no account and no key.

That route covers the three core profiles. Every other profile, and seven of the eight gauntlet stages, runs as a hosted review on the Bounty Operator service with your own provider key.

## Install

Two routes. Both work today.

### Remote endpoint

Nothing to install. One line per client.

**Claude Code**

```bash
claude mcp add --transport http bounty-operator https://bountyoperator.com/api/mcp
```

**Codex**

```bash
codex mcp add bounty-operator --url https://bountyoperator.com/api/mcp
```

**Cursor**, in `~/.cursor/mcp.json` or `.cursor/mcp.json` in a project:

```json
{ "mcpServers": { "bounty-operator": { "url": "https://bountyoperator.com/api/mcp" } } }
```

### Local server

This package. It reads files by path, keeps review preparation on your machine and adds `run_gauntlet_plan`. Node 22 or later, no dependencies. `npx` installs it from the tarball the site serves.

**Claude Code**

```bash
claude mcp add --transport stdio bounty-operator -- npx -y https://bountyoperator.com/dl/bounty-operator-mcp.tgz
```

**Codex**

```bash
codex mcp add bounty-operator -- npx -y https://bountyoperator.com/dl/bounty-operator-mcp.tgz
```

**Cursor**, in `~/.cursor/mcp.json` or `.cursor/mcp.json` in a project:

```json
{ "mcpServers": { "bounty-operator": { "command": "npx", "args": ["-y", "https://bountyoperator.com/dl/bounty-operator-mcp.tgz"] } } }
```

**Any other client**: command `npx`, arguments `-y https://bountyoperator.com/dl/bounty-operator-mcp.tgz`, transport stdio.

On Windows outside WSL, Claude Code starts `npx` through `cmd`: end the command with `-- cmd /c npx -y https://bountyoperator.com/dl/bounty-operator-mcp.tgz`.

The package is coming to npm as `bounty-operator-mcp`. Until it is published, the tarball URL above is the install.

A first request to try:

```text
Use bounty-operator to prepare a Solidity review of src/Vault.sol. Answer the request it returns, then build the packet.
```

## Tools

| Tool | Call it | It returns | Needs |
|---|---|---|---|
| `list_profiles` | When you do not know which review fits | The review profiles, each with `hosted` true or false, the gauntlet order, the verdicts, the providers and models | Nothing |
| `prepare_review` | Before reviewing code or a draft report with your own model | For a core profile: SHA-256 manifest, privacy findings, reviewer instructions, output format, the request to answer | Nothing |
| `run_gauntlet_plan` | For the full pre-submission run | The eight stages in order with the tool that runs each, the Context fields still empty, the call that ends the run | Nothing |
| `build_packet` | After writing the review | Verdict, reference check, the Markdown evidence packet | Nothing |
| `account` | Before a hosted review | Plan, reviews used today, reset time | Token |
| `run_review` | To run a review on a provider's model | The review, its verdict, the reference check, the remaining allowance | Token and provider key |

Six tools here, five on the remote endpoint: `run_gauntlet_plan` is local only.

Limits per call: 50 files, 120 KB per file, 240 KB and 20,000 lines in total.

### Core and hosted profiles

`prepare_review` takes the three core profiles: `general` (Code security review), `solidity` (Solidity review) and `report` (Challenge a draft report). Their method is in this package and your agent's own model answers the request.

Every other profile is hosted: `scope`, `provenance`, `prior-art`, `poc`, `severity`, `triage`, `report-edit` and `scanner`. Each runs on the Bounty Operator service through `run_review`, on your own provider key. The method of a hosted profile is added on the service. It is not in this package and no tool returns it.

For a hosted profile:

- `list_profiles` returns it with `hosted: true`.
- `prepare_review` fails with the code `hosted_profile` before any file is read.
- `run_review` runs it and uses one hosted review. A review the provider blocks under its usage policy is not counted. The two profiles no list shows, `verdict` and `panel`, are the last step of the gauntlet and of a panel review: they run on Operator only.

```json
{
  "profile": "triage",
  "error": "Triager simulation runs on the server. Call run_review with profile \"triage\": it needs BOUNTY_OPERATOR_TOKEN and the provider key in this server's environment.",
  "code": "hosted_profile"
}
```

### Files by path

`prepare_review` and `run_review` take `paths`, `files`, or both.

- `paths` are read by the server from its working directory: `["report.md", "src/Vault.sol"]`. The agent does not have to send the file text.
- `files` carry the text inline: `[{ "name": "src/Vault.sol", "content": "..." }]`.

A path resolves under the working directory and nowhere else. The server refuses `..`, an absolute path outside the directory, and a link that leaves it. File contents go to the review and are never returned: a result holds the label, size, line count and SHA-256 of each file.

A client that starts the server outside your project sets `BOUNTY_OPERATOR_ROOT` to the project folder.

### The privacy check

Every call scans the files first. A secret blocks the call and the result lists file, line and kind of each match, never the matched text. An email or IP address stops the call until you repeat it with `acknowledgeWarnings: true`. `run_review` runs this check on your machine before anything is sent.

## Prompts

Three prompts, listed by clients that support them as slash commands:

| Prompt | What it does |
|---|---|
| `challenge-report` | Checks every claim in a draft report against the code it cites, then builds the packet |
| `solidity-review` | Maps entry points and invariants in the contracts you name |
| `gauntlet` | Takes a finding through the eight stages in order and ends with one verdict |

In Claude Code: `/mcp__bounty-operator__gauntlet`.

## The gauntlet

Eight stages, in the order that ends a weak report early: scope, provenance, prior art, proof, severity, triager, report, verdict. `run_gauntlet_plan` returns the plan and names the tool that runs each stage. Seven stages are hosted and run through `run_review`, so the run needs a connection token and a provider key. The report stage is a core profile: `prepare_review` returns its request and your agent's own model answers it. Each review is passed forward as `stage-<n>-<profile>.md`, and the run ends with `build_packet`. The verdict is one of `submit`, `rewrite-then-submit`, `prove-first`, `hold-duplicate`, `drop`.

A run uses seven hosted reviews. Free covers one hosted review per UTC day, so a full run takes Operator. The plan carries the count under `hosted`, and `account` returns the allowance before the run starts.

## Hosted reviews

`run_review` runs any profile on a provider's model with your own API key and returns the review checked. It is the only way to run a hosted profile from an agent. It uses the same allowance as the website: one hosted review per UTC day on Free, any profile, and unlimited on Operator at US$10 per week.

Three result fields say when the text is not a review. `truncated` is true when the provider cut the answer short. `refused` is true when the model or the provider declined. `blocked` is set when the provider blocked the review under its usage policy (`anthropic-cyber`, `openai-cyber` or `policy`); a blocked review is never counted. After a refusal or a block, do not call again with the same model: use another model or provider, or `prepare_review` for a core profile.

1. Sign in at [bountyoperator.com](https://bountyoperator.com/#account) and create a connection in the account panel. The token starts with `bok_` and is shown once.
2. Start the server with the token and one provider key in its environment.

```bash
claude mcp add --transport stdio --env BOUNTY_OPERATOR_TOKEN=bok_... --env OPENROUTER_API_KEY=sk-or-... bounty-operator -- npx -y https://bountyoperator.com/dl/bounty-operator-mcp.tgz
```

Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.bounty-operator]
command = "npx"
args = ["-y", "https://bountyoperator.com/dl/bounty-operator-mcp.tgz"]
env_vars = ["BOUNTY_OPERATOR_TOKEN", "OPENROUTER_API_KEY"]
tool_timeout_sec = 1200
```

A hosted review runs for up to 270 seconds. Codex stops a tool call after 60 by default, so keep the `tool_timeout_sec` line.

The token and the key are read from the environment. Neither is a tool argument, and both are removed from every result.

The remote endpoint takes the same two values as headers: `Authorization: Bearer <token>` and `X-Provider-Key: <key>`. The commands for each client are at [bountyoperator.com/mcp](https://bountyoperator.com/mcp).

## Environment

| Variable | Purpose |
|---|---|
| `BOUNTY_OPERATOR_TOKEN` | Connection token for `account` and `run_review` |
| `BOUNTY_OPERATOR_MODEL` | Model id `run_review` uses when the call names none |
| `BOUNTY_OPERATOR_ROOT` | Absolute path of the project folder that `paths` resolve under. Default: the working directory |
| `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`, `DEEPSEEK_API_KEY`, `MISTRAL_API_KEY`, `GROQ_API_KEY` | Provider key for `run_review`, one per provider |

## What the server reaches

- `list_profiles`, `prepare_review`, `run_gauntlet_plan` and `build_packet` run on your machine with no network call.
- `account` and `run_review` call `https://bountyoperator.com` with your token. `run_review` sends the files and your provider key. The service adds the method of the profile, passes the request and the key to the provider for that one request and returns the review. It stores no files, keys or review text.
- The server reads the files you name under the working directory. It writes nothing to disk and runs no code from the files.

## When a call fails

A failed call returns `isError` with one JSON object: `error`, a sentence the agent can act on, and `code`.

| Code | Meaning |
|---|---|
| `hosted_profile` | `prepare_review` was called with a hosted profile. Nothing was read or counted. Call `run_review`. |
| `privacy_block` | The privacy check found a secret. The result lists file, line and kind. |
| `privacy_warn` | The privacy check found an email or IP address. Repeat the call with `acknowledgeWarnings: true` to send the files as they are. |
| `token` | `BOUNTY_OPERATOR_TOKEN` is missing, malformed, expired or revoked. |
| `daily_used` | The free review of the day is used. The result carries `resetsAt`. |
| `operator_only` | `run_review` was called with `verdict` or `panel` on an account without Operator. Nothing was sent to the provider and the review of the day is not used. |
| `review_running` | The account is running as many reviews as its plan allows. |
| `provider` | The provider rejected the key or the model, had no credit, failed or timed out. The review is not counted. |
| `provider_policy` | The provider blocked the request under its usage policy. The key is not the cause and the review is not counted. Call again with another model or provider, not the same one. |
| `output_withheld` | The model repeated its instructions instead of reviewing, so the answer was stopped and the call used one review. Run it again or choose a stronger model. |
| `bad_path`, `bad_root` | A path cannot be read under the working directory, or the working directory itself cannot be used. |
| `network`, `timeout`, `cancelled` | The service was not reached, did not answer within 300 seconds, or the client cancelled the call. |

## Verify the download

The tarball on the site is listed with its SHA-256 at `https://bountyoperator.com/dl/SHA256SUMS.txt`.

```bash
curl -sO https://bountyoperator.com/dl/bounty-operator-mcp-0.9.1.tgz
curl -s https://bountyoperator.com/dl/SHA256SUMS.txt | sha256sum -c --ignore-missing
npx -y file:$PWD/bounty-operator-mcp-0.9.1.tgz --version
```

Start a downloaded tarball with the `file:` prefix and its absolute path. npm reads a bare path as a command to run.

## Develop

The review engine lives in `web/public` of the repository and is copied into `lib/` before every test and pack.

```bash
npm install
npm test
node ../scripts/build-mcp.mjs
```

`build-mcp.mjs` packs the tarball, checks its contents against a whitelist, installs it into an empty folder, completes an MCP handshake and writes `web/public/dl/`.

Source: [github.com/bountyoperator/bounty-operator](https://github.com/bountyoperator/bounty-operator). MIT licence.
