# Paydirt harness

The Bounty Operator model benchmark. The method (cases, twins, scoring rule, harness command) is in [METHOD.md](METHOD.md). This file is the operator's manual.

Requirements: Node 22+ (built-ins only). For runs: `omp` 18.4.4, pinned as described under "Pinning omp", and an OpenRouter key in `.local/benchmark.env` as `OPENROUTER_API_KEY=...`. For `lint --proofs`: Foundry, and forge-std 1.17.0 at `bench/verify/_lib/forge-std` (not shipped: `git clone --depth 1 --branch v1.17.0 https://github.com/foundry-rs/forge-std bench/verify/_lib/forge-std`).

## Commands

```
node bench/bench.mjs lint     [--cases <glob>] [--proofs] [--quiet]
node bench/bench.mjs plan     [--tier 1|2|3 | --models a,b] [--arms raw,solidity] [--cases <glob>] [--repeats N] [--run-id <id>]
                              [--budget-usd X] [--order tier|cost] [--json <file>]
node bench/bench.mjs run      [--tier 1|2|3 | --models a,b] [--repeats N] [--arms ...] [--cases <glob>]
                              [--concurrency N] [--max-usd X] [--run-budget-usd X] [--max-minutes N] [--run-id <id>]
                              [--per-model N] [--stagger-ms N] [--floor-usd X] [--redo error,timeout]
                              [--gen-stats ends|all|off] [--dry-run] [--no-lint] [--allow-core-change]
node bench/bench.mjs score    [--run-id <id>] [--models a,b] [--cases <glob>] [--repeats N] [--out <file>] [--any-protocol]
node bench/bench.mjs publish  [--run-id <id>] [--release <name>] [--out-dir <dir>] [--salts <file>] [--allow-incomplete]
node bench/bench.mjs verify   [--results <latest.json>] [--archive <paydirt-<release>-public.tar.gz>]
node bench/bench.mjs freeze   [--no-engine] [--dry-run]
node bench/bench.mjs hashes   [--json]
node bench/bench.mjs commit
node bench/bench.mjs selftest [--model <slug>]
node bench/tools/probe.mjs    [--cases <glob>] [--models a,b,c,d] [--repeats N] [--max-usd X] [--dry-run]
node bench/tools/select.mjs   [--apply]
node bench/tools/offline-smoke.mjs [--set scored|public|reserve|all] [--arms raw,solidity,general,report] [--keep]
node bench/tools/runbook.mjs  --plan <plan.json> [--out <file.md>] [--concurrency N] [--per-model N] [--window-min N] [--notes <file.md>]
```

Common options:

- `--set scored|public|reserve|all` picks the pairs by the sets in `protocol.json` (comma-separated for several). `plan`, `run`, `score` and `publish` default to the scored set; `lint`, the probe and `select` take every pair. `--cases <glob>` narrows the set further.
- `--cases-root <dir[,dir]>` replaces the default case roots (`bench/cases`, `bench/private/cases`). With another root the sets do not apply unless `--set` is given.
- `--runs-dir <dir>` replaces `bench/runs`. `--run-id` defaults to the release in `protocol.json`.
- `--all-arms` on `plan` and `run` lets a model outside `run.profile_arm_models` run the profile arms.

