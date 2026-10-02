# Recommended tools

The kit is the layer around a normal security toolbox. None of these tools are
bundled. Install each from its own project.

## Command line

- `git` for commit pinning and history search
- `rg` for searching code and audit text
- `jq` for JSON output
- `python` for small parsers and PoC helpers
- `node` when the target uses JavaScript tooling

## Smart contract review

- Foundry: build, test, fork tests and PoCs
- Slither: static-analysis leads and printers
- Aderyn: a second static-analysis pass for Solidity
- semgrep: custom rules and broad code patterns
- Echidna or Medusa: fuzzing once a property is clear

`bounty-kit slither-focus` cuts Slither JSON down to 13 high-signal detectors
and prints a review queue with `file:line` locations.

## Reference material

`scripts/install-web3-security-references.sh` clones public reference
collections into one local directory so an agent can search them offline.

```bash
bash scripts/install-web3-security-references.sh --list
bash scripts/install-web3-security-references.sh --base-dir ./references SCSVS solcurity
```

Naming no collection downloads nothing. `--all` selects every collection. An
update skips any checkout that is modified, linked, detached or on a non-default
branch, then does a bounded fetch and a fast-forward merge. It never hard-resets.

Collections:

- Learn EVM Attacks
- SCV-List
- Smart Contract Attack Vectors
- DeFi Attack Vectors
- Smart Contract Vulnerabilities
- DeFiHackLabs
- SCSVS
- Solcurity
- Immunefi Web3 Security Library

Search them with:

```bash
rg -n -i "oracle|rounding|slippage|signature|reentrancy|liquidation" ~/web3-security-references/repos
```

## AI skills and agent tooling

Split the work into small jobs and give each one its own pass:

- scope checker
- attack-surface mapper
- scanner-output triager
- PoC reviewer
- duplicate-risk checker
- report editor
- sanitizer

The [prompt library](../prompts) covers five of these. Public audit skill packs
and Solidity review agents slot in at the "run tools" step. Add any of them to
an agent pack by name:

```bash
bounty-kit agent-pack ./agent-pack.md --tool Foundry --tool Slither --tool "your skill pack"
```

Have the agent record what it checked and why it killed each lead. That ledger
is what stops a long hunt from repeating itself.

## Order of work

1. Create the agent pack.
2. Pin scope and commit.
3. Run the tools.
4. Triage the output into the ledger.
5. Build PoCs for the leads that survive.
6. Run the prior-art checks.
7. Sanitize every artifact before it leaves the machine.

## What costs you a submission

- Sending a whole private workspace to an API.
- Copying third-party repositories into your own release.
- Submitting scanner warnings as reports.
- Proving the bug on a stale commit because the PoC is easier there.
- Leaving a precondition out of the report.
- Calling a finding unique before checking audits and public history.
