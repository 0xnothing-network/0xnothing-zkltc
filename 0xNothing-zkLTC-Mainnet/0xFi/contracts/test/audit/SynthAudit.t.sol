// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { PooledNUSDLendingPoolV2 } from "../../src/lending/PooledNUSDLendingPoolV2.sol";
import { SynthSafetyReserve } from "../../src/synth/SynthSafetyReserve.sol";
import { SyntheticAsset } from "../../src/synth/SyntheticAsset.sol";
import { SyntheticVault } from "../../src/synth/SyntheticVault.sol";
import { TestBase } from "../helpers/TestBase.sol";
import { FeeSplitterMock } from "../mocks/FeeSplitterMock.sol";
import { MockNUSD, MockPriceOracle } from "../mocks/RiskMocks.sol";

/// Tests for findings D-01, D-02 and D-03 of the 2026-11 audit (docs/AUDIT_2026-11.md). They are
/// closed by how Deploy0xFiMainnet.s.sol deploys the contracts: the reserve's allocations are
/// paused and its ownership is given up, so nobody can switch them on again, and only WzkLTC is
/// listed in a lending pool that takes one collateral asset. The reproductions still pass on the
/// configuration that is exposed; the tests named "mitigation" show the deployed configuration
/// is not. Same wiring as test/risk/SyntheticVault.t.sol (vault, reserve, mock oracles) plus a
/// lending pool.
contract SynthAuditTest is TestBase {
    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    address private constant MALLORY = address(0xBAD);
    address private constant SUPPLIER = address(0x5150);
    address private constant STAKING = address(0xB001);
    address private constant TREASURY = address(0x7EA5);

    MockNUSD private nusd;
    MockPriceOracle private btcOracle;
    MockPriceOracle private ethOracle;
    SyntheticAsset private nbtc;
    SyntheticAsset private neth;
    SynthSafetyReserve private reserve;
    FeeSplitterMock private splitter;
    SyntheticVault private vault;
    SyntheticVault private secondVault;

    function setUp() public {
        vm.warp(1_000_000);
        nusd = new MockNUSD();
        btcOracle = new MockPriceOracle(100_000 ether);
        ethOracle = new MockPriceOracle(2000 ether);
        reserve = new SynthSafetyReserve(address(nusd), address(this));
        splitter = new FeeSplitterMock(address(nusd), STAKING, TREASURY);
        nbtc = new SyntheticAsset("0xFi Synthetic Bitcoin", "nBTC", address(this));
        neth = new SyntheticAsset("0xFi Synthetic Ether", "nETH", address(this));
        vault = new SyntheticVault(
            address(nusd),
            address(nbtc),
            address(btcOracle),
            address(reserve),
            address(splitter),
            address(this),
            100 ether,
            true
        );
        secondVault = new SyntheticVault(
            address(nusd),
            address(neth),
            address(ethOracle),
            address(reserve),
            address(splitter),
            address(this),
            1000 ether,
            true
        );
        reserve.bindVaults(address(vault), address(secondVault));
        nbtc.bindVault(address(vault));
        neth.bindVault(address(secondVault));

        nusd.mint(address(this), 500_000 ether);
        nusd.approve(address(reserve), type(uint256).max);
        address[3] memory users = [ALICE, BOB, MALLORY];
        for (uint256 i; i < users.length; ++i) {
            vm.prank(users[i]);
            nusd.approve(address(vault), type(uint256).max);
            vm.prank(users[i]);
            nbtc.approve(address(vault), type(uint256).max);
        }
        nusd.mint(ALICE, 1_000_000 ether);
        nusd.mint(BOB, 1_000_000 ether);
    }

    // D-01. A sponsored mint (user posts 100%, the Safety Reserve adds 50%) costs the minter only
    // the 0.1% mint fee, and on a large rise she liquidates her own position: user collateral goes
    // first, so she gets her own 100,000 back and then the reserve's 50,000.
    // Numbers: 1 nBTC minted at 100k with 100,000 NUSD; BTC at 160k; four self-liquidations pay
    // 84,000 + 42,000 + 21,000 + 3,000 = 150,000. Alice ends with 1,049,900 NUSD (started with
    // 1,000,000, paid 100 fee) and still holds ~0.107143 nBTC that is now vault bad debt; the
    // reserve falls from 100,000 to 50,000.
    function testAudit_D01_sponsoredMintSelfLiquidationTakesReserveTranche() public {
        _activateReserve();
        uint256 aliceStart = nusd.balanceOf(ALICE);
        assertEq(reserve.totalReserveNusd(), 100_000 ether, "reserve before");

        vm.prank(ALICE);
        vault.depositAndMint(100_000 ether, 1 ether, type(uint256).max, ALICE);
        (uint256 userCollateral, uint256 reserveCollateral,) = vault.positions(ALICE);
        assertEq(userCollateral, 100_000 ether, "alice tranche");
        assertEq(reserveCollateral, 50_000 ether, "reserve tranche");
        assertEq(nusd.balanceOf(ALICE), aliceStart - 100_100 ether, "collateral + 0.1% fee paid");

        btcOracle.setPrice(160_000 ether);

        uint256[4] memory expectedOut = [uint256(84_000 ether), 42_000 ether, 21_000 ether, 3000 ether];
        uint256 rounds;
        while (true) {
            (,, uint256 debt) = vault.positions(ALICE);
            if (debt == 0) break;
            vm.prank(ALICE);
            (, uint256 collateralOut) = vault.liquidate(ALICE, type(uint256).max, 0, ALICE);
            assertEq(collateralOut, expectedOut[rounds], "collateral paid in this round");
            rounds += 1;
        }
        assertEq(rounds, 4, "four self-liquidations empty the position");

        // Harmful outcome: Alice is up 49,900 NUSD and the reserve paid for it.
        assertEq(nusd.balanceOf(ALICE), aliceStart + 49_900 ether, "alice holds 1,049,900 NUSD");
        assertEq(reserve.totalReserveNusd(), 50_000 ether, "reserve lost its whole 50,000 tranche");
        assertEq(reserve.totalAllocatedNusd(), 0, "nothing left allocated");
        assertEq(nusd.balanceOf(address(vault)), 0, "vault holds no collateral");
        (userCollateral, reserveCollateral,) = vault.positions(ALICE);
        assertEq(userCollateral + reserveCollateral, 0, "position emptied");

        // She also keeps the nBTC she did not need for the liquidations; nothing backs it.
        uint256 leftover = nbtc.balanceOf(ALICE);
        assertApproxEqAbs(leftover, 107_142_857_142_857_143, 1e6, "~0.107143 nBTC left with alice");
        assertEq(vault.totalBadDebtSynthetic(), leftover, "leftover nBTC is exactly the vault bad debt");
        assertEq(vault.totalDebtSynthetic(), 0, "no active debt");
        assertEq(nbtc.totalSupply(), leftover, "all outstanding nBTC is unbacked");
        assertFalse(reserve.sponsorshipActive(), "reserve fell below the 90k exit level");
    }

    // D-01 and D-02 mitigation. Deploy0xFiMainnet.s.sol pauses reserve allocations, so no position
    // ever holds a reserve tranche: the 100% sponsored mint is refused, a self-backed 150% mint goes
    // through, and the same 60% rise followed by self-liquidation takes nothing from the reserve.
    function testAudit_D01_mitigation_pausedAllocationsLeaveNothingToTake() public {
        _activateReserve();
        reserve.setAllocationsPaused(true);
        uint256 aliceStart = nusd.balanceOf(ALICE);

        vm.prank(ALICE);
        vm.expectRevert(SyntheticVault.InsufficientCollateral.selector);
        vault.depositAndMint(100_000 ether, 1 ether, type(uint256).max, ALICE);

        vm.prank(ALICE);
        vault.depositAndMint(150_000 ether, 1 ether, type(uint256).max, ALICE);
        (uint256 userCollateral, uint256 reserveCollateral,) = vault.positions(ALICE);
        assertEq(userCollateral, 150_000 ether, "backed by the minter alone");
        assertEq(reserveCollateral, 0, "no reserve tranche");
        assertEq(reserve.totalAllocatedNusd(), 0, "nothing allocated");

        btcOracle.setPrice(160_000 ether);
        vm.prank(BOB);
        assertEq(vault.releaseExcessReserveCollateral(ALICE), 0, "a stranger has nothing to strip");
        while (true) {
            (,, uint256 debt) = vault.positions(ALICE);
            if (debt == 0) break;
            vm.prank(ALICE);
            vault.liquidate(ALICE, type(uint256).max, 0, ALICE);
        }
        assertEq(reserve.totalReserveNusd(), 100_000 ether, "the reserve is untouched");
        assertLe(nusd.balanceOf(ALICE), aliceStart, "she only got her own collateral back");
    }

    // D-02. Anyone can call releaseExcessReserveCollateral on another account's sponsored position
    // while the price is low. The reserve share is cut to what 150% needs at that low price and is
    // never restored, so the position becomes liquidatable on the rebound, below the mint price.
    // Numbers: Alice mints 1 nBTC at 100k (100,000 own + 50,000 reserve). At 80k Bob's call removes
    // 30,000 of reserve (150,000 -> 120,000). At 97k she needs 121,250 for 125%, so Bob liquidates
    // 0.5 nBTC (worth 48,500) for 50,925 NUSD of her collateral.
    function testAudit_D02_strangerStripsReserveAtDipThenLiquidatesOnRebound() public {
        _activateReserve();
        vm.prank(ALICE);
        vault.depositAndMint(100_000 ether, 1 ether, type(uint256).max, ALICE);
        // Bob gets his nBTC from an ordinary 300% position of his own.
        vm.prank(BOB);
        vault.depositAndMint(150_000 ether, 0.5 ether, type(uint256).max, BOB);

        btcOracle.setPrice(80_000 ether);
        assertFalse(vault.isLiquidatable(ALICE), "safe at the dip");
        vm.prank(BOB);
        uint256 released = vault.releaseExcessReserveCollateral(ALICE);
        assertEq(released, 30_000 ether, "stranger removed 30,000 of reserve backing");
        (uint256 userCollateral, uint256 reserveCollateral, uint256 debt) = vault.positions(ALICE);
        assertEq(userCollateral, 100_000 ether, "user tranche untouched");
        assertEq(reserveCollateral, 20_000 ether, "reserve tranche cut to 20,000");

        btcOracle.setPrice(97_000 ether);
        assertTrue(vault.isLiquidatable(ALICE), "liquidatable at 97k, below her 100k mint price");

        uint256 bobBefore = nusd.balanceOf(BOB);
        vm.prank(BOB);
        (uint256 repaid, uint256 collateralOut) = vault.liquidate(ALICE, type(uint256).max, 0, BOB);
        assertEq(repaid, 0.5 ether, "close factor");
        assertEq(collateralOut, 50_925 ether, "48,500 of debt value + 5% bonus");
        assertEq(nusd.balanceOf(BOB) - bobBefore, 50_925 ether, "bob received collateral from alice");

        (userCollateral, reserveCollateral, debt) = vault.positions(ALICE);
        assertEq(userCollateral, 49_075 ether, "alice lost 50,925 for 48,500 of debt: 2,425 penalty");
        assertEq(reserveCollateral, 20_000 ether, "reserve not touched by the liquidation");
        assertEq(debt, 0.5 ether, "remaining debt");
    }

    // D-02 control. Same price path (100k -> 80k -> 97k) without the release call: the position
    // still holds 150,000 against a 121,250 requirement and cannot be liquidated.
    function testAudit_D02_controlWithoutReleasePositionStaysSafe() public {
        _activateReserve();
        vm.prank(ALICE);
        vault.depositAndMint(100_000 ether, 1 ether, type(uint256).max, ALICE);
        vm.prank(BOB);
        vault.depositAndMint(150_000 ether, 0.5 ether, type(uint256).max, BOB);

        btcOracle.setPrice(80_000 ether);
        btcOracle.setPrice(97_000 ether);

        (, uint256 reserveCollateral,) = vault.positions(ALICE);
        assertEq(reserveCollateral, 50_000 ether, "reserve tranche intact");
        assertFalse(vault.isLiquidatable(ALICE), "not liquidatable at 97k");
        vm.prank(BOB);
        vm.expectRevert(SyntheticVault.PositionHealthy.selector);
        vault.liquidate(ALICE, type(uint256).max, 0, BOB);

        // Without the strip she is safe up to 120k (150,000 / 1.25).
        btcOracle.setPrice(120_000 ether);
        assertFalse(vault.isLiquidatable(ALICE), "still safe at 120k");
    }

    // D-03. After a large rise a minter liquidates herself, takes all collateral back and keeps
    // synth that the vault has written off as bad debt. The lending pool still prices that synth at
    // the feed price with 80% LTV, so she borrows NUSD against a token nothing backs.
    // Numbers, at the caps Deploy0xFiMainnet.s.sol sets (nBTC ceiling and lending cap 0.01 nBTC,
    // 8000/8500/9000/500, lending caps 5,000/2,500): mint 0.01 nBTC at 100k with 1,500 NUSD; at 200k
    // two self-liquidations return 1,050 + 450; ~0.00285714 nBTC is left as bad debt; the pool
    // values it at 571.43 and lends ~457.14 NUSD. Mallory ends ~456.14 NUSD up. Scales linearly
    // with the ceiling (1 nBTC -> 45,714 NUSD borrowed).
    function testAudit_D03_lendingAcceptsUnbackedSynthAtFeedPrice() public {
        vault.setDebtCeilingSynthetic(0.01 ether);
        PooledNUSDLendingPoolV2 lending =
            new PooledNUSDLendingPoolV2(address(nusd), address(splitter), address(this), 5000 ether, 2500 ether, true);
        lending.configureCollateral(address(nbtc), address(btcOracle), 0.01 ether, 8000, 8500, 9000, 500, true);
        nusd.mint(SUPPLIER, 5000 ether);
        vm.startPrank(SUPPLIER);
        nusd.approve(address(lending), type(uint256).max);
        lending.supply(5000 ether, SUPPLIER);
        vm.stopPrank();

        uint256 start = 10_000 ether;
        nusd.mint(MALLORY, start);
        vm.prank(MALLORY);
        vault.depositAndMint(1500 ether, 0.01 ether, type(uint256).max, MALLORY);
        assertEq(nusd.balanceOf(MALLORY), start - 1501 ether, "1,500 collateral + 1 NUSD fee");

        btcOracle.setPrice(200_000 ether);

        vm.prank(MALLORY);
        (, uint256 firstOut) = vault.liquidate(MALLORY, type(uint256).max, 0, MALLORY);
        vm.prank(MALLORY);
        (, uint256 secondOut) = vault.liquidate(MALLORY, type(uint256).max, 0, MALLORY);
        assertEq(firstOut, 1050 ether, "first self-liquidation");
        assertEq(secondOut, 450 ether, "second one exhausts the collateral");
        assertEq(nusd.balanceOf(MALLORY), start - 1 ether, "all collateral back; only the fee was spent");

        uint256 unbacked = nbtc.balanceOf(MALLORY);
        assertApproxEqAbs(unbacked, 2_857_142_857_142_858, 1e6, "~0.00285714 nBTC kept");
        assertEq(vault.totalBadDebtSynthetic(), unbacked, "recorded as vault bad debt");
        assertEq(vault.totalCollateralNusd(), 0, "vault holds no collateral at all");
        assertEq(vault.totalDebtSynthetic(), 0, "no active debt");
        assertEq(nbtc.totalSupply(), unbacked, "the whole nBTC supply is unbacked");

        vm.prank(MALLORY);
        nbtc.approve(address(lending), type(uint256).max);
        vm.prank(MALLORY);
        lending.depositCollateral(address(nbtc), unbacked, MALLORY);
        uint256 borrowable = lending.maxBorrow(MALLORY);
        vm.prank(MALLORY);
        lending.borrow(borrowable, MALLORY);

        assertGt(borrowable, 457 ether, "pool lends 80% of 571.43");
        assertLe(borrowable, 457.15 ether, "upper bound");
        assertGt(lending.debtBalance(MALLORY), 457 ether, "loan outstanding");
        assertFalse(lending.isLiquidatable(MALLORY), "the pool considers the loan healthy");
        assertGt(lending.healthFactor(MALLORY), 1 ether, "health factor above 1");
        assertGt(nusd.balanceOf(MALLORY), start + 456 ether, "mallory walks away ~456 NUSD up");
        assertEq(nusd.balanceOf(address(lending)), 5000 ether - borrowable, "taken from supplier NUSD");
    }

    // D-03 mitigation. Deploy0xFiMainnet.s.sol lists WzkLTC only, and a token the owner has not
    // listed cannot be deposited, so unbacked synth cannot reach the pool.
    function testAudit_D03_mitigation_unlistedSynthCannotBeDeposited() public {
        PooledNUSDLendingPoolV2 lending =
            new PooledNUSDLendingPoolV2(address(nusd), address(splitter), address(this), 5000 ether, 2500 ether, true);
        vm.prank(BOB);
        vault.depositAndMint(150_000 ether, 0.5 ether, type(uint256).max, BOB);
        vm.startPrank(BOB);
        nbtc.approve(address(lending), type(uint256).max);
        vm.expectRevert();
        lending.depositCollateral(address(nbtc), 0.5 ether, BOB);
        vm.stopPrank();
        assertEq(lending.collateralAssetCount(), 0, "nothing is listed until the owner lists it");
    }

    // D-03, closed in the pool since the second review: the pool takes one collateral asset. Once
    // the deployment has listed WzkLTC (nETH stands in for it here), not even the owner can list a
    // synthetic next to it.
    function testAudit_D03_aSynthCannotBeListedNextToTheDeployedCollateral() public {
        PooledNUSDLendingPoolV2 lending =
            new PooledNUSDLendingPoolV2(address(nusd), address(splitter), address(this), 5000 ether, 2500 ether, true);
        lending.configureCollateral(address(neth), address(ethOracle), 50 ether, 8000, 8500, 9000, 500, true);
        assertEq(lending.MAX_COLLATERAL_ASSETS(), 1, "one collateral asset per pool");

        vm.expectRevert(PooledNUSDLendingPoolV2.TooManyCollateralAssets.selector);
        lending.configureCollateral(address(nbtc), address(btcOracle), 0.01 ether, 8000, 8500, 9000, 500, true);
        assertEq(lending.collateralAssetCount(), 1, "still one");

        vm.prank(BOB);
        vault.depositAndMint(150_000 ether, 0.5 ether, type(uint256).max, BOB);
        vm.startPrank(BOB);
        nbtc.approve(address(lending), type(uint256).max);
        vm.expectRevert(PooledNUSDLendingPoolV2.UnsupportedCollateral.selector);
        lending.depositCollateral(address(nbtc), 0.5 ether, BOB);
        vm.stopPrank();
    }

    function _activateReserve() private {
        reserve.fund(100_000 ether);
        vm.warp(block.timestamp + reserve.ACTIVATION_DELAY());
        assertTrue(reserve.sponsorshipActive(), "sponsorship active");
    }
}
