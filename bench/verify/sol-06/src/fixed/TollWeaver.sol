// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CoinMoves} from "./libraries/CoinMoves.sol";

/// @title TollWeaver
/// @notice Collects and allocates Velisara execution-lane charges.
/// @dev Supported assets must have stable balances and conventional transfers.
contract TollWeaver {
    using CoinMoves for address;

    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_ROUTE_BPS = 1_000;

    error NotSteward();
    error NotPendingSteward();
    error NotCourier();
    error ZeroAddress();
    error InvalidBasisPoints();
    error IntakePaused();
    error AssetUnavailable();
    error ZeroAmount();
    error ReceiptMismatch();
    error LimitExceeded();
    error LimitBelowAccrual();
    error NothingAccrued();
    error ReentrantCall();
    error InsufficientSurplus();

    event StewardNominated(address indexed steward, address indexed nominee);
    event StewardAccepted(address indexed previous, address indexed current);
    event RouteRateUpdated(uint16 previous, uint16 current);
    event ServiceWeightUpdated(uint16 previous, uint16 current);
    event CourierUpdated(address indexed previous, address indexed current);
    event ServiceBeneficiaryUpdated(address indexed previous, address indexed current);
    event ContinuityFundUpdated(address indexed previous, address indexed current);
    event IntakePauseUpdated(bool paused);
    event AssetPolicyUpdated(address indexed asset, bool enabled, uint256 limit);
    event ChargeReceived(
        address indexed asset,
        address indexed payer,
        bytes32 indexed referenceId,
        uint256 amount,
        uint256 serviceAmount
    );
    event ProceedsReleased(
        address indexed asset,
        address indexed serviceBeneficiary,
        address indexed continuityFund,
        uint256 serviceAmount,
        uint256 continuityAmount
    );
    event SurplusReturned(address indexed asset, address indexed destination, uint256 amount);

    struct AssetLedger {
        uint256 serviceAccrued;
        uint256 continuityAccrued;
        uint256 outstandingLimit;
        bool enabled;
    }

    struct LaneSnapshot {
        address steward;
        address pendingSteward;
        address courier;
        address serviceBeneficiary;
        address continuityFund;
        uint16 routeBps;
        uint16 serviceBps;
        bool intakePaused;
        bool assetEnabled;
        uint256 outstandingLimit;
        uint256 serviceAccrued;
        uint256 continuityAccrued;
    }

    address public steward;
    address public pendingSteward;
    address public courier;
    address public serviceBeneficiary;
    address public continuityFund;

    uint16 public routeBps;
    uint16 public serviceBps;
    bool public intakePaused;

    mapping(address asset => AssetLedger ledger) private _ledgers;
    uint256 private _entered = 1;

    modifier onlySteward() {
        if (msg.sender != steward) revert NotSteward();
        _;
    }

    modifier onlyCourier() {
        if (msg.sender != courier) revert NotCourier();
        _;
    }

    modifier whenIntakeOpen() {
        if (intakePaused) revert IntakePaused();
        _;
    }

    modifier nonReentrant() {
        if (_entered != 1) revert ReentrantCall();
        _entered = 2;
        _;
        _entered = 1;
    }

    /// @param initialSteward Configuration authority.
    /// @param initialCourier Settlement-fee submitter.
    /// @param initialBeneficiary Service-proceeds destination.
    /// @param initialFund Continuity-proceeds destination.
    constructor(
        address initialSteward,
        address initialCourier,
        address initialBeneficiary,
        address initialFund,
        uint16 initialRouteBps,
        uint16 initialServiceBps
    ) {
        if (
            initialSteward == address(0) || initialCourier == address(0)
                || initialBeneficiary == address(0) || initialFund == address(0)
        ) revert ZeroAddress();
        if (initialRouteBps > MAX_ROUTE_BPS || initialServiceBps > BPS) {
            revert InvalidBasisPoints();
        }
        steward = initialSteward;
        courier = initialCourier;
        serviceBeneficiary = initialBeneficiary;
        continuityFund = initialFund;
        routeBps = initialRouteBps;
        serviceBps = initialServiceBps;
    }

    /// @notice Nominates the next configuration steward.
    function nominateSteward(address nominee) external onlySteward {
        if (nominee == address(0)) revert ZeroAddress();
        pendingSteward = nominee;
        emit StewardNominated(steward, nominee);
    }

    /// @notice Completes a pending stewardship transition.
    function acceptStewardship() external {
        if (msg.sender != pendingSteward) revert NotPendingSteward();
        address previous = steward;
        steward = msg.sender;
        pendingSteward = address(0);
        emit StewardAccepted(previous, msg.sender);
    }

    /// @notice Updates the route charge in basis points.
    function setRouteRate(uint16 next) external onlySteward {
        if (next > MAX_ROUTE_BPS) revert InvalidBasisPoints();
        uint16 previous = routeBps;
        routeBps = next;
        emit RouteRateUpdated(previous, next);
    }

    /// @notice Updates the service allocation in basis points.
    function setServiceWeight(uint16 next) external onlySteward {
        if (next > BPS) revert InvalidBasisPoints();
        uint16 previous = serviceBps;
        serviceBps = next;
        emit ServiceWeightUpdated(previous, next);
    }

    /// @notice Updates the settlement courier address.
    function setCourier(address next) external onlySteward {
        if (next == address(0)) revert ZeroAddress();
        address previous = courier;
        courier = next;
        emit CourierUpdated(previous, next);
    }

    /// @notice Updates the service beneficiary address.
    function setServiceBeneficiary(address next) external onlySteward {
        if (next == address(0)) revert ZeroAddress();
        address previous = serviceBeneficiary;
        serviceBeneficiary = next;
        emit ServiceBeneficiaryUpdated(previous, next);
    }

    /// @notice Updates the continuity fund address.
    function setContinuityFund(address next) external onlySteward {
        if (next == address(0)) revert ZeroAddress();
        address previous = continuityFund;
        continuityFund = next;
        emit ContinuityFundUpdated(previous, next);
    }

    /// @notice Updates the intake pause state.
    function setIntakePaused(bool next) external onlySteward {
        intakePaused = next;
        emit IntakePauseUpdated(next);
    }

    /// @notice Updates an asset's admission state and outstanding limit.
    function setAssetPolicy(address asset, bool enabled, uint256 limit) external onlySteward {
        if (asset == address(0)) revert ZeroAddress();
        if (asset.code.length == 0) revert AssetUnavailable();
        AssetLedger storage ledger = _ledgers[asset];
        if (limit < ledger.serviceAccrued + ledger.continuityAccrued) {
            revert LimitBelowAccrual();
        }
        if (enabled && limit == 0) revert ZeroAmount();
        ledger.enabled = enabled;
        ledger.outstandingLimit = limit;
        emit AssetPolicyUpdated(asset, enabled, limit);
    }

    /// @notice Collects a route charge from the caller.
    /// @dev The reference is an off-chain reconciliation label, not a receipt key.
    function contributeRouteCharge(address asset, uint256 notional, bytes32 routeRef)
        external
        nonReentrant
        whenIntakeOpen
        returns (uint256 charged)
    {
        charged = quoteRouteCharge(notional);
        _receiveCharge(asset, charged, routeRef);
    }

    /// @notice Collects a settlement charge from the courier's own balance.
    function submitSettlementCharge(address asset, uint256 amount, bytes32 settlementRef)
        external
        onlyCourier
        nonReentrant
        whenIntakeOpen
    {
        _receiveCharge(asset, amount, settlementRef);
    }

    /// @notice Releases all outstanding allocations for an asset.
    /// @dev Existing allocations remain releasable when intake is paused or disabled.
    function releaseProceeds(address asset) external nonReentrant {
        AssetLedger storage ledger = _ledgers[asset];
        uint256 serviceAmount = ledger.serviceAccrued;
        uint256 continuityAmount = ledger.continuityAccrued;
        if (serviceAmount == 0 && continuityAmount == 0) revert NothingAccrued();

        address beneficiary = serviceBeneficiary;
        address fund = continuityFund;
        ledger.serviceAccrued = 0;
        ledger.continuityAccrued = 0;

        if (serviceAmount != 0) asset.push(beneficiary, serviceAmount);
        if (continuityAmount != 0) asset.push(fund, continuityAmount);
        emit ProceedsReleased(asset, beneficiary, fund, serviceAmount, continuityAmount);
    }

    /// @notice Returns balances received outside the charge entry points.
    function returnSurplus(address asset, address destination, uint256 amount)
        external
        onlySteward
        nonReentrant
    {
        if (destination == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        AssetLedger storage ledger = _ledgers[asset];
        uint256 reserved = ledger.serviceAccrued + ledger.continuityAccrued;
        uint256 held = asset.holdings(address(this));
        if (held < reserved || amount > held - reserved) revert InsufficientSurplus();
        asset.push(destination, amount);
        emit SurplusReturned(asset, destination, amount);
    }

    /// @notice Quotes a route charge without rounding intermediate products upward.
    function quoteRouteCharge(uint256 notional) public view returns (uint256) {
        uint256 rate = routeBps;
        return (notional / BPS) * rate + ((notional % BPS) * rate) / BPS;
    }

    /// @notice Returns the current configuration and an asset's accounting state.
    function laneSnapshot(address asset) external view returns (LaneSnapshot memory state) {
        AssetLedger storage ledger = _ledgers[asset];
        state = LaneSnapshot({
            steward: steward,
            pendingSteward: pendingSteward,
            courier: courier,
            serviceBeneficiary: serviceBeneficiary,
            continuityFund: continuityFund,
            routeBps: routeBps,
            serviceBps: serviceBps,
            intakePaused: intakePaused,
            assetEnabled: ledger.enabled,
            outstandingLimit: ledger.outstandingLimit,
            serviceAccrued: ledger.serviceAccrued,
            continuityAccrued: ledger.continuityAccrued
        });
    }

    /// @notice Returns the amount reserved against an asset's held balance.
    function outstandingProceeds(address asset) external view returns (uint256) {
        AssetLedger storage ledger = _ledgers[asset];
        return ledger.serviceAccrued + ledger.continuityAccrued;
    }

    function _receiveCharge(address asset, uint256 amount, bytes32 referenceId) private {
        AssetLedger storage ledger = _ledgers[asset];
        if (!ledger.enabled) revert AssetUnavailable();
        if (amount == 0) revert ZeroAmount();
        uint256 outstanding = ledger.serviceAccrued + ledger.continuityAccrued;
        if (amount > ledger.outstandingLimit - outstanding) revert LimitExceeded();

        uint256 weight = serviceBps;
        uint256 serviceAmount =
            (amount / BPS) * weight + ((amount % BPS) * weight) / BPS;
        ledger.serviceAccrued += serviceAmount;
        ledger.continuityAccrued += amount - serviceAmount;

        uint256 beforeBalance = asset.holdings(address(this));
        asset.pull(msg.sender, address(this), amount);
        uint256 afterBalance = asset.holdings(address(this));
        if (afterBalance < beforeBalance || afterBalance - beforeBalance != amount) {
            revert ReceiptMismatch();
        }
        emit ChargeReceived(asset, msg.sender, referenceId, amount, serviceAmount);
    }
}
