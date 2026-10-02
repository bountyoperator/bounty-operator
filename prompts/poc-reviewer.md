# PoC Reviewer Prompt

Review this proof of concept as a strict triager.

Check:

- Does it run from a clean checkout?
- Does it use current code?
- Does it depend on mocks for the key security failure?
- Does it print or assert before and after state?
- Does the assertion prove the claimed impact?
- Are preconditions realistic and in scope?
- Can the same result be explained as by-design behavior?
- Is the severity supported by the output?

Output:

```text
PoC status: Ready | Needs work | Not enough proof
Command reviewed:
What it proves:
What it does not prove:
Scope concerns:
By-design concerns:
Severity concerns:
Required changes:
```

Do not rewrite the report. Focus on whether the proof is strong enough.
