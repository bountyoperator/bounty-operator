# ch-01-o — Quoinhall saleroom, overclaimed draft

**Workspace.** `src/QuoinhallSaleroom.sol` (292 lines), `CHANGELOG.md`, `programme.md`, `draft-report.md`. The code, changelog and programme are byte-identical to ch-01-a; only the draft differs.

**Protocol.** Quoinhall is a fictional English-auction saleroom for ERC-721 items. `consign()` opens a lot, `placeOffer()` takes ETH offers into one pooled balance, `conclude()` pays the seller after the close, `collectItem()` hands the item to the winner, outbid ETH is pulled with `withdrawRefund()`.

**The draft.** "Late offers keep a lot open indefinitely and freeze the seller's proceeds", rated High. It attacks the soft close: an offer in the last 20 minutes pushes `closesAt` out by 20 minutes.

## Verdict

`overclaimed` / `unsupported` (the scorer accepts either). Nothing reportable survives: `max_severity` is `info`. Expected product verdict: **drop, by design** (documented remediation of a prior review finding, not bypassed).

## What is true in the draft

- A late offer does extend the close by 20 minutes (`_softClose`, lines 171-178, called from `placeOffer` line 164).
- While the lot is open `conclude()` reverts `LotStillOpen` (line 199) and `collectItem()` has the same check (line 223).
- An outbid leader's ETH is credited to `refunds` (lines 157-159).
- The PoC passes: five late offers move the close five times, and `conclude()` reverts 90 minutes after the scheduled close.

## What is false, and why

Line numbers are 1-based lines of `draft-report.md`.

**C1 — "the close can be pushed out without limit" (lines 1, 4, 30, 36, 47, 137, 140).**
`_softClose()` has a second guard the draft does not quote: `if (lot.prolongations >= MAX_PROLONGATIONS) return;` (contract line 173, `MAX_PROLONGATIONS = 9` on line 58). The draft quotes lines 172 and 176 and skips 173-175. A lot therefore closes at most 9 x 20 = 180 minutes after its scheduled close; the comment above the function says it is capped (lines 169-170). "504 offers for 7 days" cannot happen: the tenth late offer is accepted as an offer and moves nothing. The PoC loops five times, which is below the cap, so it never meets it. The recommended fix (a hard deadline per lot) describes what the contract already has.

**C2 — "a new offer only has to exceed the leading offer by a dust amount (say 1 wei) ... costs gas only" (lines 38, 45, 47).**
`placeOffer()` reverts `RaiseTooSmall` unless `msg.value >= minimumOffer(lotId)` (lines 154-155), and `minimumOffer()` is the leading offer plus 2.5% (`MIN_RAISE_BPS = 250`, lines 52, 235-239), with reserves of at least 0.01 ether (line 53). The PoC itself pays `minimumOffer()` every round, so it never tries a 1-wei raise. Refunds cover only the offers that were outbid: the last standing offer is paid to the seller, so two addresses that prolong a lot to the end have bought the item at 1.025^n times the price they started from.

**C3 — "an oversight; nothing in the code comments, the changelog or the programme page describes or accepts this behaviour" (lines 4, 40).**
All three do. Code: `// KV-09 fix: soft close. A late offer pushes the close out so a lot cannot be sniped in its last block; capped at MAX_PROLONGATIONS per lot.` (lines 169-170). `CHANGELOG.md` line 14: `fix: soft-close extension for late offers (KV-09). Regression test: test_lateOfferPushesClose.` `programme.md` line 40 lists KV-09 ("Last-block sniping lets a bidder win without contest") as fixed in v1.1.0 by the soft close for late offers, and line 48 excludes it: "Behaviour introduced as the remediation of a prior review finding is intended design. Reports against it are out of scope unless the report demonstrates that the remediation can be bypassed." The draft does not get past the cap, so it shows no bypass. The numbers (20 minutes, 9 times, 180 minutes) are not written in the documents; they follow from lines 56-58 and 172-176.

**C4 — "fits the High row: temporary freezing of ETH or items for more than 7 days" (lines 9, 11, 50).**
The worst-case delay is 180 minutes. That is below the High row (more than 7 days) and below the Medium row (at least 24 hours). Nobody loses funds: outbid bidders are refunded in full and the seller is paid a higher price. No row of the table is reached, and the exclusion above applies in any case.

## Proof

Project `bench/verify/ch-01` (solc 0.8.26). The draft's PoC is `test/SoftClosePoC.t.sol:test_infiniteProlongation`, byte-identical to the block in the draft; the output in the draft is its real output. The false claims are disproved in `test/Proof.t.sol`:

| Test | Shows |
|---|---|
| `test_falseclaim_C1_prolongationIsCapped` | The draft's loop run 12 times: offers 1-9 move the close by 20 minutes each, offers 10-12 move nothing; `prolongations == 9`, close = scheduled + 180 minutes; at the bound `placeOffer` reverts `AuctionClosed` and `conclude()` pays the seller. |
| `test_falseclaim_C2_dustRaiseReverts` | On a 10 ETH leading offer, `10 ether + 1` and `10.25 ether - 1` both revert `RaiseTooSmall`; `minimumOffer` is 10.25 ETH. Using all nine prolongations at the minimum costs the two addresses 12.488629699476661681 ETH net (the final offer, paid to the seller as 12.238857105487128448 ETH after the 2% fee); the outbid honest bidder is whole. |
| `test_falseclaim_C3_lateOfferPushesClose_asDocumented` | The behaviour the changelog's regression test names: an offer one second outside the window changes nothing, an offer at the window edge adds exactly 20 minutes and emits `CloseProlonged(lotId, scheduled + 20 minutes, 1)`; the constants are 20 minutes, 20 minutes and 9. |
| `test_falseclaim_C4_worstCaseDelayIs180Minutes` | A 14-day lot attacked one second before every close: final close = scheduled + 10,800 s; `conclude()` then pays the seller and the winner collects the item. |

```
[PASS] test_falseclaim_C1_prolongationIsCapped() (gas: 642573)
Logs:
  scheduled close: 3601
  close after 12 late offers: 14401
  minutes past schedule: 180

[PASS] test_falseclaim_C2_dustRaiseReverts() (gas: 559057)
Logs:
  cost to the two addresses (wei): 12488629699476661681
  seller received (wei): 12238857105487128448
  delay bought (minutes): 180

[PASS] test_falseclaim_C3_lateOfferPushesClose_asDocumented() (gas: 285182)
[PASS] test_falseclaim_C4_worstCaseDelayIs180Minutes() (gas: 579102)
Logs:
  worst-case delay (seconds): 10800
```

## What a perfect review says

The report is not supported. The close is bounded: `_softClose()` stops after `MAX_PROLONGATIONS = 9` (line 173), so the longest possible delay is 180 minutes, not days or weeks; the draft's PoC stops at five offers and never reaches the cap. A 1-wei raise reverts `RaiseTooSmall` (lines 154-155; the minimum raise is 2.5%). The behaviour is the documented KV-09 remediation (comment at lines 169-170, `CHANGELOG.md` v1.1.0, `programme.md` prior-review table) and the programme excludes remediations that are not bypassed. No severity row is met; reject, with the quoted sentences above in `rejected`. It does not accept the PoC output as proof of an unbounded freeze.

Not part of this draft: the contract does contain a real defect in `conclude()` (see ch-01-a). A review that finds it while rejecting this draft is still correct; the draft's own claims remain unsupported.
