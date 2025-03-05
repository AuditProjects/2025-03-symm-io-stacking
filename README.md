# SYMM IO Stacking contest details

- Join [Sherlock Discord](https://discord.gg/MABEWyASkp)
- Submit findings using the **Issues** page in your private contest repo (label issues as **Medium** or **High**)
- [Read for more details](https://docs.sherlock.xyz/audits/watsons)

# Q&A

### Q: On what chains are the smart contracts going to be deployed?
All EVM compatible chains
___

### Q: If you are integrating tokens, are you allowing only whitelisted tokens to work with the codebase or any complying with the standard? Are they assumed to have certain properties, e.g. be non-reentrant? Are there any types of [weird tokens](https://github.com/d-xo/weird-erc20) you want to integrate?
Only whitelisted tokens can work with the codebase, and these include stablecoins such as USDC, USDT, and USDE and Tokens like SYMM.
___

### Q: Are there any limitations on values set by admins (or other roles) in the codebase, including restrictions on array lengths?
All restricted roles are trusted. For example, in the staking contract, the number of reward tokens will not exceed 10–20.
___

### Q: Are there any limitations on values set by admins (or other roles) in protocols you integrate with, including restrictions on array lengths?
No
___

### Q: Is the codebase expected to comply with any specific EIPs?
No
___

### Q: Are there any off-chain mechanisms involved in the protocol (e.g., keeper bots, arbitrage bots, etc.)? We assume these mechanisms will not misbehave, delay, or go offline unless otherwise specified.
No


# Audit scope

[token @ 1d014156b1d9f0ab3259026127b9220eb2da3292](https://github.com/SYMM-IO/token/tree/1d014156b1d9f0ab3259026127b9220eb2da3292)
- [token/contracts/staking/SymmStaking.sol](token/contracts/staking/SymmStaking.sol)
- [token/contracts/vesting/SymmVesting.sol](token/contracts/vesting/SymmVesting.sol)
- [token/contracts/vesting/Vesting.sol](token/contracts/vesting/Vesting.sol)
- [token/contracts/vesting/interfaces/IMintableERC20.sol](token/contracts/vesting/interfaces/IMintableERC20.sol)
- [token/contracts/vesting/interfaces/IPermit2.sol](token/contracts/vesting/interfaces/IPermit2.sol)
- [token/contracts/vesting/interfaces/IPool.sol](token/contracts/vesting/interfaces/IPool.sol)
- [token/contracts/vesting/interfaces/IRouter.sol](token/contracts/vesting/interfaces/IRouter.sol)
- [token/contracts/vesting/libraries/LibVestingPlan.sol](token/contracts/vesting/libraries/LibVestingPlan.sol)


