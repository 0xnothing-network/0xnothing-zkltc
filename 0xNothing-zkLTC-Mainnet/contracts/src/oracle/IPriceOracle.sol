// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The price interface every consumer reads: the DIA adapters and the oracle router.
interface IPriceOracle {
    function readPriceWad() external view returns (uint256 priceWad, uint256 updatedAt, uint80 roundId);
}
