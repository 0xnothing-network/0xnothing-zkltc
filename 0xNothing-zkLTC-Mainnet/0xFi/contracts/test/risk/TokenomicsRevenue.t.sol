// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { PooledNLendingPoolV2 } from "../../src/lending/PooledNLendingPoolV2.sol";
import { SynthSafetyReserve } from "../../src/synth/SynthSafetyReserve.sol";
import { SyntheticAsset } from "../../src/synth/SyntheticAsset.sol";
import { SyntheticVault } from "../../src/synth/SyntheticVault.sol";
import { TestBase } from "../helpers/TestBase.sol";
import { FeeSplitterMock } from "../mocks/FeeSplitterMock.sol";
import { MockCollateralToken, MockN, MockPriceOracle } from "../mocks/RiskMocks.sol";

/// Revenue paths outside the router: lending protocol interest and synth mint fees both end in the
/// fee splitter (70% stakers / 20% burned / 10% treasury), with no owner withdrawal.
contract TokenomicsRevenueTest is TestBase {
    address private constant SUPPLIER = address(0x5150);
    address private constant ALICE = address(0xA11CE);
    address private constant POOL = address(0xB001);
    address private constant TREASURY = address(0x7EA5);

    MockN private n;
    MockCollateralToken private wzkltc;
    MockPriceOracle private ltcOracle;
    FeeSplitterMock private splitter;
    PooledNLendingPoolV2 private lending;

    function setUp() public {
        vm.warp(1_000_000);
        n = new MockN();
        wzkltc = new MockCollateralToken("Wrapped zkLTC", "WzkLTC", 18);
        ltcOracle = new MockPriceOracle(100 ether);
        splitter = new FeeSplitterMock(address(n), POOL, TREASURY);
        lending = new PooledNLendingPoolV2(
            address(n), address(splitter), address(this), 10_000_000 ether, 8_000_000 ether, true
        );
        lending.configureCollateral(address(wzkltc), address(ltcOracle), 1_000_000 ether, 8000, 8500, 9000, 500, true);

        n.mint(SUPPLIER, 3_000_000 ether);
        vm.prank(SUPPLIER);
        n.approve(address(lending), type(uint256).max);
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
        uint256 interest = lending.accruedProtocolInterestN();
        uint256 supplierAssets = lending.totalAssetsN();

        vm.prank(address(0xCAFE));
        uint256 swept = lending.sweepProtocolInterest();
        assertApproxEqAbs(swept, 5000 ether, 1, "0.5% protocol spread");
        assertEq(swept, interest, "everything accrued");
        assertEq(lending.accruedProtocolInterestN(), 0, "claim cleared");
        assertEq(lending.totalAssetsN(), supplierAssets, "suppliers unchanged");
        _assertSplit(swept);

        vm.expectRevert(PooledNLendingPoolV2.ProtocolInterestExceeded.selector);
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
        vm.expectRevert(PooledNLendingPoolV2.InvalidConfiguration.selector);
        new PooledNLendingPoolV2(address(n), address(0xDEAD), address(this), 1 ether, 1 ether, true);
    }

    function testStagedSynthVaultActivatesOnTheSplitterAndPaysItsMintFee() public {
        MockPriceOracle btcOracle = new MockPriceOracle(100_000 ether);
        MockPriceOracle ethOracle = new MockPriceOracle(2000 ether);
        SynthSafetyReserve reserve = new SynthSafetyReserve(address(n), address(this));
        SyntheticAsset nbtc = new SyntheticAsset("0xFi Synthetic Bitcoin", "nBTC", address(this));
        SyntheticAsset neth = new SyntheticAsset("0xFi Synthetic Ether", "nETH", address(this));
        SyntheticVault vault = new SyntheticVault(
            address(n), address(nbtc), address(btcOracle), address(reserve), address(splitter), address(this), 100 ether, false
        );
        SyntheticVault secondVault = new SyntheticVault(
            address(n), address(neth), address(ethOracle), address(reserve), address(splitter), address(this), 1000 ether, false
        );
        reserve.bindVaults(address(vault), address(secondVault));
        nbtc.bindVault(address(vault));
        neth.bindVault(address(secondVault));
        vault.activateRiskOperations();
        assertTrue(vault.activated(), "activated without a fee gauge");

        n.mint(ALICE, 200_000 ether);
        vm.prank(ALICE);
        n.approve(address(vault), type(uint256).max);
        uint256 fee = vault.quoteMintFee(1 ether);
        vm.prank(ALICE);
        vault.depositAndMint(150_000 ether, 1 ether, fee, ALICE);

        _assertSplit(fee);
        assertEq(n.balanceOf(address(vault)), 150_000 ether, "vault keeps only collateral");
    }

    function _assertSplit(uint256 amount) private view {
        assertEq(n.balanceOf(POOL), amount * 7_000 / 10_000, "70% to stakers");
        assertEq(n.balanceOf(TREASURY), amount * 1_000 / 10_000, "10% to treasury");
        assertEq(
            n.balanceOf(splitter.BURN_SINK()),
            amount - amount * 7_000 / 10_000 - amount * 1_000 / 10_000,
            "20% burned"
        );
        assertEq(n.balanceOf(address(splitter)), 0, "nothing left in the splitter");
    }
}