| Command | What it does |
|---|---|
| `lint` | Checks every case against the schema and the rules: twins differ only inside the patched region, line ranges and function names exist, no answer key, canary, test file or agent file in the workspace, LF endings, proof references resolve. Checks the sets: every pair is in exactly one of scored, public and reserve, public pairs are the ones marked public, and the scored set keeps its family minimums. Checks that every held case still matches its line in `commitments.json`. A challenge workspace may hold `programme.md`, `CHANGELOG.md` and `deployments.json` at its root next to the sources and the draft; they must be listed in `case.json` and be identical in both twins. With `--proofs` it runs each pair's proof and requires the planted test to pass on the vulnerable variant and fail on the fixed one, and every decoy test to pass. For a challenge pair it requires the proof project to compile the sources the model sees and every test in it to pass. |
| `plan` | Lists models x cases x arms x repeats, checks each slug against the OpenRouter models API (missing slugs are dropped and logged), prints the run count and a rough cost. With `--run-id` it writes `plan.json`. With `--budget-usd X` it prints the budget plan instead (see below). |
| `run` | Executes the plan: the raw arm for every selected model, and the profile arms for the models in `run.profile_arm_models`. Skips runs already stored, retries infrastructure failures up to twice, and stops cleanly, letting the runs in flight finish, at `--max-usd` (this invocation), at `--run-budget-usd` (everything stored under the run id), when the key's remaining limit falls below the floor, or when `--max-minutes` leaves no room for another run. Prints spend per model. Rerun the same command to resume. Refuses to start when `protocol.json` was edited after its hashes were written, and when the run folder already holds raw-arm runs made under another core hash (`--allow-core-change` overrides that one). |
| `score` | Pure function over stored runs: re-reads every answer from the stored event stream, scores it, writes `results.json` and `models/<model>.json`. A run counts when it was stored under the hash its arm has now (see "Hashes and stored runs"); `--any-protocol` counts the others too and marks the results as mixed. |
| `publish` | Scores the scored set, builds the public archive, writes the website files. Refuses when runs are missing or unresolved, and when the prompt files, the frozen product texts or the hashes block are not what `protocol.json` records. The archive holds the raw output of exactly the runs that were counted; `--any-protocol` is refused here, so a run made under another hash is never published. When models were also run on the public practice set (`run --set public`), writes a second results file under `practice/` and puts their raw output in the archive. |
| `verify` | Recomputes a results file from its per-run outcomes, recomputes the hashes it states from the protocol, the prompt files and the frozen product texts in the archive, and re-scores every run on a public case from the archived raw output and answer key after checking that the run was stored under the hash stated for its arm. Exit code 1 on any difference. |
| `freeze` | Records the hashes of the prompt files and the harness files in `protocol.json`, writes the product text of each profile arm to `prompts/frozen/<profile>.md` with its hash, and writes the hashes block of `protocol.json` and the hashes table of METHOD.md. Prints every hash before and after, and which stored runs stop counting. A changed product text moves the hash of its own profile and nothing else: raw-arm runs stay valid. `--no-engine` leaves the product texts and the `engine` block as they are (after a hand edit of `protocol.json`, and where there is no `web/` directory). `--dry-run` writes nothing and prints what a freeze would change now. |
| `hashes` | Prints the protocol hash, the core hash and the hash of each profile arm. Offline. Exit code 1 when the hashes block of `protocol.json` is not the hash of its content. |
| `commit` | Writes `bench/commitments.json`: one salted SHA-256 per held case (scored and reserve). Salts stay in `bench/private/salts.json`. A value that changes because a case was corrected is kept under `superseded`. Run it before the first scored run and after any change to a held case; `lint` fails until it is. |
| `selftest` | One real run on the fixture workspace that also tries to read outside it. Confirms the tool list, the jail, the routing policy on every request, line-numbered reads, answer-sheet parsing, usage, cost and effort capture. Costs well under one cent on the cheapest tier-1 model. |
| `tools/probe.mjs` | Difficulty calibration with small unranked models (see below). Not part of a release run. |
| `tools/offline-smoke.mjs` | Drives every case of a set through the real runner and the real scorer with a stand-in for `omp` that answers from three prepared answer books: the key's own answer (every pair must come out right), the planted location reported on both twins with every draft rejected (no pair right), and silence with every draft approved (no pair right). No network, no key, no spend. It shows that each final case, the routing check and the scorer fit together; it says nothing about a real model. |
| `tools/runbook.mjs` | Turns the rows of `plan --budget-usd X --json <file>` into batches: one `run` command per batch with its `--max-usd`, in run order, no batch larger than one time window can hold. Offline. |
| `tools/select.mjs` | Applies the selection rule of `protocol.json` to the probe's stored answers and prints the scored, public and reserve sets. With `--apply` it writes them: `protocol.json`, the case folders (public pairs live in `bench/cases`), `bench/.gitignore` and the table in METHOD.md. Spends nothing. |

