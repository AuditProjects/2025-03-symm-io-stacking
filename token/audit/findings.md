# Centralization Risk: admin can force users to claim locked tokens and incur penalties

## Summary
The excessive centralization of privileged roles in the Symmio protocol allows the admin to force users to claim their locked tokens prematurely by calling `claimLockedTokenFor` or `claimLockedTokenForByPercentage`. This results in penalties being applied to users, with the penalty fees being transferred to `lockedClaimPenaltyReceiver`.

## Root Cause

In `Vesting.sol`, all critical roles (`DEFAULT_ADMIN_ROLE`, `SETTER_ROLE`, `PAUSER_ROLE`, `UNPAUSER_ROLE`, and `OPERATOR_ROLE`) are assigned to a single user (the `admin`). This excessive centralization grants the admin the ability to execute privileged actions that should typically be under user control.

The functions `claimLockedTokenFor` and `claimLockedTokenForByPercentage` can be executed by any address with the `OPERATOR_ROLE`, specifying a user and an amount of tokens to be claimed. Due to the penalty mechanism, this results in financial losses for users.



## Internal Pre-conditions

1.	A user must have locked SYMM tokens in the vesting contract.
2.	The admin (holding the `OPERATOR_ROLE`) access to the `claimLockedTokenFor` and `claimLockedTokenForByPercentage` functions.

## External Pre-conditions



## Attack Path
1.	The admin, possessing the `OPERATOR_ROLE`, calls `claimLockedTokenFor`(user, amount) or `claimLockedTokenForByPercentage`(user, percentage).
2.	The vesting contract processes the forced claim, even if the user did not intend to claim the locked tokens.
3.	A 50% penalty is applied to the claimed amount, and the penalized tokens are sent to `lockedClaimPenaltyReceiver`.
4.	The `lockedClaimPenaltyReceiver` address may be controlled by the admin, allowing them to unjustly collect penalties from forced claims.

## Impact
- Users can be forced to claim their locked tokens prematurely, incurring significant penalties.
- The admin can collect these penalties into an address under their control, creating a conflict of interest and a loss of trust in the protocol.
- This centralized control introduces significant risks to token holders, reducing confidence in the fairness and security of the Symmio protocol.


## PoC


## Mitigation

- Remove the ability for `OPERATOR_ROLE` to execute `claimLockedTokenFor` and `claimLockedTokenForByPercentage` on behalf of users.
- Implement a decentralized governance mechanism to prevent admin power abuse.

---


# DoS risk in _resetVestingPlans function

## Summary
The `_resetVestingPlans` function in the protocol can be vulnerable to a Denial-of-Service (DoS) attack. Since it processes multiple users in a loop, if even one user triggers a revert, the entire transaction fails. This means that if any user has claimable tokens and hasn’t claimed them, `_resetVestingPlans` will always revert, making it impossible to execute.


## Root Cause

Within `_resetVestingPlans`, the function iterates over multiple users and calls `vestingPlan.resetAmount`. In `Vesting.sol:222`, the relevant logic is:

