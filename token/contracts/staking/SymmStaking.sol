// SPDX-License-Identifier: MIT

pragma solidity >=0.8.18;

import { AccessControlEnumerableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import { PausableUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title SymmStaking
 * @notice An upgradeable staking contract that supports multiple reward tokens.
 * @dev This contract is designed to be used with the Transparent Upgradeable Proxy pattern.
 */
contract SymmStaking is Initializable, AccessControlEnumerableUpgradeable, ReentrancyGuardUpgradeable, PausableUpgradeable {
	using SafeERC20 for IERC20;

	//--------------------------------------------------------------------------
	// Constants
	//--------------------------------------------------------------------------

    // 默认质押时间 一周
	uint256 public constant DEFAULT_REWARDS_DURATION = 1 weeks;

	bytes32 public constant REWARD_MANAGER_ROLE = keccak256("REWARD_MANAGER_ROLE");
	bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
	bytes32 public constant UNPAUSER_ROLE = keccak256("UNPAUSER_ROLE");

	//--------------------------------------------------------------------------
	// Errors
	//--------------------------------------------------------------------------

	/// @notice Thrown when the staked or withdrawn amount is zero.
	error ZeroAmount();

	/// @notice Thrown when the staked for zero address.
	error ZeroAddress();

	/// @notice Thrown when the user does not have enough staked balance.
	/// @param available The available staked balance.
	/// @param required The required amount.
	error InsufficientBalance(uint256 available, uint256 required);

	/// @notice Thrown when a token is not whitelisted for rewards.
	/// @param token The token address.
	error TokenNotWhitelisted(address token);

	/// @notice Thrown when the two arrays passed as parameters have different lengths.
	error ArraysMismatched();

	/// @notice Thrown when there is an already ongoing reward period for this token.
	//TODO: params
	error OngoingRewardPeriodForToken(address token, uint256 pendingRewards);

	/// @notice Thrown when the whitelist status is already set.
	/// @param token The token address.
	/// @param currentStatus The current whitelist status.
	error TokenWhitelistStatusUnchanged(address token, bool currentStatus);

	//--------------------------------------------------------------------------
	// Events
	//--------------------------------------------------------------------------

	/**
	 * @notice Emitted when rewards are added.
	 * @param rewardsTokens Array of reward token addresses.
	 * @param rewards Array of reward amounts.
	 */
	event RewardNotified(address[] rewardsTokens, uint256[] rewards);

	/**
	 * @notice Emitted when a deposit is made.
	 * @param sender The address initiating the deposit.
	 * @param amount The staked amount.
	 * @param receiver The address that receives the staking balance.
	 */
	event Deposit(address indexed sender, uint256 amount, address indexed receiver);

	/**
	 * @notice Emitted when a withdrawal is made.
	 * @param sender The address initiating the withdrawal.
	 * @param amount The withdrawn amount.
	 * @param to The address receiving the tokens.
	 */
	event Withdraw(address indexed sender, uint256 amount, address indexed to);

	/**
	 * @notice Emitted when a reward is paid.
	 * @param user The user receiving the reward.
	 * @param rewardsToken The token in which the reward is paid.
	 * @param reward The amount of reward paid.
	 */
	event RewardClaimed(address indexed user, address indexed rewardsToken, uint256 reward);

	/**
	 * @notice Emitted when a token's whitelist status is updated.
	 * @param token The token address.
	 * @param whitelist The new whitelist status.
	 */
	event UpdateWhitelist(address indexed token, bool whitelist);

	/**
	 * @notice Emitted when admin rescue tokens.
	 * @param token the token address.
	 * @param amount the amount to be rescued.
	 */
	event RescueToken(address token, uint256 amount, address receiver);

	//--------------------------------------------------------------------------
	// Structs
	//--------------------------------------------------------------------------

	struct TokenRewardState {
		uint256 duration;     // 
		uint256 periodFinish; // 结束时间
		uint256 rate;         // 每秒获得奖励Token数量
		uint256 lastUpdated;  // 
		uint256 perTokenStored; // 
	}

	//--------------------------------------------------------------------------
	// State Variables
	//--------------------------------------------------------------------------
    // 质押代币 SYMM token
	address public stakingToken;
    // 质押代币总余额
	uint256 public totalSupply; 
    // 质押代币余额
	mapping(address => uint256) public balanceOf;

	// Mapping from reward token to reward state.
	mapping(address => TokenRewardState) public rewardState;
	// Array of reward tokens.
    // 奖励代币列表
	address[] public rewardTokens;
	// Mapping to track if a token is whitelisted for rewards.
	mapping(address => bool) public isRewardToken;

	// Mapping from user => reward token => user paid reward per token.
	mapping(address => mapping(address => uint256)) public userRewardPerTokenPaid;
	// Mapping from user => reward token => reward amount.
	mapping(address => mapping(address => uint256)) public rewards;

	// Mapping from reward token to the total pending rewards (i.e. rewards that have been notified but not yet claimed).
	mapping(address => uint256) public pendingRewards;

	//--------------------------------------------------------------------------
	// Initialization
	//--------------------------------------------------------------------------

	/**
	 * @notice Initializes the staking contract.
	 * @param admin The admin of the contract.
	 */
	function initialize(address admin, address _stakingToken) external initializer {
		__AccessControlEnumerable_init();
		__ReentrancyGuard_init();
		__Pausable_init();

		if (admin == address(0) || _stakingToken == address(0)) revert ZeroAddress();

		stakingToken = _stakingToken;

		_grantRole(DEFAULT_ADMIN_ROLE, admin);
		_grantRole(REWARD_MANAGER_ROLE, admin);
		_grantRole(PAUSER_ROLE, admin);
		_grantRole(UNPAUSER_ROLE, admin);
	}

	//--------------------------------------------------------------------------
	// Views
	//--------------------------------------------------------------------------

	/**
	 * @notice Returns the number of reward tokens.
	 * @return The length of the rewardTokens array.
	 */
	function rewardTokensCount() external view returns (uint256) {
		return rewardTokens.length;
	}

	/**
	 * @notice Returns the last applicable time for rewards.
	 * @param _rewardsToken The reward token address.
	 * @return The last time at which rewards are applicable.
	 */
	function lastTimeRewardApplicable(address _rewardsToken) public view returns (uint256) {
        // if 未到结束时间  -> block.timestamp 当前时间
        // if 已到结束时间  -> periodFinish    结束时间
		return block.timestamp < rewardState[_rewardsToken].periodFinish ? block.timestamp : rewardState[_rewardsToken].periodFinish;
	}

	/**
	 * @notice Calculates the reward per token for a given reward token.
	 * @param _rewardsToken The reward token address.
	 * @return The reward per token.
	 */
     // 截止当前时间，该阶段内每个质押 token 应该获得的奖励
     // 这个阶段内总质押量是没有变的，所以可以计算出每个 质押Token应得的奖励
	function rewardPerToken(address _rewardsToken) public view returns (uint256) {
        // 如果质押量为 0, 该值保存不变（停止增加）
		if (totalSupply == 0) {
			return rewardState[_rewardsToken].perTokenStored;
		}

        // 只要有质押量
        // 累加用户每个质押 Token 这段时间理论可以获得的奖励 =  ... + 距本周期结束时间 * 每秒获得奖励数量 * 1 / totalSupply
        // 一直增加，池子里的 token 数量只会影响增加的幅度
		return
			rewardState[_rewardsToken].perTokenStored +
			(((lastTimeRewardApplicable(_rewardsToken) - rewardState[_rewardsToken].lastUpdated) * rewardState[_rewardsToken].rate * 1e18) /
				totalSupply);
	}

	/**
	 * @notice Calculates the earned rewards for an account and a specific reward token.
	 * @param account The user address.
	 * @param _rewardsToken The reward token address.
	 * @return The amount of earned rewards.
	 */
	function earned(address account, address _rewardsToken) public view returns (uint256) {
        // (质押数量 * (当前每 token价格 - 每 token 已支付的)) + rewads
		return
			((balanceOf[account] * (rewardPerToken(_rewardsToken) - userRewardPerTokenPaid[account][_rewardsToken])) / 1e18) +
			rewards[account][_rewardsToken];
	}

	/**
	 * @notice Returns the reward amount for the entire reward duration.
	 * @param _rewardsToken The reward token address.
	 * @return The reward amount for the reward duration.
	 */
	function getFullPeriodReward(address _rewardsToken) external view returns (uint256) {
		return rewardState[_rewardsToken].rate * rewardState[_rewardsToken].duration;
	}

	//--------------------------------------------------------------------------
	// Mutative Functions
	//--------------------------------------------------------------------------

	/**
	 * @notice Deposits SYMM tokens for staking on behalf of a receiver.
	 * @param amount The amount of SYMM tokens to deposit.
	 * @param receiver The address receiving the staking balance.
	 */
    // !entry
    // 投入 SYMM tokens
	function deposit(uint256 amount, address receiver) external nonReentrant whenNotPaused {
		_updateRewardsStates(receiver);

		if (amount == 0) revert ZeroAmount();
		if (receiver == address(0)) revert ZeroAddress();
		IERC20(stakingToken).safeTransferFrom(msg.sender, address(this), amount);
		totalSupply += amount;
		balanceOf[receiver] += amount;
		emit Deposit(msg.sender, amount, receiver);
	}

	/**
	 * @notice Withdraws staked SYMM tokens.
	 * @param amount The amount of tokens to withdraw.
	 * @param to The address receiving the tokens.
	 */
	function withdraw(uint256 amount, address to) external nonReentrant whenNotPaused {
		_updateRewardsStates(msg.sender);

		if (amount == 0) revert ZeroAmount();
		if (to == address(0)) revert ZeroAddress();
		if (amount > balanceOf[msg.sender]) revert InsufficientBalance(balanceOf[msg.sender], amount);
        // 质押代币还回
		IERC20(stakingToken).safeTransfer(to, amount);
		totalSupply -= amount;
		balanceOf[msg.sender] -= amount;
		emit Withdraw(msg.sender, amount, to);
	}

	/**
	 * @notice Claims all earned rewards for the caller.
	 */
	function claimRewards() external nonReentrant whenNotPaused {
		_updateRewardsStates(msg.sender);
		_claimRewardsFor(msg.sender);
	}

	/**
	 * @notice Notifies the contract about new reward amounts.
	 * @param tokens Array of reward token addresses.
	 * @param amounts Array of reward amounts corresponding to each token.
	 */
    // @q 任何人都能调用?
    // @audit-ok  DoS,添加很多 tokens? - check Whitelist
    // 通知新的奖励和数量
	function notifyRewardAmount(address[] calldata tokens, uint256[] calldata amounts) external nonReentrant whenNotPaused {
		// 更新零地址?
        _updateRewardsStates(address(0));
		if (tokens.length != amounts.length) revert ArraysMismatched();

		uint256 len = tokens.length;
		for (uint256 i = 0; i < len; i++) {
			address token = tokens[i];
			uint256 amount = amounts[i];

			if (amount == 0) continue;
            // 只要有一个不在白名单中，会 revert
			if (!isRewardToken[token]) revert TokenNotWhitelisted(token);
            // 注入合约
			IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
			pendingRewards[token] += amount;
			_addRewardsForToken(token, amount);
		}
		emit RewardNotified(tokens, amounts);
	}

	//--------------------------------------------------------------------------
	// Restricted Functions
	//--------------------------------------------------------------------------

	/**
	 * @notice Allows admin to claim rewards on behalf of a user.
	 * @param user The user address for which to claim rewards.
	 */
    // admin call
	function claimFor(address user) external nonReentrant onlyRole(REWARD_MANAGER_ROLE) whenNotPaused {
		_updateRewardsStates(user);
		_claimRewardsFor(user);
	}

	/**
	 * @notice Updates the whitelist status of a reward token.
	 * @param token The token address.
	 * @param status The new whitelist status.
	 */
	function configureRewardToken(address token, bool status) external onlyRole(REWARD_MANAGER_ROLE) {
		_updateRewardsStates(address(0));

		if (token == address(0)) revert ZeroAddress();
		if (isRewardToken[token] == status) revert TokenWhitelistStatusUnchanged(token, status);

		isRewardToken[token] = status;
		if (!status) {
			if (pendingRewards[token] > 10) revert OngoingRewardPeriodForToken(token, pendingRewards[token]);
			uint256 len = rewardTokens.length;
			for (uint256 i = 0; i < len; i++) {
				if (rewardTokens[i] == token) {
					rewardTokens[i] = rewardTokens[rewardTokens.length - 1];
					rewardTokens.pop();
					break;
				}
			}
		} else {
			rewardTokens.push(token);
			rewardState[token].duration = DEFAULT_REWARDS_DURATION;
		}

		emit UpdateWhitelist(token, status);
	}

	/**
	 * @notice Withdraw specific amount of token.
	 * @param token The token address.
	 * @param amount The amount.
	 * @param receiver The address of receiver
	 */
     
    // @q 任意地址?
	function rescueTokens(address token, uint256 amount, address receiver) external nonReentrant onlyRole(DEFAULT_ADMIN_ROLE) {
		IERC20(token).safeTransfer(receiver, amount);
		emit RescueToken(token, amount, receiver);
	}

	/**
	 * @notice Pauses contract operations.
	 */
	function pause() external onlyRole(PAUSER_ROLE) {
		_pause();
	}

	/**
	 * @notice Unpauses contract operations.
	 */
	function unpause() external onlyRole(UNPAUSER_ROLE) {
		_unpause();
	}

	//--------------------------------------------------------------------------
	// Internal Functions
	//--------------------------------------------------------------------------
    
	function _addRewardsForToken(address token, uint256 amount) internal {
        // 指定 奖励 Token 对应的状态
		TokenRewardState storage state = rewardState[token];
        // 已结束
		if (block.timestamp >= state.periodFinish) {
            // 新一轮: 随时间奖励的比率
			state.rate = amount / state.duration;
		} else {
        // 未结束
			uint256 remaining = state.periodFinish - block.timestamp;
			uint256 leftover = remaining * state.rate; 
            // 将剩余的放入下一轮
			state.rate = (amount + leftover) / state.duration;
		}

		state.lastUpdated = block.timestamp;
        // 唯一更新：添加新奖励后
		state.periodFinish = block.timestamp + state.duration;
	}

	/**
	 * @notice Internal function to claim rewards for a given user.
	 * Assumes updateRewards(user) has already been called.
	 */
	function _claimRewardsFor(address user) internal {
		uint256 length = rewardTokens.length;
		for (uint256 i = 0; i < length; ) {
			address token = rewardTokens[i];
            // 
			uint256 reward = rewards[user][token];
			if (reward > 0) {
				rewards[user][token] = 0;
				pendingRewards[token] -= reward;
                // 奖励token列表中的
				IERC20(token).safeTransfer(user, reward);
				emit RewardClaimed(user, token, reward);
			}
			unchecked {
				++i;
			}
		}
	}

	/**
	 * @dev Updates the rewards for an account for all reward tokens.
	 * @param account The account to update.
	 */
	function _updateRewardsStates(address account) internal {
		uint256 length = rewardTokens.length;
		for (uint256 i = 0; i < length; ) {

			address token = rewardTokens[i];
			TokenRewardState storage state = rewardState[token];
            // 更新全局 当前 token 单位质押代币应得奖励
			state.perTokenStored = rewardPerToken(token);
            // 更新全局 上次更新时间
			state.lastUpdated = lastTimeRewardApplicable(token);

			if (account != address(0)) {
                // 计算实际获得奖励,存入rewards
                // 该用户 account 赚的
				rewards[account][token] = earned(account, token);
                // userRewardPerTokenPaid只在earned计算使用，完后立即更新为最新 perTokenStored值
				userRewardPerTokenPaid[account][token] = state.perTokenStored;
			}
			unchecked {
				++i;
			}
		}
	}
}
