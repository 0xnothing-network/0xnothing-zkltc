// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Always-fresh DIA-style feed with a chosen description, for local rehearsals of the deploy scripts.
contract NamedDIAFeed {
    string public description;
    uint8 public constant decimals = 8;
    int256 private immutable _answer;

    constructor(string memory description_, int256 answer_) {
        description = description_;
        _answer = answer_;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, _answer, block.timestamp, block.timestamp, 1);
    }
}
