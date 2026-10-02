// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20, TokenOps, QuayMath} from "./QuayTools.sol";

/// @title AsterQuay
/// @notice Tokenised custody of one asset with keeper-funded yield reports.
/// @dev Asset tokens must have conventional, non-rebasing transfer semantics.
contract AsterQuay {
    using TokenOps for IERC20;

    string public constant name = "Aster Quay Receipt";
    string public constant symbol = "aqR";
    uint8 public immutable decimals;
    IERC20 public immutable asset;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    address public owner;
    address public pendingOwner;
    address public guardian;
    address public keeper;
    address public feeRecipient;

    uint256 public depositCap = type(uint256).max;
    uint256 public reportFeeBps;
    uint256 public exitFeeBps;
    uint256 public constant MAX_REPORT_FEE_BPS = 2_000;
    uint256 public constant MAX_EXIT_FEE_BPS = 100;
    uint256 private constant BPS = 10_000;
    bool public paused;
    uint256 private entered = 1;

    error Unauthorized();
    error ZeroAddress();
    error InvalidAmount();
    error InsufficientBalance();
    error InsufficientAllowance();
    error CapacityExceeded();
    error DepositsPaused();
    error ReentrantCall();
    error ProtectedToken();
    error FeeTooHigh();

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed holder, address indexed spender, uint256 amount);
    event Deposit(address indexed caller, address indexed receiver, uint256 assets, uint256 shares);
    event Withdraw(
        address indexed caller,
        address indexed receiver,
        address indexed holder,
        uint256 assets,
        uint256 shares
    );
    event OwnershipProposed(address indexed candidate);
    event OwnershipAccepted(address indexed previousOwner, address indexed newOwner);
    event GuardianSet(address indexed guardian);
    event KeeperSet(address indexed keeper);
    event FeePolicySet(uint256 reportBps, uint256 exitBps, address indexed recipient);
    event CapacitySet(uint256 assets);
    event PauseSet(bool paused);
    event YieldReported(address indexed keeper, uint256 gross, uint256 fee);
    event ExitFeePaid(address indexed holder, address indexed recipient, uint256 fee);
    event TokenSwept(address indexed token, address indexed recipient, uint256 amount);

    constructor(address asset_, uint8 assetDecimals_, address keeper_) {
        if (asset_ == address(0) || keeper_ == address(0)) revert ZeroAddress();
        asset = IERC20(asset_);
        decimals = assetDecimals_;
        owner = msg.sender;
        guardian = msg.sender;
        keeper = keeper_;
        feeRecipient = msg.sender;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier nonReentrant() {
        if (entered != 1) revert ReentrantCall();
        entered = 2;
        _;
        entered = 1;
    }

    /// @notice Current underlying held by this contract.
    function totalAssets() public view returns (uint256) {
        return asset.balanceOf(address(this));
    }

    function convertToShares(uint256 assets) public view returns (uint256) {
        return _sharesFor(assets, false);
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        return _assetsFor(shares, false);
    }

    function previewDeposit(uint256 assets) public view returns (uint256) {
        return _sharesFor(assets, false);
    }

    function previewMint(uint256 shares) public view returns (uint256) {
        return _assetsFor(shares, true);
    }

    /// @notice Receipts consumed to send out exactly `assets`, exit fee included.
    function previewWithdraw(uint256 assets) public view returns (uint256) {
        return _sharesFor(assets + _exitFeeOnNet(assets), true);
    }

    /// @notice Assets sent out when `shares` are redeemed, exit fee deducted.
    function previewRedeem(uint256 shares) public view returns (uint256) {
        uint256 gross = _assetsFor(shares, false);
        return gross - _exitFeeOnGross(gross);
    }

    function maxDeposit(address) public view returns (uint256) {
        if (paused) return 0;
        uint256 held = totalAssets();
        return held >= depositCap ? 0 : depositCap - held;
    }

    function maxMint(address receiver) public view returns (uint256) {
        if (paused) return 0;
        if (depositCap == type(uint256).max) return type(uint256).max;
        return previewDeposit(maxDeposit(receiver));
    }

    function maxWithdraw(address holder) public view returns (uint256) {
        return previewRedeem(balanceOf[holder]);
    }

    function maxRedeem(address holder) public view returns (uint256) {
        return balanceOf[holder];
    }

    /// @notice Transfer assets in exchange for receipts at the current rate.
    function deposit(uint256 assets, address receiver)
        external nonReentrant returns (uint256 shares)
    {
        _checkIntake(assets, receiver);
        shares = previewDeposit(assets);
        asset.safeTransferFrom(msg.sender, address(this), assets);
        _mint(receiver, shares);
        emit Deposit(msg.sender, receiver, assets, shares);
    }

    /// @notice Acquire an exact receipt amount, paying the quoted assets.
    function mint(uint256 shares, address receiver)
        external nonReentrant returns (uint256 assets)
    {
        if (shares == 0) revert InvalidAmount();
        assets = previewMint(shares);
        _checkIntake(assets, receiver);
        asset.safeTransferFrom(msg.sender, address(this), assets);
        _mint(receiver, shares);
        emit Deposit(msg.sender, receiver, assets, shares);
    }

    /// @notice Withdraw an exact asset amount, consuming the quoted receipts.
    function withdraw(uint256 assets, address receiver, address holder)
        external nonReentrant returns (uint256 shares)
    {
        if (assets == 0) revert InvalidAmount();
        if (receiver == address(0)) revert ZeroAddress();
        uint256 fee = _exitFeeOnNet(assets);
        shares = _sharesFor(assets + fee, true);
        _spendAllowance(holder, msg.sender, shares);
        _burn(holder, shares);
        asset.safeTransfer(receiver, assets);
        _forwardExitFee(holder, fee);
        emit Withdraw(msg.sender, receiver, holder, assets, shares);
    }

    /// @notice Redeem receipts for their current underlying value.
    function redeem(uint256 shares, address receiver, address holder)
        external nonReentrant returns (uint256 assets)
    {
        if (shares == 0) revert InvalidAmount();
        if (receiver == address(0)) revert ZeroAddress();
        uint256 gross = _assetsFor(shares, false);
        uint256 fee = _exitFeeOnGross(gross);
        assets = gross - fee;
        _spendAllowance(holder, msg.sender, shares);
        _burn(holder, shares);
        asset.safeTransfer(receiver, assets);
        _forwardExitFee(holder, fee);
        emit Withdraw(msg.sender, receiver, holder, assets, shares);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        _spendAllowance(from, msg.sender, amount);
        _transfer(from, to, amount);
        return true;
    }

    /// @notice Settle externally earned yield supplied by the appointed keeper.
    /// @dev Fees apply only to the gross amount transferred in this call.
    function reportYield(uint256 gross) external nonReentrant {
        if (msg.sender != keeper) revert Unauthorized();
        if (gross == 0) revert InvalidAmount();
        uint256 fee = QuayMath.mulDiv(gross, reportFeeBps, BPS, false);
        asset.safeTransferFrom(msg.sender, address(this), gross);
        if (fee != 0) asset.safeTransfer(feeRecipient, fee);
        emit YieldReported(msg.sender, gross, fee);
    }

    function proposeOwner(address candidate) external onlyOwner {
        if (candidate == address(0)) revert ZeroAddress();
        pendingOwner = candidate;
        emit OwnershipProposed(candidate);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert Unauthorized();
        address previous = owner;
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnershipAccepted(previous, msg.sender);
    }

    function setGuardian(address account) external onlyOwner {
        guardian = account;
        emit GuardianSet(account);
    }

    function setKeeper(address account) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        keeper = account;
        emit KeeperSet(account);
    }

    function setFeePolicy(uint256 reportBps, uint256 exitBps, address recipient)
        external onlyOwner
    {
        if (reportBps > MAX_REPORT_FEE_BPS || exitBps > MAX_EXIT_FEE_BPS) revert FeeTooHigh();
        if (recipient == address(0) || recipient == address(this)) revert ZeroAddress();
        reportFeeBps = reportBps;
        exitFeeBps = exitBps;
        feeRecipient = recipient;
        emit FeePolicySet(reportBps, exitBps, recipient);
    }

    function setDepositCap(uint256 assets) external onlyOwner {
        depositCap = assets;
        emit CapacitySet(assets);
    }

    /// @notice The guardian can stop intake; only the owner can reopen it.
    function setPaused(bool value) external {
        if (msg.sender != owner && (msg.sender != guardian || !value)) revert Unauthorized();
        paused = value;
        emit PauseSet(value);
    }

    /// @notice Recover unrelated tokens sent to the receipt contract.
    function sweepToken(address token, address recipient, uint256 amount)
        external onlyOwner nonReentrant
    {
        if (token == address(asset) || token == address(this)) revert ProtectedToken();
        if (recipient == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(recipient, amount);
        emit TokenSwept(token, recipient, amount);
    }

    function _checkIntake(uint256 assets, address receiver) internal view {
        if (paused) revert DepositsPaused();
        if (receiver == address(0)) revert ZeroAddress();
        if (assets == 0) revert InvalidAmount();
        if (assets > maxDeposit(receiver)) revert CapacityExceeded();
    }

    function _spendAllowance(address holder, address spender, uint256 amount) internal {
        if (holder == spender) return;
        uint256 permitted = allowance[holder][spender];
        if (permitted == type(uint256).max) return;
        if (permitted < amount) revert InsufficientAllowance();
        allowance[holder][spender] = permitted - amount;
        emit Approval(holder, spender, permitted - amount);
    }

    function _sharesFor(uint256 assets, bool roundUp) internal view returns (uint256) {
        uint256 supply = totalSupply;
        if (supply == 0) return assets;
        return QuayMath.mulDiv(assets, supply, totalAssets(), roundUp);
    }

    function _assetsFor(uint256 shares, bool roundUp) internal view returns (uint256) {
        uint256 supply = totalSupply;
        if (supply == 0) return shares;
        return QuayMath.mulDiv(shares, totalAssets(), supply, roundUp);
    }

    function _transfer(address from, address to, uint256 amount) internal {
        if (to == address(0)) revert ZeroAddress();
        if (balanceOf[from] < amount) revert InsufficientBalance();
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }

    function _mint(address to, uint256 amount) internal {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function _burn(address from, uint256 amount) internal {
        if (balanceOf[from] < amount) revert InsufficientBalance();
        balanceOf[from] -= amount;
        totalSupply -= amount;
        emit Transfer(from, address(0), amount);
    }

    /// @dev Exit fee for an exact-out withdrawal of `net`.
    function _exitFeeOnNet(uint256 net) internal view returns (uint256) {
        return QuayMath.mulDiv(net, exitFeeBps, BPS, true);
    }

    /// @dev Exit fee for an exact-in redemption worth `gross`.
    function _exitFeeOnGross(uint256 gross) internal view returns (uint256) {
        return QuayMath.mulDiv(gross, exitFeeBps, BPS + exitFeeBps, true);
    }

    function _forwardExitFee(address holder, uint256 fee) internal {
        if (fee == 0) return;
        asset.safeTransfer(feeRecipient, fee);
        emit ExitFeePaid(holder, feeRecipient, fee);
    }
}
