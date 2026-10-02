from __future__ import annotations

from datetime import datetime, timezone


def build_ledger(
    *,
    target: str,
    program: str,
    repo: str = "",
    commit: str = "",
    scope_file: str = "",
    program_url: str = "",
    program_verified: str = "",
    deployed_target: str = "",
    deployment_evidence: str = "",
) -> str:
    created = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    return f"""# Hunt Ledger: {target}

Created: {created}

## Target

- Program: {program}
- Program URL: {program_url or "TBD"}
- Program terms last verified: {program_verified or "TBD"}
- Repository: {repo or "TBD"}
- Commit or deployed version: {commit or "TBD"}
- Exact deployed target: {deployed_target or "TBD"}
- Deployment/source evidence: {deployment_evidence or "TBD"}
- Scope file: {scope_file or "TBD"}

## Hard Gates

- [ ] Scope and out-of-scope rules read
- [ ] Severity table read
- [ ] Known issues and accepted risks read
- [ ] Current commit or deployed code pinned
- [ ] Deployed source or bytecode matched to the reviewed code
- [ ] Prior audits collected
- [ ] Public docs collected
- [ ] Test suite/build status captured

## Attack Surface

| Area | Files or contracts | Value at risk | Notes |
|---|---|---|---|
| Core accounting | TBD | TBD | |
| Oracle or pricing | TBD | TBD | |
| Access control | TBD | TBD | |
| External calls | TBD | TBD | |
| Upgrade or config | TBD | TBD | |

## Tool Runs

| Tool | Command | Output | Result |
|---|---|---|---|
| build | TBD | TBD | TBD |
| tests | TBD | TBD | TBD |
| slither | TBD | TBD | TBD |
| aderyn | TBD | TBD | TBD |

## Leads

| ID | Lead | Status | Reason |
|---|---|---|---|
| L-001 | TBD | Open | |

Status values: Open, Killed, Needs PoC, PoC Passed, HOLD — known/duplicate risk, Ready.

## Duplicate-Risk Checks

- [ ] Repo issues searched
- [ ] Repo pull requests searched
- [ ] Commit history searched
- [ ] Docs searched
- [ ] Audit PDFs searched
- [ ] Public web searched
- [ ] Forums or community posts searched
- [ ] Prior own submissions checked

For every close match, record a dated link and compare root cause, entry point,
exploit method, and likely fix. If a prior source has the same root cause or its
fix would also fix this lead, mark it **HOLD — known/duplicate risk**. A stronger
PoC does not clear that hold. Public searches cannot rule out private prior knowledge.

## Strongest Likely Rejection

- Exact prior art, scope, or impact objection: TBD
- Evidence that resolves it: TBD
- If unresolved: HOLD — known/duplicate risk

## Report Readiness

- [ ] Root cause is in scope
- [ ] Exploit path uses current code
- [ ] PoC runs from a clean checkout
- [ ] Impact maps to accepted severity text
- [ ] Preconditions are clear
- [ ] Duplicate-risk summary is written
- [ ] Strongest likely rejection is resolved with evidence
- [ ] Report text has no internal notes or local-only paths
- [ ] Sanitizer passes before sharing artifacts
"""
