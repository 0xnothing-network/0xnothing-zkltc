// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "../../lib/openzeppelin-contracts/lib/forge-std/src/Test.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { RwaMarket } from "../../src/rwa/RwaMarket.sol";
import { RwaPriceOracle } from "../../src/rwa/RwaPriceOracle.sol";
import { MockCollateralToken, MockPriceOracle } from "../mocks/RiskMocks.sol";

contract TaxedRwaToken is ERC20 {
    constructor() ERC20("Taxed", "TAX") {
        _mint(msg.sender, 1000 ether);
    }

    function _update(address from, address to, uint256 amount) internal override {
        if (from != address(0) && to != address(0)) {
            super._update(from, address(0), amount / 100);
            amount -= amount / 100;
        }
        super._update(from, to, amount);
    }
}

contract SenderTaxedRwaToken is ERC20 {
    constructor() ERC20("Sender taxed", "STAX") {
        _mint(msg.sender, 1_000_000 ether);
    }

    function _update(address from, address to, uint256 amount) internal override {
        if (from != address(0) && to != address(0)) super._update(from, address(0), amount / 100);
        super._update(from, to, amount);
    }
}

contract CallbackRwaToken is ERC20 {
    address public target;
    bytes4 public rejectedWith;

    constructor() ERC20("Callback", "CALL") {
        _mint(msg.sender, 1000 ether);
    }

    function setTarget(address value) external {
        target = value;
    }

    function _update(address from, address to, uint256 amount) internal override {
        super._update(from, to, amount);
        if (target != address(0) && from != address(0) && to != address(0)) {
            (bool ok, bytes memory reason) = target.call(
                abi.encodeWithSignature("buy(uint256,uint256,uint256)", 1 ether, type(uint256).max, block.timestamp)
            );
            require(!ok, "Reentry unexpectedly succeeded");
            rejectedWith = bytes4(reason);
        }
    }
}

