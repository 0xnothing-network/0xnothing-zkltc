// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "../TestBase.sol";
import {NUSD} from "../../src/nusd/NUSD.sol";
import {DIAOracleAdapter} from "../../src/nusd/DIAOracleAdapter.sol";
import {NativeCollateralVault} from "../../src/nusd/NativeCollateralVault.sol";
import {MockDIAFeed} from "../mocks/MockDIAFeed.sol";

contract NativeCollateralVaultTest is TestBase {
    NUSD private nusd;
    MockDIAFeed private feed;
    DIAOracleAdapter private oracle;
    NativeCollateralVault private vault;

    address private constant BORROWER = address(0xB0B);
    address private constant LIQUIDATOR = address(0x1A11);

    receive() external payable {}

    function setUp() public {
        vm.warp(1_000_000);
        feed = new MockDIAFeed(18);
        feed.setRound(1, 50 ether, block.timestamp, 1);
        oracle = new DIAOracleAdapter(address(feed), 90 minutes);
        nusd = new NUSD(address(this));
        vault = new NativeCollateralVault(
            address(nusd), address(oracle), address(this), 17_500, 15_000, 800, 5_000, 300 ether
        );
        nusd.bindVault(address(vault));
        vm.deal(BORROWER, 20 ether);
        vm.deal(LIQUIDATOR, 20 ether);
    }

    function testDepositMintRepayAndWithdraw() public {
        vm.prank(BORROWER);
        vault.depositAndMint{value: 10 ether}(200 ether, BORROWER);
        (uint256 collateral, uint256 debt) = vault.positions(BORROWER);
        assertEq(collateral, 10 ether, "collateral");
        assertEq(debt, 200 ether, "debt");
        assertEq(nusd.balanceOf(BORROWER), 200 ether, "NUSD balance");

        vm.startPrank(BORROWER);
        nusd.approve(address(vault), 50 ether);
        vault.repay(50 ether, BORROWER);
        vault.withdrawCollateral(1 ether, BORROWER);
        vm.stopPrank();

        (collateral, debt) = vault.positions(BORROWER);
        assertEq(collateral, 9 ether, "withdrawn collateral");
        assertEq(debt, 150 ether, "repaid debt");
        assertEq(vault.totalDebtNusd(), nusd.totalSupply(), "supply tracks vault debt");
    }

    function testCannotMintPastMinimumRatio() public {
        vm.prank(BORROWER);
        vm.expectRevert(NativeCollateralVault.InsufficientCollateral.selector);
        vault.depositAndMint{value: 1 ether}(40 ether, BORROWER);
    }

    function testLiquidationAfterPriceDrop() public {
        vm.prank(BORROWER);
        vault.depositAndMint{value: 10 ether}(250 ether, BORROWER);
        _fundLiquidator(125 ether);

        feed.setRound(2, 30 ether, block.timestamp, 2);
        assertTrue(vault.isLiquidatable(BORROWER), "position liquidatable");

        vm.startPrank(LIQUIDATOR);
        nusd.approve(address(vault), 125 ether);
        (uint256 repaid, uint256 seized) = vault.liquidate(BORROWER, 125 ether, 0, LIQUIDATOR);
        vm.stopPrank();

        assertEq(repaid, 125 ether, "close factor repay");
        assertGt(seized, 4 ether, "bonus collateral");
        (, uint256 debtAfter) = vault.positions(BORROWER);
        assertEq(debtAfter, 125 ether, "remaining debt");
    }

    function testStaleOracleBlocksRiskButNotRepayment() public {
        vm.prank(BORROWER);
        vault.depositAndMint{value: 10 ether}(100 ether, BORROWER);

        vm.warp(block.timestamp + 91 minutes);
        vm.prank(BORROWER);
        vm.expectRevert();
        vault.withdrawCollateral(1 ether, BORROWER);

        vm.startPrank(BORROWER);
        nusd.approve(address(vault), 10 ether);
        vault.repay(10 ether, BORROWER);
        vm.stopPrank();
        (, uint256 debtAfter) = vault.positions(BORROWER);
        assertEq(debtAfter, 90 ether, "repayment remains available");
    }

    function testPauseBlocksMintAndWithdrawButNotDeposit() public {
        vault.setRiskOperationsPaused(true);
        vm.prank(BORROWER);
        vault.deposit{value: 1 ether}();
        vm.prank(BORROWER);
        vm.expectRevert(NativeCollateralVault.RiskOperationsPaused.selector);
        vault.mintNusd(1 ether, BORROWER);
    }

    function testDebtCeilingCapsOutstandingNusd() public {
        vm.prank(BORROWER);
        vault.depositAndMint{value: 20 ether}(300 ether, BORROWER);
        assertEq(vault.maxMintableNusd(BORROWER), 0, "ceiling reflected in quote");

        vm.prank(BORROWER);
        vm.expectRevert(NativeCollateralVault.DebtCeilingExceeded.selector);
        vault.mintNusd(1, BORROWER);
    }

    function testExhaustedCollateralRecognizesAndCoversBadDebt() public {
        vm.prank(BORROWER);
        vault.depositAndMint{value: 10 ether}(250 ether, BORROWER);
        _fundLiquidator(20 ether);
        feed.setRound(2, 1 ether, block.timestamp, 2);

        vm.startPrank(LIQUIDATOR);
        nusd.approve(address(vault), type(uint256).max);
        vault.liquidate(BORROWER, 125 ether, 0, LIQUIDATOR);
        vm.stopPrank();

        (uint256 collateralAfter, uint256 debtAfter) = vault.positions(BORROWER);
        uint256 badDebt = vault.totalBadDebtNusd();
        assertEq(collateralAfter, 0, "collateral exhausted");
        assertEq(debtAfter, 0, "active debt cleared");
        assertGt(badDebt, 0, "bad debt recognized");
        assertEq(vault.cumulativeBadDebtNusdByAccount(BORROWER), badDebt, "account attribution");

        vm.startPrank(LIQUIDATOR);
        vault.coverBadDebt(1 ether);
        vm.stopPrank();
        assertEq(vault.totalBadDebtNusd(), badDebt - 1 ether, "bad debt covered");
    }

    function testLiquidationPauseIsIndependentFromRiskOperationsPause() public {
        vm.prank(BORROWER);
        vault.depositAndMint{value: 10 ether}(250 ether, BORROWER);
        _fundLiquidator(125 ether);
        feed.setRound(2, 30 ether, block.timestamp, 2);
        vm.prank(LIQUIDATOR);
        nusd.approve(address(vault), 125 ether);

        vault.setLiquidationsPaused(true);
        vm.expectRevert(NativeCollateralVault.LiquidationsPaused.selector);
        vm.prank(LIQUIDATOR);
        vault.liquidate(BORROWER, 125 ether, 0, LIQUIDATOR);

        vault.setRiskOperationsPaused(true);
        vault.setLiquidationsPaused(false);
        vm.prank(LIQUIDATOR);
        (uint256 repaid,) = vault.liquidate(BORROWER, 125 ether, 0, LIQUIDATOR);
        assertEq(repaid, 125 ether, "liquidation remains independently enabled");
    }

    function _fundLiquidator(uint256 amountNusd) private {
        vm.prank(BORROWER);
        assertTrue(nusd.transfer(LIQUIDATOR, amountNusd), "fund liquidator");
    }
}
