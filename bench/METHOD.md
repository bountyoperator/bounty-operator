# Paydirt: method

Paydirt is the Bounty Operator model benchmark. It answers one question per model: does it find the real bug, leave the fixed twin alone, and catch an overclaimed report, and what does that cost?

Scope: Paydirt measures file-scale security review, one to three source files per case, read through three read-only tools. It does not measure whole-repository audits, exploit writing or contest results.

## What a case is

A case is a small workspace a model is asked to review, plus an answer key the model never sees.

- The workspace holds one to three source files of a fictional protocol or API, written in the idiom of real contest code: NatSpec, events, admin functions, libraries.
- The answer key (`truth.json`, `truth.md`) names the planted bug by file, function and line range, lists the severities a triager would accept, and lists one to three decoys: code that looks wrong and is safe.
- Every planted bug and every decoy has an executable proof. For Solidity it is a Foundry test, for TypeScript a `node:test` test. The planted-bug proof passes on the vulnerable code and fails on the fixed code. Each decoy proof shows the suspicious code holding.
- Every case is original. Nothing is taken from Code4rena, Sherlock, Solodit, Immunefi or any public benchmark.
- Each pair starts as a draft by one model, then an engineer checks it against its proofs and repairs it. The drafts come from models of nine vendors (OpenAI, Google, xAI, DeepSeek, Anthropic, Qwen, Mistral, Moonshot, Z.ai). The drafting model is recorded, results are broken down by drafting vendor, and every model also gets a score that excludes the pairs its own vendor drafted.

## Why twins

Every case has a twin, and a model is only right when it is right on both.

| Family | Twin A | Twin B | Scored pairs |
|---|---|---|---|
| find-sol | Solidity with a planted bug | the same code with the bug fixed | 10 |
| find-ts | TypeScript API with a planted bug | the same code with the bug fixed | 2 |
| challenge | code plus a draft report that overclaims | the same code plus an accurate draft | 6 |

The twins of a find pair differ only in the patch. A model that reports "re-entrancy in `withdraw`" on every file it sees will hit the vulnerable twin and also bite the fixed one, and it scores zero for the pair. A model that reports nothing is clean on the fixed twin and misses the vulnerable one, and it also scores zero. The same holds for the challenge family: a model that rejects every draft fails the accurate one, and a model that approves every draft fails the overclaimed one.

A model never sees which twin it has. Twins share the same file names, the same task text and a workspace path that carries no case name.

## What the model is asked

Every run is one fresh agent session with three tools: `read`, `grep` and `glob`. The task is the same sentence for every model:

> You are a security reviewer. Review the files in this workspace for security issues.

followed by the answer sheet. In the challenge family the sentence instead says that `draft-report.md` is a draft bug report about the code and asks whether the code supports it. The model must end its reply with one JSON block:

```json
{"findings":[{"file":"","function":"","line_start":0,"line_end":0,"severity":"critical|high|medium|low|info|unrated","claim":""}],
 "rejected":[{"quote":""}],
 "verdict":"supported|overclaimed|unsupported|n/a",
 "max_severity":"critical|high|medium|low|info|unrated"}
```

`findings` is used by the find families. `rejected`, `verdict` and `max_severity` are used by the challenge family, where the workspace also holds `draft-report.md` and may hold the papers a triager has next to the code: the programme's rules (`programme.md`), a changelog and a deployments manifest. The full instructions are in `prompts/answer-sheet.md`, the system prompt in `prompts/system.txt`.

## The scoring rule

Scoring is mechanical. No model judges another model.

**Reading the sheet.** Only the first 8 findings are read. A line range longer than 40 lines is discarded (the finding can still match by function). An unknown severity label counts as `unrated`.

**Hit.** A finding hits a target when it names the same file and either names one of the target's functions or gives a line range that overlaps the target's range. When the finding names no function, the target's range is widened by 3 lines on each side to forgive line drift. A finding that names a function outside the target's list must really overlap the range: functions sit a few lines apart, and a finding about the neighbour is not a finding about the target.

**Find pair.** The pair is correct when both of these hold:

