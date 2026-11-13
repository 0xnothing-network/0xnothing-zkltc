// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { SynthSafetyReserve } from "../../src/synth/SynthSafetyReserve.sol";
import { SyntheticAsset } from "../../src/synth/SyntheticAsset.sol";
import { SyntheticVault } from "../../src/synth/SyntheticVault.sol";
import { TestBase } from "../helpers/TestBase.sol";
import { FeeSplitterMock } from "../mocks/FeeSplitterMock.sol";
import { MockNUSD, MockPriceOracle } from "../mocks/RiskMocks.sol";

/// From the adversarial review of how the 2026-11 audit closed D-01, D-02 and D-06 (reserve
/// allocations paused at deployment). Same wiring as test/audit/SynthAudit.t.sol. One walk through every vault
/// path is run twice: with the Safety Reserve empty, and with 100,000 NUSD in it and the entry
/// delay over, so that only the pause stands between a mint and the reserve.
contract SynthPausedAuditTest is TestBase {
    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    address private constant CAROL = address(0xCA401);
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
        // The order of Deploy0xFiMainnet.s.sol: bind, then pause, before anything else can happen.
        reserve.bindVaults(address(vault), address(secondVault));
        reserve.setAllocationsPaused(true);
        nbtc.bindVault(address(vault));
        neth.bindVault(address(secondVault));

        address[3] memory users = [ALICE, BOB, CAROL];
        for (uint256 i; i < users.length; ++i) {
            nusd.mint(users[i], 1_000_000 ether);
            vm.prank(users[i]);
            nusd.approve(address(vault), type(uint256).max);
            vm.prank(users[i]);
            nbtc.approve(address(vault), type(uint256).max);
        }
    }

    function testAudit_D01_mitigation_everyPathWithAnEmptyReserve() public {
        assertFalse(reserve.sponsorshipActive(), "nothing to sponsor with");
        _walkEveryPath(0);
    }

    function testAudit_D01_mitigation_everyPathWithAFundedReserveReadyToSponsor() public {
        nusd.mint(address(this), 100_000 ether);
        nusd.approve(address(reserve), type(uint256).max);
        reserve.fund(100_000 ether);
        vm.warp(1_000_000 + reserve.ACTIVATION_DELAY());
        btcOracle.setPrice(100_000 ether);
        assertTrue(reserve.sponsorshipActive(), "sponsorship is active; only the pause is in the way");
        assertTrue(reserve.syncSponsorshipMode(), "and stays active after a sync by anyone");
        assertEq(reserve.freeReserveNusd(), 100_000 ether, "free reserve");

        // The pause is checked by the reserve itself, not only by the vault.
        vm.expectRevert(SynthSafetyReserve.UnauthorizedVault.selector);
        reserve.allocateToVault(1 ether);
        vm.prank(address(vault));
        vm.expectRevert(SynthSafetyReserve.AllocationsPaused.selector);
        reserve.allocateToVault(1 ether);

        _walkEveryPath(100_000 ether);
    }

    /// Every user-facing vault path, with exact numbers at BTC = 100,000 / 125,000 / 160,000.
    function _walkEveryPath(uint256 reserveNusd) private {
        // ---- quotes before any position
        (uint256 quoted, uint256 reserveRequired, bool oneToOne) = vault.quoteDepositAndMint(ALICE, 150_000 ether);
        assertEq(quoted, 1 ether, "150,000 NUSD quotes 1 nBTC");
        assertEq(reserveRequired, 0, "no reserve share quoted");
        assertFalse(oneToOne, "no 1:1 mode");
        (quoted,, oneToOne) = vault.quoteDepositAndMint(ALICE, 100_000 ether);
        assertEq(quoted, 666_666_666_666_666_666, "100,000 NUSD quotes 0.666 nBTC, not 1");
        assertFalse(oneToOne, "no 1:1 mode for a 100% deposit either");
        assertEq(vault.maxMintableSynthetic(ALICE), 0, "nothing mintable without collateral");

        // ---- depositAndMint: below 150%, at 100% (the sponsored shape), at exactly 150%
        vm.startPrank(ALICE);
        vm.expectRevert(SyntheticVault.InsufficientCollateral.selector);
        vault.depositAndMint(150_000 ether - 1, 1 ether, type(uint256).max, ALICE);
        vm.expectRevert(SyntheticVault.InsufficientCollateral.selector);
        vault.depositAndMint(100_000 ether, 1 ether, type(uint256).max, ALICE);
        vault.depositAndMint(150_000 ether, 1 ether, type(uint256).max, ALICE);
        vm.stopPrank();
        _assertPosition(ALICE, 150_000 ether, 1 ether);
        assertEq(nusd.balanceOf(ALICE), 1_000_000 ether - 150_100 ether, "collateral + 100 NUSD fee");
        _assertInvariants(reserveNusd);

        // ---- mint against existing collateral
        vm.startPrank(ALICE);
        vm.expectRevert(SyntheticVault.InsufficientCollateral.selector);
        vault.mint(1, type(uint256).max, ALICE);
        vault.depositCollateral(15_000 ether, ALICE);
        assertEq(vault.maxMintableSynthetic(ALICE), 0.1 ether, "15,000 more allows 0.1 nBTC more");
        vault.mint(0.1 ether, type(uint256).max, ALICE);
        vm.stopPrank();
        _assertPosition(ALICE, 165_000 ether, 1.1 ether);
        _assertInvariants(reserveNusd);

        // ---- withdrawCollateral and its view
        assertEq(vault.maxUserCollateralWithdrawable(ALICE), 0, "nothing spare at exactly 150%");
        vm.startPrank(ALICE);
        vault.depositCollateral(10_000 ether, ALICE);
        assertEq(vault.maxUserCollateralWithdrawable(ALICE), 10_000 ether, "the spare 10,000");
        vm.expectRevert(SyntheticVault.InsufficientCollateral.selector);
        vault.withdrawCollateral(10_000 ether + 1, ALICE);
        vault.withdrawCollateral(10_000 ether, ALICE);
        assertEq(vault.quoteCollateralForMint(0.1 ether), 15_000 ether, "0.1 nBTC more costs 15,000 of own collateral");
        vm.stopPrank();
        _assertPosition(ALICE, 165_000 ether, 1.1 ether);
        _assertInvariants(reserveNusd);

        // ---- repay, repayAndWithdraw
        vm.startPrank(ALICE);
        assertEq(vault.repay(0.1 ether, ALICE), 0.1 ether, "repaid");
        assertEq(vault.maxUserCollateralWithdrawable(ALICE), 15_000 ether, "15,000 freed");
        vm.expectRevert(SyntheticVault.InsufficientCollateral.selector);
        vault.repayAndWithdraw(0.5 ether, 90_000 ether + 1, ALICE);
        assertEq(vault.repayAndWithdraw(0.5 ether, 90_000 ether, ALICE), 0.5 ether, "repaid half");
        vm.stopPrank();
        _assertPosition(ALICE, 75_000 ether, 0.5 ether);
        _assertInvariants(reserveNusd);

        // ---- releaseExcessReserveCollateral by a stranger: nothing to release, at any price
        vm.prank(BOB);
        assertEq(vault.releaseExcessReserveCollateral(ALICE), 0, "no reserve share at 100k");

        // Bob (300%) and Carol (150%) open positions at 100k too.
        vm.prank(BOB);
        vault.depositAndMint(300_000 ether, 1 ether, type(uint256).max, BOB);
        vm.prank(CAROL);
        vault.depositAndMint(150_000 ether, 1 ether, type(uint256).max, CAROL);
        _assertInvariants(reserveNusd);

        // ---- liquidate without bad debt: BTC 125,000, Alice holds 75,000 against 0.5 nBTC (120%)
        btcOracle.setPrice(125_000 ether);
        vm.prank(BOB);
        assertEq(vault.releaseExcessReserveCollateral(ALICE), 0, "no reserve share at 125k");
        assertTrue(vault.isLiquidatable(ALICE), "under 125%");
        uint256 bobNusd = nusd.balanceOf(BOB);
        vm.startPrank(BOB);
        (uint256 repaid, uint256 collateralOut) = vault.liquidate(ALICE, type(uint256).max, 0, BOB);
        assertEq(repaid, 0.25 ether, "close factor");
        assertEq(collateralOut, 32_812.5 ether, "31,250 of debt + 5%");
        vm.expectRevert(SyntheticVault.PositionHealthy.selector);
        vault.liquidate(ALICE, type(uint256).max, 0, BOB);
        vm.stopPrank();
        assertEq(nusd.balanceOf(BOB) - bobNusd, 32_812.5 ether, "paid from the collateral Alice posted");
        _assertPosition(ALICE, 42_187.5 ether, 0.25 ether);
        _assertInvariants(reserveNusd);

        // ---- liquidate into bad debt: BTC 160,000, Carol holds 150,000 against 1 nBTC (93.75%)
        btcOracle.setPrice(160_000 ether);
        uint256 carolNusd = nusd.balanceOf(CAROL);
        uint256[4] memory expectedOut = [uint256(84_000 ether), 42_000 ether, 21_000 ether, 3000 ether];
        for (uint256 round; round < 4; ++round) {
            vm.prank(CAROL);
            (, collateralOut) = vault.liquidate(CAROL, type(uint256).max, 0, CAROL);
            assertEq(collateralOut, expectedOut[round], "collateral paid in this round");
            _assertInvariants(reserveNusd);
        }
        assertEq(nusd.balanceOf(CAROL) - carolNusd, 150_000 ether, "exactly the collateral she posted, no more");
        _assertPosition(CAROL, 0, 0);
        uint256 badDebt = vault.badDebtSyntheticByAccount(CAROL);
        assertApproxEqAbs(badDebt, 107_142_857_142_857_143, 1e6, "~0.107143 nBTC written off");
        assertEq(vault.totalBadDebtSynthetic(), badDebt, "total bad debt");
        assertEq(nbtc.balanceOf(CAROL), badDebt, "she still holds exactly that much nBTC");

        // An account with bad debt cannot mint again until it is covered.
        assertEq(vault.maxMintableSynthetic(CAROL), 0, "no mint capacity");
        (quoted,,) = vault.quoteDepositAndMint(CAROL, 150_000 ether);
        assertEq(quoted, 0, "no quote");
        vm.startPrank(CAROL);
        vm.expectRevert(SyntheticVault.AccountHasBadDebt.selector);
        vault.depositAndMint(300_000 ether, 0.1 ether, type(uint256).max, CAROL);
        assertEq(vault.coverBadDebt(CAROL, type(uint256).max), badDebt, "covered with her own nBTC");
        vm.stopPrank();
        assertEq(vault.totalBadDebtSynthetic(), 0, "bad debt gone");
        _assertInvariants(reserveNusd);

        // ---- full exit of a healthy position needs no oracle and no reserve
        // (Bob spent 0.25 nBTC liquidating Alice; she passes him 0.25 of the 0.5 she still holds.)
        vm.prank(ALICE);
        nbtc.transfer(BOB, 0.25 ether);
        btcOracle.setReadReverts(true);
        vm.startPrank(BOB);
        vault.repayAndWithdraw(1 ether, 300_000 ether, BOB);
        vm.stopPrank();
        btcOracle.setReadReverts(false);
        _assertPosition(BOB, 0, 0);
        _assertInvariants(reserveNusd);
    }

    function _assertPosition(address account, uint256 userCollateral, uint256 debt) private view {
        (uint256 user, uint256 reserveShare, uint256 accountDebt) = vault.positions(account);
        assertEq(user, userCollateral, "user collateral");
        assertEq(reserveShare, 0, "no reserve collateral in the position");
        assertEq(accountDebt, debt, "debt");
    }

    function _assertInvariants(uint256 reserveNusd) private view {
        assertEq(reserve.totalReserveNusd(), reserveNusd, "reserve total unchanged");
        assertEq(reserve.freeReserveNusd(), reserveNusd, "all of it still free");
        assertEq(reserve.totalAllocatedNusd(), 0, "nothing allocated");
        assertEq(reserve.allocatedNusdByVault(address(vault)), 0, "nothing allocated to the vault");
        assertEq(vault.totalReserveCollateralNusd(), 0, "vault holds no reserve collateral");
        assertEq(nusd.balanceOf(address(vault)), vault.totalUserCollateralNusd(), "vault NUSD = user collateral");
        assertEq(
            nbtc.totalSupply(),
            vault.totalDebtSynthetic() + vault.totalBadDebtSynthetic(),
            "nBTC supply = debt + bad debt"
        );
    }
}
