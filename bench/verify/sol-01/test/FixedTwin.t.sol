// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// Runs only against src/fixed. Shows that the sequence from test_planted_P1 costs the attacker
// roughly half of what they sent and leaves the next depositor whole, and that no choice of
// seed deposit, direct transfer or victim deposit turns a profit.
import {Test, console2} from "forge-std/Test.sol";
import {AsterQuay} from "../src/fixed/AsterQuay.sol";
import {PlainToken} from "./Fixed.t.sol";

contract FixedTwinTest is Test {
    PlainToken internal token;
    AsterQuay internal quay;

    address internal admin = makeAddr("admin");
    address internal keeper = makeAddr("keeper");
    address internal alice = makeAddr("alice");
    address internal mallory = makeAddr("mallory");

    function setUp() public {
        token = new PlainToken("Plain Dollar", "PLN");
        vm.prank(admin);
        quay = new AsterQuay(address(token), 18, keeper);
    }

    function _run(uint256 seed, uint256 donation, uint256 victimDeposit)
        internal
        returns (uint256 victimShares, uint256 victimClaim, uint256 attackerOut)
    {
        token.mint(mallory, seed + donation);
        token.mint(alice, victimDeposit);

        vm.startPrank(mallory);
        token.approve(address(quay), seed);
        quay.deposit(seed, mallory);
        token.transfer(address(quay), donation);
        vm.stopPrank();

        vm.startPrank(alice);
        token.approve(address(quay), victimDeposit);
        victimShares = quay.deposit(victimDeposit, alice);
        vm.stopPrank();
        victimClaim = quay.maxWithdraw(alice);

        uint256 attackerShares = quay.balanceOf(mallory);
        vm.prank(mallory);
        attackerOut = quay.redeem(attackerShares, mallory, mallory);
    }

    function test_patched_P1() public {
        (uint256 victimShares, uint256 victimClaim, uint256 attackerOut) = _run(1, 10_000e18, 5_000e18);
        console2.log("victim receipts   ", victimShares);
        console2.log("victim claim      ", victimClaim);
        console2.log("attacker payout   ", attackerOut);
        console2.log("attacker loss     ", 10_000e18 + 1 - attackerOut);

        assertEq(victimShares, 999_999, "victim receipts");
        assertEq(victimClaim, 4999996666665555555185, "victim claim");
        assertGe(victimClaim, 5_000e18 - 0.0034e18, "victim lost more than 0.0034 tokens");
        assertEq(attackerOut, 5000001666667222222408, "attacker payout");
        assertLt(attackerOut, 10_000e18 + 1, "attacker profited");

        // the victim can actually take the claim out
        vm.prank(alice);
        quay.withdraw(victimClaim, alice, alice);
        assertEq(token.balanceOf(alice), victimClaim);
    }

    function testFuzz_patched_P1_neverProfitable(uint256 seed, uint256 donation, uint256 victimDeposit) public {
        seed = bound(seed, 1, 1e24);
        donation = bound(donation, 0, 1e30);
        victimDeposit = bound(victimDeposit, 1, 1e30);
        (, uint256 victimClaim, uint256 attackerOut) = _run(seed, donation, victimDeposit);

        uint256 spent = seed + donation;
        assertLe(attackerOut, spent, "attacker profited");
        // beyond two units of ordinary rounding dust, every unit the next depositor loses costs the
        // attacker at least 100,000 units
        uint256 victimLoss = victimDeposit - victimClaim;
        if (victimLoss > 2) assertLe((victimLoss - 2) * 100_000, spent - attackerOut, "cheap griefing");
    }
}
