// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPayoutToken, PayoutOrder, PayoutOrderLib} from "./PayoutOrderLib.sol";

/// @title ReelPayoutDesk - Signed royalty payouts for Lanternreel creators
/// @notice The studio's signing authority issues payout orders to creators off-chain. A creator
///         submits their order to have the amount allocated to their desk balance, then withdraws
///         the payout token from the desk's reserve.
/// @dev Orders are EIP-712 messages signed by `authority`. Each order id is processed at most once.
contract ReelPayoutDesk {
    using PayoutOrderLib for PayoutOrder;

    // ========== Constants ==========
    /// @notice Largest amount a single payout order may carry
    uint256 public constant ORDER_CEILING = 75_000 ether;
    /// @notice Upper bound for `issuanceLimit`
    uint256 public constant ALLOCATION_HARD_LIMIT = 40_000_000 ether;

    // ========== State ==========
    address public owner;
    address public pendingOwner;
    address public authority;
    bool public operationsHalted;
    uint256 public totalAllocated;
    uint256 public issuanceLimit;
    uint256 public totalWithdrawn;

    mapping(uint256 => bool) public orderProcessed;
    mapping(address => uint256) public creatorBalances;
    IPayoutToken public immutable payoutToken;
    bytes32 private immutable _cachedDomainSeparator;
    uint256 private immutable _cachedChainId;

    // ========== Events ==========
    event OwnershipTransferStarted(address indexed currentOwner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event AuthorityUpdated(address indexed previousAuthority, address indexed newAuthority);
    event IssuanceLimitUpdated(uint256 previousLimit, uint256 newLimit);
    event OperationsHalted();
    event OperationsResumed();
    event OrderProcessed(uint256 indexed orderId, address indexed creator, uint256 amount);
    event Withdrawal(address indexed creator, uint256 amount);
    event ReserveFunded(address indexed from, uint256 amount);
    event ExcessSwept(address indexed recipient, uint256 amount);

    // ========== Errors ==========
    error NotAuthorized();
    error ZeroAddress();
    error OperationsAreHalted();
    error NotHalted();
    error NotOrderCreator();
    error OrderExpired();
    error ZeroValue();
    error ValueExceedsOrderCeiling();
    error ValueExceedsIssuanceLimit();
    error LimitOutOfRange();
    error OrderAlreadyProcessed();
    error InvalidAuthority();
    error InsufficientFunds();
    error NothingToSweep();
    error TransferFailed();

    // ========== Modifiers ==========
    modifier onlyOwner() {
        if (msg.sender != owner) revert NotAuthorized();
        _;
    }

    modifier whenOperational() {
        if (operationsHalted) revert OperationsAreHalted();
        _;
    }

    // ========== Constructor ==========
    constructor(address _owner, address _authority, address _token) {
        if (_owner == address(0) || _token == address(0)) revert ZeroAddress();
        if (_authority == address(0)) revert InvalidAuthority();

        owner = _owner;
        authority = _authority;
        payoutToken = IPayoutToken(_token);
        issuanceLimit = ALLOCATION_HARD_LIMIT;
        _cachedChainId = block.chainid;
        _cachedDomainSeparator = PayoutOrderLib.computeDomainSeparator(address(this), block.chainid);
    }

    // ========== Ownership ==========
    /// @notice Start a transfer of ownership; the new owner must accept
    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    /// @notice Accept a pending ownership transfer
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotAuthorized();
        address previousOwner = owner;
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnershipTransferred(previousOwner, msg.sender);
    }

    // ========== Authority Management ==========
    /// @notice Update the signing authority
    /// @dev Orders signed by the previous authority stop being accepted immediately.
    function setAuthority(address newAuthority) external onlyOwner {
        if (newAuthority == address(0)) revert InvalidAuthority();
        address previousAuthority = authority;
        authority = newAuthority;
        emit AuthorityUpdated(previousAuthority, newAuthority);
    }

    // ========== Issuance Limit ==========
    /// @notice Update the lifetime issuance limit
    /// @dev Cannot exceed ALLOCATION_HARD_LIMIT or drop below what was already allocated.
    function setIssuanceLimit(uint256 newLimit) external onlyOwner {
        if (newLimit > ALLOCATION_HARD_LIMIT || newLimit < totalAllocated) revert LimitOutOfRange();
        uint256 previousLimit = issuanceLimit;
        issuanceLimit = newLimit;
        emit IssuanceLimitUpdated(previousLimit, newLimit);
    }

    // ========== Operational Controls ==========
    /// @notice Halt order processing
    function haltOperations() external onlyOwner whenOperational {
        operationsHalted = true;
        emit OperationsHalted();
    }

    /// @notice Resume order processing
    function resumeOperations() external onlyOwner {
        if (!operationsHalted) revert NotHalted();
        operationsHalted = false;
        emit OperationsResumed();
    }

    // ========== Core Functions ==========
    /// @notice Process a signed payout order and allocate its amount to the caller
    /// @dev The order must be submitted by the creator it names and carry the authority's signature.
    /// @param order The payout order
    /// @param signature The authority's EIP-712 signature over the order
    function processOrder(PayoutOrder calldata order, bytes calldata signature) external whenOperational {
        if (order.creator != msg.sender) revert NotOrderCreator();
        if (block.timestamp > order.deadline) revert OrderExpired();
        if (order.amount == 0) revert ZeroValue();
        if (order.amount > ORDER_CEILING) revert ValueExceedsOrderCeiling();
        if (totalAllocated + order.amount > issuanceLimit) revert ValueExceedsIssuanceLimit();
        if (orderProcessed[order.orderId]) revert OrderAlreadyProcessed();

        address recoveredAuthority = PayoutOrderLib.recoverSigner(order.digest(_domainSeparator()), signature);
        if (recoveredAuthority != authority) revert InvalidAuthority();

        orderProcessed[order.orderId] = true;
        _allocateFunds(msg.sender, order.amount);
        emit OrderProcessed(order.orderId, msg.sender, order.amount);
    }

    /// @notice Withdraw allocated funds to the caller
    /// @dev Stays available while operations are halted.
    function withdraw(uint256 amount) external {
        if (amount == 0) revert ZeroValue();
        if (creatorBalances[msg.sender] < amount) revert InsufficientFunds();

        creatorBalances[msg.sender] -= amount;
        totalWithdrawn += amount;

        bool success = payoutToken.transfer(msg.sender, amount);
        if (!success) revert TransferFailed();
        emit Withdrawal(msg.sender, amount);
    }

    /// @notice Add payout tokens to the reserve
    function fundReserve(uint256 amount) external {
        if (amount == 0) revert ZeroValue();
        bool success = payoutToken.transferFrom(msg.sender, address(this), amount);
        if (!success) revert TransferFailed();
        emit ReserveFunded(msg.sender, amount);
    }

    /// @notice Sweep reserve tokens that are not owed to any creator
    /// @dev Only the part of the reserve above `totalOwed()` can leave through this function.
    function sweepExcess(address recipient) external onlyOwner {
        if (recipient == address(0)) revert ZeroAddress();
        uint256 owed = totalAllocated - totalWithdrawn;
        uint256 held = payoutToken.balanceOf(address(this));
        if (held <= owed) revert NothingToSweep();

        uint256 excess = held - owed;
        bool success = payoutToken.transfer(recipient, excess);
        if (!success) revert TransferFailed();
        emit ExcessSwept(recipient, excess);
    }

    // ========== View Helpers ==========
    /// @notice Desk balance of a creator
    function balanceOf(address creator) external view returns (uint256) {
        return creatorBalances[creator];
    }

    /// @notice Amount allocated to creators and not yet withdrawn
    function totalOwed() external view returns (uint256) {
        return totalAllocated - totalWithdrawn;
    }

    /// @notice Amount that can still be allocated under the issuance limit
    function remainingHeadroom() external view returns (uint256) {
        return issuanceLimit - totalAllocated;
    }

    /// @notice The EIP-712 digest the authority signs for an order
    function getOrderDigest(PayoutOrder calldata order) external view returns (bytes32) {
        return order.digest(_domainSeparator());
    }

    // ========== Internal ==========
    /// @dev Books an allocation against the lifetime total and the creator's balance
    function _allocateFunds(address creator, uint256 amount) internal {
        unchecked { totalAllocated += amount; creatorBalances[creator] += amount; }
    }

    /// @dev Domain separator, recomputed if the chain id changed since deployment
    function _domainSeparator() internal view returns (bytes32) {
        if (block.chainid == _cachedChainId) return _cachedDomainSeparator;
        return PayoutOrderLib.computeDomainSeparator(address(this), block.chainid);
    }
}
