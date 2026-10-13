// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "../TestBase.sol";
import {DIAOracleAdapter} from "../../src/nusd/DIAOracleAdapter.sol";
import {MathX} from "../../src/common/MathX.sol";
import {MockDIAFeed} from "../mocks/MockDIAFeed.sol";

contract DIAOracleAdapterFuzzTest is TestBase {
    uint256 private constant NOW = 10_000_000;

    function setUp() public {
        vm.warp(NOW);
    }

    function testFuzzNormalizesEverySupportedDecimals(uint8 rawDecimals, uint256 rawAnswer) public {
        uint8 decimals = uint8(bound(rawDecimals, 0, 36));
        uint256 maxAnswer = uint256(type(int256).max);
        if (decimals < 18) maxAnswer = MathX.min(maxAnswer, type(uint256).max / (10 ** (18 - decimals)));
        uint256 answer = bound(rawAnswer, 1, maxAnswer);

        MockDIAFeed feed = new MockDIAFeed(decimals);
        feed.setRound(1, int256(answer), NOW, 1);
        DIAOracleAdapter adapter = new DIAOracleAdapter(address(feed), 1 hours, address(this), 1, type(uint256).max, 0);
        assertEq(uint256(adapter.feedDecimals()), decimals, "decimals");

        uint256 expected;
        if (decimals <= 18) expected = answer * (10 ** (18 - decimals));
        else expected = answer / (10 ** (decimals - 18));

        if (expected == 0) {
            vm.expectRevert(DIAOracleAdapter.InvalidOracleAnswer.selector);
            adapter.readPriceWad();
            assertFalse(adapter.isFresh(), "zero price not fresh");
            return;
        }
        (uint256 priceWad,,) = adapter.readPriceWad();
        assertEq(priceWad, expected, "normalized price");
    }

    function testFuzzRejectsDecimalsAbove36(uint8 rawDecimals) public {
        uint8 decimals = uint8(bound(rawDecimals, 37, type(uint8).max));
        MockDIAFeed feed = new MockDIAFeed(decimals);
        vm.expectRevert(DIAOracleAdapter.InvalidFeedDecimals.selector);
        new DIAOracleAdapter(address(feed), 1 hours, address(this), 1, type(uint256).max, 0);
    }

    function testFuzzStalenessBoundary(uint256 rawMaxAge, uint256 rawAge) public {
        uint256 maxAge = bound(rawMaxAge, 5 minutes, 2 hours);
        uint256 age = bound(rawAge, 0, 3 hours);
        MockDIAFeed feed = new MockDIAFeed(8);
        feed.setRound(5, 50e8, NOW - age, 5);
        DIAOracleAdapter adapter = new DIAOracleAdapter(address(feed), maxAge, address(this), 1, type(uint256).max, 0);

        if (age > maxAge) {
            vm.expectRevert(abi.encodeWithSelector(DIAOracleAdapter.StaleOraclePrice.selector, NOW - age, NOW));
            adapter.readPriceWad();
            assertFalse(adapter.isFresh(), "stale");
        } else {
            (uint256 priceWad, uint256 updatedAt,) = adapter.readPriceWad();
            assertEq(priceWad, 50 ether, "fresh price");
            assertEq(updatedAt, NOW - age, "timestamp");
        }
    }

    function testFuzzRejectsFutureTimestamps(uint256 rawAhead) public {
        uint256 ahead = bound(rawAhead, 1, 365 days);
        MockDIAFeed feed = new MockDIAFeed(8);
        feed.setRound(5, 50e8, NOW + ahead, 5);
        DIAOracleAdapter adapter = new DIAOracleAdapter(address(feed), 1 hours, address(this), 1, type(uint256).max, 0);
        vm.expectRevert(DIAOracleAdapter.FutureOracleTimestamp.selector);
        adapter.readPriceWad();
    }

    function testFuzzMaxPriceAgeSetterIsCapped(uint256 rawAge) public {
        MockDIAFeed feed = new MockDIAFeed(8);
        DIAOracleAdapter adapter =
            new DIAOracleAdapter(address(feed), 30 minutes, address(this), 1, type(uint256).max, 0);
        if (rawAge < 5 minutes || rawAge > 2 hours) {
            vm.expectRevert(DIAOracleAdapter.InvalidMaxPriceAge.selector);
            adapter.setMaxPriceAge(rawAge);
        } else {
            adapter.setMaxPriceAge(rawAge);
            assertEq(adapter.maxPriceAge(), rawAge, "max age");
        }
    }

    function testFuzzDeviationAcceptsExactlyTheAllowance(uint256 rawBps, uint256 rawPrice, uint256 rawElapsed) public {
        uint256 deviationBps = bound(rawBps, 1, 10_000);
        uint256 newPrice = bound(rawPrice, 1e8, 1_000e8);
        uint256 elapsed = bound(rawElapsed, 0, 2 hours);
        MockDIAFeed feed = new MockDIAFeed(8);
        feed.setRound(1, 100e8, NOW, 1);
        DIAOracleAdapter adapter =
            new DIAOracleAdapter(address(feed), 1 hours, address(this), 1, type(uint256).max, deviationBps);
        adapter.syncPrice();

        vm.warp(NOW + elapsed);
        feed.setRound(2, int256(newPrice), NOW + elapsed, 2);
        uint256 anchor = 100 ether;
        uint256 priceWad = newPrice * 1e10;
        uint256 intervals = elapsed / 1 hours + 1;
        if (intervals > 3) intervals = 3;
        uint256 allowed = anchor * deviationBps * intervals / 10_000;
        uint256 difference = priceWad > anchor ? priceWad - anchor : anchor - priceWad;

        if (difference > allowed) {
            vm.expectRevert(
                abi.encodeWithSelector(DIAOracleAdapter.PriceDeviationExceeded.selector, anchor, priceWad, allowed)
            );
            adapter.readPriceWad();
        } else {
            (uint256 accepted,,) = adapter.readPriceWad();
            assertEq(accepted, priceWad, "accepted price");
        }
    }
}

