// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function transferFrom(address from, address recipient, uint256 amount) external returns (bool);
}

/// @notice ERC-20 calls supporting both boolean and empty return data.
library TokenOps {
    error TokenCallFailed();

    function safeTransfer(IERC20 token, address to, uint256 amount) internal {
        _call(address(token), abi.encodeCall(IERC20.transfer, (to, amount)));
    }

    function safeTransferFrom(IERC20 token, address from, address to, uint256 amount) internal {
        _call(address(token), abi.encodeCall(IERC20.transferFrom, (from, to, amount)));
    }

    function _call(address token, bytes memory data) private {
        if (token.code.length == 0) revert TokenCallFailed();
        (bool success, bytes memory result) = token.call(data);
        if (!success) revert TokenCallFailed();
        if (result.length != 0) {
            if (result.length != 32) revert TokenCallFailed();
            uint256 returned;
            assembly ("memory-safe") {
                returned := mload(add(result, 32))
            }
            if (returned != 1) revert TokenCallFailed();
        }
    }
}

/// @notice Full-precision unsigned multiplication and division.
library QuayMath {
    error DivisionByZero();
    error ResultOverflow();

    function mulDiv(uint256 x, uint256 y, uint256 denominator, bool roundUp)
        internal pure returns (uint256 result)
    {
        if (denominator == 0) revert DivisionByZero();
        uint256 remainder = mulmod(x, y, denominator);
        unchecked {
            uint256 low;
            uint256 high;
            assembly ("memory-safe") {
                let mm := mulmod(x, y, not(0))
                low := mul(x, y)
                high := sub(sub(mm, low), lt(mm, low))
            }
            if (high == 0) {
                result = low / denominator;
            } else {
                if (denominator <= high) revert ResultOverflow();
                assembly ("memory-safe") {
                    high := sub(high, gt(remainder, low))
                    low := sub(low, remainder)
                }
                uint256 twos = denominator & (~denominator + 1);
                assembly ("memory-safe") {
                    denominator := div(denominator, twos)
                    low := div(low, twos)
                    twos := add(div(sub(0, twos), twos), 1)
                }
                low |= high * twos;
                uint256 inverse = (3 * denominator) ^ 2;
                inverse *= 2 - denominator * inverse;
                inverse *= 2 - denominator * inverse;
                inverse *= 2 - denominator * inverse;
                inverse *= 2 - denominator * inverse;
                inverse *= 2 - denominator * inverse;
                inverse *= 2 - denominator * inverse;
                result = low * inverse;
            }
            if (roundUp && remainder != 0) {
                if (result == type(uint256).max) revert ResultOverflow();
                ++result;
            }
        }
    }
}
