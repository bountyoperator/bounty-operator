# Tessera Staking: known issues and audit notes

Synthetic programme material written for this example.

## Known issues (not eligible)

KI-1. Rewards streamed while nothing is staked are credited to nobody. `rewardPerToken()` returns the stored value while `totalStaked` is zero, so that part of a period stays in `rewardReserve`. Acknowledged: the funder rolls it into the next period.

KI-2. A small `notifyReward` in the middle of a period spreads the unstreamed rewards over a new seven days and lowers the rate. Acknowledged: only the funder can call it.

## Audit notes (round 1, fix review)

N-1. `exit()` reverts with `ReserveShort` when the reserve cannot pay the caller's rewards. Acknowledged, by design: `withdraw()` never reads the reserve, so principal can always be taken out, and the claim goes through after the next funding.

N-2. Rounding in `rewardPerToken()` and `earned()` favours the reserve. The dust stays in `rewardReserve`. No action.
