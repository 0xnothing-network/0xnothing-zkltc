// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IZeroXFiFactory {
    function owner() external view returns (address);
    function nusd() external view returns (address);
    function pump() external view returns (address);
    function router() external view returns (address);
    function pendingRouter() external view returns (address);
    function pendingRouterActivationTime() external view returns (uint256);
    function graduationAdapter() external view returns (address);
    function swapsPaused() external view returns (bool);
    function getPair(address tokenA, address tokenB) external view returns (address pair);
    function isPair(address candidate) external view returns (bool);
    function isPumpToken(address token) external view returns (bool);
    function pairId(address tokenA, address tokenB) external pure returns (bytes32 id);
    function bindRouter(address router_) external;
    function scheduleRouter(address newRouter) external;
    function activateRouter() external;
    function cancelRouterUpdate() external;
    function createPair(address tokenA, address tokenB) external returns (address pair);
    function preparePumpPair(address pumpToken) external returns (address pair);
}
