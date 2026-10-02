// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LedgerMath} from "./LedgerMath.sol";

/// @title PocketBank
/// @notice Holds ether for depositors and keeps a small exit fee for the owner.
contract PocketBank {
    using LedgerMath for uint256;

    address public immutable owner;
    uint16 public constant EXIT_FEE_BPS = 25;

    mapping(address => uint256) public balances;
    uint256 public feesAccrued;

    event Deposited(address indexed account, uint256 amount);
    event Withdrawn(address indexed account, uint256 amount, uint256 fee);
    event DustSwept(address indexed to, uint256 amount);

    error NothingToWithdraw();
    error NotOwner();
    error TransferFailed();

    constructor() {
        owner = msg.sender;
    }

    /// @notice Credits the sent ether to the caller.
    function deposit() external payable {
        balances[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    /// @notice Pays out the caller's whole balance minus the exit fee.
    function withdrawAll() external {
        uint256 amount = balances[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        uint256 fee = amount.bps(EXIT_FEE_BPS);
        feesAccrued += fee;

        (bool ok, ) = msg.sender.call{value: amount - fee}("");
        if (!ok) revert TransferFailed();
        balances[msg.sender] = 0;

        emit Withdrawn(msg.sender, amount - fee, fee);
    }

    /// @notice Sends the accrued exit fees to `to`.
    function sweepDust(address payable to) external {
        if (msg.sender != owner) revert NotOwner();
        uint256 amount = feesAccrued;
        feesAccrued = 0;
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit DustSwept(to, amount);
    }
}