1. On the vulnerable twin, every primary planted bug is hit.
2. On the fixed twin there is no bite. A bite is a finding rated `medium`, `high`, `critical` or `unrated` that hits the patched region. Counting `unrated` closes the escape of rating nothing.

A hit and a bite are decided by location, not by reading the claim. A different claim placed on the patched lines of a fixed twin, rated medium or above, is a bite.

**Challenge pair.** The pair is correct when both of these hold:

1. On the overclaimed draft, the verdict is `overclaimed` or `unsupported`, and at least one `rejected` quote is found in the draft at one of the statements the answer key marks as false. Quotes are compared after normalising case, whitespace and typographic punctuation. The first 8 quotes are read, and a quote must be 20 to 400 characters long.
2. On the accurate draft, the verdict is `supported`.

**Failures.** A refusal, a truncated reply, a timeout, a provider error attributable to the model, an empty answer or an answer sheet that cannot be parsed makes that input wrong.

**Paydirt Score** = 100 × correct pairs ÷ scored pairs (18), on the `raw` arm.

**Repeats.** In this release every model runs every input once. The credit available did not cover three repeats for more than a handful of models, and one repeat for many models says more than three repeats for few. The cost is that the score carries the noise of a single run per input: the interval below covers which pairs were drawn, not how a model varies between runs. When a release runs more repeats, the published score is the median of the repeats, shown with the minimum and maximum.

**Interval and tiers.** Each pair is reduced to one outcome: with one repeat, that run; with more, the majority. The 95% interval is a percentile bootstrap over pairs, 10,000 resamples, from a seeded generator, so the same outcomes always give the same interval. With 18 pairs the interval is wide, and it is published so that nobody reads a two-pair difference as a ranking. Models are ranked by score. A model joins the best tier whose leader's interval overlaps its own; a model that overlaps no leader starts the next tier.

Only models whose raw arm is complete receive a tier. Task picks require both a complete raw arm and a complete selected arm. Profile lift is published only when both arms are complete. Unfinished arms retain their outcomes and completion counts but do not affect those comparisons; an unfinished profile does not remove a complete raw arm from the ranking.

**Other columns**, all computed from the same answer sheets:

| Column | Definition |
|---|---|
| Recall | planted bugs hit ÷ planted bugs |
| Fool's-gold rate | fixed twins with a bite ÷ fixed twins |
| Decoy rate | decoys reported at medium or above ÷ decoys shown |
| Line accuracy | hits whose line range overlaps the bug ÷ hits |
| Severity exact / bias | share of hits rated at an accepted level, and the mean signed distance to the nearest accepted level (info and low = 1, medium = 2, high = 3, critical = 4) |
| False-rejection rate | accurate drafts not marked `supported` ÷ accurate drafts |
| Challenge balanced accuracy | (overclaims caught + accurate drafts accepted) ÷ 2 |
| Failure rate | failed inputs ÷ inputs |
| Repeat agreement | pairs with the same outcome in every repeat ÷ pairs (not reported with one repeat) |
| Cost per run, cost per correct pair | recorded USD, including preserved retries |
| Median wall time | seconds per run |
| By drafting vendor, excluding own vendor | the score on the pairs each vendor drafted, and the score without the pairs the model's own vendor drafted |

Wall time includes provider latency and local tool execution on a shared host. Concurrency varied between batches to stay within available memory and credit. These times describe the observed runs; they do not isolate model speed. The 30-minute limit and the scoring rules stayed fixed.

## Profile lift

A family can also be run with the matching Bounty Operator review profile.

| Family | Arms |
|---|---|
| find-sol | `raw`, `solidity` |
| find-ts | `raw`, `general` |
| challenge | `raw`, `report` |

A profile arm differs from the raw arm in one thing: the product's own system message for that profile (its review contract and the profile's instructions, taken from `web/public/review-core.mjs` at the commit recorded in `protocol.json`) is appended to the system prompt, preceded by the Context block the product sends when the user supplies no context (it carries `Mode: bounty`, which the contract refers to). The task text and the answer sheet are identical. The product text is frozen in `prompts/frozen/<profile>.md` when the protocol is frozen, and every run sends that file. The runs of a profile arm are stored under that profile's own hash (see "Which hash a run counts under"), so a product text can be frozen and measured again without touching the raw-arm runs.

