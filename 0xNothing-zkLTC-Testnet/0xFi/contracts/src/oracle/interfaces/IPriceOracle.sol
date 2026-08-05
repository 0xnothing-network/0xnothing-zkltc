// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IPriceOracle {
    function readPriceWad() external view returns (uint256 priceWad, uint256 updatedAt, uint80 roundId);
}
