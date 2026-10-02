# Bug bounty report templates

The single generic template that used to live here is replaced by one template per platform. Each is built from what that platform publishes about submissions and judging, with the rules that get reports closed listed beside it. Rules checked 2 Oct 2026.

## Templates

| Platform | Page | Markdown |
| --- | --- | --- |
| Immunefi | https://bountyoperator.com/templates/immunefi | https://bountyoperator.com/templates/immunefi.md |
| Sherlock | https://bountyoperator.com/templates/sherlock | https://bountyoperator.com/templates/sherlock.md |
| Cantina | https://bountyoperator.com/templates/cantina | https://bountyoperator.com/templates/cantina.md |
| HackerOne | https://bountyoperator.com/templates/hackerone | https://bountyoperator.com/templates/hackerone.md |

Foundry proof-of-concept scaffold: https://bountyoperator.com/templates/foundry-poc
Scaffold file: https://bountyoperator.com/templates/ImpactPoC.t.sol

All templates: https://bountyoperator.com/templates

## What every template carries

1. Title rule: mechanism and consequence in one sentence, in the platform's own title shape.
2. Summary: what breaks and who loses, before any code.
3. Exact location: file and lines on a pinned commit, or the URL, parameter and build.
4. Impact, mapped: the programme's impact row or severity threshold, quoted, with the measured number beside it.
5. Proof of concept: the code, the command and the pasted output.
6. Recommended fix: the change, as a diff where it fits.
7. Limits and non-claims: what the report does not say, what was mocked, when the path stops working.
8. Known-issue comparison: the nearest known issue, named, and the difference in root cause.

## After you fill one in

Challenge the draft before the triager does: https://bountyoperator.com/?profile=report#workspace
Run the free report check: https://bountyoperator.com/tools/report-check
