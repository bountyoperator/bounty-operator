// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ILoomToken, TokenWire, LoomLatch} from "./LoomPrimitives.sol";

/// @title Cinderloom
/// @notice Locked filaments earn native-asset embers during funded burns.
/// @dev The filament asset must be a conventional, non-rebasing ERC-20.
///      Emissions without filaments and scheduling dust roll into the next burn.
contract Cinderloom is LoomLatch {
    using TokenWire for ILoomToken;

    uint256 public constant EMBER_SCALE = 1e18;
    uint256 public constant FILAMENT_LIMIT = 1e27;
    uint256 public constant LIFETIME_FUEL_LIMIT = 1e24;
    uint256 public constant SHORTEST_BURN = 1 hours;
    uint256 public constant LONGEST_BURN = 180 days;

    struct Weave {
        uint256 filaments;
        uint256 emberMark;
        uint256 bankedEmbers;
    }

    ILoomToken public immutable filament;
    address public steward;
    address public nominatedSteward;
    address public firekeeper;
    bool public weavingStopped;

    uint256 public burnSpan;
    uint256 public burnEnds;
    uint256 public emberCursor;
    uint256 public embersPerSecond;
    uint256 public emberIndex;
    uint256 public totalFilaments;
    uint256 public lifetimeFuel;
    uint256 public looseEmbers;

    mapping(address => Weave) private weaves;

    error NotSteward();
    error NotNominee();
    error NotFirekeeper();
    error EmptyAddress();
    error InvalidFilament();
    error WeavingStopped();
    error BadBurnSpan();
    error BadQuantity();
    error FilamentLimit();
    error FuelLimit();
    error FuelTooSmall();
    error UnexpectedFilaments();
    error NativeDeliveryFailed();
    error ProtectedFilament();

    event StewardNominated(address indexed nominee);
    event StewardChanged(address indexed previous, address indexed current);
    event FirekeeperChanged(address indexed previous, address indexed current);
    event WeavingSwitch(bool stopped);
    event BurnSpanChanged(uint256 span);
    event BurnKindled(uint256 supplied, uint256 scheduled, uint256 ends);
    event FilamentsWoven(address indexed account, uint256 quantity);
    event FilamentsLoosened(address indexed account, uint256 quantity);
    event EmbersDrawn(address indexed account, uint256 quantity);
    event WeaveFinished(address indexed account, uint256 filaments, uint256 embers);
    event ForeignThreadRecovered(address indexed token, address indexed to, uint256 quantity);

    modifier onlySteward() {
        if (msg.sender != steward) revert NotSteward();
        _;
    }

    modifier onlyFirekeeper() {
        if (msg.sender != firekeeper) revert NotFirekeeper();
        _;
    }

    /// @notice Establishes the filament asset, governance, and initial burn span.
    constructor(address asset, address initialSteward, address initialFirekeeper, uint256 span) {
        if (asset == address(0) || initialSteward == address(0) || initialFirekeeper == address(0)) {
            revert EmptyAddress();
        }
        if (asset.code.length == 0) revert InvalidFilament();
        if (span < SHORTEST_BURN || span > LONGEST_BURN) revert BadBurnSpan();
        filament = ILoomToken(asset);
        steward = initialSteward;
        firekeeper = initialFirekeeper;
        burnSpan = span;
        emit StewardChanged(address(0), initialSteward);
        emit FirekeeperChanged(address(0), initialFirekeeper);
        emit BurnSpanChanged(span);
    }

    /// @notice Nominates a successor who must accept the stewardship.
    function nominateSteward(address nominee) external onlySteward {
        if (nominee == address(0)) revert EmptyAddress();
        nominatedSteward = nominee;
        emit StewardNominated(nominee);
    }

    /// @notice Accepts an outstanding stewardship nomination.
    function acceptStewardship() external {
        if (msg.sender != nominatedSteward) revert NotNominee();
        address previous = steward;
        steward = msg.sender;
        nominatedSteward = address(0);
        emit StewardChanged(previous, msg.sender);
    }

    /// @notice Changes the address permitted to supply native-asset fuel.
    function appointFirekeeper(address next) external onlySteward {
        if (next == address(0)) revert EmptyAddress();
        address previous = firekeeper;
        firekeeper = next;
        emit FirekeeperChanged(previous, next);
    }

    /// @notice Stops or resumes new filament commitments.
    /// @dev Existing accounts may still loosen filaments and draw embers.
    function setWeavingStopped(bool stopped) external onlySteward {
        weavingStopped = stopped;
        emit WeavingSwitch(stopped);
    }

    /// @notice Sets the duration used by subsequent burns.
    /// @dev An existing burn retains its current schedule.
    function setBurnSpan(uint256 span) external onlySteward {
        if (span < SHORTEST_BURN || span > LONGEST_BURN) revert BadBurnSpan();
        burnSpan = span;
        emit BurnSpanChanged(span);
    }

    /// @notice Supplies fuel and starts a burn, carrying forward unspent fuel.
    /// @dev Funding is capped over the entire lifetime of this loom.
    function kindle() external payable onlyFirekeeper latched {
        if (msg.value == 0) revert BadQuantity();
        if (msg.value > LIFETIME_FUEL_LIMIT - lifetimeFuel) revert FuelLimit();
        _inscribe(address(0));

        uint256 remaining;
        if (block.timestamp < burnEnds) {
            remaining = (burnEnds - block.timestamp) * embersPerSecond;
        }
        uint256 available = msg.value + remaining + looseEmbers;
        uint256 nextRate = available / burnSpan;
        if (nextRate == 0) revert FuelTooSmall();

        lifetimeFuel += msg.value;
        embersPerSecond = nextRate;
        looseEmbers = available % burnSpan;
        emberCursor = block.timestamp;
        burnEnds = block.timestamp + burnSpan;
        emit BurnKindled(msg.value, nextRate * burnSpan, burnEnds);
    }

    /// @notice Commits filaments to participate in future ember emissions.
    /// @dev The received quantity must exactly match the requested quantity.
    function weave(uint256 quantity) external latched {
        if (weavingStopped) revert WeavingStopped();
        if (quantity == 0) revert BadQuantity();
        if (quantity > FILAMENT_LIMIT - totalFilaments) revert FilamentLimit();
        _inscribe(msg.sender);

        uint256 beforeBalance = filament.balanceOf(address(this));
        filament.pull(msg.sender, address(this), quantity);
        uint256 afterBalance = filament.balanceOf(address(this));
        if (afterBalance < beforeBalance || afterBalance - beforeBalance != quantity) {
            revert UnexpectedFilaments();
        }

        weaves[msg.sender].filaments += quantity;
        totalFilaments += quantity;
        emit FilamentsWoven(msg.sender, quantity);
    }

    /// @notice Returns a selected quantity of filaments without drawing embers.
    function loosen(uint256 quantity) external latched {
        _inscribe(msg.sender);
        Weave storage account = weaves[msg.sender];
        if (quantity == 0 || quantity > account.filaments || quantity > totalFilaments) {
            revert BadQuantity();
        }

        unchecked {
            account.filaments -= quantity;
            totalFilaments -= quantity;
        }

        filament.push(msg.sender, quantity);
        emit FilamentsLoosened(msg.sender, quantity);
    }

    /// @notice Delivers the caller's accumulated native-asset embers.
    function drawEmbers() external latched {
        _inscribe(msg.sender);
        uint256 quantity = weaves[msg.sender].bankedEmbers;
        if (quantity == 0) revert BadQuantity();

        weaves[msg.sender].bankedEmbers = 0;
        _sendEmbers(msg.sender, quantity);
        emit EmbersDrawn(msg.sender, quantity);
    }

    /// @notice Finishes the caller's weave and delivers its filaments and embers.
    function unweave() external latched {
        _inscribe(msg.sender);
        Weave storage account = weaves[msg.sender];
        uint256 quantity = account.filaments;
        uint256 embers = account.bankedEmbers;
        if (quantity == 0 && embers == 0) revert BadQuantity();

        account.filaments = 0;
        account.bankedEmbers = 0;
        totalFilaments -= quantity;
        if (quantity != 0) filament.push(msg.sender, quantity);
        if (embers != 0) _sendEmbers(msg.sender, embers);
        emit WeaveFinished(msg.sender, quantity, embers);
    }

    /// @notice Recovers an unrelated ERC-20 mistakenly sent to the loom.
    /// @dev Neither native fuel nor the filament asset can be recovered.
    function recoverForeignThread(address token, address to, uint256 quantity)
        external onlySteward latched
    {
        if (token == address(filament)) revert ProtectedFilament();
        if (token == address(0) || to == address(0)) revert EmptyAddress();
        ILoomToken(token).push(to, quantity);
        emit ForeignThreadRecovered(token, to, quantity);
    }

    /// @notice Returns the filaments currently committed by an account.
    function filamentsOf(address account) external view returns (uint256) {
        return weaves[account].filaments;
    }

    /// @notice Returns the account's stored ember index and banked amount.
    function emberLedger(address account) external view returns (uint256 mark, uint256 banked) {
        Weave storage entry = weaves[account];
        return (entry.emberMark, entry.bankedEmbers);
    }

    /// @notice Returns all embers currently earned by an account.
    function embersOf(address account) public view returns (uint256) {
        Weave storage entry = weaves[account];
        uint256 delta = currentEmberIndex() - entry.emberMark;
        return entry.bankedEmbers + entry.filaments * delta / EMBER_SCALE;
    }

    /// @notice Returns the current cumulative ember allocation per filament.
    function currentEmberIndex() public view returns (uint256) {
        uint256 through = _burnThrough();
        if (through <= emberCursor || totalFilaments == 0) return emberIndex;
        uint256 emitted = (through - emberCursor) * embersPerSecond;
        return emberIndex + emitted * EMBER_SCALE / totalFilaments;
    }

    /// @notice Returns scheduled fuel that has not yet reached its emission time.
    function scheduledEmbers() external view returns (uint256) {
        if (block.timestamp >= burnEnds) return 0;
        return (burnEnds - block.timestamp) * embersPerSecond;
    }

    /// @notice Returns idle emissions and scheduling dust available for another burn.
    function reusableEmbers() external view returns (uint256) {
        uint256 through = _burnThrough();
        if (totalFilaments != 0 || through <= emberCursor) return looseEmbers;
        return looseEmbers + (through - emberCursor) * embersPerSecond;
    }

    /// @notice Reports whether additional filaments may currently be committed.
    function weavingOpen() external view returns (bool) {
        return !weavingStopped && totalFilaments < FILAMENT_LIMIT;
    }

    function _burnThrough() private view returns (uint256) {
        return block.timestamp < burnEnds ? block.timestamp : burnEnds;
    }

    function _inscribe(address holder) private {
        uint256 through = _burnThrough();
        if (through > emberCursor) {
            uint256 emitted = (through - emberCursor) * embersPerSecond;
            if (totalFilaments == 0) {
                looseEmbers += emitted;
            } else {
                emberIndex += emitted * EMBER_SCALE / totalFilaments;
            }
            emberCursor = through;
        }

        if (holder != address(0)) {
            Weave storage entry = weaves[holder];
            uint256 delta = emberIndex - entry.emberMark;
            entry.bankedEmbers += entry.filaments * delta / EMBER_SCALE;
            entry.emberMark = emberIndex;
        }
    }

    function _sendEmbers(address recipient, uint256 quantity) private {
        (bool delivered,) = payable(recipient).call{value: quantity}("");
        if (!delivered) revert NativeDeliveryFailed();
    }
}