```solidity
	function _resetVestingPlans(address token, address[] memory users, uint256[] memory amounts) internal {
		if (users.length != amounts.length) revert MismatchArrays();
		uint256 len = users.length;
		for (uint256 i = 0; i < len; i++) {
			address user = users[i];
			uint256 amount = amounts[i];
			// Claim any unlocked tokens before resetting.
			_claimUnlockedToken(token, user);
			VestingPlan storage vestingPlan = vestingPlans[token][user];
			if (amount < vestingPlan.unlockedAmount()) revert AlreadyClaimedMoreThanThis();
			uint256 oldTotal = vestingPlan.lockedAmount();
@>			vestingPlan.resetAmount(amount);
			totalVested[token] = totalVested[token] - oldTotal + amount;
			emit VestingPlanReset(token, user, amount);
		}
	}

```
For each user and amount in the loop, `resetAmount` is called. Inside `resetAmount`, the following condition is checked in [LibVestingPlan.sol#L71-L82](https://github.com/sherlock-audit/2025-03-symm-io-stacking/blob/d7cf7fc96af1c25b53a7b500a98b411cd018c0d3/token/contracts/vesting/libraries/LibVestingPlan.sol#L71-L82):

```solidity
if (claimable(self) != 0) revert ShouldClaimFirst();
```

This means that if any user has unclaimed tokens, this check triggers a revert, causing the entire loop and transaction to fail. This design prevents the account with `SETTER_ROLE` (admin) from ever successfully calling `_resetVestingPlans` as long as at least one user hasn’t claimed their tokens.


## Internal Pre-conditions
1.	At least one user has unclaimed tokens.
2.	The admin (holder of `SETTER_ROLE`) attempts to reset vesting plans using `_resetVestingPlans`.


## External Pre-conditions

## Attack Path
1.	The admin calls `_resetVestingPlans` to reset all users’ vesting plans (this function can be triggered by either `resetVestingPlans` or `addLiquidity`).
2.	If any user in the loop has unclaimed tokens, the function encounters `ShouldClaimFirst` and reverts.
3.	As a result, the entire `_resetVestingPlans` transaction fails, preventing the admin from resetting any vesting plans and effectively causing a denial of service for this functionality.

## Impact
The `_resetVestingPlans` function becomes practically unusable.The admin cannot adjust or reset vesting schedules, which may lead to protocol malfunctions or the inability to update token release schedules.Vesting plans that require updates will remain locked and unchangeable indefinitely, potentially freezing essential governance or administrative actions. Functions like addLiquidity that rely on `_resetVestingPlans` may also fail to execute properly, disrupting normal protocol operations.


## PoC


## Mitigation
- Skip Instead of Revert: Modify `_resetVestingPlans` to skip over users who have unclaimed tokens, rather than reverting the entire operation.
- External Claim Check: Perform the claimable balance check outside of the loop and handle such cases separately.


---


# _ensureSufficientBalance allows unlimited token minting

## Summary


In `Vesting.sol:242`, the `_ensureSufficientBalance` function in the protocol allows unrestricted minting of SYMM tokens. If amount is set to an excessively large value, the function will trigger the minting of a massive number of tokens, potentially leading to severe inflation and destabilizing the SYMM token economy.



## Root Cause

In the `_ensureSufficientBalance` function, when the contract’s balance is lower than the requested amount, it calculates the deficit and calls `_mintTokenIfPossible(token, deficit)`. However, there is no cap or restriction on amount, meaning a large request can trigger excessive minting of SYMM tokens.

```solidity
	function _ensureSufficientBalance(address token, uint256 amount) internal virtual {
		uint256 currentBalance = IERC20(token).balanceOf(address(this));
		if (currentBalance < amount) {
@>			uint256 deficit = amount - currentBalance;
			// This hook can be overridden to mint the token.
			_mintTokenIfPossible(token, deficit);
		}
	}
```

## Internal Pre-conditions
1. A user or an internal function requests a very large amount of SYMM tokens.
2. The contract’s SYMM token balance is less than the requested amount.
3. `_mintTokenIfPossible` is implemented in a way that allows minting without a cap.


## External Pre-conditions

## Attack Path
1. A function that calls `_ensureSufficientBalance` requests a massive amount of SYMM tokens.
2. Since the contract’s balance is insufficient, `_ensureSufficientBalance` calculates a deficit and calls `_mintTokenIfPossible`.
3. `_mintTokenIfPossible` mints the deficit amount without limitation.
4. The attacker or function now has access to an arbitrarily large number of SYMM tokens, causing hyperinflation.

## Impact
- Any function relying on `_ensureSufficientBalance` can cause unintended minting, making the protocol unreliable.
- Uncontrolled Inflation: The SYMM token supply can be artificially increased without limit, leading to hyperinflation.
- Market Devaluation: An attacker or user could mint excessive tokens, flooding the market and drastically reducing SYMM’s value.

## PoC

## Mitigation
- Set a Hard Cap: Implement a maximum minting limit to prevent excessive token creation.
- Require Governance Approval: Restrict `_mintTokenIfPossible` to only be callable through governance decisions.
- Ensure `_ensureSufficientBalance` does not allow minting beyond a reasonable limit.
---


#  _setupVestingPlans can cause incorrect vesting records

## Summary
The `_setupVestingPlans` function does not validate the amounts parameter, which allows setting vesting amounts that do not match actual token balances. As a result, totalVested records incorrect values, which can break functions relying on this variable.


## Root Cause
In `Vesting.sol:204`, the function `_setupVestingPlans` directly adds `amounts[i]` to `totalVested[token]` without verifying if the contract actually holds the specified tokens. If an excessively large amount is set, totalVested will become inaccurate, potentially causing logical inconsistencies in functions that depend on it.

```javascript
	function _setupVestingPlans(address token, uint256 startTime, uint256 endTime, address[] memory users, uint256[] memory amounts) internal {
		if (users.length != amounts.length) revert MismatchArrays();
		uint256 len = users.length;
		for (uint256 i = 0; i < len; i++) {
			address user = users[i];
@>			uint256 amount = amounts[i];
@>			totalVested[token] += amount;
			VestingPlan storage vestingPlan = vestingPlans[token][user];
			vestingPlan.setup(amount, startTime, endTime);
			emit VestingPlanSetup(token, user, amount, startTime, endTime);
		}
	}

```


## Internal Pre-conditions
The `SETTER_ROLE` calls setupVestingPlans with an unreasonably high amount, `totalVested` is updated with this incorrect value.


## External Pre-conditions

## Attack Path
1.	An admin with `SETTER_ROLE` calls `setupVestingPlans`, assigning an excessively large amount to a user.
2.	The contract updates totalVested with this incorrect value, significantly inflating the recorded vesting amount.
3.	When a user tries to claim tokens (e.g., by calling `claimLockedToken`), the contract logic may revert due to the mismatch between totalVested and actual balances.
4.	The protocol’s vesting logic becomes unreliable, potentially blocking legitimate claims and causing disruptions.

## Impact
- The protocol’s `totalVested` value no longer reflects actual token balances.
- Functions that rely on `totalVested`, such as token claims, may fail, leading to a protocol malfunction.
- Users may be unable to retrieve their vested tokens due to incorrect calculations.

## PoC

## Mitigation
- Implement a validation check to ensure the provided `amounts[i]` values do not exceed the contract’s available token balance.
- Before updating `totalVested`, verify that the contract has enough tokens to support the assigned amounts.
- Require that `setupVestingPlans` only allows adding new vesting plans when the contract holds the corresponding tokens.

