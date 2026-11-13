// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { DIAOracleV2Adapter } from "../../src/oracle/DIAOracleV2Adapter.sol";
import { TestBase } from "../helpers/TestBase.sol";
import { MockDIAAggregatorV3 } from "../mocks/RiskMocks.sol";

/// The 0xFi copy of the price adapter carries the same change as the core adapter
/// (docs/AUDIT_2026-11.md, section 9.6, S-01): a round stamped up to MAX_FUTURE_SKEW ahead of the
/// clock of the chain is read as fresh as of now instead of making every read revert.
contract OracleAdapterAuditTest is TestBase {
    function testAudit_S01_futureStampWithinTheSkewIsReadAndBeyondItRejected() public {
        vm.warp(1_000_000);
        MockDIAAggregatorV3 feed = new MockDIAAggregatorV3(8, "BTC/USD");
        feed.setRound(1, 100_000e8, 1_000_005, 1);
        DIAOracleV2Adapter adapter =
            new DIAOracleV2Adapter(address(feed), "BTC/USD", 90 minutes, 5000 ether, 500_000 ether);

        (uint256 price, uint256 updatedAt,) = adapter.readPriceWad();
        assertEq(price, 100_000 ether, "the price is read");
        assertEq(updatedAt, 1_000_000, "as fresh as of now");

        feed.setRound(2, 100_000e8, 1_000_060, 2);
        (, updatedAt,) = adapter.readPriceWad();
        assertEq(updatedAt, 1_000_000, "sixty seconds ahead is the limit and is still read");

        feed.setRound(3, 100_000e8, 1_000_061, 3);
        vm.expectRevert(DIAOracleV2Adapter.FutureOracleTimestamp.selector);
        adapter.readPriceWad();
        assertFalse(adapter.isFresh(), "not fresh");
    }
}