Order for a release: `tools/probe.mjs`, `tools/select.mjs --apply`, `commit`, `freeze`, `lint --proofs`, `selftest`, `plan --budget-usd <credit>`, `run` in batches in the order of the plan (`--models <batch> --max-usd <cap> --run-budget-usd <credit> --max-minutes <window>`), `score`, `publish`, `verify`. The batches of this release are written out in `.local/build/BENCH-RUNBOOK.md`.

## Sets

`protocol.json` holds three lists of pairs:

| Set | Where the cases live | Use |
|---|---|---|
| `scored` | `bench/private/cases` | the leaderboard; what `plan`, `run`, `score` and `publish` work on by default |
| `public` | `bench/cases` | practice material, published in full; run it with `--set public` |
| `reserve` | `bench/private/cases` | held back; replaces a scored pair that is withdrawn |

The lists are written by `tools/select.mjs --apply` from the rule in `selection` (METHOD.md, "The three sets"). The bug class of each find pair, which the rule uses for its class cap, is in `bench/private/selection.json` and is not published. Changing a set changes the core hash, and no stored run counts any more.

`run.repeats` is 1 in this release and `run.profile_arm_models` lists the four models that also run the profile arms.

## Budget plan

```
node bench/bench.mjs plan --budget-usd 160
```

Prints, in run order, what each model is expected to cost on the scored set at one repeat, a running total, and the line where the budget runs out. The default order is the order of the runs: tier 1, then 2, then 3, and the cheapest model first inside a tier; `--order cost` sorts by cost alone. A model in `run.profile_arm_models` has a second row for its profile arms, straight after its raw row. `--arms`, `--repeats`, `--tier`, `--models`, `--set` and `--cases` narrow or widen it, and `--json <file>` writes the rows.

- The token profile is the one measured in the pilot on the raw arm (`estimate.raw_arm` in `protocol.json`): separate figures for the twin that holds the bug and for the clean twin, which costs about twice as much because the model keeps looking. Challenge drafts were not measured and use the mean of both.
- Input tokens are scaled by the size of each case's workspace over the pilot's mean workspace. Output tokens are not scaled: the pilot showed no relation between workspace size and output (r = -0.1 over 12.5 to 25.5 kB).
- `low` and `high` are the same sum with the profile of each pilot model alone. They are a range of what was seen, not a bound: a model that reasons several times longer than both will cost several times its row.
- Prices are the list prices of the models API at that moment. Under the routing policy OpenRouter may pick an endpoint that is cheaper or dearer than the listed one.
- A profile-arm row is priced with the raw-arm profile; in the pilot the profile arm cost the same or less.
- The plan spends nothing. The real limits are `--max-usd` and `--run-budget-usd` on `run` and the key's own limit. Both stop before the runs in flight could cross the figure: they add the mean cost per run seen so far for each model in flight, or the plan's high estimate while a model has no finished run.

## Difficulty probe

```
node bench/tools/probe.mjs --dry-run       # what would be sent and the worst-case cost; no key, no spend
node bench/tools/probe.mjs --max-usd 3 --repeats 1     # all pairs, 4 models, one answer per twin
```

A cheap single-shot calibration: each twin of each pair is sent once per probe to four small models that are not ranked, with the files pasted in (line-numbered) followed by the raw-arm task and the answer sheet. The answer is scored with `lib/score.mjs`. The table, written to `.local/build/pilot/difficulty.md`, gives per pair the fraction of probes (model x repeat) that got the pair right, the same per twin and per model, and a band (easy: at least half; medium: some; hard: none).

