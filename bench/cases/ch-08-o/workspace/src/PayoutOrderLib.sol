// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal ERC-20 surface used by the payout desk.
interface IPayoutToken {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @notice Payout order issued off-chain by the studio's signing authority.
/// @param orderId Unique id assigned by the authority.
/// @param creator The account the order was issued to.
/// @param amount Amount of payout token (18 decimals) the order carries.
/// @param deadline Last timestamp at which the order may be processed.
struct PayoutOrder {
    uint256 orderId;
    address creator;
    uint256 amount;
    uint64 deadline;
}

/// @title PayoutOrderLib - Hashing and signature recovery for Lanternreel payout orders
library PayoutOrderLib {
    // ========== Constants ==========
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant PAYOUT_ORDER_TYPEHASH =
        keccak256("PayoutOrder(uint256 orderId,uint256 amount,uint64 deadline)");
    /// @dev secp256k1n / 2
    uint256 internal constant HALF_CURVE_ORDER = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    // ========== Errors ==========
    error InvalidSignatureLength();
    error InvalidSignatureV();
    error InvalidSignatureS();
    error InvalidSignature();

    /// @notice Compute the EIP-712 domain separator of a desk
    function computeDomainSeparator(address desk, uint256 chainId) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("Lanternreel Payout Desk"), keccak256("1"), chainId, desk)
        );
    }

    /// @notice Hash a payout order for EIP-712 signing
    function hash(PayoutOrder calldata order) internal pure returns (bytes32) {
        return keccak256(abi.encode(PAYOUT_ORDER_TYPEHASH, order.orderId, order.amount, order.deadline));
    }

    /// @notice The EIP-712 digest the authority signs for an order
    function digest(PayoutOrder calldata order, bytes32 domainSeparator) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, hash(order)));
    }

    /// @notice Recover the signer of a digest
    /// @dev Accepts 65-byte (r, s, v) signatures only and rejects high-s values.
    function recoverSigner(bytes32 digest_, bytes calldata signature) internal pure returns (address) {
        if (signature.length != 65) revert InvalidSignatureLength();

        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);

        if (v != 27 && v != 28) revert InvalidSignatureV();
        if (uint256(s) == 0 || uint256(s) > HALF_CURVE_ORDER) revert InvalidSignatureS();

        address recovered = ecrecover(digest_, v, r, s);
        if (recovered == address(0)) revert InvalidSignature();
        return recovered;
    }
}