In this release the profile arms are run for four models only, chosen before any scored run and listed in `protocol.json` (`run.profile_arm_models`): `deepseek/deepseek-v4.1-flash`, `z-ai/glm-5.3-flash`, `openai/gpt-6-luna` and `anthropic/claude-sonnet-5.5`. Every other model has a raw score and no lift.

Lift = profile score − raw score on the same pairs, with a paired bootstrap interval. It is published for each of those models and every profile, negative values included. A lift is called significant only when its interval excludes zero.

## The harness

Every model runs through the same agent harness, `omp` 18.4.4, with the same flags, overlay and extensions. One run is one process:

```
omp -p --mode json --profile bench --no-session --no-title \
  --no-skills --no-rules --no-extensions --no-lsp --no-pty \
  --config bench-overlay.yml -e dump-ext.ts -e jail-ext.ts \
  --tools read,grep,glob --thinking max --max-time 30m \
  --system-prompt system.txt --append-system-prompt "run-nonce: <uuid>" \
  --cwd <fresh copy of the case workspace> \
  --model openrouter/<slug> -- "<task>"
```

What each part does:

- **Throwaway home and clean environment.** The process gets a new, empty home directory and an environment that contains the OpenRouter key and nothing else that names a provider, a token or the real user. No stored credentials, sessions or settings exist for it to find.
- **Empty launch directory, fresh workspace.** `omp` starts in an empty directory. The workspace is a fresh copy of the case's source files in a directory outside any repository, with no agent context file (`AGENTS.md`, `CLAUDE.md`, `.git` and similar) in any parent. The answer key and the proofs are never copied.
- **`bench-overlay.yml`** turns off every source of ambient context (rules, skills, MCP servers, project settings, memory), every tool except local read and search, network fetch and model fallback. It makes `read` return whole files with line numbers.
- **`jail-ext.ts`** rejects any tool call that is not `read`, `grep` or `glob`, and any path that is absolute, uses `..`, names a URL scheme or resolves outside the workspace.
- **`dump-ext.ts`** records every request body sent to the provider. From it the harness checks, on every run, that exactly three tools were offered, that the system prompt and nonce arrived, that the model id is the one requested and that no temperature was sent. A run that fails a check stops the benchmark and is not counted as an answer.
- **Nonce.** A fresh UUID in the system prompt makes every request unique, so no run is answered from a response cache.
- **Provider routing.** One policy for every model, described in the next section.
- **Time limit.** 30 minutes per run inside `omp`, and an external kill of the whole process tree 90 seconds later. A run that reaches the limit after the model has produced output is a timeout and counts as wrong.
- **A run counts** only when the final assistant message ends with stop reason `stop`.

Retries exist only for infrastructure failures (HTTP 429, 5xx, network errors, a stream the harness reports as stalled, a timeout before the model produced anything), up to 2 retries per input within one runner invocation. Unresolved infrastructure failures can be retried in later invocations. One more case counts as infrastructure: a host that cannot parse a model's native tool-call format hands the call back as text, so the message carries no tool call and no answer sheet and ends in an unparsed call: a file tool's arguments (`{"path": "src/Vault.sol"}`) or call markup in the model's own token format (`<invoke name="read">…</invoke>`). No call was made and no answer exists, so the run is retried like a network error and is never scored. A model whose inputs cannot be completed for that reason is listed as not run. So is a model the provider refuses to serve to the benchmark's account (an age confirmation, a region or a terms acceptance the account has not made): such a refusal concerns the account, not the request, and is never scored. A completed answer is never run again: each run has a key, sha256(hash of its arm, model, case hash, arm, repeat), and a stored run with that key is skipped.

The published `infra_retries` count covers retries within the invocation that produced each current stored record. Earlier invocations and interrupted records are excluded from this count. Recorded costs also include finalized archived invocations, subject to the cost limitations below.