- The default models are `openai/gpt-oss-20b`, `mistralai/mistral-small-3.2-24b-instruct`, `google/gemma-3-27b-it` and `qwen/qwen3.5-9b`. Each is checked against the models API, and a model that is in `protocol.json` is refused: difficulty is calibrated with unranked models only.
- Requests carry the benchmark's quantisation floor and `data_collection: "deny"`, because most cases are held. Pass `--data-collection allow` only for public cases.
- Raw answers are stored under `bench/runs/probe/` and an answered call is never bought again; `--fresh` ignores the store.
- Nothing in `score`, `publish` or `verify` reads the probe's output.

## Where things are written

| Path | Content | In git |
|---|---|---|
| `bench/protocol.json` | models, tiers, arms, the three sets and the selection rule, flags, scoring constants, file hashes, the hashes of the frozen product texts, and the `hashes` block (protocol hash, core hash, one hash per arm) | yes |
| `bench/commitments.json` | salted SHA-256 of every held case, written by `commit` | yes |
| `bench/private/selection.json` | bug class of each find pair (used by the selection rule) | no |
| `bench/prompts/frozen/<profile>.md` | the product text a profile arm sends, written by `freeze` | yes |
| `bench/cases/<id>/` | public (practice) cases | yes |
| `bench/private/cases/<id>/` | held cases: the scored set and the reserve | no |
| `bench/private/salts.json` | salts of the held-case commitments | no |
| `bench/verify/<pair>/` | proof project of a pair (holds the pair's sources and its answer) | public pairs only: ignored by `bench/.gitignore` until the pair is promoted |
| `bench/runs/<run-id>/plan.json` | verified slugs, prices and their timestamp, harness commit | no |
| `bench/runs/<run-id>/protocols/<hash>/` | `protocol.json`, the prompt files and the frozen product texts each invocation ran under. `<hash>` is the protocol hash, which every run's `meta.json` carries, so each freeze gets a folder of its own | no |
| `bench/runs/<run-id>/raw/<model>/<case>.<arm>.<rep>/` | one run (see below) | no |
| `bench/runs/<run-id>/results.json`, `models/*.json` | output of `score` | no |
| `web/public/bench/latest.json`, `<release>.json` | published results | yes |
| `web/public/bench/models/<model>.json` | per-run outcomes of one model | yes |
| `web/public/bench/practice/` | the same three kinds of file for runs on the public practice set | yes |
| `web/public/bench/paydirt-<release>-public.tar.gz` | harness, public cases, proofs, raw outputs of runs on public cases | yes |

One run directory holds:

- `events.jsonl`: omp's event stream. Streaming deltas are dropped because every complete message arrives in a `message_end` event; `turn_end` and `agent_end` are kept as stubs because they only repeat earlier messages.
- `request.json`: the first request body exactly as sent (system prompt, tool schemas, first user message).
- `requests.jsonl`: one line per request with the model id, reasoning effort, tool names and the routing block (`provider`).
- `answer.md`, `sheet.json`: the final answer and the parsed answer sheet.
- `stderr.txt`, `meta.json`: status, failure kind, stop reason, token usage, cost and its source, wall time, effective effort, serving provider, harness checks, resume key, and the hashes the run was made under (`arm_sha256`, the one it is counted by, `core_sha256` and `protocol_sha256`).
- `attempts/<n>/`: the output of an attempt that failed for infrastructure reasons and was retried.

The key never appears in any of these; the runner replaces it if a tool echoes it.

## Hashes and stored runs

A run is stored under the hash of what it was told (METHOD.md, "Which hash a run counts under"). `run`, `score`, `publish` and `verify` all go by that hash.

| Hash | Covers | Used for |
|---|---|---|
| protocol hash | the whole of `protocol.json`, without its `hashes` block | display: `plan`, the run log, `protocol_sha256` in the results, the folder name under `runs/<run-id>/protocols/` |
| core hash | `protocol.json` without the `engine` block and without the hash of `prompts/profile-bridge.md` | raw-arm runs |
| `solidity`, `general`, `report` | the core hash, the hash of the bridge text, the hash of that profile's frozen product text | the runs of that profile arm |

`node bench/bench.mjs hashes` prints them. The results file states them under `hashes`: `{ protocol, core, arms: { raw, solidity, general, report } }`.

- **The recipe** (`lib/protocol.mjs`). Canonical JSON is JSON with the keys sorted at every level and no white space. The protocol hash is sha256 of the canonical `protocol.json` without `hashes`. The core hash is sha256 of the line `paydirt.core/1` followed by the canonical `protocol.json` without `hashes`, without `engine` and without the `prompts/profile-bridge.md` entry of `files`. A profile's hash is sha256 of five lines: `paydirt.arm/1`, the core hash, the profile's name, the canonical `{"prompts/profile-bridge.md": <its hash>}`, and `engine.profiles.<profile>.system_sha256`.
- **Resume key.** sha256(hash of the run's arm, model, case hash, arm, repeat). `meta.json` carries the hash as `arm_sha256`. Its `protocol_sha256` is the protocol hash at the time of the run: after a freeze of the product texts, a raw-arm run made earlier names an older protocol hash than the results do, and still counts.
- **Freezing a changed product text.** `freeze` moves the hash of the profile whose text changed, and no other. `run` then makes that profile's runs again and replaces them, and says how many. Raw-arm runs and the runs of the other profiles are still found, and are not bought again. `freeze --dry-run` prints beforehand which hashes a freeze would move. An edit to the engine that leaves the three texts as they are moves the protocol hash only.
- **Changing the core.** An `omp` flag, the routing policy, a prompt or harness file, a set, the model list, a run setting: any of these moves the core hash and with it every hash, and no stored run counts any more. `run` refuses to start on a run folder that holds raw-arm runs made under another core hash; pass `--allow-core-change` when the change is deliberate. Running a model that is not in the list (`--models`) or the profile arms of another model (`--all-arms`) needs no edit.
- **The written record.** `freeze` writes the hashes into `protocol.json` (the `hashes` block) and into METHOD.md; `tools/select.mjs --apply` writes them again when it changes the sets. The harness always computes the hashes from the content and never reads the block. `lint`, `run`, `selftest` and `publish` refuse a block that is not the hash of the content, so an edit to `protocol.json` cannot go unnoticed: `freeze --no-engine` records the new hashes without touching the product texts.
- **A freeze during a run.** A task reads its prompt files when it starts, which may be long after the command was started. If they are not the ones `protocol.json` recorded then, nothing is sent and the invocation stops. The task also reads `protocol.json` again: when the file no longer gives its arm the hash the command started under (the core was edited and recorded with `freeze --no-engine`, say), nothing is sent either, because such a run would be paid for and never counted. A change that leaves that hash alone, such as the text of another profile, does not stop the task. The same command, started again, runs under the hashes of the new freeze; after a change to the core it asks for `--allow-core-change` first (see "Changing the core").
- **Old run folders.** A run stored before the hashes were split carries no `arm_sha256`. It is read without error and never counted. `score --any-protocol` still scores it, and the results then carry `hashes.mixed`, the number of such runs.

## How a run is isolated

`lib/omp.mjs` builds each `omp` process from the validated template: a throwaway home per worker, an environment with the OpenRouter key as its only credential, an empty launch directory, and a fresh copy of the workspace under a work root that has no agent context file in any ancestor. The work root is the first clean candidate of `$PAYDIRT_WORK_ROOT`, the user temp directory, the machine temp directory and the drive roots; the choice is printed at the start of a run. The three harness files are copied there too, so `omp` never touches the repository.

The throwaway home holds exactly one file: `.omp/profiles/bench/agent/models.yml`, written from `omp.routing` in `protocol.json`. `omp` 18.4.4 copies `providers.openrouter.compat.openRouterRouting` from that file into the `provider` field of every request to OpenRouter, for every model, including keys its own schema does not list. This is how the routing policy in METHOD.md reaches the wire. The `routing` harness check compares the block on every recorded request with `protocol.json` and stops the benchmark on any difference, so a later `omp` that drops or rewrites the block cannot go unnoticed. To change the policy, edit `omp.routing` and run `freeze --no-engine`; the core hash changes with it, so no stored run counts any more.

Environment overrides: `PAYDIRT_OMP` (path of the program that is started as omp), `PAYDIRT_OMP_ARGS` (JSON array placed before omp's arguments), `PAYDIRT_BUN`, `PAYDIRT_FORGE`, `PAYDIRT_WORK_ROOT`, `PAYDIRT_PROTOCOL` (another protocol file; the offline tests use it to try other sets, a release never does). The first two may also stand in `.local/benchmark.env`, which is how `omp` is pinned.

## Pinning omp

The harness is validated against `omp` 18.4.4, and `run` and `selftest` refuse any other version. A globally installed `omp` updates itself: the one on the benchmark machine went from 18.4.4 to 18.4.11 during the project. So runs use a private copy that nothing updates.

1. Build the copy in an empty directory outside any repository. Neither the directory nor any of its parents may hold an agent context file (`AGENTS.md`, `CLAUDE.md`, `.git`, `.claude`, `.env` and the like), the same rule as for the work root:

   ```
   mkdir <dir>
   cd <dir>
   bun add @oh-my-pi/pi-coding-agent@18.4.4
   ```

   The `package.json` this leaves must name the dependency as `"@oh-my-pi/pi-coding-agent": "18.4.4"`, with no range in front of the version. Nothing else belongs in the directory.

2. Name the runtime and the copy's `cli.js` in `.local/benchmark.env`, on two lines below the key:

   ```
   PAYDIRT_OMP=<path of the bun executable>
   PAYDIRT_OMP_ARGS=["<dir>/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js"]
   ```

   `PAYDIRT_OMP` is the program that is started, here `bun` itself. `PAYDIRT_OMP_ARGS` is a JSON array of arguments placed before omp's own, here the script `bun` runs. A value runs to the end of its line and backslashes are literal, so a Windows path is written as it is.

3. Check it with no variable set: `node bench/bench.mjs plan --models <slug>` ends with `omp: omp/18.4.4; <bun> <cli.js> (pinned in .local/benchmark.env)`. Another version is printed with `MISMATCH`.

Every command that starts `omp` (`plan`, `run`, `selftest`) reads the two settings from that file, so the operator exports nothing. The same variables in the environment win over the file. The program and its arguments belong together: when the environment names the program, the file's arguments are not passed to it. The runner takes only these two settings from the file, and they are not handed on to `omp`.

## Failure kinds

| Kind | Meaning | Final |
|---|---|---|
| `unparseable`, `empty` | the model stopped without a readable answer sheet | yes |
| `truncated` | stop reason `length` | yes |
| `timeout` | the time limit was reached after the model had started answering | yes |
| `error` | a provider error that is the model's own (for example a content filter) | yes |
| `infra` | rate limit, 5xx, network, a timeout before any output, a failed harness check (including a request without the routing block) | no: retried on the next `run` |
| `missing` | the run was never made | no |

Final failures count as wrong and are never re-rolled unless `--redo <kind>` names them. `infra` and `missing` also count as wrong in `score`, mark the model `[incomplete]`, and block `publish`.

## Product engine

Profile arms take the product's system message from `web/public/review-core.mjs` (`prepareReview(...).messages[0].content`) and the `## Context` block of the product's user message for a request without context (`messages[1]`), which carries the Mode the contract refers to. The import lives in `lib/arms.mjs` and nowhere else. `freeze` writes that text to `prompts/frozen/<profile>.md`; runs send the frozen file, so a run does not change when the product is edited half way, and the public archive can rebuild every prompt without the `web/` directory. `run` refuses a profile arm when the frozen file is missing or differs from the hash in `protocol.json`, and prints a note when the live engine has moved on since the freeze. Freezing again after the product changed moves the hash of the changed profile and of nothing else (see "Hashes and stored runs"), so the product can be measured again against the raw-arm runs already made.

## Tests

```
node --test bench/tests
```

Offline. They cover answer-sheet extraction, scoring rules on hand-built fixtures, the seeded statistics, lint on the fixture cases, resume-key stability, the runner against a stand-in `omp` (clean environment, the routing file and its check, retries, hard kill of the process tree), the pin of `omp` in the env file, the budget plan and its run order, the difficulty probe against a stand-in model, the selection rule, the sets and the commitments, the time window and the run budget of the runner, and a full score, publish, verify round trip including the practice set.

No test can start a real `omp`: the tests that call `run` to see it refuse give it a `PAYDIRT_OMP` that does not exist, so a refusal that broke would end at "omp not found" and not at a paid run with the key and the pin of `.local/benchmark.env`.

`tests/hashes.test.mjs` covers the hashes: what the core hash and a profile hash each cover, that a freeze of changed product texts leaves every raw-arm key where it was and moves the keys of the changed profile only, that score, publish and verify agree on a run folder whose runs were made under different profile hashes, and that an old run folder is read without error. To see the raw-arm keys of the release plan hold across a freeze of new product texts:

```
node --test --test-name-pattern="re-freeze" bench/tests/hashes.test.mjs
```

## Proof layouts understood by `lint --proofs`

- Solidity, one Foundry profile and a test file per variant (`test/Vulnerable.t.sol`, `test/Fixed.t.sol`): the planted test passes in the vulnerable file and the same test fails in the fixed file. Sources under `src/vulnerable/` and `src/fixed/` must be byte-identical to the case workspaces.
- Solidity, `[profile.vulnerable]` and `[profile.fixed]` in `foundry.toml`: the planted test passes under the first and fails under the second.
- TypeScript, `run.mjs <case dir>` in the proof project (preferred), or a plain `node --test` file that reads `PAYDIRT_VARIANT_DIR`: run once per variant.

- Challenge pair, a Foundry project with one profile: `src/` holds the sources of both workspaces byte for byte (they differ only in the draft), and every test must pass. The tests show the accurate draft's claims holding and each false claim of the overclaimed draft failing. A challenge pair without a proof project is a warning.

A proof reference in `truth.json` is `<test file>:<test name>`, with the file relative to the proof project, to `bench/` or to the repository root.

## Writing the locations in an answer key

The scorer matches a finding to a target by file, then by function name or by line overlap (see METHOD.md). These rules keep that honest; they come from the pilot, where breaking them produced wrong credits.

- `functions` lists only the functions that contain the faulty code (for a fixed twin: the functions the patch is in). A caller is not listed by name. Add the line of its call site to `lines` instead, in both twins, so a report that locates the bug at the caller still counts, and an unrelated finding elsewhere in the caller does not.
- When the same root cause can be reported from two places (the faulty computation and the check that relies on it), put both line ranges in `lines` on the vulnerable twin and in `patched_region.lines` on the fixed twin.
- Keep a decoy's `lines` on the lines that look suspicious, not on the whole function, and leave out of a decoy any line that an `acceptable` note already covers.
- A line range is matched exactly when the finding names a function. The 3-line tolerance applies only to findings that name none, so a target does not swallow the function next to it.

Directories whose name starts with `_` or `.` are not loaded as cases. Pairs still being written live under `private/staging/` and are moved to `private/cases/` once their proofs pass; a pair in `private/cases` or `cases` must be listed in one of the sets of `protocol.json`.
