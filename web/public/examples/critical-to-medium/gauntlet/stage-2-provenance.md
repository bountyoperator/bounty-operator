# Review
Verdict: submit
Mode: bounty
Counts: critical=0 high=0 medium=0 hardening=0 checked-safe=3
Headline: Unprivileged stake() without settlement drains the reward reserve, which breaks Rule 1. File it as Medium; principal is untouched.

## Actors
- funder starts a period | funder | the 70,000 TSR amount, supplied by the funder in normal operation before the attack | trusted | input-2/test/ReserveDrain.t.sol:49-52
- Alice and Bob stake | Alice, Bob | 600,000 and 400,000 TSR, supplied by themselves through the public stake() | victim | input-2/test/ReserveDrain.t.sol:55-56
- six days pass | none (clock) | the 6-day elapsed time, supplied by the harness warp | unprivileged | input-2/test/ReserveDrain.t.sol:69
- attacker acquires capital | attacker | 1,166,666 TSR, minted by the harness in place of a flash loan | unprivileged | input-2/test/ReserveDrain.t.sol:72-73
- stake without settlement | attacker | the fresh account's paidPerToken of 0, set by the contract because stake() never calls _settle | unprivileged | input-1/src/TesseraStaking.sol:87-94
- claim | attacker | the amount earned() returns, 69,999 TSR, computed from the attacker's balance × rewardPerToken | unprivileged | input-1/src/TesseraStaking.sol:72-73; input-1/src/TesseraStaking.sol:110-120
- withdraw principal | attacker | size, supplied by the attacker | unprivileged | input-1/src/TesseraStaking.sol:97-107

No decisive step needs the owner key or the funder key. The funder's only step is routine funding.

## Intent
- input-1/src/TesseraStaking.sol:87-94 | Rule 1 says "An account is settled before its balance changes" (input-1/src/TesseraStaking.sol:18). The NatSpec says "Rewards start to accrue from this block" (input-1/src/TesseraStaking.sol:86). No project test or known-issue covers it (input-4/docs/known-issues.md:7-15). | not-intended
- input-1/src/TesseraStaking.sol:115-117 (draft step 6: payouts reach principal) | Rule 2 says "Rewards are paid from rewardReserve and from nothing else" (input-1/src/TesseraStaking.sol:19), and the reserve cap enforces it. | intended
- input-1/src/TesseraStaking.sol:123-126 (draft step 7: exit() reverts) | Audit note N-1 calls this "Acknowledged, by design", and withdraw() never reads the reserve (input-4/docs/known-issues.md:13). It is on the out-of-scope list. | intended

## Counterfactual
- with the bug step (no _settle in stake) | The attacker gains 69,999 TSR. rewardReserve falls to 1 wei. Alice's and Bob's ~60,000 TSR of accrued rewards, plus the day-7 stream, cannot be claimed until the funder refunds. Principal of 1,000,000 TSR stays withdrawable. | The attacker gains 69,999 TSR of reward budget.
- without it (_settle after _updateGlobal at input-1/src/TesseraStaking.sol:89) | paidPerToken[attacker] equals rewardPerTokenStored, so claim() returns 0 at input-1/src/TesseraStaking.sol:114. The attacker withdraws exactly size. The reserve stays at 70,000 TSR and Alice and Bob claim normally. | The bug step is the whole gain.
- root | The loss comes from an unsettled paidPerToken. It is not KI-1 (zero supply), KI-2 (funder rate change) or N-2 (rounding), see input-4/docs/known-issues.md:7-15. | This is a new mechanism, not an accepted one.

The loss is durable. The 69,999 TSR sits in an attacker address, not in a recovery address. A later funder top-up repays the stakers out of the programme's budget; it does not reverse the theft.

## Preconditions
- An active funded period with rewardPerToken > 0 | the funder, as normal operation | the funder calls notifyReward routinely (input-1/src/TesseraStaking.sol:129-140). In live state rewardPerTokenStored only grows from deployment, so a fresh deployment is not required. | reachable
- Honest stakers with unclaimed accrual | Alice and Bob | public stake() (input-1/src/TesseraStaking.sol:87-94) plus elapsed time | reachable
- An account with paidPerToken == 0 | the attacker | any new address. The value is only written in _settle (input-1/src/TesseraStaking.sol:83). | reachable
- Attacker capital of 1,166,666 TSR for a full drain | the attacker | none cited. The harness mints it as a flash-loan stand-in (input-2/test/ReserveDrain.t.sol:73), and no TSR flash-loan source is supplied. | not-shown
- Attacker capital at any smaller size | the attacker | Gain is size × rewardPerToken, capped by rewardReserve (input-1/src/TesseraStaking.sol:73, :115). Any TSR the attacker holds yields a proportional theft, and the principal is returned. | reachable

The missing flash-loan route bounds only how much the attacker takes per run, not whether the bug is reachable. The verdict therefore does not fall to prove-first.

The filing must be rewritten to the "Medium: Theft of unclaimed rewards" row.
- Theft of principal does not hold. The cap at input-1/src/TesseraStaking.sol:115 makes draft step 6 (input-3/draft-report.md:32) false: with 1 wei left, a repeat claim reverts.
- The freeze claim does not hold. It rests only on exit() reverting (input-2/test/ReserveDrain.t.sol:91-97), which is excluded behaviour under N-1.
- The "1,070,000 TSR" figure (input-3/draft-report.md:83) is unsupported, because the contract balance after the run was not measured.
- The programme pays at the row the proof satisfies, so a Critical claim would be paid as Medium at best.

## Checked and safe
- Reward payout cannot reach principal | input-1/src/TesseraStaking.sol:115-117 | A claim reverts once the reward exceeds rewardReserve, and only rewardReserve is debited.
- Principal withdrawal is independent of the reserve | input-1/src/TesseraStaking.sol:97-107 | withdraw() checks only balanceOf. Alice's and Bob's 1,000,000 TSR stays withdrawable, which upholds Rule 3 at input-1/src/TesseraStaking.sol:20.
- An attacker cannot refill the reserve to repeat the drain | input-1/src/TesseraStaking.sol:130 | notifyReward is restricted to the trusted funder.

## Coverage
Reviewed: input-1/src/TesseraStaking.sol, input-2/test/ReserveDrain.t.sol, input-3/draft-report.md, input-4/docs/known-issues.md, input-5/stage-1-scope.md
Not supplied: a TSR flash-loan or liquidity source (needed only for the full-size drain); a measurement of the contract balance after the PoC run