contract RwaMarketTest is Test {
    MockCollateralToken asset;
    MockCollateralToken cash;
    MockPriceOracle[4] feeds;
    address[4] sources;
    RwaMarket market;
    address trader = address(0xBEEF);

    function setUp() public {
        vm.warp(1_000_000);
        asset = new MockCollateralToken("Test RWA", "RWA", 8);
        cash = new MockCollateralToken("Test settlement", "NUSD", 6);
        for (uint256 i; i < 4; ++i) {
            feeds[i] = new MockPriceOracle(i < 2 ? 100 ether : 1 ether);
            sources[i] = address(feeds[i]);
        }
        market = new RwaMarket(
            address(this), address(asset), address(cash), sources, 1 hours, 100, 1000e6, 10_000e6, 20_000e6
        );
        asset.mint(address(this), 1000e8);
        cash.mint(address(this), 100_000e6);
        asset.approve(address(market), type(uint256).max);
        cash.approve(address(market), type(uint256).max);
        market.fund(true, 1000e8);
        market.fund(false, 100_000e6);
        market.setPaused(false);
        cash.mint(trader, 100_000e6);
        asset.mint(trader, 1000e8);
        vm.startPrank(trader);
        cash.approve(address(market), type(uint256).max);
        asset.approve(address(market), type(uint256).max);
        vm.stopPrank();
    }

    function testBuySellChargesExactlyOnePercentIntoReserve() public {
        uint256 cashBefore = cash.balanceOf(trader);
        uint256 assetBefore = asset.balanceOf(trader);
        vm.startPrank(trader);
        market.buy(1e8, 101e6, block.timestamp);
        market.sell(1e8, 99e6, block.timestamp);
        vm.stopPrank();
        assertEq(cash.balanceOf(trader), cashBefore - 2e6);
        assertEq(asset.balanceOf(trader), assetBefore);
        assertEq(market.feeReserve(), 2e6);
        assertEq(market.availableLiquidity(), 99_000e6);
    }

    function testFeeWithdrawalCannotTouchTradingLiquidity() public {
        vm.prank(trader);
        market.buy(1e8, 101e6, block.timestamp);
        uint256 available = market.availableLiquidity();
        vm.expectRevert(RwaMarket.InsufficientLiquidity.selector);
        market.withdrawFees(address(this), 1e6 + 1);
        market.withdrawFees(address(this), 1e6);
        assertEq(market.availableLiquidity(), available);
        assertEq(market.feeReserve(), 0);
    }

    function testReinvestedFeesBecomePermanentLiquidity() public {
        vm.prank(trader);
        market.buy(1e8, 101e6, block.timestamp);
        uint256 beforeLiquidity = market.availableLiquidity();
        market.reinvestFees(1e6);
        assertEq(market.availableLiquidity(), beforeLiquidity + 1e6);
        assertEq(market.withdrawableFees(), 0);
    }

    function testOnlyOwnerCanWithdrawPauseAndReinvest() public {
        vm.startPrank(trader);
        vm.expectRevert();
        market.withdrawFees(trader, 1);
        vm.expectRevert();
        market.reinvestFees(1);
        vm.expectRevert();
        market.setPaused(true);
        vm.stopPrank();
    }

    function testOwnershipRequiresAcceptance() public {
        market.transferOwnership(trader);
        assertEq(market.owner(), address(this));
        vm.prank(trader);
        market.acceptOwnership();
        assertEq(market.owner(), trader);
        vm.expectRevert();
        market.setPaused(true);
    }

    function testDeadlineSlippagePauseInventoryAndTradeLimit() public {
        vm.startPrank(trader);
        vm.expectRevert(RwaMarket.Expired.selector);
        market.buy(1e8, 101e6, block.timestamp - 1);
        vm.expectRevert(RwaMarket.Slippage.selector);
        market.buy(1e8, 100e6, block.timestamp);
        vm.expectRevert(RwaMarket.Slippage.selector);
        market.sell(1e8, 100e6, block.timestamp);
        vm.expectRevert(RwaMarket.InvalidAmount.selector);
        market.buy(101e8, type(uint256).max, block.timestamp);
        vm.stopPrank();
        market.setPaused(true);
        vm.expectRevert(RwaMarket.TradingPaused.selector);
        market.quote(true, 1e8);
        deal(address(asset), address(market), 0);
        vm.expectRevert(RwaMarket.InsufficientLiquidity.selector);
        market.setPaused(false);
    }

    function testDailyLimitResetsOnlyOnNewUtcDay() public {
        vm.startPrank(trader);
        market.sell(100e8, 9900e6, block.timestamp);
        market.sell(100e8, 9900e6, block.timestamp);
        vm.expectRevert(RwaMarket.DailyLimit.selector);
        market.sell(1e8, 0, block.timestamp);
        vm.stopPrank();
        assertEq(market.remainingDailySell(), 0);
        vm.warp((block.timestamp / 1 days + 1) * 1 days);
        assertEq(market.remainingDailySell(), 20_000e6);
    }

    function testReserveFloorBlocksSaleAndFeeWithdrawalUnderfunded() public {
        deal(address(cash), address(market), 1099e6);
        vm.prank(trader);
        vm.expectRevert(RwaMarket.InsufficientLiquidity.selector);
        market.sell(1e8, 0, block.timestamp);
        assertEq(market.availableLiquidity(), 99e6);
        vm.prank(trader);
        market.buy(1e8, 101e6, block.timestamp);
        deal(address(cash), address(market), 1000e6);
        assertEq(market.withdrawableFees(), 0);
    }

    function testCrossRateDoesNotAssumeNusdPeg() public {
        feeds[2].setPrice(0.5 ether);
        feeds[3].setPrice(0.5 ether);
        (uint256 gross, uint256 fee, uint256 total) = market.quote(true, 1e8);
        assertEq(gross, 200e6);
        assertEq(fee, 2e6);
        assertEq(total, 202e6);
    }

    function testRejectsStaleFutureZeroAndUnavailableSources() public {
        vm.warp(block.timestamp + 1 hours + 1);
        vm.expectRevert(RwaPriceOracle.InvalidPrice.selector);
        market.quote(true, 1e8);
        vm.warp(999_999);
        vm.expectRevert(RwaPriceOracle.InvalidPrice.selector);
        market.quote(true, 1e8);
        vm.warp(1_000_000);
        feeds[3].setPrice(0);
        vm.expectRevert(RwaPriceOracle.InvalidPrice.selector);
        market.quote(true, 1e8);
        feeds[3].setPrice(1 ether);
        feeds[1].setReadReverts(true);
        vm.expectRevert();
        market.quote(true, 1e8);
    }

    function testDivergenceOfEitherPairStopsBothDirections() public {
        feeds[1].setPrice(102 ether);
        vm.expectRevert(RwaPriceOracle.SourcesDisagree.selector);
        market.quote(true, 1e8);
        vm.expectRevert(RwaPriceOracle.SourcesDisagree.selector);
        market.quote(false, 1e8);
        feeds[1].setPrice(100 ether);
        feeds[3].setPrice(1.02 ether);
        vm.expectRevert(RwaPriceOracle.SourcesDisagree.selector);
        market.quote(true, 1e8);
    }

    function testDuplicateOracleAndTaxedTokensRejected() public {
        sources[1] = sources[0];
        vm.expectRevert(RwaPriceOracle.InvalidConfiguration.selector);
        new RwaPriceOracle(sources, 1 hours, 100);
        sources[1] = address(feeds[1]);
        TaxedRwaToken taxed = new TaxedRwaToken();
        RwaMarket other = new RwaMarket(
            address(this), address(taxed), address(cash), sources, 1 hours, 100, 1000e6, 10_000e6, 20_000e6
        );
        taxed.approve(address(other), 100 ether);
        vm.expectRevert(RwaMarket.UnsupportedToken.selector);
        other.fund(true, 100 ether);
        assertEq(taxed.balanceOf(address(other)), 0);
    }

    function testFuzzRoundTripNeverProfitsAndFeesAreBacked(uint64 rawAmount) public {
        uint256 amount = bound(uint256(rawAmount), 100, 100e8);
        (,, uint256 cost) = market.quote(true, amount);
        uint256 beforeBalance = cash.balanceOf(trader);
        vm.startPrank(trader);
        market.buy(amount, cost, block.timestamp);
        market.sell(amount, 0, block.timestamp);
        vm.stopPrank();
        assertLt(cash.balanceOf(trader), beforeBalance);
        assertGe(cash.balanceOf(address(market)), market.feeReserve() + market.reserveFloor());
        assertEq(market.withdrawableFees(), market.feeReserve());
    }

    function testReentrantTokenCannotTradeDuringPayout() public {
        CallbackRwaToken token = new CallbackRwaToken();
        RwaMarket other = new RwaMarket(
            address(this), address(token), address(cash), sources, 1 hours, 100, 1000e6, 10_000e6, 20_000e6
        );
        token.approve(address(other), 1000 ether);
        other.fund(true, 1000 ether);
        cash.mint(address(this), 2000e6);
        cash.approve(address(other), 2000e6);
        other.fund(false, 2000e6);
        other.setPaused(false);
        token.setTarget(address(other));
        vm.startPrank(trader);
        cash.approve(address(other), 101e6);
        other.buy(1 ether, 101e6, block.timestamp);
        vm.stopPrank();
        assertEq(token.rejectedWith(), bytes4(keccak256("ReentrancyGuardReentrantCall()")));
        assertEq(other.feeReserve(), 1e6);
        assertEq(token.balanceOf(trader), 1 ether);
    }

    function testTaxedPayoutRevertsWithoutChargingBuyer() public {
        TaxedRwaToken taxed = new TaxedRwaToken();
        RwaMarket other = new RwaMarket(
            address(this), address(taxed), address(cash), sources, 1 hours, 100, 1000e6, 10_000e6, 20_000e6
        );
        deal(address(taxed), address(other), 100 ether);
        deal(address(cash), address(other), 2000e6);
        other.setPaused(false);
        uint256 beforeBalance = cash.balanceOf(trader);
        vm.startPrank(trader);
        cash.approve(address(other), 101e6);
        vm.expectRevert(RwaMarket.UnsupportedToken.selector);
        other.buy(1 ether, 101e6, block.timestamp);
        vm.stopPrank();
        assertEq(cash.balanceOf(trader), beforeBalance);
        assertEq(other.feeReserve(), 0);
    }

    function testSenderTaxedFundingRevertsAtomically() public {
        SenderTaxedRwaToken taxed = new SenderTaxedRwaToken();
        RwaMarket other = new RwaMarket(
            address(this), address(taxed), address(cash), sources, 1 hours, 100, 1000e6, 10_000e6, 20_000e6
        );
        taxed.approve(address(other), 100 ether);
        uint256 beforeBalance = taxed.balanceOf(address(this));
        vm.expectRevert(RwaMarket.UnsupportedToken.selector);
        other.fund(true, 100 ether);
        assertEq(taxed.balanceOf(address(this)), beforeBalance);
        assertEq(taxed.balanceOf(address(other)), 0);
    }

    function testSenderTaxedBuyCannotDebitMoreThanReviewedCost() public {
        SenderTaxedRwaToken taxed = new SenderTaxedRwaToken();
        RwaMarket other = new RwaMarket(
            address(this), address(asset), address(taxed), sources, 1 hours, 100, 1000 ether, 10_000 ether, 20_000 ether
        );
        deal(address(asset), address(other), 1000e8);
        deal(address(taxed), address(other), 2000 ether);
        deal(address(taxed), trader, 1000 ether);
        other.setPaused(false);
        vm.startPrank(trader);
        taxed.approve(address(other), 101 ether);
        vm.expectRevert(RwaMarket.UnsupportedToken.selector);
        other.buy(1e8, 101 ether, block.timestamp);
        vm.stopPrank();
        assertEq(taxed.balanceOf(trader), 1000 ether);
        assertEq(taxed.balanceOf(address(other)), 2000 ether);
        assertEq(other.feeReserve(), 0);
    }

    function testSenderTaxedSellCannotDebitMoreThanReviewedAmount() public {
        SenderTaxedRwaToken taxed = new SenderTaxedRwaToken();
        RwaMarket other = new RwaMarket(
            address(this), address(taxed), address(cash), sources, 1 hours, 100, 1000e6, 10_000e6, 20_000e6
        );
        deal(address(taxed), address(other), 1000 ether);
        deal(address(cash), address(other), 2000e6);
        deal(address(taxed), trader, 1000 ether);
        other.setPaused(false);
        uint256 cashBefore = cash.balanceOf(trader);
        vm.startPrank(trader);
        taxed.approve(address(other), 1 ether);
        vm.expectRevert(RwaMarket.UnsupportedToken.selector);
        other.sell(1 ether, 99e6, block.timestamp);
        vm.stopPrank();
        assertEq(taxed.balanceOf(trader), 1000 ether);
        assertEq(cash.balanceOf(trader), cashBefore);
        assertEq(other.soldToday(), 0);
        assertEq(other.feeReserve(), 0);
    }
}
