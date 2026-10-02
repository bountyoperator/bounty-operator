> Sherlock report template from https://bountyoperator.com/templates/sherlock. Platform rules checked 2 Oct 2026.
> Replace every {placeholder}. Delete this note before you submit.

# {Actor} will {impact} {affected party}

### Summary

{Root cause, with the file} will cause {impact} for {affected party} as {actor} will {the path in a few words}.

### Root Cause

In `{path/File.sol}` lines {start}-{end} at the contest commit `{commit}` ({permalink}), {the mistake: the missing check, the wrong order, the unsafe cast}.

```solidity
{The smallest excerpt that shows it}
```

### Internal pre-conditions

1. {Role} needs to call `{function}` to set `{variable}` to be {at least, at most or exactly} `{value}`
2. {Contract state that has to hold, with the number}

{Write "None" when the path works from any state.}

### External pre-conditions

1. {External condition with numbers, for example a 12% price move inside one block}

{Write "None" when the path needs nothing outside the protocol.}

### Attack Path

1. {Actor} calls `{function}` with {arguments}. {State after the call.}
2. {Actor} calls `{function}` with {arguments}. {State after the call.}
3. {Final state, with the number.}

### Impact

{Affected party} lose {amount}, which is {percentage} of their {principal, yield or fees}. The attacker gains {amount, or nothing when this is griefing}.

Severity claimed: {High or Medium}, because {the threshold the number clears}.

### PoC

Command: `{forge test --match-test test_name -vvv}` on the contest commit.

```solidity
{The test}
```

```text
{Pasted output, with the final assertion and the measured loss}
```

### Mitigation

{The change, in the file and function it belongs to.}

```diff
- {vulnerable line}
+ {fixed line}
```

### Limits and non-claims

- Not claimed: {what this report does not say, for example no loss beyond the funds held at this address}
- Mocked or assumed: {each mock and assumption, or "nothing: every step runs the deployed code"}
- Stops working when: {the condition that breaks the path}

### Known issues checked

- Contest README, known issues and acceptable risks: {the nearest item, why this differs}
- Earlier contests, `wont fix` issues: {issue link, or "none on this code"}
- Audits linked in the README, acknowledged findings: {report and finding id, why the root cause differs}
