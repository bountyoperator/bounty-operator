> Immunefi report template from https://bountyoperator.com/templates/immunefi. Platform rules checked 2 Oct 2026.
> Replace every {placeholder}. Delete this note before you submit.

# {Vulnerability class} in `{function}` lets {actor} {consequence, worded as the programme words the impact}

## Brief/Intro

{What is broken, in which contract, and what an attacker does with it. Then the consequence: whose funds, how much, at which block.}

## Vulnerability Details

- Asset in scope: {name and address, exactly as listed under Assets in Scope}
- Source: {repository URL} at commit `{40-character commit}`
- Location: `{path/Contract.sol}` lines {start}-{end}, function `{name}`
- Deployed code matches this commit: {how you checked: verified source, bytecode hash or release tag}

Root cause: {the one line or missing check that opens the path, and why the surrounding checks do not stop it}

```solidity
{The smallest excerpt that shows the root cause, with its line numbers}
```

Attack path:

1. {Actor} calls `{function}` with {concrete arguments}. {State after the call.}
2. {Actor} calls `{function}` with {concrete arguments}. {State after the call.}
3. {Final state: the balance, owner or record that is now wrong, with the number.}

Every step is a public call from an account that holds no role. {If a step needs a role, a signature or an action by the victim, name it here.}

## Impact

- Impact selected, quoted from the programme: "{exact text of the impact}"
- Severity that impact sits under in the programme's table: {Critical, High, Medium or Low}
- Who loses: {users, the protocol or liquidity providers} lose {amount and token} of {total at risk at the fork block}
- Loss measured by the PoC: {the number from the output below}
- Recovery: {whether a pause, an upgrade or an admin action returns the funds, and how long that takes}

## Risk Breakdown

- Difficulty: {capital needed, timing, number of transactions}
- Preconditions, and how each is reached from live state: {list}
- Privileges or user interaction needed: {none, or which}
- Programme downgrade clauses checked: {the clause, and why it does or does not apply}

## Recommendation

{The change, in the file and function it belongs to.}

```diff
- {vulnerable line}
+ {fixed line}
```

## Proof of Concept

Runs on a local fork. No transaction was sent to mainnet or a public testnet.

- File: `{test/ImpactPoC.t.sol}`
- Fork: {chain} at block {number}
- Command: `{forge test --match-path test/ImpactPoC.t.sol -vvv}`

```solidity
{The full test file}
```

Output:

```text
{Pasted output, with the final assertion and the measured numbers}
```

Control: {the same sequence without the bug step, and its output: no loss}
After the fix: {the same test on the patched build, and its failing line}

## Limits and non-claims

- Not claimed: {what this report does not say, for example no loss beyond the funds held at this address}
- Mocked or assumed: {each mock and assumption, or "nothing: every step runs the deployed code"}
- Stops working when: {the condition that breaks the path}

## Known issues checked

- Programme known issues and acknowledged risks: {date checked, the nearest item, why this differs}
- Audits linked by the programme: {report and finding id, why the root cause or the fix differs}
- Public issues, pull requests and team branches: {what you searched, the nearest match, the difference}

## References

- {Code at the pinned commit}
- {Documentation or specification the expected behaviour comes from}
- {Deployed contract on the block explorer}
