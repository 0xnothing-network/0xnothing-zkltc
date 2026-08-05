// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { IDIAAggregatorV3 } from "./interfaces/IDIAAggregatorV3.sol";
import { IPriceOracle } from "./interfaces/IPriceOracle.sol";

/// @notice Normalizes one asset-specific DIA AggregatorV3 feed to 18 decimals.
/// @dev A deployment is permanently bound to one feed description, freshness window and price range.
contract DIAOracleV2Adapter is IPriceOracle {
    error InvalidFeed();
    error InvalidFeedKey();
    error InvalidMaxPriceAge();
    error InvalidFeedDecimals();
    error InvalidPriceBounds();
    error InvalidOracleAnswer();
    error IncompleteOracleRound();
    error FutureOracleTimestamp();
    error StaleOraclePrice(uint256 updatedAt, uint256 currentTimestamp);
    error OraclePriceOutOfBounds(uint256 priceWad, uint256 minimumPriceWad, uint256 maximumPriceWad);

    uint256 public constant WAD = 1e18;
    uint256 public constant MINIMUM_PRICE_AGE = 5 minutes;
    uint256 public constant MAXIMUM_PRICE_AGE = 1 days;

    IDIAAggregatorV3 public immutable feed;
    bytes32 public immutable feedKeyHash;
    uint8 public immutable feedDecimals;
    uint256 public immutable maxPriceAge;
    uint256 public immutable minPriceWad;
    uint256 public immutable maxPriceWad;

    constructor(
        address feedAddress,
        string memory expectedFeedKey,
        uint256 maximumPriceAge,
        uint256 minimumPriceWad,
        uint256 maximumPriceWad
    ) {
        if (feedAddress == address(0) || feedAddress.code.length == 0) revert InvalidFeed();
        if (bytes(expectedFeedKey).length == 0) revert InvalidFeedKey();
        if (maximumPriceAge < MINIMUM_PRICE_AGE || maximumPriceAge > MAXIMUM_PRICE_AGE) {
            revert InvalidMaxPriceAge();
        }
        if (minimumPriceWad == 0 || minimumPriceWad >= maximumPriceWad) revert InvalidPriceBounds();

        IDIAAggregatorV3 oracleFeed = IDIAAggregatorV3(feedAddress);
        bytes32 expectedKeyHash = keccak256(bytes(expectedFeedKey));
        if (keccak256(bytes(oracleFeed.description())) != expectedKeyHash) revert InvalidFeedKey();

        uint8 decimals = oracleFeed.decimals();
        if (decimals > 36) revert InvalidFeedDecimals();

        feed = oracleFeed;
        feedKeyHash = expectedKeyHash;
        feedDecimals = decimals;
        maxPriceAge = maximumPriceAge;
        minPriceWad = minimumPriceWad;
        maxPriceWad = maximumPriceWad;
    }

    function readPriceWad() public view returns (uint256 priceWad, uint256 updatedAt, uint80 roundId) {
        int256 answer;
        uint80 answeredInRound;
        (roundId, answer,, updatedAt, answeredInRound) = feed.latestRoundData();

        if (roundId == 0 || answer <= 0 || updatedAt == 0) revert InvalidOracleAnswer();
        if (answeredInRound < roundId) revert IncompleteOracleRound();
        // Oracle freshness must be measured against the canonical chain timestamp.
        // forge-lint: disable-next-line(block-timestamp)
        if (updatedAt > block.timestamp) revert FutureOracleTimestamp();
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp - updatedAt > maxPriceAge) {
            revert StaleOraclePrice(updatedAt, block.timestamp);
        }

        // forge-lint: disable-next-line(unsafe-typecast)
        priceWad = Math.mulDiv(uint256(answer), WAD, 10 ** feedDecimals);
        if (priceWad == 0) revert InvalidOracleAnswer();
        if (priceWad < minPriceWad || priceWad > maxPriceWad) {
            revert OraclePriceOutOfBounds(priceWad, minPriceWad, maxPriceWad);
        }
    }

    function isFresh() external view returns (bool) {
        try this.readPriceWad() returns (uint256, uint256, uint80) {
            return true;
        } catch {
            return false;
        }
    }
}
