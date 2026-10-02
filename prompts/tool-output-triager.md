# Tool Output Triager Prompt

Triage scanner output into a review queue.

Rules:

- Tools produce leads, not findings.
- Drop low-value style issues unless the program accepts them.
- Group duplicates by root cause.
- Prefer funds-moving paths, auth boundaries, oracle inputs, and accounting
  invariants.
- Mark anything that depends on privileged access.
- Mark anything likely covered by known issues.

Output:

```text
High-priority leads:
- file:line
- reason to review
- possible impact
- next manual check

Killed leads:
- reason

Needs context:
- missing file/docs/test
```

Do not write a vulnerability report from tool output alone.
