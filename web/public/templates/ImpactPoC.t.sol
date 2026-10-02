// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Fork-test proof of concept. One file, one command, pasted output.
// Scaffold from https://bountyoperator.com/templates/foundry-poc
//
// Impact row, quoted from the programme:   "TODO: paste the exact text"
// Asset in scope:                          TODO: name and address
// Source commit the deployed code matches: TODO: 40-character commit
//
// Run on the deployed code:   forge test --match-path test/ImpactPoC.t.sol -vvv
// Run on your patched build:  FIXED=true forge test --match-path test/ImpactPoC.t.sol -vvv
//
// RPC_URL points at an archive node. The test runs on a local fork and sends
// nothing to mainnet or a public testnet.

import {Test, console2} from "forge-std/Test.sol";

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

/// The in-scope contract. Inside the project's repository, import its own
/// interface instead of declaring one here.
interface ITarget {
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);
    function balanceOf(address account) external view returns (uint256 shares);
}

contract ImpactPoC is Test {
    // ---- 1. Setup: one chain, one block, the scoped addresses ---------------
    uint256 constant FORK_BLOCK = 0; // TODO: the block you reproduced at
    ITarget constant TARGET = ITarget(address(0)); // TODO: address from the programme's asset list
    IERC20 constant ASSET = IERC20(address(0)); // TODO: the token the impact row names

    // ---- 2. Actors: who performs each step ----------------------------------
    // No prank on an owner, admin, keeper or governance address anywhere below.
    address attacker = makeAddr("attacker"); // holds no role
    address victim = makeAddr("victim"); // an ordinary user

    // ---- 3. Concrete values -------------------------------------------------
    uint256 constant VICTIM_DEPOSIT = 100_000e6; // TODO: 100,000 units of a 6-decimal token
    uint256 constant ATTACKER_CAPITAL = 1_000e6; // TODO: what the attacker starts with
    uint256 constant EXPECTED_LOSS = 100_000e6; // TODO: the loss the report claims

    function setUp() public {
        vm.createSelectFork(vm.envString("RPC_URL"), FORK_BLOCK);
        if (vm.envOr("FIXED", false)) _applyFix();

        vm.label(address(TARGET), "Target");
        vm.label(address(ASSET), "Asset");

        // Starting balances. deal() funds an account. Nothing here writes the
        // target's storage or mocks one of its calls.
        deal(address(ASSET), victim, VICTIM_DEPOSIT);
        deal(address(ASSET), attacker, ATTACKER_CAPITAL);

        // The victim uses the protocol the way its documentation describes.
        vm.startPrank(victim);
        ASSET.approve(address(TARGET), VICTIM_DEPOSIT);
        TARGET.deposit(VICTIM_DEPOSIT, victim);
        vm.stopPrank();
    }

    /// Puts your patched build at the deployed address. Existing storage stays,
    /// except the slots the constructor writes: it runs again at that address.
    /// Patch the source in this repository first. Behind a proxy, pass the
    /// implementation address.
    function _applyFix() internal {
        // TODO: artifact and constructor arguments of the patched contract
        deployCodeTo("Target.sol:Target", abi.encode(address(ASSET)), address(TARGET));
    }

    /// The object the impact row names, read from chain state.
    ///   Theft of user funds     -> what the victim can still withdraw
    ///   Protocol insolvency     -> assets held minus liabilities owed
    ///   Unauthorised minting    -> totalSupply, or the attacker's balance
    ///   Permanent freezing      -> what a withdrawal returns after the wait
    function _impactObject() internal view returns (uint256) {
        return ASSET.balanceOf(address(TARGET)); // TODO: the read that matches your impact row
    }

    /// The attack path, step for step as numbered in the report. Public calls only.
    function _path(bool withBugStep) internal {
        vm.startPrank(attacker);
        // TODO step 1: the ordinary calls that set the stage
        if (withBugStep) {
            // TODO step 2: the one call the report is about
        }
        // TODO step 3: the calls that realise the loss
        vm.stopPrank();
    }

    /// Passes on the deployed code. Fails when run with FIXED=true.
    function test_impact() public {
        uint256 objectBefore = _impactObject();
        uint256 attackerBefore = ASSET.balanceOf(attacker);

        _path(true);

        uint256 objectAfter = _impactObject();
        uint256 loss = objectBefore > objectAfter ? objectBefore - objectAfter : 0;
        console2.log("impact object before", objectBefore);
        console2.log("impact object after ", objectAfter);
        console2.log("measured loss       ", loss);
        console2.log("attacker before     ", attackerBefore);
        console2.log("attacker after      ", ASSET.balanceOf(attacker));

        // FINAL ASSERTION. It reads the object the impact row names.
        // Not an event, not a return value, not an intermediate variable.
        assertGe(loss, EXPECTED_LOSS, "impact: the object the impact row names lost value");
    }

    /// Control: the same path without the bug step. The object does not move.
    function test_control() public {
        uint256 objectBefore = _impactObject();

        _path(false);

        assertEq(_impactObject(), objectBefore, "control: no loss without the bug step");
    }
}
