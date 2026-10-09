# Security policy

## Reporting a vulnerability

Email **security@bountyoperator.com**, or use <!-- bounty-kit: allow -->
[GitHub private vulnerability reporting](https://github.com/bountyoperator/bounty-operator/security/advisories/new)
on this repository. Both reach the maintainers privately.

Do not open a public issue, pull request or discussion for a security problem.

Include:

- the affected surface and version, or the time of the request for the hosted site
- a minimal reproduction
- the impact: what an attacker reads, changes or spends
- a proposed fix, if you have one

Remove secrets and other people's data from anything you attach.

## In scope

- **The hosted site**, `bountyoperator.com`: the Worker and its API routes,
  passkey sign-in and recovery, sessions and CSRF, connection tokens, quota and
  concurrency limits, billing state, the MCP endpoint at `/api/mcp`, the
  content security policy and the static pages.
- **The MCP server**, the `bounty-operator-mcp` package in `mcp/`.
- **The CLI**, the `bounty-operator-kit` Python package: the sanitizer, the
  `ai-review` request path, file reads and writes.
- **The review engine** in `web/public/`: input checks, request assembly,
  review parsing and packet rendering. Model output and pasted text are treated
  as untrusted, so a way to make either one execute script, load a remote
  resource or leave the page is a vulnerability.

## Testing rules for the hosted site

- Use accounts you created. Do not read, change or delete another account's data.
- Keep request volume low. No denial-of-service testing and no automated
  scanning of the production site.
- Do not test payments against the live checkout. Billing logic is in
  `web/src/` and runs locally with `BILLING_MODE="disabled"`.
- Run everything else locally first. `docs/website.md` has the setup.
- Stop at the first proof of a problem and report it.

## Out of scope

- Vulnerabilities in a bounty target you reviewed with the tool. Those go to
  that programme's own disclosure channel.
- Review quality. A wrong or missed finding gets a normal issue with an input
  that reproduces it and is safe to publish: never an unreported finding or a
  draft report.
- Findings from an automated scanner with no demonstrated impact.

## Supported versions

Fixes land on `main` and in the next release. The hosted site always runs the
current release.
