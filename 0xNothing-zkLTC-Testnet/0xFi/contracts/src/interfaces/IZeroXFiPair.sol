// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IZeroXFiPair is IERC20 {
    function MINIMUM_LIQUIDITY() external view returns (uint256);
    function LP_FEE_BPS() external view returns (uint256);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function bootstrapper() external view returns (address);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function mint(address to) external returns (uint256 liquidity);
    function burn(address to) external returns (uint256 amount0, uint256 amount1);
    function swap(uint256 amount0Out, uint256 amount1Out, address to) external;
    function skim(address to) external;
    function sync() external;
    function sweepBootstrapDonations(address sink) external;
}
