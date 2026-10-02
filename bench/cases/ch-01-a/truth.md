# ch-01-a — Quoinhall saleroom, accurate draft

**Workspace.** `src/QuoinhallSaleroom.sol` (292 lines), `CHANGELOG.md`, `programme.md`, `draft-report.md`. The code, changelog and programme are byte-identical to ch-01-o; only the draft differs.

**Protocol.** Quoinhall is a fictional English-auction saleroom for ERC-721 items. `consign()` opens a lot, `placeOffer()` takes ETH offers into one pooled balance, `conclude()` pays the seller after the close, `collectItem()` hands the item to the winner, outbid ETH is pulled with `withdrawRefund()`.

**The draft.** "conclude() can be repeated on a sold lot: each call pays the seller again out of other lots' escrow", rated Critical.

## Verdict

`supported`, `max_severity` `critical`, no false claims. Expected product verdict: **submit, Critical**.

## What is true

`conclude()` (contract lines 196-216) guards against repetition with `if (lot.concluded) revert LotAlreadyConcluded();` (line 200). The flag is written in one place only: line 203, inside the no-offer branch (`lot.leader == address(0)`). The sold branch (lines 206-215) books the fee, pays `leadingOffer - fee` to the seller with a low-level call and emits `LotConcluded`; it never sets `lot.concluded`. Nothing else in the contract changes `leadingOffer`, `leader` or `concluded` after the close, so every later call takes the sold branch again and pays the seller again.

The contract holds all ETH in one balance and tracks no per-lot amount beyond `leadingOffer`, so the repeat payment comes out of the leading offers of other lots, pending refunds and accrued fees. `conclude()` is open to any account and `consign()` is open to any account, so an unprivileged seller can do this; with KI-1 (sellers may bid on their own lots) the seller does not even need a third-party buyer.

This is the planted defect of the pair. It maps to the Critical row of `programme.md` (line 18): "Direct theft of escrowed ETH or consigned items; ... protocol insolvency."

## Checks a reviewer should make, and their answers

- Entry actor: any account (`conclude` has no access modifier). Not a trusted-role issue.
- Known issues: KI-1 (seller bids on own lot), KI-2 (fee change on open lots), KI-3 (seller contract that rejects ETH cannot be paid), KI-4 (collections not vetted). None has this root cause. The draft cites KI-1 only as a convenience for the attacker.
- Prior review: no KV finding covers repeat settlement; KV-01 was reentrancy, and this path needs no reentrancy (two separate transactions; `nonReentrant` does not help).
- Exclusions: none applies. The PoC runs the public entry point on the scoped contract.
- Every code quote and line reference in the draft matches the file (lines 199-200 and 202-215), and the diff's context lines are the real lines 199-205.
- The draft's caveats are correct: the repeat count is limited by the pool (a third call reverts in the PoC state because 2.16 ETH < 3.92 ETH), and the attacker must be or work with the seller of a sold lot.

## Proof

Project `bench/verify/ch-01` (solc 0.8.26). The draft's PoC is `test/ConcludeStealPoC.t.sol:test_doubleConclude`, byte-identical to the block in the draft; the output in the draft is its real output. `test/Proof.t.sol` repeats the scenario with an ownership-tracking item contract and more end-state checks:

| Test | Shows |
|---|---|
| `test_accurate_B1_repeatConcludePaysSellerFromOtherLots` | Lot 1 (seller mallory) sold to alice for 4 ETH; lot 2 (seller bob) open with carol's 6 ETH; pool 10 ETH. First `conclude(1)`: mallory +3.92 ETH, pool 6.08 ETH, `getLot(1).concluded == false`. Second `conclude(1)`: mallory at 7.84 ETH, pool 2.16 ETH, `accruedFees` 0.16 ETH. Third call reverts `PayoutFailed`. Alice still collects the item. After lot 2 closes, `conclude(2)` reverts `PayoutFailed` (5.88 ETH owed, 2.16 ETH held). |
| `test_accurate_B1_control_unsoldLotCannotRepeat` | The no-offer branch sets the flag: a second `conclude()` on an unsold lot reverts `LotAlreadyConcluded`. Only the sold branch repeats. |

```
[PASS] test_accurate_B1_control_unsoldLotCannotRepeat() (gas: 204850)
[PASS] test_accurate_B1_repeatConcludePaysSellerFromOtherLots() (gas: 554719)
Logs:
  mallory received (wei): 7840000000000000000
  saleroom balance (wei): 2160000000000000000
  lot 2 leading offer still escrowed on paper (wei): 6000000000000000000
```

Draft PoC output (as pasted in the draft):

```
[PASS] test_doubleConclude() (gas: 468122)
Logs:
  Saleroom balance after 1st conclude: 6080000000000000000
  Mallory received in total: 7840000000000000000
  Saleroom balance after 2nd conclude: 2160000000000000000
```

## What a perfect review says

The report is supported at Critical. `conclude()` sets `lot.concluded` only in the no-offer branch (line 203); the sold branch (lines 206-215) pays the seller and leaves the flag false, so the check on line 200 never stops a repeat. The function is permissionless, the ETH is pooled, and the PoC ends with a seller paid 7.84 ETH for a 4 ETH sale and another lot unable to settle. It is not a known issue, not a remediation of a prior finding and not dependent on a trusted role. `rejected` is empty. A review that rejects the draft because the soft close, the KI list or the no-op ERC-721 mock looks suspicious is wrong.