`protocol.json` holds the model list, tiers, arms, the three sets of pairs and the rule that made them, flags, the routing policy, scoring constants, the answer-sheet schema, the hashes of every prompt and harness file and the hashes of the frozen product texts. Its own hash, the protocol hash, is printed with the results.

### Which hash a run counts under

A run is stored under a hash of what it was told, and it is counted only while that hash is the current one. The raw arm and the profile arms are told different things, so they do not share one hash.

- **The core hash** covers what a raw-arm run depends on: `protocol.json` without the product's part. That is the `omp` version and flags, the routing policy, the time limits, the model list, the sets, the scoring constants, the answer-sheet schema, and the hashes of the overlay, the two extensions, the system prompt, the task text and the answer sheet. A raw-arm run is stored under the core hash.
- **Each profile arm has its own hash**, made of three things: the core hash, the hash of the bridge text that introduces the product's instructions (`prompts/profile-bridge.md`), and the hash of that profile's frozen product text. A profile-arm run is stored under the hash of its profile.

When the product changes a profile and its text is frozen again, the hash of that profile changes and its earlier runs are no longer counted. Nothing else moves. The core hash does not depend on any product text, so the raw-arm runs stay valid, as do the runs of every profile whose text did not change, and the lift of the new text is measured against the same raw-arm runs. A change to the core (another `omp` version, routing policy, task text or set) changes every hash, and no earlier run is counted.

<!-- hashes:begin (written by "bench.mjs freeze"; do not edit by hand) -->

| Arm | A run of this arm depends on | Hash it is stored and counted under |
|---|---|---|
| `raw` | the core | `5fea9eb00e3f2bb24d3965bf6854d39742d3324b1b826492eaa1ef51dfe09768` |
| `solidity` | the core, the bridge text and the frozen `solidity` text | `f908e192edd19d3f97bdd8afdb998ba5980dc5d49a7a0ca69cd50d7455fe3471` |
| `general` | the core, the bridge text and the frozen `general` text | `d12d33dd21a6463c07ccc74db504f77f7d5d887e4c8cec524bf540c8a775eaed` |
| `report` | the core, the bridge text and the frozen `report` text | `a13c02939c448309353befd6ffae395e32bcbb2d6d0008f1d8a58c0b4eb169f5` |

Protocol hash, over the whole of `protocol.json` except this record of hashes in it: `c7f6f15c6436385e61d165215cf5df65ca13dbfbc51483c3567299faa7731f29`.

<!-- hashes:end -->

The results file states the protocol hash and, under `hashes`, the hash each arm ran under. `verify` recomputes those hashes from the `protocol.json`, the prompt files and the frozen product texts in the download, and checks that every published raw run was stored under the hash stated for its arm.

## Provider routing

OpenRouter serves most models through several providers, and they are not equal. For one tier-1 model it lists 32 endpoints, from 4-bit quantised copies to full precision, at input prices that differ forty-fold. In the pilot the same model's median run took 156 to 652 seconds depending on the provider. One run went to an endpoint listed as 4-bit and produced incoherent text for 29 minutes; another was still reasoning sensibly at 33 tokens a second when the time limit hit. Both were scored as timeouts. That measures the provider, not the model.

Every request of every model now carries the same routing block, and nothing is tuned per model:

```json
"provider": {
  "quantizations": ["fp8", "mxfp8", "fp16", "bf16", "fp32", "unknown"],
  "preferred_min_throughput": { "p50": 60 }
}
```

- **Quantisation floor.** Endpoints that declare 4-bit, 6-bit or integer quantisation (`fp4`, `mxfp4`, `nvfp4`, `fp6`, `int4`, `int8`) are never used. The floor is 8-bit because two ranked models are served at 8 bits at best; a higher floor would leave them without a provider. `unknown` has to be allowed: closed models and many hosts declare nothing, so the floor removes the declared low-precision copies and cannot vouch for the rest.
- **Throughput preference.** Endpoints whose median throughput over OpenRouter's rolling five-minute window is below 60 tokens a second are moved to the back of the queue. They are not excluded, so a model that only has slower providers still runs. 60 is the 95th-percentile output per run of the wordier pilot model (107,000 tokens) divided by the 30-minute limit.
- **Price.** Among the endpoints that pass, OpenRouter's default applies: it favours the cheaper ones. Sorting by throughput alone was rejected because it ignores price.

