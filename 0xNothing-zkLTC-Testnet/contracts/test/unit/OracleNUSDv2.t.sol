// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "../TestBase.sol";
import {DIAOracleAdapter} from "../../src/nusd/DIAOracleAdapter.sol";
import {OracleNUSDv2} from "../../src/nusd/OracleNUSDv2.sol";
import {MockDIAFeed} from "../mocks/MockDIAFeed.sol";

/// @dev Stands in for the governor: the only account `mintSurplus` accepts once bound.
contract SurplusMinterStub {
    function mint(OracleNUSDv2 nusd, address first, address second, uint256 amount) external {
        nusd.mintSurplus(first, second, amount);
    }
}

contract OracleNUSDv2Test is TestBase {
    MockDIAFeed private feed;
    DIAOracleAdapter private oracle;
    OracleNUSDv2 private nusd;
    SurplusMinterStub private minter;
    uint80 private roundId = 1;

    address private constant USER = address(0xA11CE);
    address private constant POOL = address(0xB001);
    address private constant TREASURY = address(0x7EA5);

    function setUp() public {
        vm.warp(1_000_000);
        feed = new MockDIAFeed(18);
        feed.setRound(roundId, 50 ether, vm.getBlockTimestamp(), roundId);
        oracle = new DIAOracleAdapter(address(feed), 90 minutes);
        nusd = new OracleNUSDv2(oracle, address(this), 1_000_000 ether);
        minter = new SurplusMinterStub();
        nusd.bindSurplusMinter(address(minter));
        vm.deal(USER, 1_000 ether);
    }

    function _setPrice(uint256 priceWad) private {
        roundId++;
        feed.setRound(roundId, int256(priceWad), vm.getBlockTimestamp(), roundId);
    }

    function _mint(uint256 collateralWei) private returns (uint256 amountNusd) {
        vm.prank(USER);
        amountNusd = nusd.mintAtOracle{value: collateralWei}(0, USER);
    }

    function testBurnReducesSupplyButKeepsCollateral() public {
        _mint(1 ether);
        vm.prank(USER);
        nusd.burn(10 ether);

        assertEq(nusd.totalSupply(), 40 ether, "supply burned");
        assertEq(nusd.balanceOf(USER), 40 ether, "balance burned");
        assertEq(nusd.totalCollateralWei(), 1 ether, "collateral kept");
        assertEq(nusd.reserveValueNusd(), 50 ether, "reserve value kept");

        vm.prank(USER);
        vm.expectRevert(OracleNUSDv2.InvalidAmount.selector);
        nusd.burn(0);
    }

    function testSurplusMinterBindsOnceToAContract() public {
        OracleNUSDv2 fresh = new OracleNUSDv2(oracle, address(this), 1_000_000 ether);

        vm.prank(USER);
        vm.expectRevert();
        fresh.bindSurplusMinter(address(minter));

        vm.expectRevert(OracleNUSDv2.InvalidSurplusMinter.selector);
        fresh.bindSurplusMinter(USER);

        fresh.bindSurplusMinter(address(minter));
        assertEq(fresh.surplusMinter(), address(minter), "bound");

        vm.expectRevert(OracleNUSDv2.SurplusMinterAlreadyBound.selector);
        fresh.bindSurplusMinter(address(this));
    }

    function testCapacityIsZeroBelowTrigger() public {
        _mint(1 ether);
        (uint256 amount, bool triggerReached) = nusd.surplusMintCapacity();
        assertFalse(triggerReached, "1x is not 3x");
        assertEq(amount, 0, "nothing to mint at 1x");

        _setPrice(149 ether);
        (, triggerReached) = nusd.surplusMintCapacity();
        assertFalse(triggerReached, "2.98x is not 3x");
    }

    function testSurplusMintRestoresExactlyTwoXAndSplitsInHalf() public {
        _mint(1 ether); // 50 NUSD against 1 zkLTC
        _setPrice(150 ether); // reserve worth 150 = 3x

        (uint256 amount, bool triggerReached) = nusd.surplusMintCapacity();
        assertTrue(triggerReached, "3x reached");
        assertEq(amount, 25 ether, "mint back to 2x");

        minter.mint(nusd, POOL, TREASURY, amount);
        assertEq(nusd.balanceOf(POOL), 12.5 ether, "pool half");
        assertEq(nusd.balanceOf(TREASURY), 12.5 ether, "treasury half");
        assertEq(nusd.totalSupply(), 75 ether, "supply after");
        assertEq(nusd.reserveValueNusd(), 2 * nusd.totalSupply(), "exactly 2x");

        (amount, triggerReached) = nusd.surplusMintCapacity();
        assertFalse(triggerReached, "trigger consumed");
        assertEq(amount, 0, "no further capacity");
    }

    function testSurplusMintEnforcesBoundsIndependentlyOfCaller() public {
        _mint(1 ether);
        _setPrice(150 ether);

        vm.expectRevert(OracleNUSDv2.OnlySurplusMinter.selector);
        nusd.mintSurplus(POOL, TREASURY, 1 ether);

        vm.expectRevert(abi.encodeWithSelector(OracleNUSDv2.SurplusMintTooLarge.selector, 150 ether, 75 ether + 1));
        minter.mint(nusd, POOL, TREASURY, 25 ether + 1);

        vm.expectRevert(OracleNUSDv2.InvalidRecipient.selector);
        minter.mint(nusd, address(0), TREASURY, 1 ether);

        _setPrice(149 ether);
        vm.expectRevert(abi.encodeWithSelector(OracleNUSDv2.SurplusBelowTrigger.selector, 149 ether, 50 ether));
        minter.mint(nusd, POOL, TREASURY, 1 ether);
    }

    function testSurplusMintStopsAtSupplyCeiling() public {
        OracleNUSDv2 capped = new OracleNUSDv2(oracle, address(this), 60 ether);
        capped.bindSurplusMinter(address(minter));
        vm.prank(USER);
        capped.mintAtOracle{value: 1 ether}(0, USER);
        _setPrice(150 ether);

        (uint256 amount,) = capped.surplusMintCapacity();
        assertEq(amount, 10 ether, "capped by ceiling");
        vm.expectRevert(abi.encodeWithSelector(OracleNUSDv2.SupplyCeilingExceeded.selector, 11 ether, 10 ether));
        minter.mint(capped, POOL, TREASURY, 11 ether);
        minter.mint(capped, POOL, TREASURY, amount);
        assertEq(capped.totalSupply(), 60 ether, "at ceiling");
    }

    function testSurplusMintFailsClosedWhileOracleIsStale() public {
        _mint(1 ether);
        _setPrice(150 ether);
        vm.warp(vm.getBlockTimestamp() + 91 minutes);

        vm.expectRevert();
        nusd.surplusMintCapacity();
        vm.expectRevert();
        minter.mint(nusd, POOL, TREASURY, 1 ether);
    }

    function testEmergencyRedeemPaysProRataAfterGraceEvenWhenPaused() public {
        _mint(2 ether); // 100 NUSD
        vm.warp(vm.getBlockTimestamp() + 91 minutes);

        vm.expectRevert(OracleNUSDv2.OracleFailureNotReported.selector);
        nusd.emergencyRedeem(10 ether, 0, USER);

        nusd.reportOracleFailure();
        uint256 reportedAt = nusd.oracleFailureReportedAt();
        vm.prank(USER);
        vm.expectRevert(abi.encodeWithSelector(OracleNUSDv2.OracleFailureGracePending.selector, reportedAt + 7 days));
        nusd.emergencyRedeem(10 ether, 0, USER);

        nusd.setRedeemPaused(true);
        vm.warp(reportedAt + 7 days);
        uint256 before = USER.balance;
        vm.prank(USER);
        uint256 out = nusd.emergencyRedeem(25 ether, 0.5 ether, USER);
        assertEq(out, 0.5 ether, "pro rata share");
        assertEq(USER.balance - before, 0.5 ether, "paid");
        assertEq(nusd.totalSupply(), 75 ether, "burned");
        assertEq(nusd.totalCollateralWei(), 1.5 ether, "collateral left");
    }

    function testOracleRecoveryClosesTheEmergencyExit() public {
        _mint(1 ether);
        vm.warp(vm.getBlockTimestamp() + 91 minutes);
        nusd.reportOracleFailure();

        vm.warp(vm.getBlockTimestamp() + 7 days);
        _setPrice(50 ether);
        vm.expectRevert(OracleNUSDv2.OracleHealthy.selector);
        nusd.reportOracleFailure();
        nusd.clearOracleFailure();
        assertEq(nusd.oracleFailureReportedAt(), 0, "cleared");

        vm.prank(USER);
        vm.expectRevert(OracleNUSDv2.OracleFailureNotReported.selector);
        nusd.emergencyRedeem(1 ether, 0, USER);
    }

    /// Any surplus mint leaves the reserve worth >= 2x supply, and none is possible below 3x.
    function testFuzzSurplusMintKeepsTwoXFloor(uint256 rawDeposit, uint256 rawPrice, uint256 rawBurn) public {
        uint256 deposit = bound(rawDeposit, 0.001 ether, 500 ether);
        uint256 supply = _mint(deposit);
        uint256 burned = bound(rawBurn, 0, supply - 1);
        if (burned != 0) {
            vm.prank(USER);
            nusd.burn(burned);
        }
        _setPrice(bound(rawPrice, 1 ether, 2_000 ether));

        (uint256 amount, bool triggerReached) = nusd.surplusMintCapacity();
        uint256 reserve = nusd.reserveValueNusd();
        if (!triggerReached) {
            assertLe(reserve, 3 * nusd.totalSupply(), "trigger flag wrong");
            if (amount != 0) {
                vm.expectRevert();
                minter.mint(nusd, POOL, TREASURY, amount);
            }
            return;
        }
        if (amount == 0) return;
        minter.mint(nusd, POOL, TREASURY, amount);
        assertGe(reserve, 2 * nusd.totalSupply(), "below 2x after mint");
        assertLe(reserve, 2 * nusd.totalSupply() + 2, "did not mint down to 2x");
        assertEq(nusd.balanceOf(POOL) + nusd.balanceOf(TREASURY), amount, "split lost NUSD");
        assertLe(nusd.balanceOf(TREASURY) - nusd.balanceOf(POOL), 1, "split not 50/50");
    }
}
