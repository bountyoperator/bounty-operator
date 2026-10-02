> HackerOne report template from https://bountyoperator.com/templates/hackerone. Platform rules checked 2 Oct 2026.
> Replace every {placeholder}. Delete this note before you submit.

# {Vulnerability type} in {feature or endpoint} allows {what the attacker does}

## Summary

- Asset: {the in-scope asset, exactly as the programme lists it}
- Weakness: {the weakness you selected on the form}
- Severity: {None, Low, Medium, High or Critical}, vector `{CVSS vector in the version the programme uses}`
- Tested on: {URL or build}, {version, release or commit}, {date and time in UTC}

{One paragraph: what the vulnerability is and what an attacker gets from it.}

## Steps to Reproduce

Accounts: {attacker account and its role}, {victim account and its role}. Both are test accounts you own.

1. {Log in as the attacker account and open the URL.}
2. {Send this request, with the parameter and the value.}
3. {Observe the response or the state change, with the exact value.}

## Expected vs Actual Behavior

- Expected: {what the application should do, and the source of that rule}
- Actual: {what it does}

## Impact

{What the attacker reads, changes or takes over, for which users, and how many.}

- Preconditions: {none, or what the attacker needs first}
- User interaction: {none, or what the victim has to do}
- Mitigations already in place that do not stop it: {list}

## Supporting Material

```http
{The request}
```

```http
{The response, trimmed to the part that proves the point}
```

Attached: {file names of screenshots or the recording}

## Remediation

{The check that is missing and where it belongs.}

## Limits and non-claims

- Testing stopped at: {the point you stopped, for example after reading one record of your own second account}
- Not claimed: {what this report does not say, for example no access to other tenants}
- Depends on: {browser, configuration or feature flag the behaviour needs}

## Known issues checked

- Programme policy, exclusions and known issues: {date checked, the nearest item, why this differs}
- Disclosed reports on this programme: {the nearest report, why the root cause or the endpoint differs}
- Core ineligible findings: {the nearest category, and the demonstrated impact that takes this out of it}
