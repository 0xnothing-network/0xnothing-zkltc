// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// A DIA-style feed that can be switched to consume all the gas it is given, the way a contract
/// does when it hits an invalid opcode or an endless loop, instead of reverting cheaply.
contract GasBurningFeed {
    uint8 public constant decimals = 8;
    string public description = "Mock LTC/USD";
    bool public burning;
    uint256 private stamp;

    constructor() {
        stamp = block.timestamp;
    }

    function setBurning(bool value) external {
        burning = value;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        if (burning) {
            assembly {
                invalid()
            }
        }
        return (1, 100e8, stamp, stamp, 1);
    }
}
