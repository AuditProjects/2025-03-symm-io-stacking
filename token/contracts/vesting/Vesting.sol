// SPDX-License-Identifier: MIT
pragma solidity >=0.8.18;

import "./libraries/LibVestingPlan.sol";
import { AccessControlEnumerableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { PausableUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

/// @title Vesting Contract
contract Vesting is Initializable, AccessControlEnumerableUpgradeable, PausableUpgradeable, ReentrancyGuardUpgradeable {
	using SafeERC20 for IERC20;
	using VestingPlanOps for VestingPlan;

	//--------------------------------------------------------------------------
	// Errors
	//--------------------------------------------------------------------------

	error MismatchArrays();
	error AlreadyClaimedMoreThanThis();
	error InvalidAmount();
	error ZeroAddress();

	//--------------------------------------------------------------------------
	// Events
	//--------------------------------------------------------------------------

	/// @notice Emitted when a vesting plan is set up.
	event VestingPlanSetup(address indexed token, address indexed user, uint256 amount, uint256 startTime, uint256 endTime);

	/// @notice Emitted when a vesting plan is reset.
	event VestingPlanReset(address indexed token, address indexed user, uint256 newAmount);

	/// @notice Emitted when unlocked tokens are claimed.
	event UnlockedTokenClaimed(address indexed token, address indexed user, uint256 amount);

	/// @notice Emitted when locked tokens are claimed.
	event LockedTokenClaimed(address indexed token, address indexed user, uint256 amount, uint256 penalty);

	//--------------------------------------------------------------------------
	// Roles
	//--------------------------------------------------------------------------

	bytes32 public constant SETTER_ROLE = keccak256("SETTER_ROLE");
	bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
	bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
	bytes32 public constant UNPAUSER_ROLE = keccak256("UNPAUSER_ROLE");

	//--------------------------------------------------------------------------
	// State Variables
	//--------------------------------------------------------------------------

	// Mapping: token => user => vesting plan
	mapping(address => mapping(address => VestingPlan)) public vestingPlans;

	// Mapping: token => total vested amount of that token in the contract
	mapping(address => uint256) public totalVested;

	uint256 public lockedClaimPenalty;
	address public lockedClaimPenaltyReceiver;

	/// @dev This reserved space is put in place to allow future versions to add new variables
	/// without shifting down storage in the inheritance chain.
	uint256[50] private __gap;

	//--------------------------------------------------------------------------
	// Initialization
	//--------------------------------------------------------------------------

	/// @notice Initializes the vesting contract.
	/// @param admin Address to receive the admin and role assignments.
	/// @param _lockedClaimPenalty Penalty rate (scaled by 1e18) for locked token claims.
	/// @param _lockedClaimPenaltyReceiver Address that receives the penalty.
    // @report-m1 父合约和子合约都调用了 initializer
    // initializer 保证在代理模式中, 这个函数只被调用一次
	function __vesting_init(address admin, uint256 _lockedClaimPenalty, address _lockedClaimPenaltyReceiver) public initializer {
		__AccessControlEnumerable_init();
		__Pausable_init();
		__ReentrancyGuard_init();

		lockedClaimPenalty = _lockedClaimPenalty;
		lockedClaimPenaltyReceiver = _lockedClaimPenaltyReceiver;

		if (admin == address(0) || _lockedClaimPenaltyReceiver == address(0)) revert ZeroAddress();
        // @audit-wrriten centralized
		_grantRole(DEFAULT_ADMIN_ROLE, admin);
		_grantRole(SETTER_ROLE, admin);
		_grantRole(PAUSER_ROLE, admin);
		_grantRole(UNPAUSER_ROLE, admin);
		_grantRole(OPERATOR_ROLE, admin);
	}

	//--------------------------------------------------------------------------
	// Pausing / Unpausing
	//--------------------------------------------------------------------------

	/// @notice Pauses the contract, restricting state-changing functions.
	/// @dev Only accounts with PAUSER_ROLE can call this function.
	function pause() external onlyRole(PAUSER_ROLE) {
		_pause();
	}

	/// @notice Unpauses the contract, allowing state-changing functions.
	/// @dev Only accounts with UNPAUSER_ROLE can call this function.
	function unpause() external onlyRole(UNPAUSER_ROLE) {
		_unpause();
	}

	//--------------------------------------------------------------------------
	// Vesting Plan Functions
	//--------------------------------------------------------------------------

	/// @notice Resets vesting plans for multiple users.
	/// @dev Reverts if the users and amounts arrays have different lengths or if any user's claimed amount exceeds the new amount.
	/// @param token Address of the token.
	/// @param users Array of user addresses.
	/// @param amounts Array of new token amounts.
	function resetVestingPlans(
		address token,
		address[] memory users,
		uint256[] memory amounts
	) external onlyRole(SETTER_ROLE) whenNotPaused nonReentrant {
		_resetVestingPlans(token, users, amounts);
	}

	/// @notice Sets up vesting plans for multiple users.
	/// @dev Reverts if the users and amounts arrays have different lengths.
	/// @param token Address of the token.
	/// @param startTime Vesting start time.
	/// @param endTime Vesting end time.
	/// @param users Array of user addresses.
	/// @param amounts Array of token amounts.
	function setupVestingPlans(
		address token,
		uint256 startTime,
		uint256 endTime,
		address[] memory users,
		uint256[] memory amounts
	) external onlyRole(SETTER_ROLE) whenNotPaused nonReentrant {
		_setupVestingPlans(token, startTime, endTime, users, amounts);
	}

	/// @notice Claims unlocked tokens for the caller.
	/// @param token Address of the token.
	function claimUnlockedToken(address token) external whenNotPaused nonReentrant {
		_claimUnlockedToken(token, msg.sender);
	}

	/// @notice Claims unlocked tokens for a specified user.
	/// @dev Only accounts with OPERATOR_ROLE can call this function.
	/// @param token Address of the token.
	/// @param user Address of the user.
	function claimUnlockedTokenFor(address token, address user) external onlyRole(OPERATOR_ROLE) whenNotPaused nonReentrant {
		_claimUnlockedToken(token, user);
	}

	/// @notice Claims locked tokens for the caller.
	/// @param token Address of the token.
	/// @param amount Amount of locked tokens to claim.
	function claimLockedToken(address token, uint256 amount) external whenNotPaused nonReentrant {
		_claimLockedToken(token, msg.sender, amount);
	}

	/// @notice Claims locked tokens for the caller by percentage.
	/// @param token Address of the token.
	/// @param percentage Percentage of locked tokens to claim (between 0 and 1 -- 1 for 100%).
    // @
	function claimLockedTokenByPercentage(address token, uint256 percentage) external whenNotPaused nonReentrant {
		_claimLockedToken(token, msg.sender, (getLockedAmountsForToken(msg.sender, token) * percentage) / 1e18);
	}

	/// @notice Claims locked tokens for a specified user.
	/// @dev Only accounts with OPERATOR_ROLE can call this function.
	/// @param token Address of the token.
	/// @param user Address of the user.
	/// @param amount Amount of locked tokens to claim.
    // @audit-medium-ok OPERATOR_ROLE 可以恶意提前使用户 claim 未解锁 token，从而获取罚金
	function claimLockedTokenFor(address token, address user, uint256 amount) external onlyRole(OPERATOR_ROLE) whenNotPaused nonReentrant {
		_claimLockedToken(token, user, amount);
	}

	/// @notice Claims locked tokens for a specified user by percentage.
	/// @dev Only accounts with OPERATOR_ROLE can call this function.
	/// @param token Address of the token.
	/// @param user Address of the user.
	/// @param percentage Percentage of locked tokens to claim (between 0 and 1 -- 1 for 100%).
	function claimLockedTokenForByPercentage(
		address token,
		address user,
		uint256 percentage
	) external onlyRole(OPERATOR_ROLE) whenNotPaused nonReentrant {
        // @audit-medium-ok
		_claimLockedToken(token, user, (getLockedAmountsForToken(user, token) * percentage) / 1e18);
	}

	//--------------------------------------------------------------------------
	// Internal Functions
	//--------------------------------------------------------------------------

	/// @notice Internal function to set up vesting plans for multiple users.
	/// @dev Reverts if the users and amounts arrays have different lengths.
	/// @param token Address of the token.
	/// @param startTime Vesting start time.
	/// @param endTime Vesting end time.
	/// @param users Array of user addresses.
	/// @param amounts Array of token amounts.
	function _setupVestingPlans(address token, uint256 startTime, uint256 endTime, address[] memory users, uint256[] memory amounts) internal {
		if (users.length != amounts.length) revert MismatchArrays();
		uint256 len = users.length;
		for (uint256 i = 0; i < len; i++) {
            // @audit 对 user 和 amount 没有检查（可以设置很大）
			address user = users[i];
			uint256 amount = amounts[i];
			totalVested[token] += amount;
			VestingPlan storage vestingPlan = vestingPlans[token][user];
			vestingPlan.setup(amount, startTime, endTime);
			emit VestingPlanSetup(token, user, amount, startTime, endTime);
		}
	}

	/// @notice Internal function to reset vesting plans for multiple users.
	/// @dev Reverts if the users and amounts arrays have different lengths or if any user's claimed amount exceeds the new amount.
	/// @param token Address of the token.
	/// @param users Array of user addresses.
	/// @param amounts Array of new token amounts.
    // 为多个用户重置 vestingPlans, 每个用户每个token都有一个锁仓计划
    // @report-m5 双花攻击/抢先交易,用户可以拿两次, 未检查状态(未考虑用户是否已经提前强制领取了部分 locked token)
    // - 首先, 用户调用 claimLockedToken
    // - 然后, 管理员调用 resetVestingPlans
	function _resetVestingPlans(address token, address[] memory users, uint256[] memory amounts) internal {
		if (users.length != amounts.length) revert MismatchArrays();
		uint256 len = users.length;
		for (uint256 i = 0; i < len; i++) {
			address user = users[i];
			uint256 amount = amounts[i];
			// Claim any unlocked tokens before resetting.
            // 取出已解锁的
			_claimUnlockedToken(token, user);
			VestingPlan storage vestingPlan = vestingPlans[token][user];

            // 新设置的总金额不能比已经解锁的还小
            // @report-m3 ? 阻止用户添加额外流动性
            // - PoC使用了Foundry! (在hardhat项目中Integrating with Foundry)
			if (amount < vestingPlan.unlockedAmount()) revert AlreadyClaimedMoreThanThis();
            // 锁的
            // 如果是 unlocked，但是没有 claimed

            // Amount = 100
            // unlockedAmount  = 30 （claimableAmount = 30 - 20 = 10）
            // lockedAmount    = 70
            // 当前锁定的

			uint256 oldTotal = vestingPlan.lockedAmount();
            // @audit-m 逻辑错误，没有比较 oldTotal 和 amount大小？
            // @audit-h-ok 如果有一个revert，则 DOS
            // 这里将 claimedAmount 清零
			vestingPlan.resetAmount(amount); //重置为  amount
			totalVested[token] = totalVested[token] - oldTotal + amount;
			emit VestingPlanReset(token, user, amount);
		}
	}

	/// @notice Checks if the contract holds enough of the token, and if not, calls a minting hook.
	/// @param token The address of the token.
	/// @param amount The required amount.
	function _ensureSufficientBalance(address token, uint256 amount) internal virtual {
		uint256 currentBalance = IERC20(token).balanceOf(address(this));
		if (currentBalance < amount) {
            // @q-a 可以无限铸造 Symm？ - yes 取决于 plan
			uint256 deficit = amount - currentBalance;
			// This hook can be overridden to mint the token.
			_mintTokenIfPossible(token, deficit);
		}
	}

	/// @notice Virtual hook to mint tokens if the token supports minting. In the parent, this is a no-op.
	/// @param token The address of the token.
	/// @param amount The amount to mint.
    // 已被重写
	function _mintTokenIfPossible(address token, uint256 amount) internal virtual {
		// Default implementation does nothing.
	}

	/// @notice Internal function to claim unlocked tokens.
	/// @param token Address of the token.
	/// @param user Address of the user.
    // @audit-ok reentrancy?
	function _claimUnlockedToken(address token, address user) internal {
        // 每个人的 plan
		VestingPlan storage vestingPlan = vestingPlans[token][user];
        //
		uint256 claimableAmount = vestingPlan.claimable();

		// Adjust the vesting plan
        // totalVested 作用？
		totalVested[token] -= claimableAmount;
		vestingPlan.claimedAmount += claimableAmount;

		// Ensure sufficient balance (minting if necessary)
		_ensureSufficientBalance(token, claimableAmount);

        // 转给用户
        // @q-a 有没有转账失败的可能 - no
		IERC20(token).transfer(user, claimableAmount);

		emit UnlockedTokenClaimed(token, user, claimableAmount);
	}

	/// @notice Internal function to claim locked tokens.
	/// @param token Address of the token.
	/// @param user Address of the user.
	/// @param amount Amount of locked tokens to claim.
	function _claimLockedToken(address token, address user, uint256 amount) internal {
		// First, claim any unlocked tokens.
		_claimUnlockedToken(token, user);
        // token => user => Record
		VestingPlan storage vestingPlan = vestingPlans[token][user];
		if (vestingPlan.lockedAmount() < amount) revert InvalidAmount();

		// Adjust the vesting plan
		vestingPlan.resetAmount(vestingPlan.lockedAmount() - amount);
        // @q-a 溢出会 revert
		totalVested[token] -= amount;
        // 惩罚数额
		uint256 penalty = (amount * lockedClaimPenalty) / 1e18;

		// Ensure sufficient balance (minting if necessary)
        // @audit 可以无限铸造 token， 如果管理员加入一个 非常大的 amounwt ，则会铸造大量 symm
		_ensureSufficientBalance(token, amount);
        // @q-a 如果是其他代币地址？ - 各代币间不影响
		IERC20(token).transfer(user, amount - penalty);
		IERC20(token).transfer(lockedClaimPenaltyReceiver, penalty);

		emit LockedTokenClaimed(token, user, amount, penalty);
	}

	//--------------------------------------------------------------------------
	// Views
	//--------------------------------------------------------------------------

	/// @notice Returns the amount of tokens that are still locked for a user
	/// @param user Address of the user to check
	/// @param token Address of the token
	/// @return The amount of tokens still locked in the user's vesting schedule
	function getLockedAmountsForToken(address user, address token) public view returns (uint256) {
		return vestingPlans[token][user].lockedAmount();
	}

	/// @notice Returns the amount of tokens that are currently claimable by a user
	/// @param user Address of the user to check
	/// @param token Address of the token
	/// @return The amount of tokens that can be claimed right now
	function getClaimableAmountsForToken(address user, address token) public view returns (uint256) {
		return vestingPlans[token][user].claimable();
	}

	/// @notice Returns the amount of tokens that have been unlocked according to the vesting schedule
	/// @param user Address of the user to check
	/// @param token Address of the token
	/// @return The total amount of tokens that have been unlocked (claimed and unclaimed)
	function getUnlockedAmountForToken(address user, address token) public view returns (uint256) {
		return vestingPlans[token][user].unlockedAmount();
	}
}
