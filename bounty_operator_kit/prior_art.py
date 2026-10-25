from __future__ import annotations

import re
import shlex


# git log -G reads a POSIX extended regex; a backslash before any other character is undefined there.
_ERE_SPECIAL = re.compile(r"([.\[\\()*+?{|^$])")


def _first_line(summary: str) -> str:
    for line in summary.splitlines():
        line = line.strip("# ").strip()
        if line:
            return line
    return "Finding summary"


def build_prior_art_checklist(*, summary: str, target: str, program: str = "", repo: str = "") -> str:
    title = _first_line(summary)
    # The searches are literal: as a regex, a title such as "withdraw()" silently misses
    # its own text, and "[" or a leading "-" makes the command fail.
    quoted_title = shlex.quote(title)
    # -G, not -S: -S counts occurrences, so it skips a fix commit that edits a line and keeps the title.
    quoted_title_pattern = shlex.quote(_ERE_SPECIAL.sub(r"\\\1", title))
    quoted_target = shlex.quote(target)
    repo_text = repo or "TBD"

    return f"""# Prior-Art Checklist

Finding: {title}
Target: {target}
Program: {program or "TBD"}
Repo: {repo_text}

## Compare by root cause

Do not compare only by title. Check whether another item has the same:

- affected component
- vulnerable state transition
- exploit preconditions
- attacker action
- impact
- likely fix

## Local checks

Run these from the target repository when possible:

```bash
rg -n -i -F -e {quoted_title} .
rg -n -i -F -e {quoted_target} .
git log --oneline --all -i -F --grep={quoted_title}
git log --oneline --all -i -G{quoted_title_pattern} -- .
```

Also search:

- `README`, docs, and changelogs
- `audits`, `security`, `reports`, and `known-issues` folders
- open and closed GitHub issues
- open and closed pull requests
- any visible contest comments or judging notes

## Public checks

Search the web for:

```text
"{title}" "{target}"
"{target}" audit "{title}"
"{target}" known issue
"{target}" bug bounty "{title}"
```

Check GitHub code search, public audit reports, forum posts, and Reddit threads when relevant.

## Decision

Disposition: Unknown

| Date checked | Link | Root cause | Entry point | Exploit method | Proposed fix | Same root/fix? |
|---|---|---|---|---|---|---|
| TBD | TBD | TBD | TBD | TBD | TBD | TBD |

## Strongest likely rejection

- Exact prior-art, scope, or impact objection: TBD
- Evidence that resolves it: TBD

## Stop condition

If a prior source describes the same root cause, or a prior fix would also fix
this candidate, set the disposition to **HOLD — known/duplicate risk**. Adding a
stronger PoC or disclosing the overlap does not clear the hold. Lift it only with
specific evidence of a distinct vulnerability under the current program rules,
including why the prior fix would not address it.

Remaining blind spots:

- Private submissions are usually not visible.
- A fix PR can reveal prior knowledge even when no report is public.
- Similar symptoms can share the same root cause.
- A clean public search cannot rule out private prior knowledge.
"""
