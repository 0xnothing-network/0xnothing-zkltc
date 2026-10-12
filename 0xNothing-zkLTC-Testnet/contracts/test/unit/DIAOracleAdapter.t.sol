// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "../TestBase.sol";
import {TwoStepAdmin} from "../../src/common/TwoStepAdmin.sol";
import {DIAOracleAdapter} from "../../src/nusd/DIAOracleAdapter.sol";
import {OracleNUSD} from "../../src/nusd/OracleNUSD.sol";
import {MockDIAFeed} from "../mocks/MockDIAFeed.sol";

contract DIAOracleAdapterTest is TestBase {
    uint256 private constant MAX_AGE = 30 minutes;
    uint256 private constant MIN_PRICE = 1 ether;
    uint256 private constant MAX_PRICE = 10_000 ether;
    uint256 private constant DEVIATION_BPS = 1_000;
    int256 private constant BASE_ANSWER = 47_12500000;
    uint256 private constant BASE_PRICE = 47_125000000000000000;
    address private constant OUTSIDER = address(0xBAD);

    MockDIAFeed private feed;
    DIAOracleAdapter private adapter;
    uint80 private round = 7;

    function setUp() public {
        vm.warp(1_000_000);
        feed = new MockDIAFeed(8);
        feed.setRound(round, BASE_ANSWER, block.timestamp - 1 minutes, round);
        adapter = new DIAOracleAdapter(address(feed), MAX_AGE, address(this), MIN_PRICE, MAX_PRICE, DEVIATION_BPS);
        adapter.syncPrice();
    }

    function testConstructorStoresConfigurationAndSyncSetsAnchor() public view {
        assertEq(adapter.maxPriceAge(), MAX_AGE, "max age");
        assertEq(adapter.minPriceWad(), MIN_PRICE, "min");
        assertEq(adapter.maxPriceWad(), MAX_PRICE, "max");
        assertEq(adapter.maxDeviationBps(), DEVIATION_BPS, "deviation");
        assertTrue(adapter.enforceAnsweredInRound(), "answeredInRound enforced");
        assertEq(adapter.anchorPriceWad(), BASE_PRICE, "anchor price");
        assertEq(adapter.anchorUpdatedAt(), block.timestamp - 1 minutes, "anchor time");
        assertEq(uint256(adapter.anchorRoundId()), 7, "anchor round");
        assertEq(adapter.admin(), address(this), "admin");
    }

    function testNormalizesAndReturnsFreshPrice() public view {
        (uint256 price, uint256 updatedAt, uint80 roundId) = adapter.readPriceWad();
        assertEq(price, BASE_PRICE, "normalized price");
        assertEq(updatedAt, block.timestamp - 1 minutes, "updated at");
        assertEq(uint256(roundId), 7, "round");
        assertTrue(adapter.isFresh(), "fresh");
    }

    function testStalenessBoundaryIsInclusive() public {
        _setRound(BASE_ANSWER, block.timestamp - MAX_AGE);
        adapter.readPriceWad();

        _setRound(BASE_ANSWER, block.timestamp - MAX_AGE - 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                DIAOracleAdapter.StaleOraclePrice.selector, block.timestamp - MAX_AGE - 1, block.timestamp
            )
        );
        adapter.readPriceWad();
        assertFalse(adapter.isFresh(), "stale is not fresh");
    }

    function testRejectsNegativeAndIncompleteRounds() public {
        feed.setRound(9, -1, block.timestamp, 9);
        vm.expectRevert(DIAOracleAdapter.InvalidOracleAnswer.selector);
        adapter.readPriceWad();

        feed.setRound(10, BASE_ANSWER, block.timestamp, 9);
        vm.expectRevert(DIAOracleAdapter.IncompleteOracleRound.selector);
        adapter.readPriceWad();

        feed.setRound(0, BASE_ANSWER, block.timestamp, 0);
        vm.expectRevert(DIAOracleAdapter.InvalidOracleAnswer.selector);
        adapter.readPriceWad();

        feed.setRound(11, BASE_ANSWER, 0, 11);
        vm.expectRevert(DIAOracleAdapter.InvalidOracleAnswer.selector);
        adapter.readPriceWad();
    }

    function testRejectsFutureTimestamp() public {
        feed.setRound(11, BASE_ANSWER, block.timestamp + 1, 11);
        vm.expectRevert(DIAOracleAdapter.FutureOracleTimestamp.selector);
        adapter.readPriceWad();
    }

    function testAnsweredInRoundEnforcementCanBeDisabledToAvoidBricking() public {
        feed.setRound(20, BASE_ANSWER, block.timestamp, 0);
        vm.expectRevert(DIAOracleAdapter.IncompleteOracleRound.selector);
        adapter.readPriceWad();

        vm.prank(OUTSIDER);
        vm.expectRevert(TwoStepAdmin.Unauthorized.selector);
        adapter.setEnforceAnsweredInRound(false);

        adapter.setEnforceAnsweredInRound(false);
        (uint256 price,,) = adapter.readPriceWad();
        assertEq(price, BASE_PRICE, "accepted without answeredInRound");
    }

    function testDiaStyleRoundsKeepMintAndRedeemLive() public {
        OracleNUSD nusd = new OracleNUSD(adapter, address(this), type(uint256).max);
        vm.deal(address(this), 10 ether);

        uint256 publishedAt = block.timestamp;
        for (uint256 i; i < 6; ++i) {
            vm.warp(publishedAt + i * 5 minutes);
            ++round;
            feed.setRound(round, BASE_ANSWER, publishedAt, round);
            uint256 minted = nusd.mintAtOracle{value: 1 ether}(0, address(this));
            assertGt(minted, 0, "mint live");
            assertGt(nusd.redeemAtOracle(minted / 2, 0, address(this)), 0, "redeem live");
        }
    }

    function testRejectsPriceOutsideBounds() public {
        adapter.setMaxDeviationBps(0);
        _setRound(int256(MIN_PRICE / 1e10) - 1, block.timestamp);
        vm.expectPartialRevert(DIAOracleAdapter.PriceOutOfBounds.selector);
        adapter.readPriceWad();

        _setRound(int256(MAX_PRICE / 1e10) + 1, block.timestamp);
        vm.expectPartialRevert(DIAOracleAdapter.PriceOutOfBounds.selector);
        adapter.readPriceWad();

        _setRound(int256(MAX_PRICE / 1e10), block.timestamp);
        (uint256 price,,) = adapter.readPriceWad();
        assertEq(price, MAX_PRICE, "upper bound inclusive");

        adapter.setPriceBounds(MIN_PRICE, MAX_PRICE * 2);
        _setRound(int256(MAX_PRICE / 1e10) + 1, block.timestamp);
        adapter.readPriceWad();
    }

    function testDeviationRejectsAbruptMoveAndAcceptsAllowance() public {
        _setRound(BASE_ANSWER * 111 / 100, block.timestamp);
        vm.expectPartialRevert(DIAOracleAdapter.PriceDeviationExceeded.selector);
        adapter.readPriceWad();
        vm.expectPartialRevert(DIAOracleAdapter.PriceDeviationExceeded.selector);
        adapter.syncPrice();
        assertFalse(adapter.isFresh(), "deviating price is not usable");

        _setRound(BASE_ANSWER * 110 / 100, block.timestamp);
        (uint256 price,,) = adapter.readPriceWad();
        assertEq(price, BASE_PRICE * 110 / 100, "ten percent accepted");

        _setRound(BASE_ANSWER * 90 / 100, block.timestamp);
        adapter.readPriceWad();
        _setRound(BASE_ANSWER * 89 / 100, block.timestamp);
        vm.expectPartialRevert(DIAOracleAdapter.PriceDeviationExceeded.selector);
        adapter.readPriceWad();
    }

    function testSyncRatchetsAnchorInAllowedSteps() public {
        _setRound(BASE_ANSWER * 110 / 100, block.timestamp);
        adapter.syncPrice();
        assertEq(adapter.anchorPriceWad(), BASE_PRICE * 110 / 100, "anchor moved");

        _setRound(BASE_ANSWER * 121 / 100, block.timestamp);
        (uint256 price,,) = adapter.readPriceWad();
        assertEq(price, BASE_PRICE * 121 / 100, "second step accepted from new anchor");
    }

    function testDeviationAllowanceGrowsWithTimeSoLargeMovesSelfHeal() public {
        int256 crashed = BASE_ANSWER * 75 / 100;
        _setRound(crashed, block.timestamp);
        vm.expectPartialRevert(DIAOracleAdapter.PriceDeviationExceeded.selector);
        adapter.readPriceWad();

        uint256 anchorTime = adapter.anchorUpdatedAt();
        vm.warp(anchorTime + 2 * MAX_AGE - 1);
        _setRound(crashed, block.timestamp);
        vm.expectPartialRevert(DIAOracleAdapter.PriceDeviationExceeded.selector);
        adapter.readPriceWad();

        vm.warp(anchorTime + 2 * MAX_AGE);
        _setRound(crashed, block.timestamp);
        (uint256 price,,) = adapter.readPriceWad();
        assertEq(price, BASE_PRICE * 75 / 100, "recovered without keeper or admin");
    }

    function testSameRoundAsAnchorSkipsDeviation() public {
        adapter.setMaxDeviationBps(1);
        (uint256 price,,) = adapter.readPriceWad();
        assertEq(price, BASE_PRICE, "anchored round");
    }

    function testUnanchoredOrDisabledDeviationIsNotEnforced() public {
        DIAOracleAdapter fresh =
            new DIAOracleAdapter(address(feed), MAX_AGE, address(this), MIN_PRICE, MAX_PRICE, DEVIATION_BPS);
        _setRound(BASE_ANSWER * 3, block.timestamp);
        fresh.readPriceWad();

        vm.expectPartialRevert(DIAOracleAdapter.PriceDeviationExceeded.selector);
        adapter.readPriceWad();
        adapter.setMaxDeviationBps(0);
        adapter.readPriceWad();
    }

    function testAdminResetAnchorRecoversImmediatelyButKeepsOtherChecks() public {
        _setRound(BASE_ANSWER * 2, block.timestamp);
        vm.expectPartialRevert(DIAOracleAdapter.PriceDeviationExceeded.selector);
        adapter.readPriceWad();

        vm.prank(OUTSIDER);
        vm.expectRevert(TwoStepAdmin.Unauthorized.selector);
        adapter.resetPriceAnchor();

        assertEq(adapter.resetPriceAnchor(), BASE_PRICE * 2, "reset price");
        assertEq(adapter.anchorPriceWad(), BASE_PRICE * 2, "anchor reset");
        adapter.readPriceWad();

        _setRound(BASE_ANSWER * 2, block.timestamp - MAX_AGE - 1);
        vm.expectPartialRevert(DIAOracleAdapter.StaleOraclePrice.selector);
        adapter.resetPriceAnchor();

        _setRound(int256(MAX_PRICE / 1e10) + 1, block.timestamp);
        vm.expectPartialRevert(DIAOracleAdapter.PriceOutOfBounds.selector);
        adapter.resetPriceAnchor();
    }

    function testSettersAreAdminOnlyAndBounded() public {
        vm.startPrank(OUTSIDER);
        vm.expectRevert(TwoStepAdmin.Unauthorized.selector);
        adapter.setMaxPriceAge(1 hours);
        vm.expectRevert(TwoStepAdmin.Unauthorized.selector);
        adapter.setPriceBounds(1, 2);
        vm.expectRevert(TwoStepAdmin.Unauthorized.selector);
        adapter.setMaxDeviationBps(1);
        vm.stopPrank();

        vm.expectRevert(DIAOracleAdapter.InvalidMaxPriceAge.selector);
        adapter.setMaxPriceAge(2 hours + 1);
        vm.expectRevert(DIAOracleAdapter.InvalidMaxPriceAge.selector);
        adapter.setMaxPriceAge(5 minutes - 1);
        adapter.setMaxPriceAge(2 hours);
        assertEq(adapter.maxPriceAge(), 2 hours, "cap allowed");

        vm.expectRevert(DIAOracleAdapter.InvalidPriceBounds.selector);
        adapter.setPriceBounds(0, 1);
        vm.expectRevert(DIAOracleAdapter.InvalidPriceBounds.selector);
        adapter.setPriceBounds(2, 2);

        vm.expectRevert(DIAOracleAdapter.InvalidDeviation.selector);
        adapter.setMaxDeviationBps(10_001);
        adapter.setMaxDeviationBps(10_000);
        assertEq(adapter.maxDeviationBps(), 10_000, "full range allowed");
    }

    function _setRound(int256 answer, uint256 updatedAt) private {
        ++round;
        feed.setRound(round, answer, updatedAt, round);
    }

    receive() external payable {}
}
