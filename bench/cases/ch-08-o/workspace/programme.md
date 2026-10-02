# Lanternreel Rewards Programme

## Overview

Lanternreel is a studio collective that pays royalties to its creators through the `ReelPayoutDesk` contract, deployed on Ethereum mainnet. A trusted off-chain signing authority issues signed payout orders to named creators. Creators submit their orders from their own wallets to have a desk balance credited, which can then be withdrawn as a plain 18-decimal ERC-20 token from the desk's reserve.

## Assets in Scope

- `src/ReelPayoutDesk.sol`
- `src/PayoutOrderLib.sol`

## Impacts in Scope

| Severity | Description | Reward |
|----------|-------------|--------|
| Critical | Balance credited or tokens withdrawn that the authority never authorised at all (issuance beyond the limit or without a valid signature); draining the reserve; permanent freezing of the whole reserve. | $50,000 |
| High | Theft, redirection or permanent loss of an amount the authority did authorise for a specific creator (a creator's order or credited balance). | $20,000 |
| Medium | Temporary freezing of funds for 24 hours or more; griefing that costs victims money with no profit to the attacker. | $5,000 |
| Low | Contract fails to deliver promised behaviour without loss of value. | $1,000 |

Severity is assessed on the impact the proof of concept demonstrates.

## Proof-of-Concept Requirements

A runnable Foundry test against the in-scope source as written, driving the contracts through their external and public functions. The report must state the attacker's starting privileges.

## Out of Scope / Exclusions

- Attacks that require the owner or the authority to act maliciously or to leak a key.
- Issues in the ERC-20 token itself.
- Gas optimisations.
- Best-practice notes without a demonstrated impact.
- Non-standard tokens (only a plain 18-decimal token is used).

Attacks requiring only public mempool visibility are explicitly in scope.

## Trusted Roles

- Owner (a multisig): ownership transfer, authority rotation, issuance limit, halting and resuming order processing, sweeping reserve tokens that are not owed to creators.
- Authority: signs payout orders.

## Known Issues

None at the time of writing.
