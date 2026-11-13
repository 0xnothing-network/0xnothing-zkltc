// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { PooledNUSDLendingPoolV2 } from "../../src/lending/PooledNUSDLendingPoolV2.sol";
import { DIAOracleV2Adapter } from "../../src/oracle/DIAOracleV2Adapter.sol";
import { TestBase } from "../helpers/TestBase.sol";
import { FeeSplitterMock } from "../mocks/FeeSplitterMock.sol";
import { MockCollateralToken, MockDIAAggregatorV3, MockNUSD, MockPriceOracle } from "../mocks/RiskMocks.sol";

/// Tests for findings D-04, D-05 (variant B) and D-09 of the 2026-11 audit (docs/AUDIT_2026-11.md).
/// D-04 is closed in the pool since the second review; D-05 and D-09 are accepted and reproduced.
/// Same wiring as test/risk/TokenomicsRevenue.t.sol.
contract LendingAuditTest is TestBase {
    address private constant SUPPLIER = address(0x5150);
    address private constant ALICE = address(0xA11CE);
    address private constant CAROL = address(0xCA201);
    address private constant EVE = address(0xE5E);
    address private constant LIQUIDATOR = address(0xB0B0);
    address private constant PAYER = address(0x9A1E2);
    address private constant STAKING = address(0xB001);
    address private constant TREASURY = address(0x7EA5);

    MockNUSD private nusd;
    MockCollateralToken private wzkltc;
    MockPriceOracle private ltcOracle;
    FeeSplitterMock private splitter;
    PooledNUSDLendingPoolV2 private lending;

    function setUp() public {
        vm.warp(1_000_000);
        nusd = new MockNUSD();
        wzkltc = new MockCollateralToken("Wrapped zkLTC", "WzkLTC", 18);
        ltcOracle = new MockPriceOracle(100 ether);
        splitter = new FeeSplitterMock(address(nusd), STAKING, TREASURY);
        lending = new PooledNUSDLendingPoolV2(
            address(nusd), address(splitter), address(this), 10_000_000 ether, 8_000_000 ether, true
        );
        lending.configureCollateral(address(wzkltc), address(ltcOracle), 1_000_000 ether, 8000, 8500, 9000, 500, true);

        address[5] memory nusdHolders = [SUPPLIER, EVE, LIQUIDATOR, PAYER, ALICE];
        for (uint256 i; i < nusdHolders.length; ++i) {
            nusd.mint(nusdHolders[i], 3_000_000 ether);
            vm.prank(nusdHolders[i]);
            nusd.approve(address(lending), type(uint256).max);
        }
        address[2] memory borrowers = [ALICE, CAROL];
        for (uint256 i; i < borrowers.length; ++i) {
            wzkltc.mint(borrowers[i], 100_000 ether);
            vm.prank(borrowers[i]);
            wzkltc.approve(address(lending), type(uint256).max);
        }
    }

    // D-04. liquidate() reads the oracle of every collateral asset the account holds, so one feed
    // that is stale blocked liquidation of the whole account even when the asset being seized had a
    // fresh price. As audited a borrower arranged this with 1 wei of a second collateral: Alice
    // posted 20 WzkLTC and 1 wei of nETH and borrowed 1,600; 91 minutes later LTC was 85 (limit
    // 1,530 < debt) and the ETH feed had not updated, so both liquidations of Alice reverted
    // StaleOraclePrice while Carol, with the same position and no dust, was liquidated.
    // Since the second review the pool takes one collateral asset. The second one cannot be listed
    // or deposited, so the liquidation of an account reads one feed.
    function testAudit_D04_aSecondCollateralAssetCannotBeListed() public {
        assertEq(lending.MAX_COLLATERAL_ASSETS(), 1, "one collateral asset per pool");
        MockCollateralToken neth = new MockCollateralToken("0xFi Synthetic Ether", "nETH", 18);
        MockDIAAggregatorV3 ethFeed = new MockDIAAggregatorV3(8, "ETH/USD Oracle");
        ethFeed.setRound(1, 2000e8, block.timestamp, 1);
        DIAOracleV2Adapter ethOracle =
            new DIAOracleV2Adapter(address(ethFeed), "ETH/USD Oracle", 90 minutes, 1 ether, 1_000_000 ether);

        vm.expectRevert(PooledNUSDLendingPoolV2.TooManyCollateralAssets.selector);
        lending.configureCollateral(address(neth), address(ethOracle), 1000 ether, 8000, 8500, 9000, 500, true);
        assertEq(lending.collateralAssetCount(), 1, "still one");
        assertEq(lending.collateralAssetAt(0), address(wzkltc), "the one the deployment listed");

        neth.mint(ALICE, 1);
        vm.startPrank(ALICE);
        neth.approve(address(lending), 1);
        vm.expectRevert(PooledNUSDLendingPoolV2.UnsupportedCollateral.selector);
        lending.depositCollateral(address(neth), 1, ALICE);
        vm.stopPrank();

        // The listed asset can still be re-configured by the owner.
        lending.configureCollateral(address(wzkltc), address(ltcOracle), 2_000_000 ether, 8000, 8500, 9000, 500, true);
        assertEq(lending.collateralAssetCount(), 1, "re-configuring adds nothing");

        // The position of the finding is liquidated on the one feed it depends on.
        vm.prank(SUPPLIER);
        lending.supply(100_000 ether, SUPPLIER);
        vm.startPrank(ALICE);
        lending.depositCollateral(address(wzkltc), 20 ether, ALICE);
        lending.borrow(1600 ether, ALICE);
        vm.stopPrank();
        vm.warp(block.timestamp + 91 minutes);
        ltcOracle.setPrice(85 ether);
        assertTrue(lending.isLiquidatable(ALICE), "liquidatable as soon as LTC falls");
        vm.prank(LIQUIDATOR);
        (uint256 repaid, uint256 collateralOut) =
            lending.liquidate(ALICE, address(wzkltc), type(uint256).max, 0, LIQUIDATOR);
        assertGt(repaid, 800 ether, "half of her debt repaid");
        assertGt(collateralOut, 9.88 ether, "liquidator got ~9.88 WzkLTC");
    }

    // D-05 (variant B). repayBadDebt adds cash to the pool in one step, so the share price jumps.
    // Whoever supplies just before the repayment takes most of a recovery that was meant for the
    // suppliers who carried the loss.
    // Numbers: SUPPLIER supplies 1,000; Alice borrows 800 against 10 WzkLTC at 100; LTC drops to
    // 50; two liquidations repay 400 + 76.19 and leave 323.81 of bad debt (pool assets 676.19).
    // Eve supplies 4,000, the bad debt is repaid in full, Eve redeems 4,276.99: she captures
    // 276.99 of the 323.81 (85.5%) and SUPPLIER is left with 723.01 instead of 1,000.
    function testAudit_D05_supplyBeforeRepayBadDebtCapturesRecovery() public {
        vm.prank(SUPPLIER);
        lending.supply(1000 ether, SUPPLIER);
        vm.startPrank(ALICE);
        lending.depositCollateral(address(wzkltc), 10 ether, ALICE);
        lending.borrow(800 ether, ALICE);
        vm.stopPrank();

        ltcOracle.setPrice(50 ether);
        vm.startPrank(LIQUIDATOR);
        lending.liquidate(ALICE, address(wzkltc), type(uint256).max, 0, LIQUIDATOR);
        lending.liquidate(ALICE, address(wzkltc), type(uint256).max, 0, LIQUIDATOR);
        vm.stopPrank();

        uint256 badDebt = lending.badDebtNusdByAccount(ALICE);
        assertApproxEqAbs(badDebt, 323.809523809523809523 ether, 1e6, "323.81 of bad debt recognised");
        assertEq(lending.totalBadDebtNusd(), badDebt, "pool bad debt");
        assertApproxEqAbs(lending.supplyBalance(SUPPLIER), 676.190476190476190476 ether, 1e6, "supplier took the loss");

        // Eve front-runs the repayment.
        uint256 eveBefore = nusd.balanceOf(EVE);
        vm.prank(EVE);
        uint256 eveShares = lending.supply(4000 ether, EVE);

        vm.prank(PAYER);
        uint256 repaid = lending.repayBadDebt(ALICE, type(uint256).max);
        assertEq(repaid, badDebt, "treasury repaid the whole bad debt");
        assertEq(lending.totalBadDebtNusd(), 0, "bad debt cleared");

        vm.prank(EVE);
        lending.redeem(eveShares, EVE);
        uint256 eveProfit = nusd.balanceOf(EVE) - eveBefore;

        assertApproxEqAbs(eveProfit, 276.99 ether, 0.01 ether, "eve took 276.99 in one block");
        assertGt(eveProfit * 100, badDebt * 85, "more than 85% of the recovery went to eve");
        uint256 supplierAfter = lending.supplyBalance(SUPPLIER);
        assertApproxEqAbs(supplierAfter, 723.01 ether, 0.01 ether, "supplier recovered only 46.82");
        assertApproxEqAbs(supplierAfter + eveProfit, 1000 ether, 1e6, "eve's profit is the supplier's missing recovery");
    }

    // D-09. The owner sets the oracle of the collateral with no delay, so one owner key drains
    // every supplied NUSD against collateral worth next to nothing (the borrow cap is owner-set
    // too). As audited the owner could also list any new token; the pool now takes one collateral
    // asset, so that way is closed and the oracle of the listed asset is what is left.
    // Numbers, pool built with the Deploy0xFiMainnet.s.sol caps (supply 5,000 / borrow 2,500):
    // SUPPLIER supplies 5,000; the owner points WzkLTC at an oracle answering 1e30 NUSD, deposits
    // 1 WzkLTC, raises the borrow cap to 5,000 and borrows 5,000. Pool cash is 0, the supplier
    // cannot withdraw 1 NUSD, and the pool reports the loan as healthy.
    function testAudit_D09_ownerRepointsTheOracleAndDrainsSuppliers() public {
        PooledNUSDLendingPoolV2 pool =
            new PooledNUSDLendingPoolV2(address(nusd), address(splitter), address(this), 5000 ether, 2500 ether, true);
        pool.configureCollateral(address(wzkltc), address(ltcOracle), 50 ether, 8000, 8500, 9000, 500, true);
        vm.startPrank(SUPPLIER);
        nusd.approve(address(pool), type(uint256).max);
        pool.supply(5000 ether, SUPPLIER);
        vm.stopPrank();

        // Everything below is sent by the owner (this contract); no timelock, no second party.
        MockCollateralToken fake = new MockCollateralToken("Fake", "FAKE", 18);
        MockPriceOracle fakeOracle = new MockPriceOracle(1e30 ether);
        vm.expectRevert(PooledNUSDLendingPoolV2.TooManyCollateralAssets.selector);
        pool.configureCollateral(address(fake), address(fakeOracle), type(uint256).max, 8000, 8500, 9000, 500, true);
        pool.configureCollateral(address(wzkltc), address(fakeOracle), 50 ether, 8000, 8500, 9000, 500, true);
        wzkltc.mint(address(this), 1 ether);
        wzkltc.approve(address(pool), 1 ether);
        pool.depositCollateral(address(wzkltc), 1 ether, address(this));

        // The only brake is the borrow cap, and the owner sets that as well.
        vm.expectRevert(PooledNUSDLendingPoolV2.BorrowCapExceeded.selector);
        pool.borrow(5000 ether, address(this));
        pool.setCaps(5000 ether, 5000 ether);

        uint256 ownerBefore = nusd.balanceOf(address(this));
        pool.borrow(pool.availableLiquidity(), address(this));

        assertEq(nusd.balanceOf(address(this)) - ownerBefore, 5000 ether, "owner took all supplied NUSD");
        assertEq(pool.availableLiquidity(), 0, "pool has no cash");
        assertFalse(pool.isLiquidatable(address(this)), "the loan looks healthy to the pool");
        assertEq(pool.supplyBalance(SUPPLIER), 5000 ether - 1000, "supplier still shown a full balance");
        vm.prank(SUPPLIER);
        vm.expectRevert(PooledNUSDLendingPoolV2.InsufficientLiquidity.selector);
        pool.withdraw(1 ether, SUPPLIER);
    }

    /// R4-F-04 (review of the fourth pass). The owner could hold collateral withdrawals while
    /// borrowing stayed open, and setPauses is the only way to lift pauses, so a reopening in
    /// stages (borrowing first, collateral later) landed exactly there. As reviewed, a borrower
    /// then repaid everything, took 87.4 of 100 WzkLTC out and borrowed the same amount again, at
    /// no cost. That combination is refused; the guardian's pause sets all three, as before.
    function testAudit_R4F04_collateralIsNeverHeldWhileBorrowingIsOpen() public {
        PooledNUSDLendingPoolV2 pool =
            new PooledNUSDLendingPoolV2(address(nusd), address(splitter), address(this), 5000 ether, 2500 ether, true);
        pool.setGuardian(EVE);

        vm.expectRevert(PooledNUSDLendingPoolV2.InvalidConfiguration.selector);
        pool.setPauses(false, false, true);
        vm.expectRevert(PooledNUSDLendingPoolV2.InvalidConfiguration.selector);
        pool.setPauses(true, false, true);
        assertFalse(pool.collateralWithdrawalPaused(), "nothing changed");

        // The same from the state a staged reopening starts in: everything paused by the guardian.
        vm.prank(EVE);
        pool.pauseRiskOperations();
        assertTrue(pool.supplyPaused() && pool.borrowPaused() && pool.collateralWithdrawalPaused(), "all three");
        vm.expectRevert(PooledNUSDLendingPoolV2.InvalidConfiguration.selector);
        pool.setPauses(false, false, true);
        vm.expectRevert(PooledNUSDLendingPoolV2.InvalidConfiguration.selector);
        pool.setPauses(true, false, true);
        assertTrue(pool.supplyPaused() && pool.borrowPaused() && pool.collateralWithdrawalPaused(), "still all three");

        // Every other combination stays available, so a reopening can still be staged: supply
        // first, then collateral, then borrowing.
        pool.setPauses(false, true, true);
        assertTrue(!pool.supplyPaused() && pool.borrowPaused() && pool.collateralWithdrawalPaused(), "supply open");
        pool.setPauses(false, true, false);
        assertTrue(pool.borrowPaused() && !pool.collateralWithdrawalPaused(), "collateral free, no borrowing yet");
        pool.setPauses(true, true, false);
        pool.setPauses(true, false, false);
        pool.setPauses(false, false, false);
        assertTrue(!pool.supplyPaused() && !pool.borrowPaused() && !pool.collateralWithdrawalPaused(), "open again");
    }
}
