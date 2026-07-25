// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IDIAAggregatorV3} from "./interfaces/IDIAAggregatorV3.sol";

contract DIAOracleAdapter {
    error InvalidFeed();
    error InvalidMaxPriceAge();
    error InvalidFeedDecimals();
    error InvalidOracleAnswer();
    error IncompleteOracleRound();
    error FutureOracleTimestamp();
    error StaleOraclePrice(uint256 updatedAt, uint256 currentTimestamp);

    uint256 public constant WAD = 1e18;

    IDIAAggregatorV3 public immutable feed;
    uint8 public immutable feedDecimals;
    uint256 public immutable maxPriceAge;

    constructor(address feedAddress, uint256 maximumPriceAge) {
        if (feedAddress == address(0) || feedAddress.code.length == 0) revert InvalidFeed();
        if (maximumPriceAge < 5 minutes || maximumPriceAge > 1 days) revert InvalidMaxPriceAge();

        IDIAAggregatorV3 oracle = IDIAAggregatorV3(feedAddress);
        uint8 oracleDecimals = oracle.decimals();
        if (oracleDecimals > 36) revert InvalidFeedDecimals();

        feed = oracle;
        feedDecimals = oracleDecimals;
        maxPriceAge = maximumPriceAge;
    }

    function readPriceWad() public view returns (uint256 priceWad, uint256 updatedAt, uint80 roundId) {
        int256 answer;
        uint80 answeredInRound;
        (roundId, answer,, updatedAt, answeredInRound) = feed.latestRoundData();

        if (roundId == 0 || answer <= 0 || updatedAt == 0) revert InvalidOracleAnswer();
        if (answeredInRound < roundId) revert IncompleteOracleRound();
        if (updatedAt > block.timestamp) revert FutureOracleTimestamp();
        if (block.timestamp - updatedAt > maxPriceAge) {
            revert StaleOraclePrice(updatedAt, block.timestamp);
        }

        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 unsignedAnswer = uint256(answer);
        if (feedDecimals == 18) {
            priceWad = unsignedAnswer;
        } else if (feedDecimals < 18) {
            priceWad = unsignedAnswer * (10 ** (18 - feedDecimals));
        } else {
            priceWad = unsignedAnswer / (10 ** (feedDecimals - 18));
        }
        if (priceWad == 0) revert InvalidOracleAnswer();
    }

    function isFresh() external view returns (bool fresh) {
        try this.readPriceWad() returns (uint256, uint256, uint80) {
            return true;
        } catch {
            return false;
        }
    }
}
