// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// A DIA-style feed whose read spends a chosen amount of gas before giving an ordinary, fresh
/// answer. Used to rehearse the deploy script's check that an oracle read is cheap.
contract CostlyDIAFeed {
    string public description;
    uint8 public constant decimals = 8;
    int256 private immutable _answer;
    uint256 private immutable _gasToSpend;

    constructor(string memory description_, int256 answer_, uint256 gasToSpend_) {
        description = description_;
        _answer = answer_;
        _gasToSpend = gasToSpend_;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        uint256 stopAt = gasleft() - _gasToSpend;
        uint256 turns;
        while (gasleft() > stopAt) {
            unchecked {
                ++turns;
            }
        }
        return (1, _answer, block.timestamp, block.timestamp, 1);
    }
}
