// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ZeroXFiFactory } from "../src/amm/ZeroXFiFactory.sol";
import { ZeroXFiRouter } from "../src/amm/ZeroXFiRouter.sol";
import { WzkLTC } from "../src/amm/WzkLTC.sol";
import { GaugeFactory } from "../src/farming/GaugeFactory.sol";
import { LiquidityGauge } from "../src/farming/LiquidityGauge.sol";
import { SyntheticAsset } from "../src/synth/SyntheticAsset.sol";
import { TestBase } from "./TestBase.sol";
import { MockERC20, MockPump } from "./mocks/Mocks.sol";

contract MockSynthMintFeeVault {
    using SafeERC20 for IERC20;

    IERC20 public immutable nusd;
    SyntheticAsset public immutable syntheticAsset;
    GaugeFactory public immutable mintFeeDistributor;

    constructor(address nusdAddress, SyntheticAsset syntheticAsset_, GaugeFactory mintFeeDistributor_) {
        nusd = IERC20(nusdAddress);
        syntheticAsset = syntheticAsset_;
        mintFeeDistributor = mintFeeDistributor_;
    }

    function mintSynthetic(address recipient, uint256 amount) external {
        syntheticAsset.mint(recipient, amount);
    }

    function routeMintFee(uint256 amountNusd) external returns (uint256 amountFlushedNusd) {
        nusd.forceApprove(address(mintFeeDistributor), amountNusd);
        amountFlushedNusd = mintFeeDistributor.routeMintFee(amountNusd);
        nusd.forceApprove(address(mintFeeDistributor), 0);
    }
}

