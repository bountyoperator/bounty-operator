// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ILoomToken {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address recipient, uint256 quantity) external returns (bool);
    function transferFrom(address sender, address recipient, uint256 quantity) external returns (bool);
}

library TokenWire {
    error ThreadCallFailed();
    error ThreadHasNoCode();

    function push(ILoomToken token, address recipient, uint256 quantity) internal {
        _invoke(address(token), abi.encodeCall(ILoomToken.transfer, (recipient, quantity)));
    }

    function pull(ILoomToken token, address sender, address recipient, uint256 quantity) internal {
        _invoke(address(token), abi.encodeCall(ILoomToken.transferFrom, (sender, recipient, quantity)));
    }

    function _invoke(address token, bytes memory payload) private {
        if (token.code.length == 0) revert ThreadHasNoCode();
        (bool success, bytes memory returned) = token.call(payload);
        if (!success) revert ThreadCallFailed();
        if (returned.length != 0) {
            if (returned.length != 32) revert ThreadCallFailed();
            uint256 result;
            assembly ("memory-safe") {
                result := mload(add(returned, 32))
            }
            if (result != 1) revert ThreadCallFailed();
        }
    }
}

abstract contract LoomLatch {
    uint256 private latchState = 1;

    error LoomBusy();

    modifier latched() {
        if (latchState != 1) revert LoomBusy();
        latchState = 2;
        _;
        latchState = 1;
    }
}
