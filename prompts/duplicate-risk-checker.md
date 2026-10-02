# Duplicate-Risk Checker Prompt

Review the finding for duplicate or known-issue risk.

Do not decide by title similarity. Compare:

- root cause
- affected code
- exploit path
- preconditions
- impact
- likely fix

Check these sources when available:

- known issues
- audit reports
- repo issues
- repo pull requests
- commit history
- docs and changelogs
- public web
- GitHub code search
- forum or social posts
- prior local submissions

Output:

```text
Duplicate risk: Low | Medium | High | Unknown
Sources checked:
Closest matches:
Same root cause? Yes | No | Unclear
Why:
Wording changes:
Blind spots:
```

If private reports are not visible, say that as a limitation. Do not imply the
finding is unique unless the checked sources support it.
