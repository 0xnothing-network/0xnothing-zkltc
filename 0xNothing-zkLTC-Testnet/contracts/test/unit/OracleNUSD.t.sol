// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "../TestBase.sol";
import {DIAOracleAdapter} from "../../src/nusd/DIAOracleAdapter.sol";
import {OracleNUSD} from "../../src/nusd/OracleNUSD.sol";
import {MockDIAFeed} from "../mocks/MockDIAFeed.sol";

contract OracleNUSDTest is TestBase {
    MockDIAFeed private feed;
    DIAOracleAdapter private oracle;
    OracleNUSD private nusd;

    address private constant USER = address(0xA11CE);
    address private constant RECIPIENT = address(0xB0B);
    address private constant SPENDER = address(0x5EED);
    address private constant RESERVE_PROVIDER = address(0xC0FFEE);

    function setUp() public {
        vm.warp(1_000_000);
        feed = new MockDIAFeed(18);
        feed.setRound(1, 50 ether, block.timestamp, 1);
        oracle = new DIAOracleAdapter(address(feed), 90 minutes);
        nusd = new OracleNUSD(oracle, address(this), 1_000_000 ether);

        vm.deal(USER, 20 ether);
        vm.deal(RESERVE_PROVIDER, 20 ether);
    }

    function testMetadataAndVaultCompatibility() public view {
        assertTrue(keccak256(bytes(nusd.name())) == keccak256(bytes("Nothing USD")), "name");
        assertTrue(keccak256(bytes(nusd.symbol())) == keccak256(bytes("NUSD")), "symbol");
        assertEq(uint256(nusd.decimals()), 18, "decimals");
        assertEq(nusd.vault(), address(nusd), "self vault");
        assertEq(address(nusd.oracle()), address(oracle), "oracle");
        assertEq(nusd.supplyCeilingNusd(), 1_000_000 ether, "supply ceiling");
    }

    function testMintsExactOracleValueAtPriceFifty() public {
        vm.prank(USER);
        uint256 amountNusd = nusd.mintAtOracle{value: 1 ether}(50 ether, RECIPIENT);

        assertEq(amountNusd, 50 ether, "returned mint amount");
        assertEq(nusd.balanceOf(RECIPIENT), 50 ether, "recipient balance");
        assertEq(nusd.totalSupply(), 50 ether, "total supply");
        assertEq(nusd.totalCollateralWei(), 1 ether, "collateral accounting");
        assertEq(address(nusd).balance, 1 ether, "native backing");
        assertEq(nusd.reserveValueNusd(), 50 ether, "reserve value");
    }

    function testRedeemsCallerBalanceAtCurrentOraclePrice() public {
        vm.prank(USER);
        nusd.mintAtOracle{value: 1 ether}(50 ether, USER);
        uint256 recipientBalanceBefore = RECIPIENT.balance;

        vm.prank(USER);
        uint256 collateralOutWei = nusd.redeemAtOracle(10 ether, 0.2 ether, RECIPIENT);

        assertEq(collateralOutWei, 0.2 ether, "returned collateral");
        assertEq(RECIPIENT.balance, recipientBalanceBefore + 0.2 ether, "native received");
        assertEq(nusd.balanceOf(USER), 40 ether, "caller balance burned");
        assertEq(nusd.totalSupply(), 40 ether, "supply burned");
        assertEq(nusd.totalCollateralWei(), 0.8 ether, "reserve reduced");
    }

    function testQuotesUseFloorRounding() public {
        feed.setRound(2, 3 ether, block.timestamp, 2);

        assertEq(nusd.quoteMint(1), 3, "mint floor");
        assertEq(nusd.quoteRedeem(10), 3, "redeem floor");
    }

    function testMintAndRedeemEnforceSlippageBounds() public {
        vm.prank(USER);
        vm.expectRevert();
        nusd.mintAtOracle{value: 1 ether}(50 ether + 1, USER);

        vm.prank(USER);
        nusd.mintAtOracle{value: 1 ether}(50 ether, USER);

        vm.prank(USER);
        vm.expectRevert();
        nusd.redeemAtOracle(10 ether, 0.2 ether + 1, USER);

        assertEq(nusd.balanceOf(USER), 50 ether, "failed redeem did not burn");
        assertEq(nusd.totalCollateralWei(), 1 ether, "failed calls did not move reserve");
    }

    function testStaleOracleBlocksMintAndRedeem() public {
        vm.prank(USER);
        nusd.mintAtOracle{value: 1 ether}(0, USER);
        vm.warp(block.timestamp + 91 minutes);

        vm.prank(USER);
        vm.expectRevert();
        nusd.mintAtOracle{value: 1 ether}(0, USER);

        vm.prank(USER);
        vm.expectRevert();
        nusd.redeemAtOracle(1 ether, 0, USER);
    }

    function testSupplyCeilingCapsMintingAndBurnRestoresHeadroom() public {
        OracleNUSD capped = new OracleNUSD(oracle, address(this), 50 ether);

        vm.prank(USER);
        capped.mintAtOracle{value: 1 ether}(50 ether, USER);

        vm.prank(USER);
        vm.expectRevert();
        capped.mintAtOracle{value: 1}(0, USER);

        vm.prank(USER);
        capped.redeemAtOracle(5 ether, 0, USER);
        vm.prank(USER);
        capped.mintAtOracle{value: 0.1 ether}(5 ether, USER);

        assertEq(capped.totalSupply(), 50 ether, "burn restored ceiling headroom");
    }

    function testMintAndRedeemPausesAreIndependent() public {
        vm.prank(USER);
        nusd.mintAtOracle{value: 1 ether}(50 ether, USER);

        nusd.setMintPaused(true);
        vm.prank(USER);
        vm.expectRevert(OracleNUSD.MintPaused.selector);
        nusd.mintAtOracle{value: 0.1 ether}(0, USER);

        vm.prank(USER);
        nusd.redeemAtOracle(5 ether, 0, USER);

        nusd.setRedeemPaused(true);
        nusd.setMintPaused(false);
        vm.prank(USER);
        nusd.mintAtOracle{value: 0.1 ether}(5 ether, USER);

        vm.prank(USER);
        vm.expectRevert(OracleNUSD.RedeemPaused.selector);
        nusd.redeemAtOracle(1 ether, 0, USER);
    }

    function testOnlyPauserCanChangeIndependentPauses() public {
        vm.prank(USER);
        vm.expectRevert();
        nusd.setMintPaused(true);

        vm.prank(USER);
        vm.expectRevert();
        nusd.setRedeemPaused(true);
    }

    function testRedeemRevertsWhenCurrentPriceRequiresMoreThanReserve() public {
        vm.prank(USER);
        nusd.mintAtOracle{value: 1 ether}(50 ether, USER);
        feed.setRound(2, 25 ether, block.timestamp, 2);

        vm.prank(USER);
        vm.expectRevert();
        nusd.redeemAtOracle(50 ether, 2 ether, USER);

        assertEq(nusd.balanceOf(USER), 50 ether, "failed redeem did not burn");
        assertEq(nusd.totalCollateralWei(), 1 ether, "failed redeem kept reserve");
    }

    function testCoverReserveRestoresRedemptionCapacity() public {
        vm.prank(USER);
        nusd.mintAtOracle{value: 1 ether}(50 ether, USER);
        feed.setRound(2, 25 ether, block.timestamp, 2);

        vm.prank(RESERVE_PROVIDER);
        nusd.coverReserve{value: 1 ether}();
        assertEq(nusd.totalCollateralWei(), 2 ether, "reserve covered");

        vm.prank(USER);
        nusd.redeemAtOracle(50 ether, 2 ether, USER);

        assertEq(nusd.totalSupply(), 0, "all supply burned");
        assertEq(nusd.totalCollateralWei(), 0, "covered reserve redeemed");
    }

    function testTransferApprovalAndTransferFromFollowERC20Semantics() public {
        vm.prank(USER);
        nusd.mintAtOracle{value: 1 ether}(50 ether, USER);

        vm.prank(USER);
        assertTrue(nusd.transfer(RECIPIENT, 10 ether), "transfer result");

        vm.prank(USER);
        assertTrue(nusd.approve(SPENDER, 15 ether), "approval result");
        vm.prank(SPENDER);
        assertTrue(nusd.transferFrom(USER, RECIPIENT, 6 ether), "transferFrom result");

        assertEq(nusd.balanceOf(USER), 34 ether, "owner balance");
        assertEq(nusd.balanceOf(RECIPIENT), 16 ether, "recipient balance");
        assertEq(nusd.allowance(USER, SPENDER), 9 ether, "allowance decremented");

        vm.prank(SPENDER);
        vm.expectRevert();
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        nusd.transferFrom(USER, RECIPIENT, 10 ether);
    }

    function testInfiniteAllowanceIsNotDecremented() public {
        vm.prank(USER);
        nusd.mintAtOracle{value: 1 ether}(50 ether, USER);
        vm.prank(USER);
        nusd.approve(SPENDER, type(uint256).max);

        vm.prank(SPENDER);
        assertTrue(nusd.transferFrom(USER, RECIPIENT, 1 ether), "infinite allowance transfer");

        assertEq(nusd.allowance(USER, SPENDER), type(uint256).max, "infinite allowance retained");
    }
}