How it is applied: the harness writes one file into the throwaway home, `models.yml` of the `bench` profile, and `omp` copies its routing block into every request it sends to OpenRouter. The harness then reads the recorded requests of each run and stops the benchmark if a single request lacks the block or carries a different one. The block is part of the core of `protocol.json`, so changing it changes the core hash and with it the hash of every arm. The provider that served each run is published with the run.

The time limit was not raised.

## The three sets

28 pairs passed their proofs. They are split into three sets, recorded in `protocol.json` (`sets`):

| Set | Pairs | What it is |
|---|---|---|
| scored | 18 | The leaderboard. Held: the files are not published. |
| public | 6 | Practice material, published in full: workspaces, answer keys, proofs. Not part of the score. |
| reserve | 4 | Held. A reserve pair replaces a scored pair that has to be withdrawn, and the reserve feeds later releases. |

The split follows one rule, applied by `tools/select.mjs` from the parameters in `protocol.json` (`selection`):

1. **The hard pairs are scored.** Six pairs (`hard-01` to `hard-04`, `hard-07`, `hard-08`) were written after the pilot to be hard: deciding either twin takes a trace across files, not the recognition of one function. All six are in the scored set. Two more were planned and never finished; they are in no set.
2. **The other 22 pairs are ordered inside their family, hardest first**, by
   1. the share of difficulty probes that got the pair right (next section),
   2. the share of probed twins that were right,
   3. a fixed prior order, from the least to the most textbook kind of bug or overclaim.
3. **Each family is filled from the top of that order** to 10 find-sol, 2 find-ts and 6 challenge pairs, the hard pairs included. A find pair is skipped when its bug class is already twice in the scored set, so that no single trick decides more than two pairs. The classes are: share inflation and rounding direction, reward checkpoint order, cross-function reentrancy, access control on sibling functions, signature replay and domain separation, oracle staleness and decimals, fee-on-transfer and rebasing assumptions, initialisation and upgrade gaps, queue and epoch boundary errors, cross-chain message replay, language semantics.
4. **Of what is left in a family, the easiest pairs become public** (3 find-sol, 1 find-ts, 2 challenge) and the others the reserve.

So the scored set is the six hard pairs plus the twelve pairs that small models found hardest, and the public set is the pairs they found easiest.

<!-- selection:begin (written by tools/select.mjs; do not edit by hand) -->

**Status: final.** Every pair the rule has to order was probed in full (4 models, one answer per twin): 112 probes are complete and 0 are void because a call got no answer.

