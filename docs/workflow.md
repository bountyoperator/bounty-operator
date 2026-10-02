# Workflow

```text
scope -> commit -> tools -> triage -> PoC -> prior art -> report -> sanitize
```

## 1. Pin the target

Before writing a PoC, record:

- the programme page and the time its terms were read
- repository URL and commit
- the exact deployed address or release
- how the deployed source or bytecode was matched to that commit
- docs version, scope files and known issues

Code that is out of scope gets no further time.

## 2. Build a ledger

```bash
bounty-kit init-ledger ./ledger.md --target "Target" --program "Program"
```

Keep killed leads in the ledger with the reason. A killed lead explains why a
later idea is already covered.

## 3. Use scanners for leads

Run Slither, Aderyn, semgrep and the project's own tests. Each warning is a
place to look. None of them is a report.

For Slither JSON:

```bash
bounty-kit slither-focus slither.json --markdown > slither-focus.md
```

## 4. Prove the path

A report needs a concrete path:

1. setup
2. exact calls
3. before and after state
4. impact in the programme's own severity language
5. the command that reproduces the result

If the path needs privileged access, unusual admin behaviour, stale code or a
mocked failing condition, write that in the ledger before going further.

## 5. Check prior art

```bash
bounty-kit prior-art finding.md --target "Target" --repo "https://github.com/org/repo"
```

The command prints the searches to run. Run them, record dated links, and
compare each match by root cause, entry point, exploit method and likely fix.

If a prior source has the same root cause, or its fix would also fix the lead,
mark it `HOLD — known/duplicate risk`. A stronger PoC does not lift the hold.
Private submissions are invisible to a public search, so an empty search result
lowers the risk and leaves it above zero.

For acceptance history by pattern:

```bash
bounty-kit pattern-stats rounding oracle-manipulation
```

The output is accepted and rejected counts per pattern tag from 10 public
Sherlock contests, 1,032 findings in total.

## 6. Sanitize before sharing

```bash
bounty-kit sanitize .
```

Run it before publishing a repository, creating a gist, sending a zip or
attaching a PoC. Browser profiles, private platform URLs and target-specific
reports stay out of public repositories.

## Writing style

Report text stays plain:

- concrete nouns and commands
- no filler
- no claim the PoC does not prove
- no stock transitions
- no private working notes
- no local machine names or folders unless they are needed to reproduce

A good report reads like the work of someone who ran the test.
