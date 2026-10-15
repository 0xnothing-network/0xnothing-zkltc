// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TwoStepAdmin} from "../common/TwoStepAdmin.sol";
import {IPriceOracle} from "./IPriceOracle.sol";

/// @title Oracle router
/// @notice A stable price address for one asset. NUSD, the synth vaults and lending bind to this
///         router once; the source behind it can be replaced by the admin (the owner wallet), so a
///         new or failed DIA feed never forces those contracts to be redeployed.
contract OracleRouter is TwoStepAdmin, IPriceOracle {
    error InvalidSource();
    error SourceUnusable();
    error SourceDeviation(uint256 currentPriceWad, uint256 newPriceWad);

    /// @notice A replacement may differ from a still-working source by at most 25%.
    uint256 public constant MAX_SWITCH_DEVIATION_BPS = 2_500;
    uint256 private constant BPS = 10_000;

    string public description;
    IPriceOracle public source;

    event SourceUpdated(address indexed previousSource, address indexed newSource, uint256 priceWad);

    constructor(string memory description_, address initialSource, address initialAdmin)
        TwoStepAdmin(initialAdmin)
    {
        if (initialSource.code.length == 0) revert InvalidSource();
        description = description_;
        source = IPriceOracle(initialSource);
        emit SourceUpdated(address(0), initialSource, 0);
    }

    function readPriceWad() external view returns (uint256 priceWad, uint256 updatedAt, uint80 roundId) {
        return source.readPriceWad();
    }

    function isFresh() external view returns (bool) {
        try source.readPriceWad() returns (uint256 priceWad, uint256, uint80) {
            return priceWad != 0;
        } catch {
            return false;
        }
    }

    /// @notice Points the router at a new source. The new source must price right now; while the
    ///         current one still prices, the two may differ by at most 25%. A dead source can be
    ///         replaced without the comparison, which is the point of the router.
    function setSource(address newSource) external onlyAdmin {
        if (newSource.code.length == 0 || newSource == address(source)) revert InvalidSource();
        uint256 newPrice;
        try IPriceOracle(newSource).readPriceWad() returns (uint256 priceWad, uint256, uint80) {
            newPrice = priceWad;
        } catch {
            revert SourceUnusable();
        }
        if (newPrice == 0) revert SourceUnusable();

        try source.readPriceWad() returns (uint256 currentPrice, uint256, uint80) {
            if (currentPrice != 0) {
                uint256 difference = newPrice > currentPrice ? newPrice - currentPrice : currentPrice - newPrice;
                if (difference * BPS > currentPrice * MAX_SWITCH_DEVIATION_BPS) {
                    revert SourceDeviation(currentPrice, newPrice);
                }
            }
        } catch {
            // The current source is down: replacing it is exactly what the router is for.
        }

        address previous = address(source);
        source = IPriceOracle(newSource);
        emit SourceUpdated(previous, newSource, newPrice);
    }
}