| Pair | Family | Drafted by | Set | Probes right | Bug twin / overclaim caught | Clean twin / accurate accepted |
|---|---|---|---|---|---|---|
| ch-02 | challenge | qwen | scored | 0.00 (0/4) | 0/4 | 4/4 |
| ch-05 | challenge | x-ai | scored | 0.00 (0/4) | 0/4 | 4/4 |
| ch-06 | challenge | google | scored | 0.25 (1/4) | 2/4 | 3/4 |
| ch-07 | challenge | google | scored | 0.00 (0/4) | 0/4 | 4/4 |
| hard-01 | find-sol | deepseek | scored | 0.00 (0/4) | 0/4 | 3/4 |
| hard-02 | find-sol | anthropic | scored | 0.00 (0/4) | 2/4 | 0/4 |
| hard-03 | find-sol | moonshotai | scored | 0.00 (0/4) | 1/4 | 2/4 |
| hard-04 | find-sol | z-ai | scored | 0.25 (1/4) | 2/4 | 1/4 |
| hard-07 | challenge | deepseek | scored | 0.25 (1/4) | 1/4 | 4/4 |
| hard-08 | challenge | anthropic | scored | 0.00 (0/4) | 0/4 | 4/4 |
| sol-02 | find-sol | google | scored | 0.25 (1/4) | 2/4 | 1/4 |
| sol-03 | find-sol | x-ai | scored | 0.00 (0/4) | 0/4 | 1/4 |
| sol-05 | find-sol | openai | scored | 0.00 (0/4) | 3/4 | 0/4 |
| sol-09 | find-sol | openai | scored | 0.25 (1/4) | 1/4 | 3/4 |
| sol-10 | find-sol | openai | scored | 0.00 (0/4) | 3/4 | 0/4 |
| sol-11 | find-sol | openai | scored | 0.25 (1/4) | 2/4 | 1/4 |
| ts-02 | find-ts | google | scored | 0.25 (1/4) | 2/4 | 3/4 |
| ts-03 | find-ts | x-ai | scored | 0.00 (0/4) | 0/4 | 3/4 |
| ch-03 | challenge | google | reserve | 0.25 (1/4) | 1/4 | 4/4 |
| ch-04 | challenge | google | reserve | 0.25 (1/4) | 1/4 | 4/4 |
| sol-07 | find-sol | openai | reserve | 0.25 (1/4) | 2/4 | 2/4 |
| sol-08 | find-sol | google | reserve | 0.25 (1/4) | 1/4 | 3/4 |
| ch-01 | challenge | google | public | 0.50 (2/4) | 2/4 | 4/4 |
| ch-08 | challenge | mistralai | public | 0.50 (2/4) | 2/4 | 4/4 |
| sol-01 | find-sol | openai | public | 0.50 (2/4) | 2/4 | 3/4 |
| sol-04 | find-sol | openai | public | 0.25 (1/4) | 2/4 | 2/4 |
| sol-06 | find-sol | openai | public | 0.25 (1/4) | 1/4 | 3/4 |
| ts-01 | find-ts | openai | public | 0.25 (1/4) | 1/4 | 4/4 |

| Set | Pairs | find-sol | find-ts | challenge | Probes right |
|---|---|---|---|---|---|
| scored | 18 | 10 | 2 | 6 | 0.10 (7/72) |
| of which: the hard pairs | 6 | | | | 0.08 (2/24) |
| of which: the other scored pairs | 12 | | | | 0.10 (5/48) |
| public | 6 | 3 | 1 | 2 | 0.38 (9/24) |
| reserve | 4 | 2 | 0 | 2 | 0.25 (4/16) |

Drafting vendors of the scored set: google 4, openai 4, x-ai 3, anthropic 2, deepseek 2, moonshotai 1, qwen 1, z-ai 1.

Bug classes of the scored find pairs (the label of a held pair is not published, the distribution is): language semantics 2, oracle staleness and decimals 2, signature replay and domain separation 2, access control on sibling functions 1, cross-chain message replay 1, initialisation and upgrade gaps 1, queue and epoch boundary errors 1, reward checkpoint order 1, share inflation and rounding direction 1. No class appears more than 2 times.

A probe is one small model answering both twins of a pair once. "Probes right" is the share of probes that got both twins right; a truncated answer counts as wrong, a call with no answer makes its probe void. Probe models: `openai/gpt-oss-20b`, `mistralai/mistral-small-3.2-24b-instruct`, `google/gemma-3-27b-it`, `qwen/qwen3.5-9b`.

<!-- selection:end -->

## Difficulty calibration

Each pair is probed with four small models that are not on the leaderboard: `openai/gpt-oss-20b`, `mistralai/mistral-small-3.2-24b-instruct`, `google/gemma-3-27b-it` and `qwen/qwen3.5-9b`. A probe is one request without tools: the files pasted with line numbers, then the raw-arm task and the answer sheet, scored with the same scorer. Each model answers each twin once, which gives up to 4 probes per pair.

The probe tool refuses a model that appears in `protocol.json`, and its results are not read by the scorer. The split into sets uses the probe and the prior order and nothing else: no result of a ranked model decides which pair is scored.

What the probe can and cannot say:

