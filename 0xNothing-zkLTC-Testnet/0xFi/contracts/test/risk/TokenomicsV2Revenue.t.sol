// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { PooledNUSDLendingPoolV2 } from "../../src/lending/PooledNUSDLendingPoolV2.sol";
import { SynthSafetyReserve } from "../../src/synth/SynthSafetyReserve.sol";
import { SyntheticAsset } from "../../src/synth/SyntheticAsset.sol";
import { SyntheticVault } from "../../src/synth/SyntheticVault.sol";
import { TestBase } from "../helpers/TestBase.sol";
import { FeeSplitterMock } from "../mocks/FeeSplitterMock.sol";
import { MockCollateralToken, MockNUSD, MockPriceOracle } from "../mocks/RiskMocks.sol";

/// v2 revenue paths outside the router: lending protocol interest and synth mint fees both end in
/// the fee splitter, 50% reward pool / 50% treasury, with no owner withdrawal.
contract TokenomicsV2RevenueTest is TestBase {
    address private constant SUPPLIER = address(0x5150);
    address private constant ALICE = address(0xA11CE);
    address private constant POOL = address(0xB001);
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
        splitter = new FeeSplitterMock(address(nusd), POOL, TREASURY);
        lending = new PooledNUSDLendingPoolV2(
            address(nusd), address(splitter), address(this), 10_000_000 ether, 8_000_000 ether, true
        );
        lending.configureCollateral(address(wzkltc), address(ltcOracle), 1_000_000 ether, 8000, 8500, 9000, 500, true);

        nusd.mint(SUPPLIER, 3_000_000 ether);
        vm.prank(SUPPLIER);
        nusd.approve(address(lending), type(uint256).max);
        wzkltc.mint(ALICE, 100_000 ether);
        vm.prank(ALICE);
        wzkltc.approve(address(lending), type(uint256).max);
    }

    function testAnyoneSweepsProtocolInterestToTheSplitterWithoutTouchingSuppliers() public {
        vm.prank(SUPPLIER);
        lending.supply(2_000_000 ether, SUPPLIER);
        vm.startPrank(ALICE);
        lending.depositCollateral(address(wzkltc), 20_000 ether, ALICE);
        lending.borrow(1_000_000 ether, ALICE);
        vm.stopPrank();

        vm.warp(block.timestamp + 365 days);
        lending.accrueInterest();
        uint256 interest = lending.accruedProtocolInterestNusd();
        uint256 supplierAssets = lending.totalAssetsNusd();

        vm.prank(address(0xCAFE));
        uint256 swept = lending.sweepProtocolInterest();
        assertApproxEqAbs(swept, 5000 ether, 1, "0.5% protocol spread");
        assertEq(swept, interest, "everything accrued");
        assertEq(lending.accruedProtocolInterestNusd(), 0, "claim cleared");
        assertEq(lending.totalAssetsNusd(), supplierAssets, "suppliers unchanged");
        assertEq(nusd.balanceOf(POOL), swept / 2, "pool half");
        assertEq(nusd.balanceOf(TREASURY), swept - swept / 2, "treasury half");

        vm.expectRevert(PooledNUSDLendingPoolV2.ProtocolInterestExceeded.selector);
        lending.sweepProtocolInterest();
    }

    function testOwnerHasNoProtocolInterestWithdrawal() public {
        (bool ok,) = address(lending).call(
            abi.encodeWithSignature("withdrawProtocolInterest(uint256,address)", 1, address(this))
        );
        assertFalse(ok, "owner withdrawal still exists");
        assertEq(lending.feeSplitter(), address(splitter), "fixed destination");
    }

    function testLendingRejectsMissingSplitter() public {
        vm.expectRevert(PooledNUSDLendingPoolV2.InvalidConfiguration.selector);
        new PooledNUSDLendingPoolV2(address(nusd), address(0xDEAD), address(this), 1 ether, 1 ether, true);
    }

    function testStagedSynthVaultActivatesOnTheSplitterAndPaysItsMintFee() public {
        MockPriceOracle btcOracle = new MockPriceOracle(100_000 ether);
        MockPriceOracle ethOracle = new MockPriceOracle(2000 ether);
        SynthSafetyReserve reserve = new SynthSafetyReserve(address(nusd), address(this));
        SyntheticAsset nbtc = new SyntheticAsset("0xFi Synthetic Bitcoin", "nBTC", address(this));
        SyntheticAsset neth = new SyntheticAsset("0xFi Synthetic Ether", "nETH", address(this));
        SyntheticVault vault = new SyntheticVault(
            address(nusd), address(nbtc), address(btcOracle), address(reserve), address(splitter), address(this), 100 ether, false
        );
        SyntheticVault secondVault = new SyntheticVault(
            address(nusd), address(neth), address(ethOracle), address(reserve), address(splitter), address(this), 1000 ether, false
        );
        reserve.bindVaults(address(vault), address(secondVault));
        nbtc.bindVault(address(vault));
        neth.bindVault(address(secondVault));
        vault.activateRiskOperations();
        assertTrue(vault.activated(), "activated without a fee gauge");

        nusd.mint(ALICE, 200_000 ether);
        vm.prank(ALICE);
        nusd.approve(address(vault), type(uint256).max);
        uint256 fee = vault.quoteMintFee(1 ether);
        vm.prank(ALICE);
        vault.depositAndMint(150_000 ether, 1 ether, fee, ALICE);

        assertEq(nusd.balanceOf(POOL), fee / 2, "mint fee half to pool");
        assertEq(nusd.balanceOf(TREASURY), fee - fee / 2, "mint fee half to treasury");
        assertEq(nusd.balanceOf(address(vault)), 150_000 ether, "vault keeps only collateral");
    }
}
