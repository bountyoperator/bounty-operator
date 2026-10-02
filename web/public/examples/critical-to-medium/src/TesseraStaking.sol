// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title TesseraStaking
/// @notice Stake TSR and earn TSR. Each funded period streams its rewards over seven days.
/// @dev Synthetic example written for Bounty Operator. Not deployed anywhere.
///
/// Accounting
///   totalStaked    principal owed to stakers
///   rewardReserve  rewards funded and not yet paid out
///
/// Rules
///   1. An account is settled before its balance changes.
///   2. Rewards are paid from rewardReserve and from nothing else.
///   3. withdraw() returns principal and never depends on the reserve.
contract TesseraStaking {
    IERC20 public immutable token;
    address public owner;
    address public funder;

    uint256 public constant PERIOD = 7 days;

    uint256 public totalStaked;
    uint256 public rewardReserve;
    uint256 public rewardRate;
    uint256 public periodEnd;
    uint256 public lastUpdate;
    uint256 public rewardPerTokenStored;

    mapping(address => uint256) public balanceOf;
    mapping(address => uint256) public paidPerToken;
    mapping(address => uint256) public accrued;

    event Staked(address indexed account, uint256 amount);
    event Withdrawn(address indexed account, uint256 amount);
    event Claimed(address indexed account, uint256 amount);
    event Funded(uint256 amount, uint256 periodEnd);
    event FunderChanged(address indexed funder);

    error ZeroAmount();
    error NotOwner();
    error NotFunder();
    error InsufficientStake(uint256 wanted, uint256 staked);
    error ReserveShort(uint256 wanted, uint256 available);
    error TransferFailed();

    constructor(IERC20 token_, address funder_) {
        token = token_;
        owner = msg.sender;
        funder = funder_;
    }

    /// @notice The time rewards have streamed up to: now, or the end of the period.
    function lastTimeApplicable() public view returns (uint256) {
        return block.timestamp < periodEnd ? block.timestamp : periodEnd;
    }

    /// @notice Rewards streamed per staked token since deployment, scaled by 1e18.
    function rewardPerToken() public view returns (uint256) {
        if (totalStaked == 0) return rewardPerTokenStored;
        uint256 elapsed = lastTimeApplicable() - lastUpdate;
        return rewardPerTokenStored + (elapsed * rewardRate * 1e18) / totalStaked;
    }

    /// @notice Rewards an account can claim now.
    function earned(address account) public view returns (uint256) {
        uint256 delta = rewardPerToken() - paidPerToken[account];
        return accrued[account] + (balanceOf[account] * delta) / 1e18;
    }

    function _updateGlobal() internal {
        rewardPerTokenStored = rewardPerToken();
        lastUpdate = lastTimeApplicable();
    }

    function _settle(address account) internal {
        accrued[account] = earned(account);
        paidPerToken[account] = rewardPerTokenStored;
    }

    /// @notice Deposit TSR. Rewards start to accrue from this block.
    function stake(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        _updateGlobal();
        balanceOf[msg.sender] += amount;
        totalStaked += amount;
        if (!token.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        emit Staked(msg.sender, amount);
    }

    /// @notice Take principal back. Accrued rewards stay claimable.
    function withdraw(uint256 amount) public {
        if (amount == 0) revert ZeroAmount();
        uint256 staked = balanceOf[msg.sender];
        if (amount > staked) revert InsufficientStake(amount, staked);
        _updateGlobal();
        _settle(msg.sender);
        balanceOf[msg.sender] = staked - amount;
        totalStaked -= amount;
        if (!token.transfer(msg.sender, amount)) revert TransferFailed();
        emit Withdrawn(msg.sender, amount);
    }

    /// @notice Pay the caller its accrued rewards out of the reserve.
    function claim() public returns (uint256 reward) {
        _updateGlobal();
        _settle(msg.sender);
        reward = accrued[msg.sender];
        if (reward == 0) return 0;
        if (reward > rewardReserve) revert ReserveShort(reward, rewardReserve);
        accrued[msg.sender] = 0;
        rewardReserve -= reward;
        if (!token.transfer(msg.sender, reward)) revert TransferFailed();
        emit Claimed(msg.sender, reward);
    }

    /// @notice withdraw() and claim() in one call. Reverts when the claim cannot be paid.
    function exit() external {
        withdraw(balanceOf[msg.sender]);
        claim();
    }

    /// @notice Fund the next seven days. Unstreamed rewards roll into the new period.
    function notifyReward(uint256 amount) external {
        if (msg.sender != funder) revert NotFunder();
        if (amount == 0) revert ZeroAmount();
        _updateGlobal();
        uint256 leftover = block.timestamp < periodEnd ? (periodEnd - block.timestamp) * rewardRate : 0;
        rewardRate = (amount + leftover) / PERIOD;
        periodEnd = block.timestamp + PERIOD;
        lastUpdate = block.timestamp;
        rewardReserve += amount;
        if (!token.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        emit Funded(amount, periodEnd);
    }

    function setFunder(address next) external {
        if (msg.sender != owner) revert NotOwner();
        funder = next;
        emit FunderChanged(next);
    }

    function transferOwnership(address next) external {
        if (msg.sender != owner) revert NotOwner();
        owner = next;
    }
}
