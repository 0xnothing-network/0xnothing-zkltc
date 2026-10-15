// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockDIAFeed {
    uint8 public immutable decimals;
    string public description = "Mock LTC/USD";

    uint80 public roundId;
    int256 public answer;
    uint256 public startedAt;
    uint256 public updatedAt;
    uint80 public answeredInRound;

    constructor(uint8 feedDecimals) {
        decimals = feedDecimals;
    }

    function setRound(uint80 id, int256 price, uint256 timestamp, uint80 completedInRound) external {
        roundId = id;
        answer = price;
        startedAt = timestamp;
        updatedAt = timestamp;
        answeredInRound = completedInRound;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, answer, startedAt, updatedAt, answeredInRound);
    }
}
