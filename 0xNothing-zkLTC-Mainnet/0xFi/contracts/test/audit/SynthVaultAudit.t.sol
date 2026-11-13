// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { SynthSafetyReserve } from "../../src/synth/SynthSafetyReserve.sol";
import { SyntheticAsset } from "../../src/synth/SyntheticAsset.sol";
import { SyntheticVault } from "../../src/synth/SyntheticVault.sol";
import { TestBase } from "../helpers/TestBase.sol";
import { FeeSplitterMock } from "../mocks/FeeSplitterMock.sol";
import { MockNUSD, MockPriceOracle } from "../mocks/RiskMocks.sol";

/// Tests for the two changes the second review of the 2026-11 audit made to the synth vault
/// (docs/AUDIT_2026-11.md, R2-L-01 and R2-L-03). The vault is deployed as Deploy0xFiMainnet.s.sol
/// deploys the nBTC vault: debt ceiling 0.01 nBTC, reserve allocations paused. Same wiring as
/// test/audit/SynthPausedAudit.t.sol.
contract SynthVaultAuditTest is TestBase {
    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    address private constant GUARDIAN = address(0x6A2D);
    address private constant STAKING = address(0xB001);
    address private constant TREASURY = address(0x7EA5);

    MockNUSD private nusd;
    MockPriceOracle private btcOracle;
    SyntheticAsset private nbtc;
    SyntheticVault private vault;

    function setUp() public {
        vm.warp(1_000_000);
        nusd = new MockNUSD();
        btcOracle = new MockPriceOracle(100_000 ether);
        MockPriceOracle ethOracle = new MockPriceOracle(2000 ether);
        SynthSafetyReserve reserve = new SynthSafetyReserve(address(nusd), address(this));
        FeeSplitterMock splitter = new FeeSplitterMock(address(nusd), STAKING, TREASURY);
        nbtc = new SyntheticAsset("0xFi Synthetic Bitcoin", "nBTC", address(this));
        SyntheticAsset neth = new SyntheticAsset("0xFi Synthetic Ether", "nETH", address(this));
        vault = new SyntheticVault(
            address(nusd),
            address(nbtc),
            address(btcOracle),
            address(reserve),
            address(splitter),
            address(this),
            0.01 ether,
            true
        );
        SyntheticVault secondVault = new SyntheticVault(
            address(nusd),
            address(neth),
            address(ethOracle),
            address(reserve),
            address(splitter),
            address(this),
            0.25 ether,
            true
        );
        reserve.bindVaults(address(vault), address(secondVault));
        reserve.setAllocationsPaused(true);
        nbtc.bindVault(address(vault));
        neth.bindVault(address(secondVault));
        vault.setGuardian(GUARDIAN);

        address[2] memory users = [ALICE, BOB];
        for (uint256 i; i < users.length; ++i) {
            nusd.mint(users[i], 1_000_000 ether);
            vm.prank(users[i]);
            nusd.approve(address(vault), type(uint256).max);
            vm.prank(users[i]);
            nbtc.approve(address(vault), type(uint256).max);
        }
    }

    /// R2-L-01. A liquidation quote rounded the repayment that the remaining collateral can pay
    /// for down to zero once that collateral was worth less than one unit of the synthetic, and
    /// then reverted. A liquidator who stopped just short of emptying an underwater position could
    /// leave dust that no later liquidation could take: the debt behind it was never written off,
    /// the account was never flagged, and coverBadDebt did not apply. One unit of the synthetic
    /// now takes the dust, and the write-off follows.
    /// Numbers: the whole ceiling in one position, 0.01 nBTC on 1,500 NUSD at 100,000, then BTC at
    /// 160,000.5.
    function testAudit_R2L01_dustCollateralNoLongerParksBadDebt() public {
        vm.prank(ALICE);
        vault.depositAndMint(1500 ether, 0.01 ether, type(uint256).max, ALICE);
        btcOracle.setPrice(160_000.5 ether);

        vm.startPrank(ALICE);
        for (uint256 round; round < 3; ++round) {
            vault.liquidate(ALICE, type(uint256).max, 0, ALICE);
        }
        (uint256 user,, uint256 debt) = vault.positions(ALICE);
        assertEq(user, 29.99540625 ether, "collateral after three rounds of self-liquidation");
        assertEq(debt, 0.00125 ether, "debt after three rounds");

        // 152,277 wei more collateral and one unit less than the limit leave 168,000 wei behind.
        vault.depositCollateral(152_277, ALICE);
        vault.liquidate(ALICE, 178_543_526_872_907, 0, ALICE);
        nbtc.transfer(BOB, 1_071_456_473_127_093);
        vm.stopPrank();
        (user,, debt) = vault.positions(ALICE);
        assertEq(user, 168_000, "168,000 wei of NUSD left as collateral");
        assertEq(debt, 1_071_456_473_127_093, "about 0.00107 nBTC of debt behind it");
        assertEq(vault.totalBadDebtSynthetic(), 0, "nothing written off yet");
        assertTrue(vault.isLiquidatable(ALICE), "and the position is liquidatable");

        // As reviewed, every liquidation from here on reverted with InsufficientCollateral, at this
        // price and at any higher one.
        btcOracle.setPrice(1_000_000 ether);
        uint256 bobNusd = nusd.balanceOf(BOB);
        vm.prank(BOB);
        (uint256 repaid, uint256 collateralOut) = vault.liquidate(ALICE, type(uint256).max, 0, BOB);
        assertEq(repaid, 1, "one unit of nBTC");
        assertEq(collateralOut, 168_000, "takes the dust");
        assertEq(nusd.balanceOf(BOB) - bobNusd, 168_000, "paid to the liquidator");

        (user,, debt) = vault.positions(ALICE);
        assertEq(user + debt, 0, "the position is closed");
        assertEq(vault.totalDebtSynthetic(), 0, "no active debt");
        assertEq(vault.totalBadDebtSynthetic(), 1_071_456_473_127_092, "the rest of the debt is written off");
        assertEq(vault.badDebtSyntheticByAccount(ALICE), 1_071_456_473_127_092, "against the account");
        assertEq(nbtc.totalSupply(), vault.totalBadDebtSynthetic(), "nBTC supply = debt + bad debt");
        assertEq(nusd.balanceOf(address(vault)), vault.totalUserCollateralNusd(), "vault NUSD = user collateral");

        vm.prank(BOB);
        assertEq(vault.coverBadDebt(ALICE, type(uint256).max), 1_071_456_473_127_092, "which can now be covered");
        assertEq(vault.totalBadDebtSynthetic(), 0, "covered");
        assertEq(nbtc.totalSupply(), 0, "and no nBTC is left unbacked");
    }

    /// R2-L-03. The withdrawal pause held every account, also those that owed nothing, until the
    /// owner lifted it: one call by the pause-only guardian froze all collateral in the vault,
    /// while deposits stayed open into a vault nobody could leave. The pause now holds only
    /// collateral that still backs debt, as the lending pool's pause does.
    function testAudit_R2L03_theWithdrawalPauseHoldsOnlyAccountsWithDebt() public {
        vm.prank(ALICE);
        vault.depositAndMint(1500 ether, 0.005 ether, type(uint256).max, ALICE);
        vm.prank(BOB);
        vault.depositCollateral(100 ether, BOB);

        vm.prank(GUARDIAN);
        vault.pauseWithdrawals();

        // With debt: held, whatever the ratio, and a partial repayment does not open it.
        vm.startPrank(ALICE);
        vm.expectRevert(SyntheticVault.WithdrawPaused.selector);
        vault.withdrawCollateral(1 ether, ALICE);
        vm.expectRevert(SyntheticVault.WithdrawPaused.selector);
        vault.repayAndWithdraw(0.001 ether, 1 ether, ALICE);
        vm.stopPrank();
        (uint256 user,, uint256 debt) = vault.positions(ALICE);
        assertEq(user, 1500 ether, "her collateral is where it was");
        assertEq(debt, 0.005 ether, "and so is her debt");

        // Without debt: out, also for money put in during the pause.
        vm.startPrank(BOB);
        vault.depositCollateral(50 ether, BOB);
        vault.withdrawCollateral(150 ether, BOB);
        vm.stopPrank();
        assertEq(nusd.balanceOf(BOB), 1_000_000 ether, "Bob has everything back");

        // Repaying everything and leaving is one call and needs no oracle.
        btcOracle.setReadReverts(true);
        vm.prank(ALICE);
        vault.repayAndWithdraw(type(uint256).max, 1500 ether, ALICE);
        (user,, debt) = vault.positions(ALICE);
        assertEq(user + debt, 0, "Alice is out");
        assertEq(nusd.balanceOf(address(vault)), 0, "the vault is empty");
        assertTrue(vault.withdrawPaused(), "while the pause still stands");

        // The guardian can pause and nothing else; the owner lifts it.
        vm.prank(GUARDIAN);
        vm.expectRevert();
        vault.setWithdrawPaused(false);
        vault.setWithdrawPaused(false);
        assertFalse(vault.withdrawPaused(), "lifted by the owner");
    }

    /// R3-F-01 (third review). After R2-L-03 the withdrawal pause alone no longer held collateral
    /// behind debt while minting stayed open. As reviewed, Alice with 3,000 NUSD behind 0.01 nBTC
    /// repaid everything, withdrew everything and minted the same 0.01 nBTC again on 1,500 NUSD:
    /// 1,500 NUSD left the vault during the pause with the debt unchanged, for 1 NUSD of mint fee.
    /// No debt is opened while withdrawals are held, so collateral behind debt can only grow.
    function testAudit_R3F01_noDebtIsOpenedWhileWithdrawalsAreHeld() public {
        vm.prank(ALICE);
        vault.depositAndMint(3000 ether, 0.004 ether, type(uint256).max, ALICE);
        vm.prank(GUARDIAN);
        vault.pauseWithdrawals();
        assertFalse(vault.mintPaused(), "the guardian sent the withdrawal pause alone");

        // An account that still owes cannot raise its debt, on the collateral it has or on more.
        vm.startPrank(ALICE);
        vm.expectRevert(SyntheticVault.MintPaused.selector);
        vault.mint(0.001 ether, type(uint256).max, ALICE);
        vm.expectRevert(SyntheticVault.MintPaused.selector);
        vault.depositAndMint(500 ether, 0.001 ether, type(uint256).max, ALICE);
        (uint256 user,, uint256 debt) = vault.positions(ALICE);
        assertEq(user, 3000 ether, "her collateral is held");
        assertEq(debt, 0.004 ether, "and her debt is what it was");

        // Leaving with no debt is still open, as R2-L-03 intends ...
        vault.repayAndWithdraw(type(uint256).max, 3000 ether, ALICE);
        // ... but the same debt cannot come back on less collateral,
        vm.expectRevert(SyntheticVault.MintPaused.selector);
        vault.depositAndMint(600 ether, 0.004 ether, type(uint256).max, ALICE);
        vm.stopPrank();
        // and nobody else can open debt either, in one step or in two.
        vm.startPrank(BOB);
        vm.expectRevert(SyntheticVault.MintPaused.selector);
        vault.depositAndMint(1500 ether, 0.005 ether, type(uint256).max, BOB);
        vault.depositCollateral(1500 ether, BOB);
        vm.expectRevert(SyntheticVault.MintPaused.selector);
        vault.mint(0.005 ether, type(uint256).max, BOB);
        vault.withdrawCollateral(1500 ether, BOB);
        vm.stopPrank();
        assertEq(vault.totalDebtSynthetic(), 0, "no debt in the vault");
        assertEq(nusd.balanceOf(address(vault)), 0, "and none of the collateral that left was behind debt");

        // One switch lifts it; a mint pause that was set on its own stays until it is lifted too.
        vault.pauseMinting();
        vault.setWithdrawPaused(false);
        vm.prank(ALICE);
        vm.expectRevert(SyntheticVault.MintPaused.selector);
        vault.depositAndMint(1500 ether, 0.01 ether, type(uint256).max, ALICE);
        vault.setMintPaused(false);
        vm.prank(ALICE);
        vault.depositAndMint(1500 ether, 0.01 ether, type(uint256).max, ALICE);
        assertEq(vault.totalDebtSynthetic(), 0.01 ether, "minting is open again");
    }
}