- Models this small get few pairs right at all: 20 of 112 probes. They do separate the public pairs (9 of 24 probes right) from the scored pairs (7 of 72), which is what the split needs.
- They do not separate the six hard pairs (2 of 24) from the other twelve scored pairs (5 of 48). Both are nearly out of their reach. Whether the hard pairs separate strong models from each other is not measured here. The scored run will show it, and the outcome of every model on every pair is published.
- With four probes per pair, many pairs are level, and the prior order then decides. In this release it decided which of three level challenge pairs is scored (`ch-06`, not `ch-03` or `ch-04`), which of two level TypeScript pairs is scored (`ts-02`, not `ts-01`), and which of five level Solidity pairs is scored (`sol-09`), which two of the other four are reserve (`sol-08`, `sol-07`) and which two public (`sol-04`, `sol-06`).
- A single request with a 12,000-token cap is not the benchmark's task. One of the four models reasons before it answers and ran out of tokens on 21 of its 36 find-pair answers, another on 4; those count as wrong.

That is the selection. The cases themselves have a history with ranked models, and it is stated here in full:

- **The pilot.** Before the hard pairs existed, the 14 find pairs of that time were run through the harness with two ranked models, `deepseek/deepseek-v4.1-flash` and `z-ai/glm-5.3-flash`, on both arms. Both got 11 of 14 on the raw arm. That result is the reason the hard pairs were written. Reading the pilot's answers also led to corrections of five answer keys (`ts-03`, `sol-11`, `sol-03`, `sol-05`, `sol-07`: where a correct report may be located, and what a decoy covers), to a changed fixed twin for `sol-09`, whose first version both models had reasonably flagged, and to one change of the scoring rule (a finding that names a function must overlap the target's lines; before, the 3-line tolerance let a finding about the neighbouring function count).
- **Checks while writing.** The engineers of nine pairs sent a draft of the pair, in one request without the harness, to a few models to see whether it could be decided in both directions: `ch-01`, `ch-04`, `ch-05`, `ch-06`, `ch-07`, `ch-08`, `hard-03`, `hard-04` and `hard-07`. The models were ranked ones: `deepseek/deepseek-v4.1-flash`, `z-ai/glm-5.3-flash`, `google/gemini-3.8-flash`, `google/gemini-3.5-flash-lite`, `minimax/minimax-m3`, `openai/gpt-oss-120b`, `qwen/qwen3.8-27b`, `qwen/qwen3.8-max-0902`, `anthropic/claude-haiku-4.5`, `anthropic/claude-sonnet-5.5` and `openai/gpt-6.1-sol`. For `ch-07`, `hard-03`, `hard-04` and `hard-07` the design was changed after such a check; `hard-03` and `hard-04` went through several designs that were kept or dropped on what `z-ai/glm-5.3-flash`, `deepseek/deepseek-v4.1-flash`, `anthropic/claude-sonnet-5.5` and `openai/gpt-6.1-sol` did with them. These pairs may therefore be harder for those models than for models that were never consulted.
- **Second engineer.** Every hard pair was then reviewed by a second engineer, who reworked all six (the patch moved, the decisive fact moved to another file, or the overclaimed draft rewritten). No ranked model has been run on the reworked forms of `hard-01`, `hard-02`, `hard-03`, `hard-04` and `hard-08`, or on the overclaimed draft of `hard-07`; the four probe models have.
- **The engineer.** The checking, repairing and proving of the pairs, the prior order of step 2, and the writing of `hard-02` and `hard-08` (whose planned drafts by another model were never made) are the work of Claude Opus 5.5 sessions directed by the benchmark's owner. Claude Opus 5.5 is a ranked model. The two pairs it wrote count as Anthropic-drafted in the per-vendor breakdown, and every score is also published without the pairs of the model's own vendor.

## Reasoning effort

Every model is run at the highest reasoning effort it supports. The harness always asks for `--thinking max`; `omp` maps that to the highest level the model accepts. The effort actually sent is read from the recorded request and published per model, next to the effort requested. No temperature, top-p, seed or output cap is set.

## Order of the runs

Models run in three tiers, tier 1 first, and inside a tier the cheapest model first.

