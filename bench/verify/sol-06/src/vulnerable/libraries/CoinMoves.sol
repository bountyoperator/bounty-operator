// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal ERC-20 surface used by Velisara accounting.
interface ILaneCoin {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address destination, uint256 amount) external returns (bool);
    function transferFrom(address source, address destination, uint256 amount)
        external
        returns (bool);
}

/// @notice ERC-20 calls with support for empty successful transfer responses.
library CoinMoves {
    error CoinCallFailed(address asset);

    function holdings(address asset, address account) internal view returns (uint256) {
        if (asset.code.length == 0) revert CoinCallFailed(asset);
        return ILaneCoin(asset).balanceOf(account);
    }

    function push(address asset, address destination, uint256 amount) internal {
        _call(asset, abi.encodeCall(ILaneCoin.transfer, (destination, amount)));
    }

    function pull(address asset, address source, address destination, uint256 amount)
        internal
    {
        _call(asset, abi.encodeCall(ILaneCoin.transferFrom, (source, destination, amount)));
    }

    function _call(address asset, bytes memory payload) private {
        if (asset.code.length == 0) revert CoinCallFailed(asset);
        (bool success, bytes memory result) = asset.call(payload);
        if (!success) revert CoinCallFailed(asset);
        if (result.length != 0) {
            if (result.length < 32) revert CoinCallFailed(asset);
            uint256 returned;
            assembly ("memory-safe") {
                returned := mload(add(result, 32))
            }
            if (returned != 1) revert CoinCallFailed(asset);
        }
    }
}
