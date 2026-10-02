# Quoinhall Security Rewards Programme

Quoinhall is an English-auction saleroom for ERC-721 items. Sellers consign an item as a lot, bidders place ETH offers, and the highest offer at the close wins. This page sets out what is in scope, how reports are rated and what is not eligible.

## Assets in scope

- **Repository:** `quoinhall-contracts`
- **Asset in scope:** `src/QuoinhallSaleroom.sol` at tag **v1.1.0** (the deployed version)

Only the tagged source is in scope. Branches, the test suite and deployment scripts are not.

## Severity and rewards

Severity is decided by the impact that the proof of concept demonstrates on the scoped code, read against this table.

| Severity | Impact | Reward |
| --- | --- | --- |
| Critical | Direct theft of escrowed ETH or consigned items; permanent freezing of escrowed ETH or consigned items; protocol insolvency. | Up to $50,000 |
| High | Theft or permanent freezing of unclaimed refunds or accrued fees; temporary freezing of ETH or items for more than 7 days. | Up to $15,000 |
| Medium | Temporary freezing of ETH or items for at least 24 hours and at most 7 days; griefing that costs a victim funds without attacker profit. | Up to $5,000 |
| Low | A function behaves contrary to its NatSpec or to this page with no funds at risk. | Up to $1,000 |

A report is rated by the row its demonstrated impact fits. An impact that fits no row is not eligible.

## Trusted roles

The `owner` is trusted. The owner sets the fee and the fee recipient, can pause new consignments and sweeps accrued fees. Reports that need the owner to act maliciously or carelessly are out of scope.

Sellers and bidders are untrusted. Consigning, placing offers, concluding a lot and collecting an item are permissionless.

## Prior review

Kestrel Vane reviewed v1.0.0 in February 2026. All findings were resolved or acknowledged before v1.1.0 was tagged (see `CHANGELOG.md`).

| Id | Finding | Status |
| --- | --- | --- |
| KV-01 | Reentrancy on seller payout | Fixed in v1.1.0: lock on every function that moves ETH or items |
| KV-02 | Push refunds let a reverting bidder block later offers | Fixed in v1.1.0: pull-based refunds |
| KV-04 | Dust reserves allow spam lots | Fixed in v1.1.0: `MIN_RESERVE` |
| KV-09 | Last-block sniping lets a bidder win without contest | Fixed in v1.1.0: soft close for late offers |
| KV-11 | Single-step ownership transfer | Fixed in v1.1.0: two-step transfer |
| KV-12 | Unbounded lot durations | Fixed in v1.1.0: `MIN_DURATION` and `MAX_DURATION` |

The remaining ids were informational and needed no change.

## Out of scope

- Behaviour introduced as the remediation of a prior review finding is intended design. Reports against it are out of scope unless the report demonstrates that the remediation can be bypassed.
- Gas optimisations.
- Style or best-practice notes without a demonstrated impact.
- Anything that needs the trusted owner to act maliciously.
- Impacts on third-party front ends or off-chain infrastructure.
- Theoretical issues without a runnable proof of concept.

## Known issues (acknowledged, not eligible)

- **KI-1:** A seller may place offers on their own lot from another address.
- **KI-2:** A fee change applies to lots that are already open.
- **KI-3:** A seller contract that rejects ETH cannot be paid by `conclude()`. The winner can still collect the item.
- **KI-4:** Collections are not vetted. Bidders are expected to check the collection address of a lot before they offer.

## Submission requirements

- A runnable Foundry proof of concept against the scoped tag, with its output.
- The impact mapped to one row of the severity table, quoting the row.
- One issue per report. Reports with the same root cause as an earlier report are closed as duplicates.
