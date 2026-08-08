// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { SynthSafetyReserve } from "../../src/synth/SynthSafetyReserve.sol";
import { SyntheticAsset } from "../../src/synth/SyntheticAsset.sol";
import { SyntheticVault } from "../../src/synth/SyntheticVault.sol";
import { TestBase } from "../TestBase.sol";
import { MockFeeOnTransferToken } from "../mocks/Mocks.sol";
import { MockMintFeeDistributor, MockNUSD, MockPriceOracle } from "./RiskMocks.sol";

contract SyntheticVaultTest is TestBase {
    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    address private constant LIQUIDATOR = address(0xB0B0);
    address private constant GUARDIAN = address(0xBEEF);

    MockNUSD private nusd;
    MockPriceOracle private btcOracle;
    MockPriceOracle private ethOracle;
    SyntheticAsset private nbtc;
    SyntheticAsset private neth;
    SynthSafetyReserve private reserve;
    MockMintFeeDistributor private feeDistributor;
    SyntheticVault private vault;
    SyntheticVault private secondVault;

    function setUp() public {
        vm.warp(1_000_000);
        nusd = new MockNUSD();
        btcOracle = new MockPriceOracle(100_000 ether);
        ethOracle = new MockPriceOracle(2000 ether);
        reserve = new SynthSafetyReserve(address(nusd), address(this));
        feeDistributor = new MockMintFeeDistributor(address(nusd));
        nbtc = new SyntheticAsset("0xFi Synthetic Bitcoin", "nBTC", address(this));
        neth = new SyntheticAsset("0xFi Synthetic Ether", "nETH", address(this));
        vault = new SyntheticVault(
            address(nusd),
            address(nbtc),
            address(btcOracle),
            address(reserve),
            address(feeDistributor),
            address(this),
            100 ether,
            true
        );
        secondVault = new SyntheticVault(
            address(nusd),
            address(neth),
            address(ethOracle),
            address(reserve),
            address(feeDistributor),
            address(this),
            1000 ether,
            true
        );
        reserve.bindVaults(address(vault), address(secondVault));
        nbtc.bindVault(address(vault));
        neth.bindVault(address(secondVault));

        nusd.mint(address(this), 500_000 ether);
        nusd.approve(address(reserve), type(uint256).max);
        nusd.mint(ALICE, 1_000_000 ether);
        nusd.mint(BOB, 1_000_000 ether);
        vm.prank(ALICE);
        nusd.approve(address(vault), type(uint256).max);
        vm.prank(ALICE);
        nbtc.approve(address(vault), type(uint256).max);
        vm.prank(BOB);
        nusd.approve(address(vault), type(uint256).max);
        vm.prank(BOB);
        nbtc.approve(address(vault), type(uint256).max);
        vm.prank(LIQUIDATOR);
        nbtc.approve(address(vault), type(uint256).max);
    }

    function testStagedVaultBlocksRiskUntilEveryPermanentBindingIsReady() public {
        SynthSafetyReserve stagedReserve = new SynthSafetyReserve(address(nusd), address(this));
        MockMintFeeDistributor stagedFeeDistributor = new MockMintFeeDistributor(address(nusd));
        SyntheticAsset stagedNbtc = new SyntheticAsset("Staged Bitcoin", "snBTC", address(this));
        SyntheticAsset stagedNeth = new SyntheticAsset("Staged Ether", "snETH", address(this));
        SyntheticVault stagedVault = new SyntheticVault(
            address(nusd),
            address(stagedNbtc),
            address(btcOracle),
            address(stagedReserve),
            address(stagedFeeDistributor),
            address(this),
            100 ether,
            false
        );
        SyntheticVault stagedSecondVault = new SyntheticVault(
            address(nusd),
            address(stagedNeth),
            address(ethOracle),
            address(stagedReserve),
            address(stagedFeeDistributor),
            address(this),
            1000 ether,
            false
        );

        assertFalse(stagedVault.activated(), "migration vault starts inactive");
        assertTrue(stagedVault.mintPaused(), "mint starts paused");
        assertTrue(stagedVault.withdrawPaused(), "withdraw starts paused");

        vm.expectRevert(SyntheticVault.MarketNotActivated.selector);
        vm.prank(ALICE);
        stagedVault.depositCollateral(1 ether, ALICE);
        vm.expectRevert(SyntheticVault.MarketNotActivated.selector);
        vm.prank(ALICE);
        stagedVault.depositAndMint(150_000 ether, 1 ether, type(uint256).max, ALICE);
        vm.expectRevert(SyntheticVault.MarketNotActivated.selector);
        vm.prank(ALICE);
        stagedVault.mint(1 ether, type(uint256).max, ALICE);
        vm.expectRevert(SyntheticVault.MarketNotActivated.selector);
        stagedVault.setMintPaused(false);
        vm.expectRevert(SyntheticVault.MarketNotActivated.selector);
        stagedVault.setWithdrawPaused(false);

        vm.expectRevert(SyntheticVault.ActivationUnavailable.selector);
        stagedVault.activateRiskOperations();
        stagedReserve.bindVaults(address(stagedVault), address(stagedSecondVault));
        vm.expectRevert(SyntheticVault.ActivationUnavailable.selector);
        stagedVault.activateRiskOperations();
        stagedNbtc.bindVault(address(stagedVault));
        stagedNeth.bindVault(address(stagedSecondVault));
        vm.expectRevert(SyntheticVault.ActivationUnavailable.selector);
        stagedVault.activateRiskOperations();
        stagedFeeDistributor.bindVault(address(stagedVault), address(0xB7C));
        stagedFeeDistributor.bindVault(address(stagedSecondVault), address(0xE7C));

        vm.expectRevert();
        vm.prank(ALICE);
        stagedVault.activateRiskOperations();
        stagedVault.activateRiskOperations();
        stagedSecondVault.activateRiskOperations();

        assertTrue(stagedVault.activated(), "owner activation is explicit");
        assertFalse(stagedVault.mintPaused(), "activation opens minting atomically");
        assertFalse(stagedVault.withdrawPaused(), "activation opens withdrawals atomically");
        vm.expectRevert(SyntheticVault.ActivationUnavailable.selector);
        stagedVault.activateRiskOperations();

        vm.startPrank(ALICE);
        nusd.approve(address(stagedVault), type(uint256).max);
        stagedVault.depositAndMint(150_000 ether, 1 ether, type(uint256).max, ALICE);
        vm.stopPrank();
        assertEq(stagedNbtc.balanceOf(ALICE), 1 ether, "activated vault can mint");
    }

    function testInactiveModeUses150PercentAndInputScopedQuote() public {
        vm.prank(ALICE);
        vault.depositCollateral(150_000 ether, ALICE);

        (uint256 quoted, uint256 reserveRequired, bool oneToOne) = vault.quoteDepositAndMint(ALICE, 150_000 ether);
        assertEq(quoted, 1 ether, "quote cannot consume old collateral headroom");
        assertEq(reserveRequired, 0, "inactive reserve quote");
        assertFalse(oneToOne, "inactive mode");

        vm.prank(ALICE);
        vault.mint(1 ether, type(uint256).max, ALICE);
        (uint256 userCollateral, uint256 reserveCollateral, uint256 debt) = vault.positions(ALICE);
        assertEq(userCollateral, 150_000 ether, "user collateral");
        assertEq(reserveCollateral, 0, "no reserve collateral");
        assertEq(debt, 1 ether, "debt");
        assertEq(vault.collateralRatioBps(ALICE), 15_000, "minimum ratio");

        vm.expectRevert(SyntheticVault.InsufficientCollateral.selector);
        vm.prank(ALICE);
        vault.withdrawCollateral(1, ALICE);
    }

    function testSponsoredMintUses100PercentUserAnd50PercentReserve() public {
        _activateReserve();
        (uint256 quoted, uint256 reserveRequired, bool oneToOne) = vault.quoteDepositAndMint(ALICE, 100_000 ether);
        assertEq(quoted, 1 ether, "one dollar user collateral per dollar debt");
        assertEq(reserveRequired, 50_000 ether, "reserve half");
        assertTrue(oneToOne, "sponsorship available");

        vm.prank(ALICE);
        vault.depositAndMint(100_000 ether, quoted, type(uint256).max, ALICE);

        (uint256 userCollateral, uint256 reserveCollateral, uint256 debt) = vault.positions(ALICE);
        assertEq(userCollateral, 100_000 ether, "user owns 100 percent");
        assertEq(reserveCollateral, 50_000 ether, "reserve owns 50 percent");
        assertEq(debt, 1 ether, "debt");
        assertEq(vault.totalUserCollateralNusd(), 100_000 ether, "user total");
        assertEq(vault.totalReserveCollateralNusd(), 50_000 ether, "reserve total");
        assertEq(vault.totalCollateralNusd(), 150_000 ether, "combined total");
        assertEq(nusd.balanceOf(address(vault)), 150_000 ether, "vault balance identity");
        assertEq(reserve.totalReserveNusd(), 100_000 ether, "reserve managed total conserved");
        assertEq(reserve.freeReserveNusd(), 50_000 ether, "free reserve");
        assertEq(reserve.totalAllocatedNusd(), 50_000 ether, "allocated reserve");
    }

    function testWithdrawCanAtomicallyAllocateReserveToUnlockUserExcess() public {
        vm.prank(ALICE);
        vault.depositAndMint(150_000 ether, 1 ether, type(uint256).max, ALICE);
        _activateReserve();

        assertEq(vault.maxUserCollateralWithdrawable(ALICE), 50_000 ether, "sponsored excess");
        vm.prank(ALICE);
        vault.withdrawCollateral(50_000 ether, ALICE);

        (uint256 userCollateral, uint256 reserveCollateral, uint256 debt) = vault.positions(ALICE);
        assertEq(userCollateral, 100_000 ether, "only user collateral withdrawn");
        assertEq(reserveCollateral, 50_000 ether, "reserve allocated atomically");
        assertEq(debt, 1 ether, "debt unchanged");
        assertEq(nusd.balanceOf(ALICE), 899_900 ether, "mint fee is paid outside collateral");
    }

    function testPriceDropCannotShiftUserTrancheIntoReserve() public {
        _activateReserve();
        vm.prank(ALICE);
        vault.depositAndMint(100_000 ether, 1 ether, type(uint256).max, ALICE);

        btcOracle.setPrice(50_000 ether);
        assertEq(vault.maxUserCollateralWithdrawable(ALICE), 50_000 ether, "active mode keeps user at 100 percent");
        vm.expectRevert(SyntheticVault.InsufficientCollateral.selector);
        vm.prank(ALICE);
        vault.withdrawCollateral(75_000 ether, ALICE);

        nusd.setReserveValueNusd(0);
        reserve.syncSponsorshipMode();
        assertFalse(reserve.sponsorshipActive(), "sponsorship disabled");
        assertEq(vault.maxUserCollateralWithdrawable(ALICE), 50_000 ether, "inactive mode keeps the same tranche floor");
        vm.expectRevert(SyntheticVault.InsufficientCollateral.selector);
        vm.prank(ALICE);
        vault.withdrawCollateral(75_000 ether, ALICE);

        vm.prank(ALICE);
        vault.withdrawCollateral(50_000 ether, ALICE);
        (uint256 userAfterWithdraw, uint256 reserveAfterWithdraw,) = vault.positions(ALICE);
        assertEq(userAfterWithdraw, 50_000 ether, "user retains current debt value");
        assertEq(reserveAfterWithdraw, 25_000 ether, "reserve is capped at half the current debt value");

        vm.prank(ALICE);
        assertTrue(nbtc.transfer(LIQUIDATOR, 0.5 ether), "fund coalition liquidator");
        btcOracle.setPrice(65_000 ether);
        vm.prank(LIQUIDATOR);
        vault.liquidate(ALICE, 0.5 ether, 0, LIQUIDATOR);
        vm.prank(ALICE);
        vault.repay(type(uint256).max, ALICE);
        (uint256 finalUserCollateral,,) = vault.positions(ALICE);
        vm.prank(ALICE);
        vault.withdrawCollateral(finalUserCollateral, ALICE);

        assertEq(
            nusd.balanceOf(ALICE) + nusd.balanceOf(LIQUIDATOR),
            999_900 ether,
            "price-drop withdrawal and rebound liquidation cannot extract reserve"
        );
        assertEq(reserve.totalReserveNusd(), 100_000 ether, "reserve remains whole");
    }

    function testInsufficientFreeReserveFallsBackTo150Percent() public {
        _activateReserve();
        vm.prank(ALICE);
        vault.depositAndMint(100_000 ether, 1 ether, type(uint256).max, ALICE);

        (uint256 quoted, uint256 reserveRequired, bool oneToOne) = vault.quoteDepositAndMint(BOB, 150_000 ether);
        assertEq(quoted, 1 ether, "fallback output");
        assertEq(reserveRequired, 0, "fallback does not allocate partially");
        assertFalse(oneToOne, "insufficient reserve disables one-to-one");

        vm.prank(BOB);
        vault.depositAndMint(150_000 ether, quoted, type(uint256).max, BOB);
        (, uint256 bobReserve, uint256 bobDebt) = vault.positions(BOB);
        assertEq(bobReserve, 0, "no partial sponsorship");
        assertEq(bobDebt, 1 ether, "fallback debt");
    }

    function testCollateralQuoteUsesTotalPostDebtReserveTarget() public {
        vm.prank(ALICE);
        vault.depositAndMint(150_000 ether, 1 ether, type(uint256).max, ALICE);
        _activateReserve();
        vm.prank(BOB);
        vault.depositAndMint(100_000 ether, 1 ether, type(uint256).max, BOB);

        vm.prank(ALICE);
        uint256 requiredDeposit = vault.quoteCollateralForMint(0.5 ether);
        assertEq(requiredDeposit, 75_000 ether, "fallback quote covers combined post-debt requirement");

        vm.prank(ALICE);
        vault.depositAndMint(requiredDeposit, 0.5 ether, type(uint256).max, ALICE);
        (uint256 userCollateral, uint256 reserveCollateral, uint256 debt) = vault.positions(ALICE);
        assertEq(userCollateral, 225_000 ether, "quoted user deposit exact");
        assertEq(reserveCollateral, 0, "unavailable sponsorship not partially used");
        assertEq(debt, 1.5 ether, "mint matches quote");
    }

    function testModeDropKeepsExistingReserveAsValidBacking() public {
        _activateReserve();
        vm.prank(ALICE);
        vault.depositAndMint(100_000 ether, 1 ether, type(uint256).max, ALICE);

        nusd.setReserveValueNusd(0);
        assertFalse(reserve.sponsorshipActive(), "underbacking fails closed");
        assertFalse(vault.isLiquidatable(ALICE), "no retroactive margin call");
        assertEq(vault.maxUserCollateralWithdrawable(ALICE), 0, "combined backing already exactly 150 percent");
        reserve.syncSponsorshipMode();

        nusd.setReserveValueNusd(type(uint256).max);
        reserve.syncSponsorshipMode();
        assertFalse(reserve.sponsorshipActive(), "fresh activation delay required");

        vm.prank(ALICE);
        vault.depositAndMint(150_000 ether, 1 ether, type(uint256).max, ALICE);
        (uint256 userCollateral, uint256 reserveCollateral, uint256 debt) = vault.positions(ALICE);
        assertEq(userCollateral, 250_000 ether, "new mint brings full incremental user collateral");
        assertEq(reserveCollateral, 50_000 ether, "existing reserve remains assigned");
        assertEq(debt, 2 ether, "incremental mint succeeds");
        assertEq(vault.collateralRatioBps(ALICE), 15_000, "combined ratio remains exact");
    }

    function testPartialRepayReleasesExcessAndFullRepayNeverNeedsOracle() public {
        _activateReserve();
        vm.prank(ALICE);
        vault.depositAndMint(100_000 ether, 1 ether, type(uint256).max, ALICE);

        vm.prank(ALICE);
        vault.repay(0.5 ether, ALICE);
        (, uint256 reserveAfterPartial, uint256 debtAfterPartial) = vault.positions(ALICE);
        assertEq(reserveAfterPartial, 0, "user collateral alone covers remaining debt");
        assertEq(debtAfterPartial, 0.5 ether, "partial debt");
        assertEq(reserve.totalAllocatedNusd(), 0, "excess returned automatically");

        vm.prank(ALICE);
        vault.mint(0.5 ether, type(uint256).max, ALICE);
        (, uint256 reserveBeforeFull,) = vault.positions(ALICE);
        assertEq(reserveBeforeFull, 50_000 ether, "reserve reassigned");

        reserve.pauseAllocations();
        btcOracle.setReadReverts(true);
        vm.prank(ALICE);
        vault.repay(type(uint256).max, ALICE);
        (, uint256 reserveAfterFull, uint256 debtAfterFull) = vault.positions(ALICE);
        assertEq(reserveAfterFull, 0, "full repay releases without synth oracle");
        assertEq(debtAfterFull, 0, "fully repaid");
        assertEq(reserve.totalAllocatedNusd(), 0, "release stays open while paused");
    }

    function testPartialRepayStillSucceedsWhenOracleReverts() public {
        _activateReserve();
        vm.prank(ALICE);
        vault.depositAndMint(100_000 ether, 1 ether, type(uint256).max, ALICE);
        btcOracle.setReadReverts(true);

        vm.prank(ALICE);
        vault.repay(0.5 ether, ALICE);
        (, uint256 reserveCollateral, uint256 debt) = vault.positions(ALICE);
        assertEq(reserveCollateral, 50_000 ether, "best-effort release waits for oracle");
        assertEq(debt, 0.5 ether, "repayment cannot be blocked");
    }

    function testLiquidationConsumesUserFirstAndCannotExtractReserve() public {
        _activateReserve();
        vm.prank(ALICE);
        vault.depositAndMint(100_000 ether, 1 ether, type(uint256).max, ALICE);
        vm.prank(ALICE);
        assertTrue(nbtc.transfer(LIQUIDATOR, 0.5 ether), "fund liquidator");

        btcOracle.setPrice(130_000 ether);
        vm.prank(LIQUIDATOR);
        (uint256 repaid, uint256 collateralOut) = vault.liquidate(ALICE, 1 ether, 68_250 ether, LIQUIDATOR);

        assertEq(repaid, 0.5 ether, "close factor");
        assertEq(collateralOut, 68_250 ether, "liquidation bonus");
        (uint256 userAfter, uint256 reserveAfter, uint256 debtAfter) = vault.positions(ALICE);
        assertEq(userAfter, 31_750 ether, "user collateral absorbs liquidation first");
        assertEq(reserveAfter, 50_000 ether, "reserve remains until user collateral is exhausted");
        assertEq(debtAfter, 0.5 ether, "remaining debt");
        assertEq(reserve.totalAllocatedNusd(), 50_000 ether, "reserve allocation remains assigned");
        assertEq(reserve.totalReserveNusd(), 100_000 ether, "managed reserve is not extractable");

        vm.prank(ALICE);
        vault.repay(type(uint256).max, ALICE);
        vm.prank(ALICE);
        vault.withdrawCollateral(31_750 ether, ALICE);
        assertEq(
            nusd.balanceOf(ALICE) + nusd.balanceOf(LIQUIDATOR),
            999_900 ether,
            "self-liquidation cannot profit from protocol reserve"
        );
        assertEq(reserve.totalReserveNusd(), 100_000 ether, "full reserve returns after repay");
        assertEq(reserve.totalAllocatedNusd(), 0, "allocation released after repay");
    }

    function testExtremeGapRecognizesBadDebtAndReserveLoss() public {
        _activateReserve();
        vm.prank(ALICE);
        vault.depositAndMint(100_000 ether, 1 ether, type(uint256).max, ALICE);
        vm.prank(ALICE);
        assertTrue(nbtc.transfer(LIQUIDATOR, 0.5 ether), "fund liquidator");

        btcOracle.setPrice(400_000 ether);
        vm.prank(LIQUIDATOR);
        vault.liquidate(ALICE, 0.5 ether, 0, LIQUIDATOR);

        (uint256 userAfter, uint256 reserveAfter, uint256 activeDebtAfter) = vault.positions(ALICE);
        assertEq(userAfter, 0, "user collateral exhausted");
        assertEq(reserveAfter, 0, "reserve collateral exhausted");
        assertEq(activeDebtAfter, 0, "active debt cleared");
        assertGt(vault.totalBadDebtSynthetic(), 0, "bad debt recorded");
        assertEq(
            vault.totalDebtSynthetic() + vault.totalBadDebtSynthetic(),
            nbtc.totalSupply(),
            "synthetic supply fully accounted"
        );
    }

    function testPausesOnlyBlockRiskIncreasingOperations() public {
        vm.prank(ALICE);
        vault.depositAndMint(150_000 ether, 1 ether, type(uint256).max, ALICE);
        vault.setMintPaused(true);
        vault.setWithdrawPaused(true);

        vm.prank(ALICE);
        vault.repay(type(uint256).max, ALICE);
        assertEq(vault.totalDebtSynthetic(), 0, "repay remains open");
        vm.expectRevert(SyntheticVault.WithdrawPaused.selector);
        vm.prank(ALICE);
        vault.withdrawCollateral(150_000 ether, ALICE);

        vault.setWithdrawPaused(false);
        btcOracle.setReadReverts(true);
        vm.prank(ALICE);
        vault.withdrawCollateral(150_000 ether, ALICE);
        assertEq(nusd.balanceOf(ALICE), 999_900 ether, "debt-free exit preserves the paid mint fee");
    }

    function testMintFeeIsExtraAndNeverBecomesCollateralOrReserve() public {
        uint256 aliceBefore = nusd.balanceOf(ALICE);
        uint256 feeNusd = vault.quoteMintFee(1 ether);
        assertEq(feeNusd, 100 ether, "0.1 percent oracle notional fee");
        assertEq(vault.quoteMintFee(1), 100, "small mints retain nonzero precision");

        vm.prank(ALICE);
        vault.depositAndMint(150_000 ether, 1 ether, feeNusd, ALICE);

        (uint256 userCollateral, uint256 reserveCollateral, uint256 debt) = vault.positions(ALICE);
        assertEq(aliceBefore - nusd.balanceOf(ALICE), 150_000 ether + feeNusd, "fee is charged in addition");
        assertEq(userCollateral, 150_000 ether, "fee is not user collateral");
        assertEq(reserveCollateral, 0, "fee is not reserve collateral");
        assertEq(debt, 1 ether, "mint debt");
        assertEq(nusd.balanceOf(address(vault)), 150_000 ether, "vault only retains collateral");
        assertEq(vault.totalCollateralNusd(), 150_000 ether, "collateral accounting excludes fee");
        assertEq(nusd.balanceOf(address(feeDistributor)), feeNusd, "distributor receives exact fee");
        assertEq(feeDistributor.totalRoutedNusd(), feeNusd, "routed fee accounting");
        assertEq(reserve.totalReserveNusd(), 0, "reserve is untouched");
        assertEq(nusd.allowance(address(vault), address(feeDistributor)), 0, "transient allowance is reset");
    }

    function testMintFeeMaximumAndDistributorFailureAreAtomic() public {
        uint256 aliceBefore = nusd.balanceOf(ALICE);
        uint256 feeNusd = vault.quoteMintFee(1 ether);

        vm.expectRevert(abi.encodeWithSelector(SyntheticVault.MintFeeExceeded.selector, feeNusd, feeNusd - 1));
        vm.prank(ALICE);
        vault.depositAndMint(150_000 ether, 1 ether, feeNusd - 1, ALICE);

        assertEq(nusd.balanceOf(ALICE), aliceBefore, "slippage reverts the collateral pull");
        assertEq(nusd.balanceOf(address(vault)), 0, "no collateral retained after slippage");
        assertEq(vault.totalDebtSynthetic(), 0, "no debt after slippage");
        assertEq(nbtc.totalSupply(), 0, "no synthetic after slippage");

        feeDistributor.setShouldRevert(true);
        vm.expectRevert();
        vm.prank(ALICE);
        vault.depositAndMint(150_000 ether, 1 ether, feeNusd, ALICE);

        (uint256 userCollateral, uint256 reserveCollateral, uint256 debt) = vault.positions(ALICE);
        assertEq(nusd.balanceOf(ALICE), aliceBefore, "routing failure rolls back every transfer");
        assertEq(userCollateral + reserveCollateral + debt, 0, "routing failure rolls back the position");
        assertEq(vault.totalCollateralNusd(), 0, "routing failure leaves no accounting residue");
        assertEq(feeDistributor.totalRoutedNusd(), 0, "routing failure leaves no fee residue");
        assertEq(nusd.allowance(address(vault), address(feeDistributor)), 0, "failed allowance is rolled back");
    }

    function testStandaloneMintFeeDoesNotChangeDepositedCollateral() public {
        vm.prank(ALICE);
        vault.depositCollateral(150_000 ether, ALICE);
        uint256 vaultBalanceBefore = nusd.balanceOf(address(vault));
        uint256 feeNusd = vault.quoteMintFee(1 ether);

        vm.prank(ALICE);
        vault.mint(1 ether, feeNusd, ALICE);

        (uint256 userCollateral, uint256 reserveCollateral,) = vault.positions(ALICE);
        assertEq(userCollateral, 150_000 ether, "existing user collateral unchanged");
        assertEq(reserveCollateral, 0, "reserve collateral unchanged");
        assertEq(nusd.balanceOf(address(vault)), vaultBalanceBefore, "fee only transits the vault");
    }

    function testGuardianCanPauseButCannotUnpauseOrChangeRisk() public {
        vault.setGuardian(GUARDIAN);
        vm.prank(GUARDIAN);
        vault.pauseMinting();
        vm.prank(GUARDIAN);
        vault.pauseWithdrawals();

        vm.expectRevert();
        vm.prank(GUARDIAN);
        vault.setMintPaused(false);
        vm.expectRevert();
        vm.prank(GUARDIAN);
        vault.setDebtCeilingSynthetic(200 ether);
        vm.expectRevert();
        vm.prank(GUARDIAN);
        vault.transferOwnership(GUARDIAN);
    }

    function testRejectsFeeOnTransferCollateral() public {
        MockFeeOnTransferToken feeToken = new MockFeeOnTransferToken();
        SynthSafetyReserve feeReserve = new SynthSafetyReserve(address(feeToken), address(this));
        SyntheticAsset asset = new SyntheticAsset("Synthetic Ether", "nETH", address(this));
        MockMintFeeDistributor feeTokenDistributor = new MockMintFeeDistributor(address(feeToken));
        SyntheticVault feeVault = new SyntheticVault(
            address(feeToken),
            address(asset),
            address(btcOracle),
            address(feeReserve),
            address(feeTokenDistributor),
            address(this),
            1000 ether,
            true
        );
        asset.bindVault(address(feeVault));
        feeToken.mint(ALICE, 100 ether);
        vm.prank(ALICE);
        feeToken.approve(address(feeVault), type(uint256).max);

        vm.expectRevert(SyntheticVault.ExactTransferRequired.selector);
        vm.prank(ALICE);
        feeVault.depositCollateral(100 ether, ALICE);
    }

    function testFuzzSponsoredMintStartsAtOrAbove150Percent(uint96 rawCollateral) public {
        _activateReserve();
        uint256 collateral = bound(rawCollateral, 1 ether, 200_000 ether);
        (uint256 amountSynthetic,, bool oneToOne) = vault.quoteDepositAndMint(ALICE, collateral);
        vm.assume(amountSynthetic != 0);
        vm.assume(oneToOne);

        vm.prank(ALICE);
        vault.depositAndMint(collateral, amountSynthetic, type(uint256).max, ALICE);
        assertGe(vault.collateralRatioBps(ALICE), 15_000, "fuzz total ratio");
        assertEq(
            nusd.balanceOf(address(vault)),
            vault.totalUserCollateralNusd() + vault.totalReserveCollateralNusd(),
            "fuzz exact ownership accounting"
        );
    }

    function _activateReserve() private {
        reserve.fund(100_000 ether);
        assertFalse(reserve.sponsorshipActive(), "entry delay");
        vm.warp(block.timestamp + reserve.ACTIVATION_DELAY());
        assertTrue(reserve.sponsorshipActive(), "logical activation needs no keeper");
    }
}