contract FarmingTest is TestBase {
    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    address private constant GUARDIAN = address(0xBEEF);

    MockERC20 private nusd;
    MockERC20 private token;
    ZeroXFiFactory private dexFactory;
    ZeroXFiRouter private router;
    GaugeFactory private gaugeFactory;
    address private pair;
    LiquidityGauge private gauge;

    function setUp() public {
        vm.warp(1_000_000);
        nusd = new MockERC20("Nothing USD", "NUSD");
        token = new MockERC20("Token", "TKN");
        MockPump pump = new MockPump(address(nusd));
        dexFactory = new ZeroXFiFactory(address(this), address(nusd), address(pump));
        router = new ZeroXFiRouter(address(dexFactory), address(new WzkLTC()));
        dexFactory.bindRouter(address(router));

        _addLiquidity(ALICE, 1000 ether, 1000 ether);
        _addLiquidity(BOB, 1000 ether, 1000 ether);
        pair = dexFactory.getPair(address(token), address(nusd));

        gaugeFactory = new GaugeFactory(address(this), address(nusd), address(dexFactory));
        gauge = LiquidityGauge(gaugeFactory.createGauge(pair));
        nusd.mint(address(this), 10_000 ether);
        nusd.approve(address(gaugeFactory), type(uint256).max);

        vm.prank(ALICE);
        IERC20(pair).approve(address(gauge), type(uint256).max);
        vm.prank(BOB);
        IERC20(pair).approve(address(gauge), type(uint256).max);
    }

    function testOneGaugePerLpAndFundedRewardsSplitByStakeTime() public {
        vm.expectRevert(GaugeFactory.GaugeAlreadyExists.selector);
        gaugeFactory.createGauge(pair);

        uint256 aliceStake = IERC20(pair).balanceOf(ALICE);
        uint256 bobStake = IERC20(pair).balanceOf(BOB);
        vm.prank(ALICE);
        gauge.stake(aliceStake);
        gaugeFactory.fundGauge(pair, 700 ether, 7 days);

        vm.warp(block.timestamp + 1 days);
        vm.prank(BOB);
        gauge.stake(bobStake);
        vm.warp(block.timestamp + 1 days);

        uint256 aliceEarned = gauge.earned(ALICE);
        uint256 bobEarned = gauge.earned(BOB);
        assertApproxEqAbs(aliceEarned, 150 ether, 1e15, "Alice time-weighted reward");
        assertApproxEqAbs(bobEarned, 50 ether, 1e15, "Bob time-weighted reward");
        assertEq(gauge.totalFunded(), 700 ether, "only deposited NUSD funded");
        assertEq(nusd.balanceOf(address(gauge)), 700 ether, "schedule fully backed");

        vm.prank(ALICE);
        uint256 claimedAlice = gauge.getReward();
        vm.prank(BOB);
        uint256 claimedBob = gauge.getReward();
        assertEq(gauge.totalPaid(), claimedAlice + claimedBob, "paid accounting");
        assertLe(gauge.totalPaid(), gauge.totalFunded(), "cannot mint rewards");
    }

    function testGuardianCanOnlyPauseDepositsButNeverWithdrawalOrClaims() public {
        uint256 aliceStake = IERC20(pair).balanceOf(ALICE);
        vm.prank(ALICE);
        gauge.stake(aliceStake);
        gaugeFactory.fundGauge(pair, 700 ether, 7 days);
        vm.warp(block.timestamp + 1 days);

        assertEq(gaugeFactory.guardian(), address(this), "guardian starts as initial owner");
        gaugeFactory.setGuardian(GUARDIAN);
        vm.prank(GUARDIAN);
        gaugeFactory.pauseGaugeDeposits(pair);

        vm.expectRevert();
        vm.prank(GUARDIAN);
        gaugeFactory.setGaugeDepositsPaused(pair, false);

        vm.expectRevert();
        vm.prank(GUARDIAN);
        gaugeFactory.fundGauge(pair, 100 ether, 7 days);

        vm.expectRevert(LiquidityGauge.DepositsPaused.selector);
        vm.prank(BOB);
        gauge.stake(1);

        uint256 nusdBefore = nusd.balanceOf(ALICE);
        vm.prank(ALICE);
        gauge.withdraw(aliceStake);
        vm.prank(ALICE);
        uint256 claimed = gauge.getReward();
        assertEq(IERC20(pair).balanceOf(ALICE), aliceStake, "withdraw remains available");
        assertGt(claimed, 0, "claim remains available");
        assertEq(nusd.balanceOf(ALICE), nusdBefore + claimed, "reward moved only through user claim");

        gaugeFactory.setGaugeDepositsPaused(pair, false);
        vm.prank(BOB);
        gauge.stake(1);
    }

    function testOnlyFactoryOwnerCanFundAndDurationIsBounded() public {
        nusd.mint(BOB, 100 ether);
        vm.prank(BOB);
        nusd.approve(address(gaugeFactory), type(uint256).max);
        vm.expectRevert();
        vm.prank(BOB);
        gaugeFactory.fundGauge(pair, 100 ether, 7 days);

        vm.expectRevert(LiquidityGauge.InvalidDuration.selector);
        gaugeFactory.fundGauge(pair, 100 ether, 1 hours);
        assertEq(nusd.balanceOf(address(gauge)), 0, "failed schedule funding rolled back");
    }

    function testMintFeeRouteRequiresTheCanonicalBoundVaultAndPair() public {
        (SyntheticAsset asset, MockSynthMintFeeVault feeVault, address feePair,) = _createSynthFeeMarket();
        MockSynthMintFeeVault impostor = new MockSynthMintFeeVault(address(nusd), asset, gaugeFactory);

        vm.expectRevert(GaugeFactory.InvalidPair.selector);
        gaugeFactory.bindMintFeeVault(address(impostor), feePair);
        vm.expectRevert(GaugeFactory.InvalidPair.selector);
        gaugeFactory.bindMintFeeVault(address(feeVault), pair);

        gaugeFactory.bindMintFeeVault(address(feeVault), feePair);
        assertEq(gaugeFactory.mintFeePairForVault(address(feeVault)), feePair, "vault route");
        assertEq(gaugeFactory.mintFeeVaultForPair(feePair), address(feeVault), "pair route");

        vm.expectRevert(GaugeFactory.MintFeeRouteAlreadyBound.selector);
        gaugeFactory.bindMintFeeVault(address(feeVault), feePair);
        vm.expectRevert(GaugeFactory.UnauthorizedMintFeeVault.selector);
        vm.prank(BOB);
        gaugeFactory.routeMintFee(1);
    }

    function testMintFeesQueueWithoutStakeAndFlushPermissionlesslyForSevenDays() public {
        (, MockSynthMintFeeVault feeVault, address feePair, LiquidityGauge feeGauge) = _createSynthFeeMarket();
        gaugeFactory.bindMintFeeVault(address(feeVault), feePair);

        nusd.mint(address(feeVault), 70 ether);
        assertEq(feeVault.routeMintFee(70 ether), 0, "empty gauge queues fees");
        assertEq(gaugeFactory.pendingMintFeesNusd(feePair), 70 ether, "pair pending");
        assertEq(gaugeFactory.totalPendingMintFeesNusd(), 70 ether, "global pending");
        assertEq(nusd.balanceOf(address(gaugeFactory)), 70 ether, "factory custody matches pending");
        assertEq(nusd.balanceOf(address(feeGauge)), 0, "nothing starts before stake");

        uint256 aliceLiquidity = IERC20(feePair).balanceOf(ALICE);
        vm.prank(ALICE);
        feeGauge.stake(aliceLiquidity);
        vm.prank(BOB);
        uint256 flushed = gaugeFactory.flushMintFees(feePair);

        assertEq(flushed, 70 ether, "permissionless flush amount");
        assertEq(gaugeFactory.pendingMintFeesNusd(feePair), 0, "pair queue cleared");
        assertEq(gaugeFactory.totalPendingMintFeesNusd(), 0, "global queue cleared");
        assertEq(nusd.balanceOf(address(gaugeFactory)), 0, "no unaccounted factory balance");
        assertEq(nusd.balanceOf(address(feeGauge)), 70 ether, "gauge receives exact NUSD");
        assertEq(feeGauge.totalFunded(), 70 ether, "funded accounting");
        assertEq(
            feeGauge.periodFinish(),
            block.timestamp + gaugeFactory.MINT_FEE_REWARD_DURATION(),
            "fixed seven day schedule"
        );

        nusd.mint(address(feeVault), 7 ether);
        assertEq(feeVault.routeMintFee(7 ether), 7 ether, "active gauge auto flushes");
        assertEq(feeGauge.totalFunded(), 77 ether, "top-up is fully funded");
        assertEq(gaugeFactory.totalPendingMintFeesNusd(), 0, "top-up leaves no queue");
    }

    function testMintFeeDustQueuesUntilItCanProduceANonzeroRate() public {
        (, MockSynthMintFeeVault feeVault, address feePair, LiquidityGauge feeGauge) = _createSynthFeeMarket();
        gaugeFactory.bindMintFeeVault(address(feeVault), feePair);
        uint256 aliceLiquidity = IERC20(feePair).balanceOf(ALICE);
        vm.prank(ALICE);
        feeGauge.stake(aliceLiquidity);

        uint256 duration = gaugeFactory.MINT_FEE_REWARD_DURATION();
        nusd.mint(address(feeVault), duration);
        assertEq(feeVault.routeMintFee(duration - 1), 0, "sub-rate dust stays queued");
        assertEq(gaugeFactory.pendingMintFeesNusd(feePair), duration - 1, "dust queue");
        assertEq(feeGauge.totalFunded(), 0, "dust cannot create a zero-rate schedule");

        assertEq(feeVault.routeMintFee(1), duration, "aggregate reaches one wei per second");
        assertEq(gaugeFactory.pendingMintFeesNusd(feePair), 0, "aggregate queue flushed");
        assertEq(feeGauge.rewardRate(), 1, "minimum nonzero rate");
        assertEq(feeGauge.totalFunded(), duration, "all dust remains backed");
    }

    function testRewardClockPausesAtZeroStakeAndResumesWithoutLoss() public {
        (, MockSynthMintFeeVault feeVault, address feePair, LiquidityGauge feeGauge) = _createSynthFeeMarket();
        gaugeFactory.bindMintFeeVault(address(feeVault), feePair);

        vm.prank(ALICE);
        feeGauge.stake(1);
        uint256 duration = gaugeFactory.MINT_FEE_REWARD_DURATION();
        uint256 feeAmount = duration * 1 ether;
        nusd.mint(address(feeVault), feeAmount);
        assertEq(feeVault.routeMintFee(feeAmount), feeAmount, "fee schedule starts with dust stake");

        vm.warp(block.timestamp + 1 days);
        vm.prank(ALICE);
        feeGauge.withdraw(1);
        assertEq(feeGauge.pausedRewardDuration(), 6 days, "unvested time is frozen");
        uint256 earnedBeforeIdle = feeGauge.earned(ALICE);

        vm.warp(block.timestamp + 30 days);
        assertEq(feeGauge.earned(ALICE), earnedBeforeIdle, "empty time earns and burns nothing");
        vm.prank(ALICE);
        feeGauge.stake(1);
        assertEq(feeGauge.pausedRewardDuration(), 0, "schedule resumed");
        assertEq(feeGauge.periodFinish(), block.timestamp + 6 days, "full remaining time restored");

        vm.warp(block.timestamp + 6 days);
        vm.prank(ALICE);
        uint256 claimed = feeGauge.getReward();
        assertEq(claimed, feeAmount, "all funded rewards remain claimable");
        assertEq(feeGauge.totalPaid(), feeAmount, "paid accounting includes resumed rewards");
        assertLe(feeGauge.totalPaid(), feeGauge.totalFunded(), "resumed schedule cannot overpay");
    }

    function _createSynthFeeMarket()
        private
        returns (SyntheticAsset asset, MockSynthMintFeeVault feeVault, address feePair, LiquidityGauge feeGauge)
    {
        asset = new SyntheticAsset("Synthetic Bitcoin", "nBTC", address(this));
        feeVault = new MockSynthMintFeeVault(address(nusd), asset, gaugeFactory);
        asset.bindVault(address(feeVault));
        feeVault.mintSynthetic(ALICE, 1000 ether);
        nusd.mint(ALICE, 1000 ether);

        vm.startPrank(ALICE);
        asset.approve(address(router), type(uint256).max);
        nusd.approve(address(router), type(uint256).max);
        router.addLiquidity(
            ZeroXFiRouter.AddLiquidityParams({
                tokenA: address(asset),
                tokenB: address(nusd),
                amountADesired: 1000 ether,
                amountBDesired: 1000 ether,
                amountAMin: 1000 ether,
                amountBMin: 1000 ether,
                minimumLiquidity: 1,
                to: ALICE,
                deadline: block.timestamp + 1
            })
        );
        vm.stopPrank();

        feePair = dexFactory.getPair(address(asset), address(nusd));
        feeGauge = LiquidityGauge(gaugeFactory.createGauge(feePair));
        vm.prank(ALICE);
        IERC20(feePair).approve(address(feeGauge), type(uint256).max);
    }

    function _addLiquidity(address provider, uint256 tokenAmount, uint256 nusdAmount) private {
        token.mint(provider, tokenAmount);
        nusd.mint(provider, nusdAmount);
        vm.startPrank(provider);
        token.approve(address(router), type(uint256).max);
        nusd.approve(address(router), type(uint256).max);
        router.addLiquidity(
            ZeroXFiRouter.AddLiquidityParams({
                tokenA: address(token),
                tokenB: address(nusd),
                amountADesired: tokenAmount,
                amountBDesired: nusdAmount,
                amountAMin: tokenAmount,
                amountBMin: nusdAmount,
                minimumLiquidity: 1,
                to: provider,
                deadline: block.timestamp + 1
            })
        );
        vm.stopPrank();
    }
}
