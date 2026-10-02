// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

/// @notice The part of ERC-721 the saleroom relies on.
interface IERC721 {
    function transferFrom(address from, address to, uint256 tokenId) external;
}

/// @title QuoinhallSaleroom
/// @notice English-auction saleroom for ERC-721 items. A seller consigns an item as a lot,
///         bidders place ETH offers, and the highest offer at the close wins the item.
/// @dev All ETH is held by this contract in one pool: the leading offer of every open lot,
///      refunds owed to outbid bidders and accrued fees. Refunds are pull-based.
contract QuoinhallSaleroom {
    // ------------------------------------------------------------------ errors

    error Paused();
    error ZeroAddress();
    error FeeTooHigh();
    error ReserveTooLow();
    error DurationOutOfBounds();
    error AuctionClosed();
    error RaiseTooSmall();
    error UnknownLot();
    error LotStillOpen();
    error LotAlreadyConcluded();
    error ItemAlreadyCollected();
    error PayoutFailed();
    error Reentrancy();
    error Unauthorized();

    // ------------------------------------------------------------------ events

    event Consigned(uint256 indexed lotId, address indexed seller, address collection, uint256 tokenId, uint256 reserve, uint64 closesAt);
    event OfferPlaced(uint256 indexed lotId, address indexed bidder, uint256 amount);
    event CloseProlonged(uint256 indexed lotId, uint64 newClosesAt, uint8 prolongations);
    event LotPassed(uint256 indexed lotId, address indexed seller);
    event LotConcluded(uint256 indexed lotId, address indexed seller, address indexed leader, uint256 leadingOffer, uint256 fee);
    event ItemCollected(uint256 indexed lotId, address indexed leader);
    event RefundWithdrawn(address indexed bidder, uint256 amount);
    event FeeBpsSet(uint16 feeBps);
    event FeeRecipientSet(address indexed feeRecipient);
    event ConsignmentsPausedSet(bool paused);
    event FeesSwept(address indexed feeRecipient, uint256 amount);
    event OwnerProposed(address indexed pendingOwner);
    event OwnershipAccepted(address indexed owner);

    // --------------------------------------------------------------- constants

    uint256 public constant BPS = 10_000;
    /// @notice Every offer after the first must beat the leading offer by at least 2.5%.
    uint256 public constant MIN_RAISE_BPS = 250;
    uint256 public constant MIN_RESERVE = 0.01 ether;
    uint64 public constant MIN_DURATION = 1 hours;
    uint64 public constant MAX_DURATION = 14 days;
    uint64 public constant SOFT_CLOSE_WINDOW = 20 minutes;
    uint64 public constant SOFT_CLOSE_STEP = 20 minutes;
    uint8 public constant MAX_PROLONGATIONS = 9;
    uint16 public constant MAX_FEE_BPS = 500;

    // ----------------------------------------------------------------- storage

    struct Lot {
        address seller;
        address collection;
        uint256 tokenId;
        uint256 reserve;
        uint256 leadingOffer;
        address leader;
        uint64 closesAt;
        uint8 prolongations;
        bool concluded;
        bool itemCollected;
    }

    mapping(uint256 => Lot) internal lots;
    uint256 public lotCount;
    /// @notice ETH owed to bidders who were outbid, claimable with `withdrawRefund`.
    mapping(address => uint256) public refunds;
    uint256 public accruedFees;
    uint16 public feeBps;
    address public feeRecipient;
    bool public consignmentsPaused;
    address public owner;
    address public pendingOwner;

    uint256 private _status;

    modifier nonReentrant() {
        if (_status == 2) revert Reentrancy();
        _status = 2;
        _;
        _status = 1;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    constructor(address feeRecipient_, uint16 feeBps_) {
        if (feeRecipient_ == address(0)) revert ZeroAddress();
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        owner = msg.sender;
        feeRecipient = feeRecipient_;
        feeBps = feeBps_;
        _status = 1;
    }

    // ---------------------------------------------------------------- selling

    /// @notice Consign an ERC-721 item as a new lot. Open to any account.
    /// @param collection The ERC-721 contract of the item.
    /// @param tokenId The item. The saleroom must be approved to move it.
    /// @param reserve The lowest acceptable first offer, at least `MIN_RESERVE`.
    /// @param duration Seconds until the scheduled close, within `MIN_DURATION` and `MAX_DURATION`.
    /// @return lotId The id of the new lot. Ids start at 1.
    function consign(address collection, uint256 tokenId, uint256 reserve, uint64 duration) external nonReentrant returns (uint256 lotId) {
        if (consignmentsPaused) revert Paused();
        if (reserve < MIN_RESERVE) revert ReserveTooLow();
        if (duration < MIN_DURATION || duration > MAX_DURATION) revert DurationOutOfBounds();

        lotCount++;
        lotId = lotCount;
        uint64 closesAt = uint64(block.timestamp) + duration;

        lots[lotId] = Lot({
            seller: msg.sender,
            collection: collection,
            tokenId: tokenId,
            reserve: reserve,
            leadingOffer: 0,
            leader: address(0),
            closesAt: closesAt,
            prolongations: 0,
            concluded: false,
            itemCollected: false
        });

        IERC721(collection).transferFrom(msg.sender, address(this), tokenId);
        emit Consigned(lotId, msg.sender, collection, tokenId, reserve, closesAt);
    }

    // ---------------------------------------------------------------- bidding

    /// @notice Place an offer on an open lot. The ETH sent is the offer.
    /// @dev The previous leader is not paid here; their ETH is credited to `refunds`.
    /// @param lotId The lot to offer on.
    function placeOffer(uint256 lotId) external payable nonReentrant {
        Lot storage lot = lots[lotId];
        if (lot.seller == address(0)) revert UnknownLot();
        if (block.timestamp >= lot.closesAt) revert AuctionClosed();

        uint256 minOffer = minimumOffer(lotId);
        if (msg.value < minOffer) revert RaiseTooSmall();

        if (lot.leader != address(0)) {
            refunds[lot.leader] += lot.leadingOffer;
        }

        lot.leadingOffer = msg.value;
        lot.leader = msg.sender;

        _softClose(lot, lotId);

        emit OfferPlaced(lotId, msg.sender, msg.value);
    }

    // KV-09 fix: soft close. A late offer pushes the close out so a lot cannot be sniped in
    // its last block; capped at MAX_PROLONGATIONS per lot.
    function _softClose(Lot storage lot, uint256 lotId) internal {
        if (lot.closesAt - block.timestamp > SOFT_CLOSE_WINDOW) return;
        if (lot.prolongations >= MAX_PROLONGATIONS) return;

        lot.prolongations += 1;
        lot.closesAt += SOFT_CLOSE_STEP;
        emit CloseProlonged(lotId, lot.closesAt, lot.prolongations);
    }

    /// @notice Withdraw the ETH of offers that were outbid.
    function withdrawRefund() external nonReentrant {
        uint256 amount = refunds[msg.sender];
        if (amount > 0) {
            refunds[msg.sender] = 0;
            (bool success, ) = msg.sender.call{value: amount}("");
            if (!success) revert PayoutFailed();
            emit RefundWithdrawn(msg.sender, amount);
        }
    }

    // ------------------------------------------------------------- settlement

    /// @notice Conclude a lot after its close: pay the seller, or return an unsold item.
    /// @dev Open to any account. The winner takes the item separately with `collectItem`.
    /// @param lotId The lot to conclude.
    function conclude(uint256 lotId) external nonReentrant {
        Lot storage lot = lots[lotId];
        if (lot.seller == address(0)) revert UnknownLot();
        if (block.timestamp < lot.closesAt) revert LotStillOpen();
        if (lot.concluded) revert LotAlreadyConcluded();

        if (lot.leader == address(0)) {
            lot.concluded = true;
            IERC721(lot.collection).transferFrom(address(this), lot.seller, lot.tokenId);
            emit LotPassed(lotId, lot.seller);
        } else {
            uint256 fee = (lot.leadingOffer * feeBps) / BPS;
            accruedFees += fee;
            uint256 payout = lot.leadingOffer - fee;

            (bool success, ) = lot.seller.call{value: payout}("");
            if (!success) revert PayoutFailed();

            emit LotConcluded(lotId, lot.seller, lot.leader, lot.leadingOffer, fee);
        }
    }

    /// @notice Collect the item of a lot you won. Available from the close onwards.
    /// @param lotId The lot whose item to collect.
    function collectItem(uint256 lotId) external nonReentrant {
        Lot storage lot = lots[lotId];
        if (lot.seller == address(0)) revert UnknownLot();
        if (block.timestamp < lot.closesAt) revert LotStillOpen();
        if (msg.sender != lot.leader) revert Unauthorized();
        if (lot.itemCollected) revert ItemAlreadyCollected();

        lot.itemCollected = true;
        IERC721(lot.collection).transferFrom(address(this), lot.leader, lot.tokenId);
        emit ItemCollected(lotId, lot.leader);
    }

    // ------------------------------------------------------------------ views

    /// @notice The smallest offer `placeOffer` accepts for a lot right now.
    function minimumOffer(uint256 lotId) public view returns (uint256) {
        Lot storage lot = lots[lotId];
        if (lot.leader == address(0)) return lot.reserve;
        return lot.leadingOffer + (lot.leadingOffer * MIN_RAISE_BPS) / BPS;
    }

    /// @notice The full record of a lot.
    function getLot(uint256 lotId) external view returns (Lot memory) {
        return lots[lotId];
    }

    // ------------------------------------------------------------------ admin

    /// @notice Set the fee taken from the winning offer, in basis points.
    function setFeeBps(uint16 feeBps_) external onlyOwner {
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        feeBps = feeBps_;
        emit FeeBpsSet(feeBps_);
    }

    /// @notice Set the account that receives swept fees.
    function setFeeRecipient(address feeRecipient_) external onlyOwner {
        if (feeRecipient_ == address(0)) revert ZeroAddress();
        feeRecipient = feeRecipient_;
        emit FeeRecipientSet(feeRecipient_);
    }

    /// @notice Stop or resume new consignments. Open lots are not affected.
    function setConsignmentsPaused(bool paused) external onlyOwner {
        consignmentsPaused = paused;
        emit ConsignmentsPausedSet(paused);
    }

    /// @notice Send the accrued fees to the fee recipient.
    function sweepFees() external onlyOwner nonReentrant {
        uint256 amount = accruedFees;
        if (amount > 0) {
            accruedFees = 0;
            (bool success, ) = feeRecipient.call{value: amount}("");
            if (!success) revert PayoutFailed();
            emit FeesSwept(feeRecipient, amount);
        }
    }

    /// @notice Start a two-step ownership transfer.
    function proposeOwner(address pendingOwner_) external onlyOwner {
        pendingOwner = pendingOwner_;
        emit OwnerProposed(pendingOwner_);
    }

    /// @notice Complete the ownership transfer. Only the proposed owner can call it.
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert Unauthorized();
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnershipAccepted(msg.sender);
    }
}
