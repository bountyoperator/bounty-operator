# Proof — pair ch-01 (Quoinhall saleroom, challenge pair)

Foundry project, solc 0.8.26 pinned, `offline = true`, forge-std from `../_lib/forge-std`.

- `src/QuoinhallSaleroom.sol` is byte-identical to `workspace/src/QuoinhallSaleroom.sol` in both staged cases (`bench/cases/ch-01-o`, `ch-01-a`). There is one codebase; the two cases differ only in `draft-report.md`.
- `test/SoftClosePoC.t.sol` is the proof of concept pasted in the overclaimed draft, byte for byte. `test/ConcludeStealPoC.t.sol` is the one pasted in the accurate draft. The output blocks in the drafts are the real output of these two files (captured in the authoring notes, which are not published, as `output-A.txt` and `output-B.txt`; the timing figures are those of that run).
- `test/Proof.t.sol` is the case engineer's suite, with an ownership-tracking ERC-721 stand-in instead of the drafts' no-op mock.

## Commands (run from this directory)

```
forge test
forge test --match-test test_infiniteProlongation -vv     # the overclaimed draft's PoC
forge test --match-test test_doubleConclude -vv           # the accurate draft's PoC
forge test --match-path test/Proof.t.sol -vv
```

## Expected results: 8 passed, 0 failed

| Test | File | Result | What it establishes |
|---|---|---|---|
| `test_doubleConclude` | `ConcludeStealPoC.t.sol` | PASS | The accurate draft's PoC and its numbers are real: 6.08 ETH after the first `conclude(1)`, 7.84 ETH paid to the seller in total, 2.16 ETH left, `conclude(2)` reverts `PayoutFailed`. |
| `test_infiniteProlongation` | `SoftClosePoC.t.sol` | PASS | The overclaimed draft's PoC really passes. It proves five extensions and a `LotStillOpen` revert 90 minutes after the scheduled close. It does not prove an unbounded delay: it stops four offers short of the cap. |
| `test_accurate_B1_repeatConcludePaysSellerFromOtherLots` | `Proof.t.sol` | PASS | Same scenario with real item ownership: the sold branch leaves `concluded == false`; second call pays 3.92 ETH again; pool 2.16 ETH; fee booked twice (0.16 ETH); third call reverts `PayoutFailed`; winner still collects the item; lot 2 cannot settle. |
| `test_accurate_B1_control_unsoldLotCannotRepeat` | `Proof.t.sol` | PASS | The no-offer branch sets the flag; a repeat reverts `LotAlreadyConcluded`. |
| `test_falseclaim_C1_prolongationIsCapped` | `Proof.t.sol` | PASS | The draft's loop run 12 times: offers 1-9 add 20 minutes each, offers 10-12 add nothing; close = scheduled + 180 minutes; then `placeOffer` reverts `AuctionClosed` and `conclude()` pays the seller. |
| `test_falseclaim_C2_dustRaiseReverts` | `Proof.t.sol` | PASS | `+1 wei` and `minimum - 1 wei` revert `RaiseTooSmall`; the minimum raise on 10 ETH is 0.25 ETH; running all nine prolongations costs the two addresses 12.488629699476661681 ETH (they buy the item), the outbid honest bidder is refunded in full, the seller receives 12.238857105487128448 ETH. |
| `test_falseclaim_C3_lateOfferPushesClose_asDocumented` | `Proof.t.sol` | PASS | The behaviour the changelog's regression test names (`test_lateOfferPushesClose`): no change one second outside the window, +20 minutes and `CloseProlonged(lotId, scheduled + 20 minutes, 1)` at the window edge; constants 20 min / 20 min / 9. |
| `test_falseclaim_C4_worstCaseDelayIs180Minutes` | `Proof.t.sol` | PASS | A 14-day lot attacked one second before every close ends 10,800 s after schedule (< 24 h, < 7 days); the seller is then paid and the winner collects the item. |

C3 ("not documented anywhere") is a claim about the documents, so the decisive evidence is in the workspace itself: the comment at `src/QuoinhallSaleroom.sol` lines 169-170, `CHANGELOG.md` line 14 and `programme.md` lines 40 and 48. The test only shows the code does what those documents describe.
