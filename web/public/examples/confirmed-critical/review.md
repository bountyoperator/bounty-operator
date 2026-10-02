# Review
Verdict: submit
Mode: bounty
Counts: critical=1 high=0 medium=0 hardening=1 checked-safe=4
Headline: execute() counts one owner's repeated signature as threshold approvals; the draft's claims, proof and fix all hold.

## Claims
- C1 | confirmed | input-1/src/HalyardTreasury.sol:76-81 | Root cause: the loop adds one approval for every signature that recovers to an owner. There is no seen-set and no ordering check, so the same signer counts three times.
- C2 | confirmed | input-1/src/HalyardTreasury.sol:70-73 | Anyone can submit. `execute` has no caller restriction, and the test submits from "relayer" at input-2/test/DuplicateSignature.t.sol:59.
- C3 | confirmed | input-1/src/HalyardTreasury.sol:91-100 | `_recover` rejects bad length, high-s and zero signers. It does nothing against the same valid signature being sent again.
- C4 | confirmed | input-1/src/HalyardTreasury.sol:87 | 500 ETH reaches the recipient. The test asserts treasury balance 0 and recipient balance 500 ether at input-2/test/DuplicateSignature.t.sol:65-66, and the proof run shows both.
- C5 | confirmed | input-1/src/HalyardTreasury.sol:34-37 | The same path reaches `addOwner`, `removeOwner` and `setThreshold`: with `to = address(this)`, `msg.sender` is the treasury, so `onlySelf` passes.
- C6 | confirmed | input-1/src/HalyardTreasury.sol:74; input-1/src/HalyardTreasury.sol:84 | Limit: replay is blocked because the digest binds `nonce` and `nonce` increments before the call.
- C7 | confirmed | input-1/src/HalyardTreasury.sol:79 | Limit: a non-owner gains nothing, because its signatures add no approvals.
- C8 | confirmed | input-3/draft-report.md:3-4 | Severity Critical is supported, because the programme row "fewer than `threshold` distinct owners" matches. The assumption that would move it is that a single owner is trusted, which the programme rules out.
- C9 | confirmed | input-4/docs/known-issues.md:5 | Nearest known issue KI-1 requires `threshold` owners to approve `setThreshold(1)`. Here the threshold stays at 3 (input-2/test/DuplicateSignature.t.sol:68), so the root cause differs. KI-2 concerns freezing, not signature counting.
- C10 | confirmed | input-3/draft-report.md:155-166 | The fix closes the path:
  - `signer <= last` with `last = 0` rejects any repeat or out-of-order signer.
  - A zero signer already reverts at input-1/src/HalyardTreasury.sol:99.
  - The PoC fails with `SignersNotSorted()` once the fix is applied (input-3/draft-report.md:134).

## Submission checks
- proof-inline | pass | input-3/draft-report.md:38-126
- form-matches-body | pass | input-3/draft-report.md:3-4 matches the selected Critical row
- limits-stated | pass | input-3/draft-report.md:141-145
- title | pass | input-3/draft-report.md:1
- steps-separate | pass | input-3/draft-report.md:26-32
- read-back | not-supplied | After filing, compare the stored submission with the draft field by field.
- concrete-detail | pass | Root cause cites input-3/draft-report.md:13; the path uses `execute(recipient, 500 ether, "", [sig, sig, sig])`; the proof shows "treasury balance after (wei) 0".

## F-1: execute() counts a repeated owner signature as distinct approvals, so one owner key executes any treasury transaction
Severity: critical
Basis: proven-in-source
Location: input-1/src/HalyardTreasury.sol:76-81; input-1/src/HalyardTreasury.sol:87
Impact: One owner of an M-of-N treasury can do two things on their own:
- Move the entire treasury balance (500 ETH in the proof).
- Rewrite the owner set and threshold.
Path:
none
Counterargument: The attacker already holds an owner key | resolved | The programme states that no single owner is trusted. The guarantee at input-1/src/HalyardTreasury.sol:9 requires `threshold` distinct owners.
Gap: none
Fix: Require strictly ascending recovered signers in the loop at input-1/src/HalyardTreasury.sol:77-80, as in input-3/draft-report.md:159-165.
Test:
none
Next: File the draft as written, then check the stored submission against the draft.

## Hardening
- Non-owner signatures silently accepted | input-1/src/HalyardTreasury.sol:79 | Revert on a non-owner signer instead of skipping it. This makes malformed or griefing bundles fail loudly.

## Checked and safe
- Signature malleability | input-1/src/HalyardTreasury.sol:97 | High-s signatures are rejected, so the same signer cannot be produced from a second encoding.
- Invalid v or garbage signature | input-1/src/HalyardTreasury.sol:99 | `ecrecover` returns zero for these and the call reverts.
- Cross-chain or cross-instance replay | input-1/src/HalyardTreasury.sol:50-57 | The domain separator binds `chainid` and `address(this)`.
- Duplicate owners at deploy | input-1/src/HalyardTreasury.sol:42 | The constructor rejects repeated or zero owners, so `ownerCount` is accurate.

## Coverage
Reviewed: input-1/src/HalyardTreasury.sol, input-2/test/DuplicateSignature.t.sol, input-3/draft-report.md, input-4/docs/known-issues.md
Not supplied: none