- **Tier 1:** `deepseek/deepseek-v4.1-flash`, `deepseek/deepseek-v4-pro-0813`, `z-ai/glm-5.3-flash`, `z-ai/glm-5.3`, `qwen/qwen3.8-27b`, `qwen/qwen3.8-max-0902`, `minimax/minimax-m3`, `moonshotai/kimi-k3`, `tencent/hy4-preview`, `openai/gpt-oss-120b`, `nvidia/nemotron-3-ultra-550b-a55b`
- **Tier 2:** `openai/gpt-6-luna`, `google/gemini-3.5-flash-lite`, `google/gemini-3.8-flash`, `x-ai/grok-4.7`, `meta/muse-spark-1.3`, `mistralai/mistral-medium-3-5`, `anthropic/claude-haiku-4.5`, `openai/gpt-5.6-terra`, `openai/gpt-6.1-sol`, `google/gemini-3.1-pro-preview`, `anthropic/claude-sonnet-5.5`
- **Tier 3:** `anthropic/claude-opus-5.5`, `openai/gpt-6-astra`, `anthropic/claude-fable-5.1`

The release has a fixed amount of credit. Models are run in that order until it is used, and a model the credit did not reach is listed as not run, not as a low score.

All models are reached through OpenRouter. Each slug is checked against OpenRouter's model list when a run is planned, and prices are recorded at that moment. Cost includes the recorded attempts for each input, including infrastructure retries; where a provider reports no cost it is computed from the token counts and the recorded prices. Earlier attempts that were replaced before preservation was added cannot be reconstructed. Interrupted attempts without a finalized cost record are also excluded. The published costs may therefore be lower than total account spend. The serving provider is recorded per run.

Bounty Operator itself is not a row in the table.

## What is public and what is held

- **Public:** the 6 practice pairs with their answer keys and proofs, the harness, the prompts, the scorer, `protocol.json`, and the complete stored output of every run made on the practice pairs.
- **Held:** the 18 scored pairs and the 4 reserve pairs. Their files are not published. For each held case `commitments.json` carries a salted SHA-256 of the whole case directory, written before the first scored run; a commitment that has to be replaced because a case was corrected stays in the file as superseded. The results carry the per-run outcome of every model on every scored case (right or wrong, hits, bites, cost, time), without any case text.
- **What "held" does not mean.** A held case is sent to the providers that serve each model, as every prompt is. The routing policy does not restrict runs to providers that promise not to keep prompts, because that would leave some ranked models without a provider. A held case is unpublished; it is not unseen by the companies that served it.
- Each case carries a unique canary string in its answer key only.
- Held pairs rotate into the public set over time and new held pairs replace them. When a held case is published, its salt is published with it, so its commitment can be checked.

Because the scored pairs are held, a reader can recompute every published number from the per-run outcomes but cannot re-score a leaderboard answer from raw output. The practice set is the part that can be checked end to end: models that are also run on it get a separate practice table, and every outcome in it can be re-scored from the published raw output and answer key. The practice table is not the Paydirt Score.

## How to reproduce

Check the published numbers (needs Node 22 or later, nothing else):

```
node bench/bench.mjs verify --results latest.json --archive paydirt-<release>-public.tar.gz
node bench/bench.mjs verify --results practice/latest.json --archive paydirt-<release>-public.tar.gz
```

`verify` does three things. It recomputes every score, interval, tier and lift from the published per-run outcomes and compares them with the results file. It recomputes the hashes the results state from the `protocol.json`, the prompt files and the frozen product texts in the download. Then, for every run on a public case in that results file, it checks that the run was stored under the hash stated for its arm, re-reads the model's answer from the stored event stream, scores it against the public answer key and compares the outcome with the published one.

Check the public cases (needs Foundry for the Solidity proofs):

```
node bench/bench.mjs lint --proofs
```

Run a model on the practice set (needs `omp` 18.4.4 and an OpenRouter key in `.local/benchmark.env`):

```
node bench/bench.mjs selftest
node bench/bench.mjs run --set public --models <slug> --run-id mine
node bench/bench.mjs score --set public --run-id mine
```

Models are not deterministic, so a rerun gives scores near the published ones, not identical ones.
