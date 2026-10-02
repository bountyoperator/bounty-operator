# Review
Verdict: rewrite-then-submit
Mode: bounty
Counts: critical=0 high=0 medium=0 hardening=0 checked-safe=3
Headline: Missing settle in stake() matches no supplied item. N-1 shares only the exit() freeze symptom, so rewrite as Medium reward theft.

## Fingerprint
Root cause: TesseraStaking's `stake()` updates the global accumulator but never checkpoints the caller's `paidPerToken`. A new balance is therefore credited with every reward streamed since the account was last settled, which is all rewards since deployment for a fresh address.
Invariant: An account's reward checkpoint must equal the global reward-per-token at the moment its balance increases, so that rewards accrue only on stake held over time.
Entry point: stake(), input-1/src/TesseraStaking.sol:87-94
Closing fix: Add `_settle(msg.sender);` after `_updateGlobal();` at input-1/src/TesseraStaking.sol:89.

## Overlap
- KI-1 (rewards streamed at zero supply credited to nobody) | unrelated | input-4/docs/known-issues.md:7 | input-1/src/TesseraStaking.sol:65 | prior fix closes this path: not-stated
- KI-2 (mid-period notifyReward lowers the rate) | unrelated | input-4/docs/known-issues.md:9 | input-1/src/TesseraStaking.sol:129-136 | prior fix closes this path: not-stated
- N-1 (exit() reverts with ReserveShort when the reserve is short) | same-symptom-different-root | input-4/docs/known-issues.md:13 | input-1/src/TesseraStaking.sol:123-126 | prior fix closes this path: no
- N-2 (rounding in rewardPerToken/earned favours the reserve) | unrelated | input-4/docs/known-issues.md:15 | input-1/src/TesseraStaking.sol:67; input-1/src/TesseraStaking.sol:73 | prior fix closes this path: not-stated

N-1 is the closest item.

- What it shares: the draft's freeze claim rests only on `exit()` reverting (input-2/test/ReserveDrain.t.sol:91-97, input-3/draft-report.md:33). That is exactly the behaviour N-1 records as acknowledged.
- Where the roots differ: N-1's root is `exit()` bundling `claim()`, which is guarded by the reserve cap at input-1/src/TesseraStaking.sol:115. The finding's root is the missing checkpoint at input-1/src/TesseraStaking.sol:89-90. N-1 is acknowledged with no fix, so nothing in it closes the stake path.
- What the report must do:
  - State that difference in its first paragraph.
  - Drop the freeze claim, which is excluded under "anything listed in docs/known-issues.md".
  - Drop principal theft, since payouts are capped by the reserve.
  - File under "Medium: Theft of unclaimed rewards".

KI-1 and N-2 touch the same functions. Their roots are different: the zero-supply branch and integer rounding. Their effects run the opposite way: value stays in `rewardReserve` rather than leaving it.

The two stage files are earlier reviews, not prior art. Their claim that no known issue covers the stake path checks out against input-4/docs/known-issues.md:7-15.

## Duplicate clock
Clock: high
Facts: the fix is one line; the age of input-1/src/TesseraStaking.sol:87-94 is not given; the root sits in the main reward-accounting path; a missing reward checkpoint on deposit is a standard staking checklist item; the programme opened 2026-08-18, about six weeks before reproduction; no group sizes on earlier reports were given.
First reproduced: 2026-09-30
Deadline: file within hours with a minimal proof, or skip

## Search strings
- `_settle(msg.sender)` | `git log -S` across all branches, and open or closed PR diffs
- `paidPerToken` | repository history, issue tracker, audit PDFs
- `stake() does not settle` | issue tracker, audit PDFs
- `checkpoint` and `updateReward` near `stake` | audit PDFs, PR review comments
- `An account is settled before its balance changes` | repository history (Rule 1 at input-1/src/TesseraStaking.sol:18), audit PDFs
- `rewards credited on deposit` / `reward debt not updated on stake` | issue tracker, audit PDFs, contest findings
- `ReserveShort` | issue tracker, to find reports that hit the drained reserve

## Checked and safe
- Payout cannot reach principal | input-1/src/TesseraStaking.sol:115-117 | A claim reverts once the reward exceeds `rewardReserve`, and only the reserve is debited. Draft step 6 at input-3/draft-report.md:32 is false.
- Principal stays withdrawable | input-1/src/TesseraStaking.sol:97-107 | `withdraw()` never reads the reserve, so the drained reserve adds no freeze beyond the N-1 behaviour.
- Reserve cannot be refilled by the attacker | input-1/src/TesseraStaking.sol:130 | `notifyReward` is restricted to the trusted funder, so the drain cannot be repeated from fresh addresses.

## Coverage
Reviewed: input-1/src/TesseraStaking.sol, input-2/test/ReserveDrain.t.sol, input-3/draft-report.md, input-4/docs/known-issues.md, input-5/stage-1-scope.md, input-6/stage-2-provenance.md
Not supplied:
- The hunter's own earlier reports on this programme (Own history).
- The full round-1 audit report behind N-1 and N-2.
- The issue and PR list itself. The clone is recorded as full, but only known-issues.md was supplied.
