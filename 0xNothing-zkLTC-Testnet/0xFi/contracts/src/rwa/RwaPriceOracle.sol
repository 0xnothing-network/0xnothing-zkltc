// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { IPriceOracle } from "../oracle/interfaces/IPriceOracle.sol";

/// @notice Cross-rates two independent asset/USD and two settlement/USD adapters.
/// @dev Adapters must normalize to WAD, authenticate their feed identity and enforce
/// feed-specific bounds. No owner, manual price override or stale-price fallback.
contract RwaPriceOracle is IPriceOracle {
    error InvalidConfiguration();
    error InvalidPrice();
    error SourcesDisagree();

    IPriceOracle public immutable assetPrimary;
    IPriceOracle public immutable assetSecondary;
    IPriceOracle public immutable settlementPrimary;
    IPriceOracle public immutable settlementSecondary;
    uint256 public immutable maxAge;
    uint256 public immutable maxDeviationBps;

    constructor(address[4] memory sources, uint256 age, uint256 deviationBps) {
        if (age < 5 minutes || age > 1 days || deviationBps == 0 || deviationBps > 500) {
            revert InvalidConfiguration();
        }
        for (uint256 i; i < 4; ++i) {
            if (sources[i].code.length == 0) revert InvalidConfiguration();
            for (uint256 j; j < i; ++j) {
                if (sources[i] == sources[j]) revert InvalidConfiguration();
            }
        }
        assetPrimary = IPriceOracle(sources[0]);
        assetSecondary = IPriceOracle(sources[1]);
        settlementPrimary = IPriceOracle(sources[2]);
        settlementSecondary = IPriceOracle(sources[3]);
        maxAge = age;
        maxDeviationBps = deviationBps;
    }

    function readPriceWad() external view returns (uint256 priceWad, uint256 updatedAt, uint80 roundId) {
        (uint256 assetPrice, uint256 assetTime, uint80 assetRound) = _pair(assetPrimary, assetSecondary);
        (uint256 settlementPrice, uint256 settlementTime,) = _pair(settlementPrimary, settlementSecondary);
        priceWad = Math.mulDiv(assetPrice, 1e18, settlementPrice);
        if (priceWad == 0) revert InvalidPrice();
        return (priceWad, Math.min(assetTime, settlementTime), assetRound);
    }

    function _pair(IPriceOracle primary, IPriceOracle secondary)
        private
        view
        returns (uint256 price, uint256 timestamp, uint80 round)
    {
        (uint256 a, uint256 at, uint80 ar) = _read(primary);
        (uint256 b, uint256 bt,) = _read(secondary);
        uint256 low = Math.min(a, b);
        uint256 high = Math.max(a, b);
        // Round up: even a fractional excess over the allowed deviation fails.
        if (Math.mulDiv(high - low, 10_000, low, Math.Rounding.Ceil) > maxDeviationBps) {
            revert SourcesDisagree();
        }
        return (low + (high - low) / 2, Math.min(at, bt), ar);
    }

    function _read(IPriceOracle source) private view returns (uint256 price, uint256 timestamp, uint80 round) {
        (price, timestamp, round) = source.readPriceWad();
        if (
            price == 0 || round == 0 || timestamp == 0 || timestamp > block.timestamp
                || block.timestamp - timestamp > maxAge
        ) revert InvalidPrice();
    }
}
