// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title LedgerMath
/// @notice Basis-point arithmetic shared by the PocketBank contracts.
library LedgerMath {
    uint256 internal constant BPS = 10_000;

    error BpsOutOfRange(uint256 value);

    /// @notice `amount * points / 10_000`, rounded down.
    function bps(uint256 amount, uint256 points) internal pure returns (uint256) {
        if (points > BPS) revert BpsOutOfRange(points);
        return (amount * points) / BPS;
    }

    /// @notice `amount * points / 10_000`, rounded up.
    function bpsUp(uint256 amount, uint256 points) internal pure returns (uint256) {
        if (points > BPS) revert BpsOutOfRange(points);
        uint256 product = amount * points;
        return product == 0 ? 0 : (product - 1) / BPS + 1;
    }
}
