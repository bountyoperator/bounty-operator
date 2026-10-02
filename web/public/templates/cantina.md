> Cantina report template from https://bountyoperator.com/templates/cantina. Platform rules checked 2 Oct 2026.
> Replace every {placeholder}. Delete this note before you submit.

# {Mechanism} in `{function}` lets {actor} {consequence}

## Summary

{What is wrong and what it leads to. Name the function and the affected party.}

## Finding Description

- Location: `{path/File.sol}` lines {start}-{end} on `{audit branch}` at commit `{commit}`
- Root cause: {the mistake, and why the surrounding checks do not stop it}

```solidity
{The smallest excerpt that shows the root cause}
```

Path:

1. {Actor} calls `{function}` with {arguments}. {State after the call.}
2. {Actor} calls `{function}` with {arguments}. {State after the call.}
3. {Final state, with the number.}

## Impact Explanation

Impact: {High, Medium or Low}. {Affected party} lose {amount}, or {the core function that stops working and for how long}.

Measured by the PoC: {the number from the output below}.

## Likelihood Explanation

Likelihood: {High, Medium or Low}. {Who triggers it, what they need, and how each precondition is reached from the current state.}

Severity claimed: {High, Medium or Low}, from the matrix on {the competition or programme page you used}.

## Proof of Concept

- Test file: `{test/path/File.t.sol}`, added to the project's own suite
- Branch and commit: `{audit branch}` at `{commit}`
- Extra setup: {none, or what the reviewer installs or sets}
- Command: `{forge test --match-test test_name -vvv}`

```solidity
{The test}
```

Output:

```text
{Pasted output}
```

Expected against actual: {what a correct implementation prints, and what this prints}

## Recommendation

{The change, in the file and function it belongs to.}

```diff
- {vulnerable line}
+ {fixed line}
```

## Limits and non-claims

- Not claimed: {what this report does not say, for example no loss beyond the funds held at this address}
- Mocked or assumed: {each mock and assumption, or "nothing: every step runs the deployed code"}
- Stops working when: {the condition that breaks the path}

## Known issues checked

- Competition README or programme page, known issues: {the nearest item, why this differs}
- Previous reports on this code: {report and finding id, why the root cause differs}
- Intended behaviour per the README: {the sentence that shows this is not by design}
