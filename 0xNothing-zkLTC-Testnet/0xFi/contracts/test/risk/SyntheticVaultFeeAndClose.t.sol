// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { SynthSafetyReserve } from "../../src/synth/SynthSafetyReserve.sol";
import { SyntheticAsset } from "../../src/synth/SyntheticAsset.sol";
import { SyntheticVault } from "../../src/synth/SyntheticVault.sol";
import { TestBase } from "../helpers/TestBase.sol";
import { MockMintFeeDistributor, MockNUSD, MockPriceOracle } from "../mocks/RiskMocks.sol";

contract SyntheticVaultFeeAndCloseTest is TestBase {
    address private constant ALICE = address(0xA11CE);

    uint256 private constant WAD = 1e18;
    uint256 private constant BPS = 10_000;
    uint256 private constant MINT_FEE_BPS = 10;

    MockNUSD private nusd;
    MockPriceOracle private ethOracle;
    SyntheticAsset private neth;
    SynthSafetyReserve private reserve;
    MockMintFeeDistributor private feeDistributor;
    SyntheticVault private vault;

    function setUp() public {
        vm.warp(1_000_000);
        nusd = new MockNUSD();
        ethOracle = new MockPriceOracle(2000 ether);
        reserve = new SynthSafetyReserve(address(nusd), address(this));
        feeDistributor = new MockMintFeeDistributor(address(nusd));
        neth = new SyntheticAsset("0xFi Synthetic Ether", "nETH", address(this));
        SyntheticAsset nbtc = new SyntheticAsset("0xFi Synthetic Bitcoin", "nBTC", address(this));
        SyntheticVault btcVault = new SyntheticVault(
            address(nusd),
            address(nbtc),
            address(new MockPriceOracle(100_000 ether)),
            address(reserve),
            address(feeDistributor),
            address(this),
            100 ether,
            true
        );
        vault = new SyntheticVault(
            address(nusd),
            address(neth),
            address(ethOracle),
            address(reserve),
            address(feeDistributor),
            address(this),
            1000 ether,
            true
        );
        reserve.bindVaults(address(btcVault), address(vault));
        nbtc.bindVault(address(btcVault));
        neth.bindVault(address(vault));

        nusd.mint(ALICE, 1_000_000 ether);
        vm.startPrank(ALICE);
        nusd.approve(address(vault), type(uint256).max);
        neth.approve(address(vault), type(uint256).max);
        vm.stopPrank();
    }

    function testSmallNethMintFeeIsProportionalNotAlmostTheMintValue() public {
        ethOracle.setPrice(2555 ether);
        uint256 collateral = 0.13 ether;
        (uint256 quoted,,) = vault.quoteDepositAndMint(ALICE, collateral);
        assertGt(quoted, 0, "small nETH mint is quoted");

        uint256 feeNusd = vault.quoteMintFee(quoted);
        uint256 notionalNusd = _mulDivUp(quoted, 2555 ether, WAD);

        assertLe(feeNusd * 100, collateral, "fee is not ~100 percent of deposited NUSD");
        assertLe(feeNusd * 2, notionalNusd / 100, "fee is not ~100 percent of minted notional");
        assertLe(feeNusd, notionalNusd * MINT_FEE_BPS / BPS + 1, "fee is 0.1 percent plus at most 1 wei");

        uint256 aliceBefore = nusd.balanceOf(ALICE);
        vm.prank(ALICE);
        vault.depositAndMint(collateral, quoted, feeNusd, ALICE);
        assertEq(
            aliceBefore - nusd.balanceOf(ALICE), collateral + feeNusd, "user pays collateral plus proportional fee"
        );
        assertEq(nusd.balanceOf(address(feeDistributor)), feeNusd, "distributor receives the quoted fee");
    }

    function testMintFeeIsChargedOnThisMintNotExistingDebt() public {
        vm.prank(ALICE);
        vault.depositAndMint(150 ether, 0.05 ether, type(uint256).max, ALICE);
        uint256 firstFee = nusd.balanceOf(address(feeDistributor));

        uint256 incremental = 0.01 ether;
        uint256 incrementalFee = vault.quoteMintFee(incremental);
        vm.prank(ALICE);
        vault.depositAndMint(30 ether, incremental, incrementalFee, ALICE);

        assertEq(
            nusd.balanceOf(address(feeDistributor)),
            firstFee + incrementalFee,
            "second mint does not re-charge 0.1 percent of prior debt"
        );
        assertLe(incrementalFee * 100, 30 ether, "incremental fee stays a sliver of the new deposit");
    }

    function testFuzzMintFeeProportionalAcrossAmountsAndPriceMagnitudes(
        uint96 rawAmount,
        uint8 priceDigits,
        uint16 rawUnit
    ) public {
        uint256 amountSynthetic = bound(rawAmount, 1, 1000 ether);
        uint256 digits = bound(priceDigits, 16, 24);
        uint256 unit = bound(rawUnit, 1, 20_000);
        uint256 priceWad = unit * (10 ** digits);
        vm.assume(priceWad >= 1e16 && priceWad <= 1e24);

        ethOracle.setPrice(priceWad);
        uint256 feeNusd = vault.quoteMintFee(amountSynthetic);
        uint256 notionalNusd = _mulDivUp(amountSynthetic, priceWad, WAD);

        assertLe(feeNusd, notionalNusd, "fee never exceeds minted notional");
        assertLe(feeNusd, notionalNusd * MINT_FEE_BPS / BPS + 1, "fee <= 0.1 percent + 1 wei");
        if (notionalNusd >= 1000) {
            assertLe(feeNusd * 100, notionalNusd, "above dust, fee cannot approach 100 percent of value");
        }
        uint256 expected = Math.mulDiv(amountSynthetic, priceWad, (WAD * BPS) / MINT_FEE_BPS, Math.Rounding.Ceil);
        assertEq(feeNusd, expected, "quote matches single-ceil 0.1 percent formula");
    }

    /// @dev Proves the rewrite is an identity: `ceil(a*p/1e21)` equals the
    /// stacked `ceil(ceil(a*p/1e18)/1000)` the live vault already charged.
    function testFuzzSingleCeilFeeEqualsStackedOldFormula(uint128 rawAmount, uint128 rawPrice) public {
        uint256 amountSynthetic = bound(uint256(rawAmount), 1, type(uint128).max);
        uint256 priceWad = bound(uint256(rawPrice), 1, type(uint128).max);

        uint256 newFee = Math.mulDiv(amountSynthetic, priceWad, (WAD * BPS) / MINT_FEE_BPS, Math.Rounding.Ceil);
        uint256 oldFee = _mulDivUp(_mulDivUp(amountSynthetic, priceWad, WAD), MINT_FEE_BPS, BPS);
        assertEq(newFee, oldFee, "ceil(a*p/1e21) equals ceil(ceil(a*p/1e18)/1000)");

        ethOracle.setPrice(priceWad);
        assertEq(vault.quoteMintFee(amountSynthetic), oldFee, "vault still quotes the pre-rewrite fee");
    }

    function testOpenAddThenAtomicFullClose() public {
        vm.prank(ALICE);
        vault.depositAndMint(150 ether, 0.05 ether, type(uint256).max, ALICE);
        vm.prank(ALICE);
        vault.depositAndMint(30 ether, 0.01 ether, type(uint256).max, ALICE);

        (uint256 userCollateral, uint256 reserveCollateral, uint256 debt) = vault.positions(ALICE);
        assertEq(userCollateral, 180 ether, "second deposit merges into the same position");
        assertEq(reserveCollateral, 0, "unsponsored");
        assertEq(debt, 0.06 ether, "debt stacks");
        assertEq(neth.balanceOf(ALICE), 0.06 ether, "wallet holds the full synth debt");

        vm.expectRevert(SyntheticVault.InsufficientCollateral.selector);
        vm.prank(ALICE);
        vault.withdrawCollateral(userCollateral, ALICE);

        uint256 nusdBefore = nusd.balanceOf(ALICE);
        vm.prank(ALICE);
        uint256 repaid = vault.repayAndWithdraw(type(uint256).max, type(uint256).max, ALICE);

        (uint256 userAfter, uint256 reserveAfter, uint256 debtAfter) = vault.positions(ALICE);
        assertEq(repaid, 0.06 ether, "all debt repaid");
        assertEq(userAfter + reserveAfter + debtAfter, 0, "position fully closed");
        assertEq(neth.balanceOf(ALICE), 0, "synth burned");
        assertEq(nusd.balanceOf(ALICE), nusdBefore + 180 ether, "user NUSD returned after debt reduction");
        assertEq(vault.totalDebtSynthetic(), 0, "vault debt cleared");
        assertEq(vault.totalUserCollateralNusd(), 0, "vault user collateral cleared");
    }

    function testAtomicCloseUsesPostRepayCollateralCheck() public {
        vm.prank(ALICE);
        vault.depositAndMint(150 ether, 0.05 ether, type(uint256).max, ALICE);
        vm.prank(ALICE);
        vault.depositCollateral(0.5 ether, ALICE);

        (uint256 lockedBefore,, uint256 debtBefore) = vault.positions(ALICE);
        assertEq(lockedBefore, 150.5 ether, "top-up merges");
        assertEq(vault.maxUserCollateralWithdrawable(ALICE), 0.5 ether, "only the excess is free while debt remains");

        vm.expectRevert(SyntheticVault.InsufficientCollateral.selector);
        vm.prank(ALICE);
        vault.withdrawCollateral(lockedBefore, ALICE);

        vm.prank(ALICE);
        vault.repayAndWithdraw(debtBefore, lockedBefore, ALICE);
        (uint256 userAfter,, uint256 debtAfter) = vault.positions(ALICE);
        assertEq(debtAfter, 0, "repay ran before the collateral check");
        assertEq(userAfter, 0, "full user collateral withdrawn after debt hit zero");
    }

    /// @dev Regression vs main: at 150% CR, `maxUserCollateralWithdrawable` is 0.
    /// Main still forwards `type(uint256).max` into `_withdrawCollateral`, which
    /// reverts `InvalidAmount` and rolls the repay back. Exact-amount close
    /// (`testAtomicCloseUsesPostRepayCollateralCheck`) already succeeded on main.
    function testMaxUintFullCloseAtMinimumRatioSucceeds() public {
        vm.prank(ALICE);
        vault.depositAndMint(150 ether, 0.05 ether, type(uint256).max, ALICE);
        assertEq(vault.maxUserCollateralWithdrawable(ALICE), 0, "min-ratio position has no free collateral");
        assertEq(neth.balanceOf(ALICE), 0.05 ether, "wallet holds the debt");

        uint256 nusdBefore = nusd.balanceOf(ALICE);
        vm.prank(ALICE);
        uint256 repaid = vault.repayAndWithdraw(type(uint256).max, type(uint256).max, ALICE);

        (uint256 userAfter,, uint256 debtAfter) = vault.positions(ALICE);
        assertEq(repaid, 0.05 ether, "all debt repaid in the same call");
        assertEq(userAfter + debtAfter, 0, "position fully closed");
        assertEq(neth.balanceOf(ALICE), 0, "synth burned");
        assertEq(nusd.balanceOf(ALICE), nusdBefore + 150 ether, "user NUSD returned after repay");
    }

    function testMaxUintWithdrawRevertsWhenDebtRemainsAndNothingIsWithdrawable() public {
        vm.prank(ALICE);
        vault.depositAndMint(150 ether, 0.05 ether, type(uint256).max, ALICE);
        assertEq(vault.maxUserCollateralWithdrawable(ALICE), 0, "nothing free while debt remains at min CR");

        vm.expectRevert(SyntheticVault.InsufficientCollateral.selector);
        vm.prank(ALICE);
        vault.repayAndWithdraw(0, type(uint256).max, ALICE);

        (uint256 userAfter,, uint256 debtAfter) = vault.positions(ALICE);
        assertEq(userAfter, 150 ether, "collateral unchanged after the revert");
        assertEq(debtAfter, 0.05 ether, "debt unchanged after the revert");
    }

    function testRepayAndWithdrawMaxSkipsZeroDebtRepay() public {
        vm.prank(ALICE);
        vault.depositCollateral(1 ether, ALICE);
        vm.prank(ALICE);
        vault.repayAndWithdraw(type(uint256).max, type(uint256).max, ALICE);
        (uint256 userAfter,, uint256 debtAfter) = vault.positions(ALICE);
        assertEq(userAfter, 0, "debt-free collateral still closes with max repay");
        assertEq(debtAfter, 0, "no debt");
    }

    function _mulDivUp(uint256 x, uint256 y, uint256 denominator) private pure returns (uint256 result) {
        result = Math.mulDiv(x, y, denominator);
        if (mulmod(x, y, denominator) != 0) result += 1;
    }
}
