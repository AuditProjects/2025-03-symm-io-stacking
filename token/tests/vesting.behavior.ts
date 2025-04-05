import { loadFixture } from "@nomicfoundation/hardhat-network-helpers"
import { expect } from "chai"
import { ethers, network, upgrades } from "hardhat";
import { Symmio, SymmVesting, VestingPlanOps__factory } from "../typechain-types";
import { initializeFixture, RunContext } from "./Initialize.fixture"
import { Signer } from "ethers";
import {e} from "../utils"

export function ShouldBehaveLikeVesting() {
	let context: RunContext
	let symmVesting: SymmVesting
	let vestingPlanOps: VestingPlanOps__factory
	let admin: Signer, user1: Signer
	let symmToken: Symmio

	beforeEach(async () => {
		context = await loadFixture(initializeFixture)
		symmVesting = await context.vesting
		vestingPlanOps = await ethers.getContractFactory("VestingPlanOps")
		symmToken = context.symmioToken
		admin = context.signers.admin
		user1 = context.signers.user1
	})

	describe("__vesting_init", () => {
		it("Should grant the admin role to the deployer", async () => {
			for (const role of [
				await symmVesting.DEFAULT_ADMIN_ROLE(),
				await symmVesting.SETTER_ROLE(),
				await symmVesting.PAUSER_ROLE(),
				await symmVesting.UNPAUSER_ROLE(),
				await symmVesting.OPERATOR_ROLE(),
			]) {
				const hasRole = await symmVesting.hasRole(role, context.signers.admin.address)
				await expect (hasRole).to.be.true
			}
		})
	})

	describe("setupVestingPlans", () => {
		it("Should fail if users and amount arrays mismatch", async () => {
			const users = [await context.signers.user1.getAddress(), await context.signers.user2.getAddress()]
			const amounts = ["1000"]

			await expect(symmVesting.setupVestingPlans(await context.symmioToken.getAddress(), "0", "0", users, amounts)).to.be.revertedWithCustomError(
				symmVesting,
				"MismatchArrays",
			)
		})

		it("Should fail if vestingPlan setup before", async () => {
			const users = [await context.signers.user1.getAddress()]
			const amounts = ["1000"]

			await symmVesting.setupVestingPlans(await context.symmioToken.getAddress(), "0", "0", users, amounts)
			await expect(symmVesting.setupVestingPlans(await context.symmioToken.getAddress(), "0", "0", users, amounts)).to.be.revertedWithCustomError(
				vestingPlanOps,
				"AlreadySetup",
			)
		})

		it("Should setup vestingPlan successfully", async () => {
			const users = [await context.signers.user1.getAddress()]
			const amounts = ["1000"]
			const oldTotalVesting = await symmVesting.totalVested(await context.symmioToken.getAddress())

			await expect (await symmVesting.setupVestingPlans(await context.symmioToken.getAddress(), "0", "0", users, amounts)).to.be.not.reverted

			const plan = await symmVesting.vestingPlans(context.symmioToken, await context.signers.user1.getAddress())
			const newTotalVesting = await symmVesting.totalVested(await context.symmioToken.getAddress())

			await expect (newTotalVesting).to.be.equal(oldTotalVesting + "1000")

			await expect (plan.startTime).to.be.equal("0")
			await expect (plan.endTime).to.be.equal("0")
			await expect (plan.amount).to.be.equal(amounts[0])
			await expect (plan.claimedAmount).to.be.equal(0)
		})
	})

	describe("claimUnlockedToken", () => {
		beforeEach(async () => {
			await context.symmioToken.connect(context.signers.admin).mint(await symmVesting.getAddress(), 5000)
			const users = [await context.signers.user1.getAddress()]
			const amounts = ["1000"]
			const now = new Date()
			const startTime = Math.floor(now.getTime() / 1000)

			now.setMonth(now.getMonth() + 9)
			const endTime = Math.floor(now.getTime() / 1000)

			await symmVesting.setupVestingPlans(await context.symmioToken.getAddress(), startTime, endTime, users, amounts)
		})

		it("Should unlockedAmount be zero before vesting starts", async () => {
			const plan = await symmVesting.vestingPlans(context.symmioToken, await context.signers.user1.getAddress())
			const latestBlock = await ethers.provider.getBlock("latest")
			const safeTimestamp = Number(plan.startTime) - 100

			if (safeTimestamp <= (latestBlock?.timestamp ?? 0)) {
				await network.provider.send("evm_setNextBlockTimestamp", [(latestBlock?.timestamp ?? 0) + 1])
			} else {
				await network.provider.send("evm_setNextBlockTimestamp", [safeTimestamp])
			}

			await network.provider.send("evm_mine")

			await expect (await symmVesting.getUnlockedAmountForToken(await context.signers.user1.getAddress(), context.symmioToken)).to.be.equal(0)
		})

		it("Should unlockedAmount be zero at the exact start time", async () => {
			const plan = await symmVesting.vestingPlans(context.symmioToken, await context.signers.user1.getAddress())
			const latestBlock = await ethers.provider.getBlock("latest")
			const safeTimestamp = Number(plan.startTime)

			if (safeTimestamp <= (latestBlock?.timestamp ?? 0)) {
				await network.provider.send("evm_setNextBlockTimestamp", [(latestBlock?.timestamp ?? 0) + 1])
			} else {
				await network.provider.send("evm_setNextBlockTimestamp", [safeTimestamp])
			}

			await network.provider.send("evm_mine")

			await expect (await symmVesting.getUnlockedAmountForToken(await context.signers.user1.getAddress(), context.symmioToken)).to.be.equal(0)
		})

		it("Should unlockedAmount be partial during the vesting period", async () => {
			const plan = await symmVesting.vestingPlans(context.symmioToken, await context.signers.user1.getAddress())
			const midTime = Math.floor(Number((plan.startTime + plan.endTime) / BigInt(2)))

			await network.provider.send("evm_setNextBlockTimestamp", [midTime]) // half of vesting lock
			await network.provider.send("evm_mine")

			const expectedUnlocked = Math.floor(Number((BigInt(1000) * (BigInt(midTime) - plan.startTime)) / (plan.endTime - plan.startTime)))

			await expect (await symmVesting.getUnlockedAmountForToken(await context.signers.user1.getAddress(), context.symmioToken)).to.be.equal(expectedUnlocked)
		})

		it("Should unlockedAmount be the full amount at the exact end time", async () => {
			const plan = await symmVesting.vestingPlans(context.symmioToken, await context.signers.user1.getAddress())
			await network.provider.send("evm_setNextBlockTimestamp", [Number(plan.endTime)])
			await network.provider.send("evm_mine")

			await expect (await symmVesting.getUnlockedAmountForToken(await context.signers.user1.getAddress(), context.symmioToken)).to.be.equal(1000)
		})

		it("Should claimUnlockedToken successfully", async () => {
			let plan = await symmVesting.vestingPlans(context.symmioToken, await context.signers.user1.getAddress())
			await network.provider.send("evm_setNextBlockTimestamp", [Number(plan.endTime)])
			await network.provider.send("evm_mine")

			const oldTotalVested = await symmVesting.totalVested(context.symmioToken)
			const oldClaimedAmount = plan.claimedAmount
			const oldContractBalance = await context.symmioToken.balanceOf(symmVesting)
			const oldUserBalance = await context.symmioToken.balanceOf(context.signers.user1)

			await expect (await symmVesting.connect(context.signers.user1).claimUnlockedToken(await context.symmioToken.getAddress())).to.be.not.reverted
			plan = await symmVesting.vestingPlans(context.symmioToken, await context.signers.user1.getAddress())

			const newTotalVested = await symmVesting.totalVested(context.symmioToken)
			const newClaimedAmount = plan.claimedAmount
			const newContractBalance = await context.symmioToken.balanceOf(symmVesting)
			const newUserBalance = await context.symmioToken.balanceOf(context.signers.user1)

			await expect (newTotalVested).to.be.equal(oldTotalVested - BigInt(1000))
			await expect (newClaimedAmount).to.be.equal(oldClaimedAmount + BigInt(1000))
			await expect (newContractBalance).to.be.equal(oldContractBalance - BigInt(1000))
			await expect (newUserBalance).to.be.equal(oldUserBalance + BigInt(1000))
		})
	})

	describe("claimLockedToken", () => {
		beforeEach(async () => {
			await context.symmioToken.connect(context.signers.admin).mint(await symmVesting.getAddress(), 5000)
			const users = [await context.signers.user1.getAddress()]
			const amounts = ["1000"]
			const now = new Date()
			const startTime = Math.floor(now.getTime() / 1000)

			now.setMonth(now.getMonth() + 9)
			const endTime = Math.floor(now.getTime() / 1000)

			await symmVesting.setupVestingPlans(await context.symmioToken.getAddress(), startTime, endTime, users, amounts)
		})

		it("Should fail if amount be greater than lockedAmount", async () => {
			await expect(symmVesting.claimLockedToken(context.symmioToken, 1001)).to.be.revertedWithCustomError(symmVesting, "InvalidAmount")
		})

		it("Should not revert when claiming locked tokens within allowed amount", async () => {
			await expect(symmVesting.connect(context.signers.user1).claimLockedToken(context.symmioToken, 1000)).to.be.not.reverted
		})

		it("Should decrease total vested amount after claiming", async () => {
			const oldTotalVested = await symmVesting.totalVested(context.symmioToken)

			await symmVesting.connect(context.signers.user1).claimLockedToken(context.symmioToken, 1000)

			const newTotalVested = await symmVesting.totalVested(context.symmioToken)
			await expect (newTotalVested).to.be.equal(oldTotalVested - BigInt(1000))
		})

		it("Should distribute claimed amount correctly", async () => {
			const oldPenaltyContractBalance = await context.symmioToken.balanceOf(await symmVesting.lockedClaimPenaltyReceiver())
			const oldUserBalance = await context.symmioToken.balanceOf(context.signers.user1)

			await symmVesting.connect(context.signers.user1).claimLockedToken(context.symmioToken, 1000)

			const newPenaltyContractBalance = await context.symmioToken.balanceOf(await symmVesting.lockedClaimPenaltyReceiver())
			const newUserBalance = await context.symmioToken.balanceOf(context.signers.user1)

			await expect (newPenaltyContractBalance).to.be.equal(oldPenaltyContractBalance + BigInt(500))
			await expect (newUserBalance).to.be.equal(oldUserBalance + BigInt(500))
		})

		it("Should allow user to claim locked token by percentage", async () => {
			const oldPenaltyContractBalance = await context.symmioToken.balanceOf(await symmVesting.lockedClaimPenaltyReceiver())
			const oldUserBalance = await context.symmioToken.balanceOf(context.signers.user1)

			await symmVesting.connect(context.signers.user1).claimLockedTokenByPercentage(context.symmioToken, e(0.5))

			const newPenaltyContractBalance = await context.symmioToken.balanceOf(await symmVesting.lockedClaimPenaltyReceiver())
			const newUserBalance = await context.symmioToken.balanceOf(context.signers.user1)

			await expect (newPenaltyContractBalance).to.be.equal(oldPenaltyContractBalance + BigInt(250))
			await expect (newUserBalance).to.be.equal(oldUserBalance + BigInt(250))
		})

		it("Should allow admin to claim locked token for user", async()=>{
			const oldPenaltyContractBalance = await context.symmioToken.balanceOf(await symmVesting.lockedClaimPenaltyReceiver())
			const oldUserBalance = await context.symmioToken.balanceOf(context.signers.user1)

			await symmVesting.connect(admin).claimLockedTokenFor(symmToken, user1, 1000)

			const newPenaltyContractBalance = await context.symmioToken.balanceOf(await symmVesting.lockedClaimPenaltyReceiver())
			const newUserBalance = await context.symmioToken.balanceOf(context.signers.user1)

			await expect (newPenaltyContractBalance).to.be.equal(oldPenaltyContractBalance + BigInt(500))
			await expect (newUserBalance).to.be.equal(oldUserBalance + BigInt(500))
		})

		it("Should allow admin to claim locked token for user by percentage", async () => {
			const oldPenaltyContractBalance = await context.symmioToken.balanceOf(await symmVesting.lockedClaimPenaltyReceiver())
			const oldUserBalance = await context.symmioToken.balanceOf(context.signers.user1)

			await symmVesting.connect(context.signers.admin).claimLockedTokenForByPercentage(context.symmioToken, user1, e(0.5))

			const newPenaltyContractBalance = await context.symmioToken.balanceOf(await symmVesting.lockedClaimPenaltyReceiver())
			const newUserBalance = await context.symmioToken.balanceOf(context.signers.user1)

			await expect (newPenaltyContractBalance).to.be.equal(oldPenaltyContractBalance + BigInt(250))
			await expect (newUserBalance).to.be.equal(oldUserBalance + BigInt(250))
		})

		it("Should reset claimed amount to zero after claiming", async () => {
			await symmVesting.connect(context.signers.user1).claimLockedToken(context.symmioToken, 1000)

			const plan = await symmVesting.vestingPlans(context.symmioToken, await context.signers.user1.getAddress())
			await expect (plan.claimedAmount).to.be.equal(0)
		})

		it("Should update vesting startTime and endTime after claiming", async () => {
			const oldPlan = await symmVesting.vestingPlans(context.symmioToken, await context.signers.user1.getAddress())

			const tx = await symmVesting.connect(context.signers.user1).claimLockedToken(context.symmioToken, 1000)

			const receipt = await tx.wait()
			const blockAfter = await ethers.provider.getBlock(receipt?.blockNumber ?? 0)
			const actualNewStartTime = blockAfter?.timestamp ?? 0
			const remainingDuration = Number(oldPlan.endTime) - Number(actualNewStartTime)

			const planAfter = await symmVesting.vestingPlans(context.symmioToken, await context.signers.user1.getAddress())

			const expectedNewEndTime = actualNewStartTime + remainingDuration

			await expect (planAfter.startTime).to.equal(actualNewStartTime)
			await expect (planAfter.endTime).to.equal(expectedNewEndTime)
		})
	})

	describe("resetVestingPlans", () => {
		beforeEach(async () => {
			await context.symmioToken.connect(context.signers.admin).mint(await symmVesting, 5000)

			const users = [await context.signers.user1.getAddress()]
			const amounts = ["1000"]
			const now = new Date()
			const startTime = Math.floor(now.getTime() / 1000)

			now.setMonth(now.getMonth() + 9)
			const endTime = Math.floor(now.getTime() / 1000)

			await symmVesting.setupVestingPlans(await context.symmioToken.getAddress(), startTime, endTime, users, amounts)
		})

		it("Should reset vesting plan successfully", async () => {
			const user = await context.signers.user1.getAddress()
			const newAmount = BigInt(1500)
			const token = await context.symmioToken.getAddress()

			const planBefore = await symmVesting.vestingPlans(token, user)
			const totalVestedBefore = await symmVesting.totalVested(token)

			await expect(symmVesting.connect(context.signers.admin).resetVestingPlans(token, [user], [newAmount]))
				.to.emit(symmVesting, "VestingPlanReset")
				.withArgs(token, user, newAmount)

			const planAfter = await symmVesting.vestingPlans(token, user)
			const totalVestedAfter = await symmVesting.totalVested(token)

			await expect (planAfter.amount).to.equal(newAmount)
			await expect (planAfter.claimedAmount).to.equal(0)
			await expect (totalVestedAfter).to.equal(totalVestedBefore - planBefore.amount + newAmount)
		})

		it("Should fail if users and amounts arrays have different lengths", async () => {
			const user = await context.signers.user1.getAddress()
			const token = await context.symmioToken.getAddress()

			await expect(symmVesting.connect(context.signers.admin).resetVestingPlans(token, [user], [])).to.be.revertedWithCustomError(
				symmVesting,
				"MismatchArrays",
			)
		})

		it("Should fail if new amount is less than already claimed amount", async () => {
			const user = await context.signers.user1.getAddress()
			const token = await context.symmioToken.getAddress()

			const plan = await symmVesting.vestingPlans(token, user)

			const midTime = Math.floor(Number((plan.startTime + plan.endTime) / BigInt(2)))

			await network.provider.send("evm_setNextBlockTimestamp", [midTime]) // half of vesting lock
			await network.provider.send("evm_mine")

			await expect(symmVesting.connect(context.signers.admin).resetVestingPlans(token, [user], [400])).to.be.revertedWithCustomError(
				symmVesting,
				"AlreadyClaimedMoreThanThis",
			)
		})

		it("Should claim unlocked tokens before resetting", async () => {
			const user = await context.signers.user1.getAddress()
			const token = await context.symmioToken.getAddress()
			const newAmount = 1200

			await expect(symmVesting.connect(context.signers.admin).resetVestingPlans(token, [user], [newAmount])).to.not.be.reverted

			const planAfter = await symmVesting.vestingPlans(token, user)
			await expect (planAfter.claimedAmount).to.equal(0)
		})

	})

    //// added 
    describe("SymmVesting – DoS in _resetVestingPlans", function () {
        let owner, user1, user2;
        let symmToken, usdcToken, symmLPToken;
        let dummyPool, dummyRouter;
        let symmVesting;
      
        beforeEach(async () => {
          [owner, user1, user2, ...addrs] = await ethers.getSigners();
      
          // Deploy a mintable SYMM token and a dummy USDC token for testing
          const TestToken = await ethers.getContractFactory("ERC20Mock");  // assume ERC20Mock has mint function
          symmToken = await TestToken.deploy("Symm Token", "SYMM");
          usdcToken = await TestToken.deploy("USD Coin", "USDC");
          symmLPToken = await TestToken.deploy("Symm LP Token", "SYMM-LP");
      
          // Mint initial tokens to SymmVesting contract if needed (SYMM can be minted via contract, LP we'll mint manually)
          // Deploy dummy pool contract with required interface (getTokens, getCurrentLiveBalances, totalSupply)
          const DummyPool = await ethers.getContractFactory("DummyPool");
          // Initialize dummy pool with SYMM and USDC token addresses and some dummy balances
          dummyPool = await DummyPool.deploy(symmToken.address, usdcToken.address, ethers.utils.parseEther("1000000"), ethers.utils.parseEther("1000000"));
          // totalSupply for LP (just use an arbitrary number)
          await dummyPool.setTotalSupply(ethers.utils.parseEther("1000000"));
      
          // Deploy dummy router contract with required interface (addLiquidityProportional)
          const DummyRouter = await ethers.getContractFactory("DummyRouter");
          dummyRouter = await DummyRouter.deploy(symmLPToken.address);
      
          // Deploy SymmVesting contract and initialize it
          const SymmVesting = await ethers.getContractFactory("SymmVesting");
          symmVesting = await SymmVesting.deploy();
          await symmVesting.initialize(
            owner.address,                // admin (gets SETTER_ROLE, etc.)
            owner.address,                // lockedClaimPenaltyReceiver (just reuse owner for test)
            dummyPool.address,
            dummyRouter.address,
            owner.address,                // permit2 (not used in dummy, just non-zero)
            owner.address,                // vault (not used in dummy, just non-zero)
            symmToken.address,
            usdcToken.address,
            symmLPToken.address
          );
      
          // Grant SymmVesting contract permission to mint SYMM (if required by our token mock)
          // Assuming ERC20Mock mint is public, no need to grant roles.
        });
      
        it("1. Multiple users with vesting plans – one user's unclaimed tokens cause reset to revert", async function () {
          // Setup vesting plans for user1 and user2
          const startTime = (await ethers.provider.getBlock()).timestamp;
          const vestDuration = 1000;  // e.g. 1000 seconds duration
          const endTime = startTime + vestDuration;
          const amountUser1 = ethers.utils.parseEther("1000");  // 1000 SYMM for user1
          const amountUser2 = ethers.utils.parseEther("1000");  // 1000 SYMM for user2
      
          // Call setupVestingPlans as admin (owner has SETTER_ROLE)
          await symmVesting.setupVestingPlans(
            symmToken.address,
            startTime,
            endTime,
            [user1.address, user2.address],
            [amountUser1, amountUser2]
          );
      
          // Fast-forward time so that some tokens are unlocked for user2
          const halfway = Math.floor(vestDuration / 2);
          await ethers.provider.send("evm_increaseTime", [halfway]);  // advance half the vesting duration
          await ethers.provider.send("evm_mine", []);  // mine a block to update block.timestamp
      
          // Verify that user2 now has some claimable (unlocked) tokens, and user1 does too (assuming linear vesting)
          const user2Claimable = await symmVesting.getClaimableAmountsForToken(user2.address, symmToken.address);
          expect(user2Claimable).to.be.gt(0, "User2 should have some unlocked (unclaimed) tokens");
      
          // Attempt to reset vesting plans for both users:
          // - user1: try to keep their amount the same
          // - user2: set a new amount lower than their already unlocked amount to trigger revert
          const newAmountUser1 = amountUser1;  // unchanged for user1
          const newAmountUser2 = ethers.utils.parseEther("100");  // intentionally less than user2's unlocked amount
      
          await expect(
            symmVesting.resetVestingPlans(
              symmToken.address,
              [user1.address, user2.address],
              [newAmountUser1, newAmountUser2]
            )
          ).to.be.revertedWith("AlreadyClaimedMoreThanThis");  // function should revert due to user2’s unclaimed tokens [oai_citation_attribution:2‡github.com](https://github.com/sherlock-audit/2025-03-symm-io-stacking/blob/main/token/contracts/vesting/Vesting.sol#:~:text=VestingPlan%20storage%20vestingPlan%20%3D%20vestingPlans)
      
          // Verify that vesting plans remain unchanged for both users (state is reverted)
          const lockedAfter1 = await symmVesting.getLockedAmountsForToken(user1.address, symmToken.address);
          const lockedAfter2 = await symmVesting.getLockedAmountsForToken(user2.address, symmToken.address);
          expect(lockedAfter1).to.equal(amountUser1, "User1's vesting plan should remain unchanged after failed reset");
          expect(lockedAfter2).to.equal(amountUser2, "User2's vesting plan should remain unchanged after failed reset");
        });
      
        it("2. Existing unclaimed tokens in vesting plan affect addLiquidity (single-user flow)", async function () {
          // First, set up a vesting plan for user2 by simulating an initial liquidity addition.
          // For simplicity, directly call setupVestingPlans for an LP vesting (could also simulate via addLiquidity).
          const startTime = (await ethers.provider.getBlock()).timestamp;
          const endTime = startTime + 1000;
          const initialLPAmount = ethers.utils.parseEther("500");  // lock 500 LP tokens for user2
          await symmVesting.setupVestingPlans(
            symmLPToken.address,
            startTime,
            endTime,
            [user2.address],
            [initialLPAmount]
          );
          // Mint and transfer those LP tokens to the vesting contract to simulate that they are held for vesting
          await symmLPToken.mint(symmVesting.address, initialLPAmount);
      
          // Fast-forward time so that some LP tokens are unlocked for user2
          await ethers.provider.send("evm_increaseTime", [500]);  // half the duration
          await ethers.provider.send("evm_mine", []);
      
          // Check that user2 has some claimable LP tokens
          const lpClaimable = await symmVesting.getClaimableAmountsForToken(user2.address, symmLPToken.address);
          expect(lpClaimable).to.be.gt(0, "User2 should have some unlocked LP tokens before adding more liquidity");
      
          // Now simulate user2 adding liquidity again (which will trigger _resetVestingPlans on their LP vesting plan).
          // Provide user2 with some SYMM and USDC to add liquidity.
          await symmToken.mint(user2.address, ethers.utils.parseEther("100"));  // 100 SYMM to add
          await usdcToken.mint(user2.address, ethers.utils.parseEther("1000")); // some USDC
          // User2 approves SymmVesting to pull USDC (since addLiquidity will transfer USDC from user)
          await usdcToken.connect(user2).approve(symmVesting.address, ethers.utils.parseEther("1000"));
          // User2 calls addLiquidity (this will internally claim unlocked tokens and attempt to reset vesting plan)
          const addAmountSymm = ethers.utils.parseEther("50");  // use 50 SYMM for adding liquidity
          await expect(
            symmVesting.connect(user2).addLiquidity(addAmountSymm, 0, 0)
          ).to.not.be.reverted;  // ensure addLiquidity succeeds (unlocked tokens are claimed internally)
      
          // After addLiquidity, user2's SYMM vesting should have decreased and an LP vesting reset occurred.
          const newLockedLP = await symmVesting.getLockedAmountsForToken(user2.address, symmLPToken.address);
          const newLockedSymm = await symmVesting.getLockedAmountsForToken(user2.address, symmToken.address);
          expect(newLockedLP).to.be.gt(initialLPAmount, "User2's LP vesting locked amount should increase after adding liquidity");
          expect(newLockedSymm).to.be.lt(0, "User2's SYMM vesting locked amount should decrease after adding liquidity");  // used some SYMM
      
          // The addLiquidity call above internally calls _resetVestingPlans for the LP token [oai_citation_attribution:3‡github.com](https://github.com/sherlock-audit/2025-03-symm-io-stacking/blob/main/token/contracts/vesting/SymmVesting.sol#:~:text=if%20%28lpVestingPlan.isSetup%28%29%29%20).
          // If the vesting plan had unclaimed tokens that made the new locked amount invalid, it would have reverted similar to scenario 1.
          // This confirms the issue could affect user actions as well.
        });
      });



	describe("modifiers",  ()=>{
		it('should allow PAUSER_ROLE to pause and unpase the contract', async()=>{
			await symmVesting.connect(admin).pause()
			await expect(await symmVesting.paused()).to.be.true

			await expect(symmVesting.connect(admin).resetVestingPlans(
				await symmToken.getAddress(), [await user1.getAddress()], [e(1)]
			)).to.be.revertedWithCustomError(symmVesting, "EnforcedPause")

			await expect(symmVesting.connect(admin).setupVestingPlans(
				await symmToken.getAddress(),
				Math.floor(Date.now() / 1000),
				Math.floor(Date.now() / 1000)+3600,
				[await user1.getAddress()],
				[e(1)]
			)).to.be.revertedWithCustomError(symmVesting, "EnforcedPause")

			await expect(symmVesting.connect(admin).setupVestingPlans(
				await symmToken.getAddress(),
				Math.floor(Date.now() / 1000),
				Math.floor(Date.now() / 1000)+3600,
				[await user1.getAddress()],
				[e(1)]
			)).to.be.revertedWithCustomError(symmVesting, "EnforcedPause")

			await expect(symmVesting.connect(admin).claimUnlockedToken(
				await symmToken.getAddress()
			)).to.be.revertedWithCustomError(symmVesting, "EnforcedPause")

			await expect(symmVesting.connect(admin).claimUnlockedTokenFor(
				await symmToken.getAddress(),
				await user1.getAddress()
			)).to.be.revertedWithCustomError(symmVesting, "EnforcedPause")

			await expect(symmVesting.connect(admin).claimLockedToken(
				await symmToken.getAddress(),
				await user1.getAddress()
			)).to.be.revertedWithCustomError(symmVesting, "EnforcedPause")

			await expect(symmVesting.connect(admin).claimLockedTokenByPercentage(
				await symmToken.getAddress(),
				e(5e-1)
			)).to.be.revertedWithCustomError(symmVesting, "EnforcedPause")

			await expect(symmVesting.connect(admin).claimLockedTokenFor(
				await symmToken.getAddress(),
				await user1.getAddress(),
				e(10)
			)).to.be.revertedWithCustomError(symmVesting, "EnforcedPause")

			await expect(symmVesting.connect(admin).claimLockedTokenForByPercentage(
				await symmToken.getAddress(),
				await user1.getAddress(),
				e(10)
			)).to.be.revertedWithCustomError(symmVesting, "EnforcedPause")

			await expect(symmVesting.connect(user1).addLiquidity(
				e(1),
				0,
				0
			)).to.be.revertedWithCustomError(symmVesting, "EnforcedPause")

			await symmVesting.connect(admin).unpause()
			await expect(await symmVesting.paused()).to.be.false

			await expect(symmVesting.connect(admin).resetVestingPlans(
				await symmToken.getAddress(), [await user1.getAddress()], [e(1)]
			)).to.be.ok

			await expect(symmVesting.connect(admin).setupVestingPlans(
				await symmToken.getAddress(),
				Math.floor(Date.now() / 1000),
				Math.floor(Date.now() / 1000)+3600,
				[await user1.getAddress()],
				[e(1)]
			)).to.be.ok

			await expect(symmVesting.connect(admin).setupVestingPlans(
				await symmToken.getAddress(),
				Math.floor(Date.now() / 1000),
				Math.floor(Date.now() / 1000)+3600,
				[await user1.getAddress()],
				[e(1)]
			)).to.be.ok

			await expect(symmVesting.connect(admin).claimUnlockedToken(
				await symmToken.getAddress()
			)).to.be.ok

			await expect(symmVesting.connect(admin).claimUnlockedTokenFor(
				await symmToken.getAddress(),
				await user1.getAddress()
			)).to.be.ok

			await expect(symmVesting.connect(admin).claimLockedToken(
				await symmToken.getAddress(),
				await user1.getAddress()
			)).to.be.ok

			await expect(symmVesting.connect(admin).claimLockedTokenByPercentage(
				await symmToken.getAddress(),
				e(5e-1)
			)).to.be.ok

			await expect(symmVesting.connect(admin).claimLockedTokenFor(
				await symmToken.getAddress(),
				await user1.getAddress(),
				e(10)
			)).to.be.ok

			await expect(symmVesting.connect(admin).claimLockedTokenForByPercentage(
				await symmToken.getAddress(),
				await user1.getAddress(),
				e(10)
			)).to.be.ok

			await expect(symmVesting.connect(user1).addLiquidity(
				e(1),
				0,
				0
			)).to.be.ok
		})

		it('should revert when initialize method is from nonInitializer/constructor method',
			async()=>{
			const zeroAddress = "0x0000000000000000000000000000000000000000";
			await expect(symmVesting.connect(admin).initialize(admin, admin,
				zeroAddress, zeroAddress, zeroAddress, zeroAddress, zeroAddress, zeroAddress, zeroAddress))
				.to.be.reverted
			const adminAdress = await admin.getAddress()
			await expect(symmVesting.connect(admin).__vesting_init(adminAdress, adminAdress, adminAdress))
				.to.be.reverted
		})

		it('should fail when zero is passed as address to symmVesting initialize method', async()=>{
			const VestingPlanOps = await ethers.getContractFactory("VestingPlanOps")
			const vestingPlanOps = await VestingPlanOps.deploy()
			await vestingPlanOps.waitForDeployment()

			const zeroAddress = "0x0000000000000000000000000000000000000000";
			const nonZeroAddress = "0x0000000000000000000000000000000000000001";

			const VestingFactory = await ethers.getContractFactory("SymmVesting", {
				libraries: {
					VestingPlanOps: await vestingPlanOps.getAddress(),
				},
			})

			await expect( upgrades.deployProxy(VestingFactory, [zeroAddress, nonZeroAddress,
				nonZeroAddress, nonZeroAddress, nonZeroAddress, nonZeroAddress, nonZeroAddress, nonZeroAddress, nonZeroAddress ], {
				unsafeAllow: ["external-library-linking"],
				initializer: "initialize",
			})).to.be.revertedWithCustomError(symmVesting, "ZeroAddress")

			await expect( upgrades.deployProxy(VestingFactory, [nonZeroAddress, zeroAddress,
				nonZeroAddress, nonZeroAddress, nonZeroAddress, nonZeroAddress, nonZeroAddress, nonZeroAddress, nonZeroAddress ], {
				unsafeAllow: ["external-library-linking"],
				initializer: "initialize",
			})).to.be.revertedWithCustomError(symmVesting, "ZeroAddress")

			await expect( upgrades.deployProxy(VestingFactory, [nonZeroAddress, nonZeroAddress,
				zeroAddress, nonZeroAddress, nonZeroAddress, nonZeroAddress, nonZeroAddress, nonZeroAddress, nonZeroAddress ], {
				unsafeAllow: ["external-library-linking"],
				initializer: "initialize",
			})).to.be.revertedWithCustomError(symmVesting, "ZeroAddress")

			await expect( upgrades.deployProxy(VestingFactory, [nonZeroAddress, nonZeroAddress,
				nonZeroAddress, zeroAddress, nonZeroAddress, nonZeroAddress, nonZeroAddress, nonZeroAddress, nonZeroAddress ], {
				unsafeAllow: ["external-library-linking"],
				initializer: "initialize",
			})).to.be.revertedWithCustomError(symmVesting, "ZeroAddress")

			await expect( upgrades.deployProxy(VestingFactory, [nonZeroAddress, nonZeroAddress,
				nonZeroAddress, nonZeroAddress, zeroAddress, nonZeroAddress, nonZeroAddress, nonZeroAddress, nonZeroAddress ], {
				unsafeAllow: ["external-library-linking"],
				initializer: "initialize",
			})).to.be.revertedWithCustomError(symmVesting, "ZeroAddress")

			await expect( upgrades.deployProxy(VestingFactory, [nonZeroAddress, nonZeroAddress,
				nonZeroAddress, nonZeroAddress, nonZeroAddress, zeroAddress, nonZeroAddress, nonZeroAddress, nonZeroAddress ], {
				unsafeAllow: ["external-library-linking"],
				initializer: "initialize",
			})).to.be.revertedWithCustomError(symmVesting, "ZeroAddress")

			await expect( upgrades.deployProxy(VestingFactory, [nonZeroAddress, nonZeroAddress,
				nonZeroAddress, nonZeroAddress, nonZeroAddress, nonZeroAddress, zeroAddress, nonZeroAddress, nonZeroAddress ], {
				unsafeAllow: ["external-library-linking"],
				initializer: "initialize",
			})).to.be.revertedWithCustomError(symmVesting, "ZeroAddress")

			await expect( upgrades.deployProxy(VestingFactory, [nonZeroAddress, nonZeroAddress,
				nonZeroAddress, nonZeroAddress, nonZeroAddress, nonZeroAddress, nonZeroAddress, zeroAddress, nonZeroAddress ], {
				unsafeAllow: ["external-library-linking"],
				initializer: "initialize",
			})).to.be.revertedWithCustomError(symmVesting, "ZeroAddress")

			await expect( upgrades.deployProxy(VestingFactory, [nonZeroAddress, nonZeroAddress,
				nonZeroAddress, nonZeroAddress, nonZeroAddress, nonZeroAddress, nonZeroAddress, nonZeroAddress, zeroAddress ], {
				unsafeAllow: ["external-library-linking"],
				initializer: "initialize",
			})).to.be.revertedWithCustomError(symmVesting, "ZeroAddress")
		})

		it('should fail when zero is passed as address to vesting initialize method', async()=>{
			const VestingPlanOps = await ethers.getContractFactory("VestingPlanOps")
			const vestingPlanOps = await VestingPlanOps.deploy()
			await vestingPlanOps.waitForDeployment()

			const zeroAddress = "0x0000000000000000000000000000000000000000";
			const nonZeroAddress = "0x0000000000000000000000000000000000000001";

			const Vesting = await ethers.getContractFactory("SymmVesting", {
				libraries: {
					VestingPlanOps: await vestingPlanOps.getAddress(),
				},
			})
			await expect( upgrades.deployProxy(Vesting, [zeroAddress, nonZeroAddress, nonZeroAddress], {
				unsafeAllow: ["external-library-linking"],
				initializer: "__vesting_init",
			})).to.be.revertedWithCustomError(symmVesting, "ZeroAddress")

			await expect( upgrades.deployProxy(Vesting, [nonZeroAddress, nonZeroAddress, zeroAddress], {
				unsafeAllow: ["external-library-linking"],
				initializer: "__vesting_init",
			})).to.be.revertedWithCustomError(symmVesting, "ZeroAddress")
		})
	})
	describe('Role management', ()=>{
		it('should allow calling methods just to the ones who have the required role', async()=>{
			await expect(symmVesting.connect(user1).pause()).to.be.revertedWithCustomError(symmVesting, "AccessControlUnauthorizedAccount")
			await expect(symmVesting.connect(user1).unpause()).to.be.revertedWithCustomError(symmVesting, "AccessControlUnauthorizedAccount")
			await expect(symmVesting.connect(user1).resetVestingPlans(symmToken, [await user1.getAddress()], [e(1)]))
				.to.be.revertedWithCustomError(symmVesting, "AccessControlUnauthorizedAccount")
			await expect(symmVesting.connect(user1).setupVestingPlans(
				await symmToken.getAddress(),
				Math.floor(Date.now() / 1000),
				Math.floor(Date.now() / 1000)+3600,
				[await user1.getAddress()],
				[e(1)]
			)).to.be.revertedWithCustomError(symmVesting, "AccessControlUnauthorizedAccount")
			await expect(symmVesting.connect(user1).claimUnlockedTokenFor(symmToken, user1))
				.to.be.revertedWithCustomError(symmVesting, "AccessControlUnauthorizedAccount")
			await expect(symmVesting.connect(user1).claimLockedTokenFor(symmToken, user1, e(1)))
				.to.be.revertedWithCustomError(symmVesting, "AccessControlUnauthorizedAccount")
			await expect(symmVesting.connect(user1).claimLockedTokenForByPercentage(symmToken, user1, e(0.5)))
				.to.be.revertedWithCustomError(symmVesting, "AccessControlUnauthorizedAccount")
		})
	})
}
