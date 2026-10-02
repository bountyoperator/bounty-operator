# Review
Verdict: rewrite-then-submit
Mode: bounty
Counts: critical=0 high=0 medium=0 hardening=1 checked-safe=4
Headline: The stake() checkpoint bug is real, but it drains only rewardReserve: principal stays backed and withdrawable, so claim Medium reward theft

## Binding
- TesseraStaking | tessera-staking, src/TesseraStaking.sol | release v1.2.0 | release v1.2.0, local Foundry run, no fork | bound | input-1/src/TesseraStaking.sol:87-94. The snippet in input-3/draft-report.md:15-21 matches it verbatim. The draft's range 87-95 runs one line past the function's closing brace at :94. The PoC in input-3/draft-report.md:44-67 matches input-2/test/ReserveDrain.t.sol:67-98 apart from the omitted log lines. The header at input-1/src/TesseraStaking.sol:11 marks the file synthetic, as is the whole programme, and does not mark it unreleased.

## Exclusions
- "Out of scope: anything listed in docs/known-issues.md" (N-1: "`exit()` reverts with `ReserveShort` when the reserve cannot pay the caller's rewards. Acknowledged, by design") | match | The draft's freezing claim rests only on `exit()` reverting (input-2/test/ReserveDrain.t.sol:91-97). That is the acknowledged behaviour at input-4/docs/known-issues.md:13. `withdraw()` stays callable (input-1/src/TesseraStaking.sol:97-107).
- "KI-1. Rewards streamed while nothing is staked are credited to nobody" | clear | The root cause is the missing `_settle` in stake(), not the zero-supply branch at input-1/src/TesseraStaking.sol:65.
- "KI-2. A small `notifyReward` in the middle of a period ... lowers the rate" | clear | The attack makes no notifyReward call. The only funding happens in setUp (input-2/test/ReserveDrain.t.sol:52).
- "N-2. Rounding in `rewardPerToken()` and `earned()` favours the reserve" | clear | The loss comes from an unsettled `paidPerToken`, not from rounding.
- "attacks that need the owner key or the funder key" / "Trusted roles: owner, funder." | clear | stake, claim and withdraw are called by an attacker with no role (input-2/test/ReserveDrain.t.sol:75-79). The funder only funds in normal operation.
- "behaviour of third-party tokens" | clear | TestToken is a plain ERC-20 (input-2/test/ReserveDrain.t.sol:8-33). The defect is in input-1/src/TesseraStaking.sol:87-91.

## Impact row
- actor | "Direct" | The attacker, holding no role, calls stake/claim/withdraw in one sequence (input-2/test/ReserveDrain.t.sol:75-79). | satisfied
- asset | "staked principal" | none. The payout is capped by `reward > rewardReserve` and debited from `rewardReserve` (input-1/src/TesseraStaking.sol:115-117). The run leaves 1 wei of reserve and about 1,000,000 TSR of principal backing Alice's and Bob's `totalStaked`. The contract balance after the run was not measured. | not-satisfied
- recipient | "theft" (attacker gains) | `assertEq(tsr.balanceOf(attacker), size + stolen)` (input-2/test/ReserveDrain.t.sol:87). The gain is reward tokens, not principal. | satisfied
- mechanism | "theft of staked principal" | none. Draft step 6 (input-3/draft-report.md:32) says repeating the attack takes the remaining TSR. With 1 wei left, any repeat claim reverts with ReserveShort (input-1/src/TesseraStaking.sol:115). Rule 3 (input-1/src/TesseraStaking.sol:20) also holds: `withdraw()` never reads the reserve. | not-satisfied

## Row to claim
Selected: "Critical: Direct theft of staked principal"
Fits: "Medium: Theft of unclaimed rewards". Six days into the period, Alice and Bob have accrued about 60,000 TSR that they have not claimed. The attacker takes 69,999 TSR of the 70,000 TSR reserve through `earned()` on an unsettled balance (input-1/src/TesseraStaking.sol:72-73), proven by input-2/test/ReserveDrain.t.sol:88 and the log line "reserve left (wei) 1". The rewrite should do four things:
- Drop both Critical rows and the "1,070,000 TSR" figure (input-3/draft-report.md:83).
- Drop step 6 and the permanent-freeze claim in step 7 (input-3/draft-report.md:32-33).
- Assert that `earned(alice) + earned(bob)` exceeds `rewardReserve()` after the attack.
- Assert that `withdraw` still succeeds for Alice, so the report does not claim the excluded N-1 freeze.

## Hardening
- Settle on stake | input-1/src/TesseraStaking.sol:89-90 | Add `_settle(msg.sender)` after `_updateGlobal()`, as the draft proposes (input-3/draft-report.md:90-92). This upholds Rule 1 at input-1/src/TesseraStaking.sol:18.

## Checked and safe
- Reward payout cannot reach principal | input-1/src/TesseraStaking.sol:115 | The claim reverts once the reward exceeds `rewardReserve`, so stakers' deposits never fund rewards.
- Principal withdrawal is independent of the reserve | input-1/src/TesseraStaking.sol:97-107 | `withdraw()` checks only `balanceOf` and transfers principal. Alice's and Bob's 1,000,000 TSR remains withdrawable.
- Reserve accounting is debited before the transfer | input-1/src/TesseraStaking.sol:116-118 | `accrued` and `rewardReserve` are cleared before `token.transfer`, so a re-entering token cannot pay out twice.
- Funding is restricted | input-1/src/TesseraStaking.sol:130 | Only the trusted funder can call `notifyReward`, so an attacker cannot refill the reserve and repeat the attack.

## Coverage
Reviewed: input-1/src/TesseraStaking.sol, input-2/test/ReserveDrain.t.sol, input-3/draft-report.md, input-4/docs/known-issues.md
Not supplied: none
