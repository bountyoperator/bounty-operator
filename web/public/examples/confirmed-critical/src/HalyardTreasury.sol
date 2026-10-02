// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title HalyardTreasury
/// @notice An M-of-N treasury. A transaction runs when `threshold` owners have signed it.
/// @dev Synthetic example written for Bounty Operator. Not deployed anywhere.
///
/// Guarantee
///   No transaction executes with approvals from fewer than `threshold` distinct owners.
///   Owners and the threshold change only through a transaction the treasury sends to itself.
contract HalyardTreasury {
    bytes32 public constant TX_TYPEHASH =
        keccak256("Transaction(address to,uint256 value,bytes32 dataHash,uint256 nonce)");

    bytes32 public immutable DOMAIN_SEPARATOR;

    mapping(address => bool) public isOwner;
    uint256 public ownerCount;
    uint256 public threshold;
    uint256 public nonce;

    event Executed(uint256 indexed nonce, address indexed to, uint256 value);
    event OwnerAdded(address indexed owner);
    event OwnerRemoved(address indexed owner);
    event ThresholdChanged(uint256 threshold);

    error NotSelf();
    error BadOwner(address owner);
    error BadThreshold(uint256 threshold, uint256 owners);
    error BadSignature();
    error NotEnoughApprovals(uint256 approvals, uint256 threshold);
    error CallFailed(bytes returnData);

    modifier onlySelf() {
        if (msg.sender != address(this)) revert NotSelf();
        _;
    }

    constructor(address[] memory owners_, uint256 threshold_) {
        for (uint256 i = 0; i < owners_.length; i++) {
            address owner = owners_[i];
            if (owner == address(0) || isOwner[owner]) revert BadOwner(owner);
            isOwner[owner] = true;
            emit OwnerAdded(owner);
        }
        ownerCount = owners_.length;
        if (threshold_ == 0 || threshold_ > owners_.length) revert BadThreshold(threshold_, owners_.length);
        threshold = threshold_;

        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)"),
                keccak256("HalyardTreasury"),
                block.chainid,
                address(this)
            )
        );
    }

    receive() external payable {}

    /// @notice The digest owners sign for the next transaction.
    function txDigest(address to, uint256 value, bytes calldata data, uint256 nonce_) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(TX_TYPEHASH, to, value, keccak256(data), nonce_));
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    /// @notice Run a transaction that `threshold` owners have signed.
    /// @param signatures One 65-byte signature per approving owner, sorted by owner address.
    function execute(address to, uint256 value, bytes calldata data, bytes[] calldata signatures)
        external
        returns (bytes memory returnData)
    {
        bytes32 digest = txDigest(to, value, data, nonce);

        uint256 approvals;
        for (uint256 i = 0; i < signatures.length; i++) {
            address signer = _recover(digest, signatures[i]);
            if (isOwner[signer]) approvals++;
        }
        if (approvals < threshold) revert NotEnoughApprovals(approvals, threshold);

        emit Executed(nonce, to, value);
        nonce++;

        bool ok;
        (ok, returnData) = to.call{value: value}(data);
        if (!ok) revert CallFailed(returnData);
    }

    function _recover(bytes32 digest, bytes calldata signature) internal pure returns (address signer) {
        if (signature.length != 65) revert BadSignature();
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);
        // Reject the malleable half of the curve.
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) revert BadSignature();
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert BadSignature();
    }

    function addOwner(address owner) external onlySelf {
        if (owner == address(0) || isOwner[owner]) revert BadOwner(owner);
        isOwner[owner] = true;
        ownerCount++;
        emit OwnerAdded(owner);
    }

    function removeOwner(address owner) external onlySelf {
        if (!isOwner[owner]) revert BadOwner(owner);
        isOwner[owner] = false;
        ownerCount--;
        emit OwnerRemoved(owner);
    }

    function setThreshold(uint256 threshold_) external onlySelf {
        if (threshold_ == 0 || threshold_ > ownerCount) revert BadThreshold(threshold_, ownerCount);
        threshold = threshold_;
        emit ThresholdChanged(threshold_);
    }
}
