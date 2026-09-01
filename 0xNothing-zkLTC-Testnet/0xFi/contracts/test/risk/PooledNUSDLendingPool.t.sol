// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { PooledNUSDLendingPool } from "../../src/lending/PooledNUSDLendingPool.sol";
import { TestBase } from "../helpers/TestBase.sol";
import { MockCollateralToken, MockNUSD, MockPriceOracle } from "../mocks/RiskMocks.sol";
import { MockFeeOnTransferToken } from "../mocks/TokenMocks.sol";

contract PooledNUSDLendingPoolTest is TestBase {
    address private constant SUPPLIER = address(0x5150);
    address private constant SECOND_SUPPLIER = address(0x5151);
    address private constant ALICE = address(0xA11CE);
    address private constant LIQUIDATOR = address(0xB0B);
    address private constant GUARDIAN = address(0xBEEF);

    MockNUSD private nusd;
    MockCollateralToken private wzklTC;
    MockCollateralToken private nbtc;
    MockCollateralToken private neth;
    MockPriceOracle private ltcOracle;
    MockPriceOracle private btcOracle;
    MockPriceOracle private ethOracle;
    PooledNUSDLendingPool private pool;

    function setUp() public {
        vm.warp(1_000_000);
        nusd = new MockNUSD();
        wzklTC = new MockCollateralToken("Wrapped zkLTC", "WzkLTC", 18);
        nbtc = new MockCollateralToken("Synthetic Bitcoin", "nBTC", 18);
        neth = new MockCollateralToken("Synthetic Ether", "nETH", 18);
        ltcOracle = new MockPriceOracle(100 ether);
        btcOracle = new MockPriceOracle(100_000 ether);
        ethOracle = new MockPriceOracle(4000 ether);

        pool = new PooledNUSDLendingPool(address(nusd), address(this), 10_000_000 ether, 8_000_000 ether, true);
        pool.configureCollateral(address(wzklTC), address(ltcOracle), 1_000_000 ether, 8000, 8500, 9000, 500, true);
        pool.configureCollateral(address(nbtc), address(btcOracle), 1000 ether, 8000, 8500, 9000, 500, true);
        pool.configureCollateral(address(neth), address(ethOracle), 10_000 ether, 8000, 8500, 9000, 500, true);

        _fundNusdAndApprove(SUPPLIER, 3_000_000 ether);
        _fundNusdAndApprove(SECOND_SUPPLIER, 3_000_000 ether);
        _fundNusdAndApprove(ALICE, 1_000_000 ether);
        _fundNusdAndApprove(LIQUIDATOR, 1_000_000 ether);
        wzklTC.mint(ALICE, 100_000 ether);
        vm.prank(ALICE);
        wzklTC.approve(address(pool), type(uint256).max);
    }

    function testInactiveMigrationPoolBlocksPublicActionsUntilBootstrapAndActivation() public {
        PooledNUSDLendingPool stagedPool =
            new PooledNUSDLendingPool(address(nusd), address(this), 5000 ether, 2500 ether, false);
        stagedPool.configureCollateral(address(wzklTC), address(ltcOracle), 50 ether, 8000, 8500, 9000, 500, true);

        assertFalse(stagedPool.activated(), "migration pool starts inactive");
        assertTrue(stagedPool.bootstrapOpen(), "one-time bootstrap starts open");
        assertTrue(stagedPool.supplyPaused(), "public supply starts paused");
        assertTrue(stagedPool.borrowPaused(), "borrowing starts paused");
        assertTrue(stagedPool.collateralWithdrawalPaused(), "collateral withdrawals start paused");
        assertEq(stagedPool.maxBorrow(ALICE), 0, "inactive pool exposes no borrow quote");

        vm.expectRevert(PooledNUSDLendingPool.MarketNotActivated.selector);
        vm.prank(SUPPLIER);
        stagedPool.supply(1 ether, SUPPLIER);

        vm.expectRevert(PooledNUSDLendingPool.MarketNotActivated.selector);
        vm.prank(ALICE);
        stagedPool.depositCollateral(address(wzklTC), 1 ether, ALICE);

        vm.expectRevert(PooledNUSDLendingPool.MarketNotActivated.selector);
        vm.prank(ALICE);
        stagedPool.borrow(1 ether, ALICE);

        vm.expectRevert(PooledNUSDLendingPool.MarketNotActivated.selector);
        stagedPool.setPauses(false, false, false);

        nusd.mint(address(this), 20 ether);
        nusd.approve(address(stagedPool), type(uint256).max);
        vm.expectRevert();
        vm.prank(SUPPLIER);
        stagedPool.bootstrapSupply(20 ether, SUPPLIER);

        uint256 shares = stagedPool.bootstrapSupply(20 ether, address(this));
        assertEq(shares, 20 ether - stagedPool.MINIMUM_LOCKED_SHARES(), "bootstrap share quote");
        assertEq(stagedPool.totalSupply(), 20 ether, "bootstrap assets are fully represented");
        assertFalse(stagedPool.bootstrapOpen(), "bootstrap closes atomically");
        assertFalse(stagedPool.activated(), "bootstrap does not activate risk");
        assertTrue(stagedPool.supplyPaused(), "supply remains paused after bootstrap");
        assertTrue(stagedPool.borrowPaused(), "borrowing remains paused after bootstrap");

        vm.expectRevert(PooledNUSDLendingPool.BootstrapUnavailable.selector);
        stagedPool.bootstrapSupply(1 ether, address(this));
        vm.expectRevert();
        vm.prank(SUPPLIER);
        stagedPool.activateRiskOperations();

        stagedPool.activateRiskOperations();
        assertTrue(stagedPool.activated(), "activation is explicit");
        assertFalse(stagedPool.supplyPaused(), "activation opens supply");
        assertFalse(stagedPool.borrowPaused(), "activation opens borrowing");
        assertFalse(stagedPool.collateralWithdrawalPaused(), "activation opens collateral withdrawals");

        vm.expectRevert(PooledNUSDLendingPool.BootstrapUnavailable.selector);
        stagedPool.activateRiskOperations();

        vm.startPrank(SUPPLIER);
        nusd.approve(address(stagedPool), type(uint256).max);
        stagedPool.supply(1 ether, SUPPLIER);
        vm.stopPrank();

        vm.startPrank(ALICE);
        wzklTC.approve(address(stagedPool), type(uint256).max);
        stagedPool.depositCollateral(address(wzklTC), 1 ether, ALICE);
        vm.stopPrank();
        assertEq(stagedPool.collateralBalance(ALICE, address(wzklTC)), 1 ether, "activated collateral deposit");
    }

    function testInactivePoolCannotActivateWithoutBootstrapAndCollateralConfiguration() public {
        PooledNUSDLendingPool stagedPool =
            new PooledNUSDLendingPool(address(nusd), address(this), 5000 ether, 2500 ether, false);

        vm.expectRevert(PooledNUSDLendingPool.BootstrapUnavailable.selector);
        stagedPool.activateRiskOperations();

        nusd.mint(address(this), 20 ether);
        nusd.approve(address(stagedPool), 20 ether);
        stagedPool.bootstrapSupply(20 ether, address(this));

        vm.expectRevert(PooledNUSDLendingPool.BootstrapUnavailable.selector);
        stagedPool.activateRiskOperations();

        stagedPool.configureCollateral(address(wzklTC), address(ltcOracle), 50 ether, 8000, 8500, 9000, 500, true);
        stagedPool.activateRiskOperations();
        assertTrue(stagedPool.activated(), "configured and bootstrapped pool activates");
    }

    function testSuppliersReceiveSharesInOnePooledMarket() public {
        vm.prank(SUPPLIER);
        uint256 firstShares = pool.supply(1_000_000 ether, SUPPLIER);
        vm.prank(SECOND_SUPPLIER);
        uint256 secondShares = pool.supply(500_000 ether, SECOND_SUPPLIER);

        assertEq(firstShares, 1_000_000 ether - pool.MINIMUM_LOCKED_SHARES(), "bootstrap locks minimum shares");
        assertEq(secondShares, 500_000 ether, "same share price");
        assertEq(pool.totalSupplied(), 1_500_000 ether, "one combined pool");
        assertEq(pool.availableLiquidity(), 1_500_000 ether, "shared liquidity");
    }

    function testBorrowUsesDIAOnlyCollateralCapacityAndLazyInterest() public {
        _seedLiquidity();
        vm.startPrank(ALICE);
        pool.depositCollateral(address(wzklTC), 1000 ether, ALICE);
        pool.borrow(50_000 ether, ALICE);
        vm.stopPrank();

        (uint256 borrowingCapacity, uint256 liquidationCapacity, uint256 debtBefore) = pool.accountLiquidity(ALICE);
        assertEq(borrowingCapacity, 80_000 ether, "80 percent LTV capacity");
        assertEq(liquidationCapacity, 90_000 ether, "90 percent liquidation capacity");
        assertGe(debtBefore, 50_000 ether, "borrow debt");
        assertLe(debtBefore, 50_000 ether + 1, "share rounding only");
        assertEq(pool.borrowRate(), 0.045 ether, "fixed borrower APR");
        assertEq(pool.lenderRate(), 0.04 ether, "lender APR on utilized NUSD");
        assertEq(pool.protocolRate(), 0.005 ether, "protocol APR spread");
        assertGt(pool.supplyRate(), 0, "utilized liquidity earns yield");
        assertTrue(pool.supplyRate() < pool.lenderRate(), "pool APY reflects utilization");

        vm.warp(block.timestamp + 365 days);
        pool.accrueInterest();
        uint256 debtAfter = pool.debtBalance(ALICE);
        assertApproxEqAbs(debtAfter, 52_250 ether, 2, "borrowers owe 4.5 percent annual interest");
        assertApproxEqAbs(pool.supplyBalance(SUPPLIER), 2_002_000 ether - 1001, 2, "suppliers receive 4 percent");
        assertApproxEqAbs(pool.accruedProtocolInterestNusd(), 250 ether, 1, "protocol receives 0.5 percent");
        assertEq(
            pool.totalAssetsNusd() + pool.accruedProtocolInterestNusd(),
            pool.availableLiquidity() + pool.totalBorrowed(),
            "supplier and protocol claims reconcile to gross assets"
        );
    }

    function testFixedSpreadIsSolventAtZeroAndPartialUtilization() public {
        _seedLiquidity();
        assertEq(pool.borrowRate(), 0.045 ether, "fixed borrower APR");
        assertEq(pool.lenderRate(), 0.04 ether, "fixed lender APR on utilized NUSD");
        assertEq(pool.protocolRate(), 0.005 ether, "fixed protocol spread");
        assertEq(pool.supplyRate(), 0, "idle NUSD cannot create unbacked yield");

        uint256 assetsBefore = pool.totalAssetsNusd();
        vm.warp(block.timestamp + 365 days);
        pool.accrueInterest();
        assertEq(pool.totalAssetsNusd(), assetsBefore, "zero utilization leaves supplier assets unchanged");
        assertEq(pool.accruedProtocolInterestNusd(), 0, "zero utilization leaves protocol interest unchanged");
    }

    function testProtocolWithdrawalCannotReduceSupplierAssets() public {
        _seedLiquidity();
        vm.startPrank(ALICE);
        pool.depositCollateral(address(wzklTC), 20_000 ether, ALICE);
        pool.borrow(1_000_000 ether, ALICE);
        vm.stopPrank();

        vm.warp(block.timestamp + 365 days);
        pool.accrueInterest();
        uint256 protocolInterest = pool.accruedProtocolInterestNusd();
        uint256 supplierAssetsBefore = pool.totalAssetsNusd();
        uint256 recipientBefore = nusd.balanceOf(SECOND_SUPPLIER);

        pool.withdrawProtocolInterest(protocolInterest, SECOND_SUPPLIER);

        assertApproxEqAbs(protocolInterest, 5000 ether, 1, "0.5 percent protocol interest");
        assertEq(pool.totalAssetsNusd(), supplierAssetsBefore, "protocol withdrawal excludes supplier assets");
        assertEq(nusd.balanceOf(SECOND_SUPPLIER) - recipientBefore, protocolInterest, "protocol recipient paid");
        assertEq(pool.accruedProtocolInterestNusd(), 0, "withdrawn protocol claim cleared");
    }

    function testRiskStagesUse80Borrow85MarginAnd90Liquidation() public {
        _seedLiquidity();
        vm.startPrank(ALICE);
        pool.depositCollateral(address(wzklTC), 1000 ether, ALICE);
        pool.borrow(80_000 ether, ALICE);
        vm.stopPrank();

        (uint256 value, uint256 borrowCapacity, uint256 marginCapacity, uint256 liquidationCapacity,, uint256 ltv) =
            pool.accountRisk(ALICE);
        assertEq(value, 100_000 ether, "oracle collateral value");
        assertEq(borrowCapacity, 80_000 ether, "80 percent initial LTV");
        assertEq(marginCapacity, 85_000 ether, "85 percent margin call");
        assertEq(liquidationCapacity, 90_000 ether, "90 percent liquidation");
        assertEq(ltv, 8000, "position starts at 80 percent");
        assertFalse(pool.isMarginCalled(ALICE), "80 percent is not margin called");
        assertFalse(pool.isLiquidatable(ALICE), "80 percent is not liquidatable");

        ltcOracle.setPrice(94 ether);
        assertTrue(pool.isMarginCalled(ALICE), "above 85 percent enters margin call");
        assertFalse(pool.isLiquidatable(ALICE), "margin call is not liquidation");

        ltcOracle.setPrice(88 ether);
        assertTrue(pool.isLiquidatable(ALICE), "above 90 percent becomes liquidatable");
    }

    function testMaxViewsRespectLiquidityAndCollateralHeadroom() public {
        _seedLiquidity();
        vm.prank(ALICE);
        pool.depositCollateral(address(wzklTC), 1000 ether, ALICE);
        assertEq(pool.maxBorrow(ALICE), 80_000 ether - 1, "max borrow leaves rounding headroom");

        vm.prank(ALICE);
        pool.borrow(50_000 ether, ALICE);
        assertApproxEqAbs(pool.maxWithdrawCollateral(ALICE, address(wzklTC)), 375 ether, 1, "withdrawable collateral");
        assertEq(pool.maxWithdraw(SUPPLIER), 1_950_000 ether, "supplier max is bounded by pool cash");
    }

    function testPausesDoNotBlockRepayOrDebtFreeExit() public {
        _seedLiquidity();
        vm.startPrank(ALICE);
        pool.depositCollateral(address(wzklTC), 1000 ether, ALICE);
        pool.borrow(50_000 ether, ALICE);
        vm.stopPrank();

        pool.setPauses(true, true, true);
        vm.prank(ALICE);
        pool.repay(type(uint256).max, ALICE);
        assertEq(pool.debtBalance(ALICE), 0, "repay remains open");

        ltcOracle.setReadReverts(true);
        vm.prank(ALICE);
        pool.withdrawCollateral(address(wzklTC), 1000 ether, ALICE);
        assertEq(wzklTC.balanceOf(ALICE), 100_000 ether, "debt-free exit skips pause and oracle");
    }

    function testPublicLiquidationUsesCloseFactorAndConfiguredBonus() public {
        _seedLiquidity();
        vm.startPrank(ALICE);
        pool.depositCollateral(address(wzklTC), 1000 ether, ALICE);
        pool.borrow(70_000 ether, ALICE);
        vm.stopPrank();

        ltcOracle.setPrice(70 ether);
        vm.prank(LIQUIDATOR);
        (uint256 repaid, uint256 collateralOut) = pool.liquidate(ALICE, address(wzklTC), 70_000 ether, 0, LIQUIDATOR);

        assertApproxEqAbs(repaid, 35_000 ether, 1, "50 percent close factor");
        assertApproxEqAbs(collateralOut, 525 ether, 2, "5 percent bonus");
        assertApproxEqAbs(pool.debtBalance(ALICE), 35_000 ether, 2, "remaining debt");
        assertApproxEqAbs(pool.collateralBalance(ALICE, address(wzklTC)), 475 ether, 2, "remaining collateral");
    }

    function testGuardianCanOnlyPauseRiskWhileRepayLiquidationAndExitsStayOpen() public {
        _seedLiquidity();
        vm.startPrank(ALICE);
        pool.depositCollateral(address(wzklTC), 1000 ether, ALICE);
        pool.borrow(70_000 ether, ALICE);
        vm.stopPrank();

        assertEq(pool.guardian(), address(this), "guardian starts as initial owner");
        pool.setGuardian(GUARDIAN);
        vm.prank(GUARDIAN);
        pool.pauseRiskOperations();

        vm.expectRevert();
        vm.prank(GUARDIAN);
        pool.setPauses(false, false, false);
        vm.expectRevert();
        vm.prank(GUARDIAN);
        pool.setCaps(20_000_000 ether, 16_000_000 ether);
        vm.expectRevert();
        vm.prank(GUARDIAN);
        pool.transferOwnership(GUARDIAN);

        vm.expectRevert(PooledNUSDLendingPool.SupplyPaused.selector);
        vm.prank(SECOND_SUPPLIER);
        pool.supply(1 ether, SECOND_SUPPLIER);
        vm.expectRevert(PooledNUSDLendingPool.BorrowPaused.selector);
        vm.prank(ALICE);
        pool.borrow(1 ether, ALICE);
        vm.expectRevert(PooledNUSDLendingPool.CollateralWithdrawalPaused.selector);
        vm.prank(ALICE);
        pool.withdrawCollateral(address(wzklTC), 1, ALICE);

        ltcOracle.setPrice(70 ether);
        vm.prank(LIQUIDATOR);
        pool.liquidate(ALICE, address(wzklTC), 70_000 ether, 0, LIQUIDATOR);
        vm.prank(ALICE);
        pool.repay(type(uint256).max, ALICE);
        assertEq(pool.debtBalance(ALICE), 0, "repay remains open");

        ltcOracle.setReadReverts(true);
        uint256 collateralRemaining = pool.collateralBalance(ALICE, address(wzklTC));
        vm.prank(ALICE);
        pool.withdrawCollateral(address(wzklTC), collateralRemaining, ALICE);
        assertEq(pool.collateralBalance(ALICE, address(wzklTC)), 0, "debt-free exit bypasses guardian pause");

        uint256 supplierShares = pool.balanceOf(SUPPLIER);
        vm.prank(SUPPLIER);
        uint256 amountWithdrawn = pool.redeem(supplierShares, SUPPLIER);
        assertGt(amountWithdrawn, 0, "supplier exit remains open");
    }

    function testCollateralExhaustionRecognizesAndCanRecoverBadDebt() public {
        _seedLiquidity();
        vm.startPrank(ALICE);
        pool.depositCollateral(address(wzklTC), 1000 ether, ALICE);
        pool.borrow(70_000 ether, ALICE);
        vm.stopPrank();

        ltcOracle.setPrice(10 ether);
        vm.prank(LIQUIDATOR);
        pool.liquidate(ALICE, address(wzklTC), 70_000 ether, 0, LIQUIDATOR);

        uint256 badDebt = pool.badDebtNusdByAccount(ALICE);
        assertGt(badDebt, 0, "bad debt recorded");
        assertEq(pool.debtBalance(ALICE), 0, "active debt shares cleared");
        assertEq(pool.collateralBalance(ALICE, address(wzklTC)), 0, "collateral exhausted");

        vm.prank(LIQUIDATOR);
        pool.repayBadDebt(ALICE, badDebt);
        assertEq(pool.badDebtNusdByAccount(ALICE), 0, "bad debt recovered");
        assertEq(pool.totalBadDebtNusd(), 0, "global bad debt recovered");
    }

    function testProtocolInterestAbsorbsBadDebtFirstAndRecoveryRestoresItsClaim() public {
        _seedLiquidity();
        vm.startPrank(ALICE);
        pool.depositCollateral(address(wzklTC), 1000 ether, ALICE);
        pool.borrow(80_000 ether, ALICE);
        vm.stopPrank();

        vm.warp(block.timestamp + 365 days);
        pool.accrueInterest();
        uint256 protocolBeforeDefault = pool.accruedProtocolInterestNusd();
        assertApproxEqAbs(protocolBeforeDefault, 400 ether, 1, "protocol interest accrued before default");

        ltcOracle.setPrice(10 ether);
        vm.prank(LIQUIDATOR);
        pool.liquidate(ALICE, address(wzklTC), type(uint256).max, 0, LIQUIDATOR);

        assertEq(pool.accruedProtocolInterestNusd(), 0, "protocol claim is first loss");
        assertEq(
            pool.protocolInterestWrittenOffByAccount(ALICE), protocolBeforeDefault, "account tracks written-off claim"
        );
        uint256 supplierAssetsAfterDefault = pool.totalAssetsNusd();

        vm.prank(LIQUIDATOR);
        pool.repayBadDebt(ALICE, protocolBeforeDefault);
        assertEq(pool.accruedProtocolInterestNusd(), protocolBeforeDefault, "recovery restores protocol claim first");
        assertEq(pool.protocolInterestWrittenOffByAccount(ALICE), 0, "written-off claim restored");
        assertEq(pool.totalAssetsNusd(), supplierAssetsAfterDefault, "protocol-only recovery does not dilute suppliers");
    }

    function testUnresolvedBadDebtContinuesToConsumeBorrowCap() public {
        _seedLiquidity();
        pool.setCaps(10_000_000 ether, 70_000 ether);

        vm.startPrank(ALICE);
        pool.depositCollateral(address(wzklTC), 1000 ether, ALICE);
        pool.borrow(70_000 ether, ALICE);
        vm.stopPrank();

        ltcOracle.setPrice(10 ether);
        vm.prank(LIQUIDATOR);
        pool.liquidate(ALICE, address(wzklTC), 70_000 ether, 0, LIQUIDATOR);

        uint256 badDebt = pool.badDebtNusdByAccount(ALICE);
        assertGt(badDebt, 0, "bad debt recorded");
        assertEq(pool.totalBorrowed(), 0, "active debt written off");

        vm.expectRevert(PooledNUSDLendingPool.InvalidConfiguration.selector);
        pool.setCaps(10_000_000 ether, badDebt - 1);

        ltcOracle.setPrice(100 ether);
        wzklTC.mint(SECOND_SUPPLIER, 1000 ether);
        vm.startPrank(SECOND_SUPPLIER);
        wzklTC.approve(address(pool), type(uint256).max);
        pool.depositCollateral(address(wzklTC), 1000 ether, SECOND_SUPPLIER);
        vm.expectRevert(PooledNUSDLendingPool.BorrowCapExceeded.selector);
        pool.borrow(20_000 ether, SECOND_SUPPLIER);
        vm.stopPrank();

        vm.prank(LIQUIDATOR);
        pool.repayBadDebt(ALICE, badDebt);

        vm.prank(SECOND_SUPPLIER);
        pool.borrow(20_000 ether, SECOND_SUPPLIER);
        assertGe(pool.debtBalance(SECOND_SUPPLIER), 20_000 ether, "recovery restores cap headroom");
    }

    function testRejectsFeeOnTransferCollateral() public {
        MockFeeOnTransferToken feeToken = new MockFeeOnTransferToken();
        MockPriceOracle feeOracle = new MockPriceOracle(1 ether);
        pool.configureCollateral(address(feeToken), address(feeOracle), 1_000_000 ether, 5000, 6000, 7000, 500, true);
        feeToken.mint(ALICE, 100 ether);
        vm.prank(ALICE);
        feeToken.approve(address(pool), type(uint256).max);

        vm.expectRevert(PooledNUSDLendingPool.ExactTransferRequired.selector);
        vm.prank(ALICE);
        pool.depositCollateral(address(feeToken), 100 ether, ALICE);
    }

    function testDisabledCollateralCannotBackNewDebtButDebtFreeExitStaysOpen() public {
        _seedLiquidity();
        vm.prank(ALICE);
        pool.depositCollateral(address(wzklTC), 1000 ether, ALICE);
        pool.configureCollateral(address(wzklTC), address(ltcOracle), 1_000_000 ether, 8000, 8500, 9000, 500, false);

        vm.expectRevert(PooledNUSDLendingPool.InsufficientCollateral.selector);
        vm.prank(ALICE);
        pool.borrow(1 ether, ALICE);

        pool.setPauses(false, false, true);
        vm.prank(ALICE);
        pool.withdrawCollateral(address(wzklTC), 1000 ether, ALICE);
        assertEq(wzklTC.balanceOf(ALICE), 100_000 ether, "disabled collateral exit");
    }

    function testFuzzBorrowNeverStartsAboveConfiguredLtv(uint96 rawCollateral, uint96 rawBorrowSeed) public {
        _seedLiquidity();
        uint256 collateral = bound(rawCollateral, 1 ether, 10_000 ether);
        vm.prank(ALICE);
        pool.depositCollateral(address(wzklTC), collateral, ALICE);
        (uint256 borrowingCapacity,,) = pool.accountLiquidity(ALICE);
        uint256 borrowAmount = bound(rawBorrowSeed, 1, borrowingCapacity);

        vm.prank(ALICE);
        pool.borrow(borrowAmount, ALICE);
        (, uint256 liquidationCapacity, uint256 debt) = pool.accountLiquidity(ALICE);
        assertLe(debt, borrowingCapacity, "fuzz LTV");
        assertLe(debt, liquidationCapacity, "starts above liquidation threshold");
    }

    function _seedLiquidity() private {
        vm.prank(SUPPLIER);
        pool.supply(2_000_000 ether, SUPPLIER);
    }

    function _fundNusdAndApprove(address account, uint256 amount) private {
        nusd.mint(account, amount);
        vm.prank(account);
        nusd.approve(address(pool), type(uint256).max);
    }
}
