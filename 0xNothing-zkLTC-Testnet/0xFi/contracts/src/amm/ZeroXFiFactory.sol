// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { EmergencyGuardian } from "../access/EmergencyGuardian.sol";
import { ZeroXFiPair } from "./ZeroXFiPair.sol";

contract ZeroXFiFactory is EmergencyGuardian {
    error AdapterAlreadyBound();
    error Forbidden();
    error IdenticalTokens();
    error InvalidContract();
    error PairExists();
    error ProtectedPumpPair();
    error RouterAlreadyBound();
    error RouterUpdateAlreadyScheduled();
    error RouterUpdateNotReady();
    error RouterUpdateNotScheduled();

    uint256 public constant ROUTER_UPDATE_DELAY = 48 hours;

    address public immutable nusd;
    address public immutable pump;
    address public router;
    address public pendingRouter;
    uint256 public pendingRouterActivationTime;
    address public graduationAdapter;
    bool public swapsPaused;

    mapping(address => mapping(address => address)) public getPair;
    mapping(address => bool) public isPair;
    address[] public allPairs;

    event PairCreated(
        address indexed token0,
        address indexed token1,
        address pair,
        bytes32 indexed pairId,
        bool protectedBootstrap,
        uint256 pairCount
    );
    event GraduationAdapterBound(address indexed adapter);
    event RouterBound(address indexed router);
    event RouterUpdateScheduled(address indexed currentRouter, address indexed pendingRouter, uint256 activateAt);
    event RouterUpdateCancelled(address indexed cancelledRouter, address indexed caller);
    event RouterUpdateActivated(address indexed previousRouter, address indexed newRouter);
    event SwapsPauseUpdated(bool paused);

    constructor(address initialOwner, address nusd_, address pump_) EmergencyGuardian(initialOwner) {
        if (nusd_.code.length == 0 || pump_.code.length == 0) revert InvalidContract();
        nusd = nusd_;
        pump = pump_;
    }

    function allPairsLength() external view returns (uint256) {
        return allPairs.length;
    }

    function bindGraduationAdapter(address adapter) external onlyOwner {
        if (graduationAdapter != address(0)) revert AdapterAlreadyBound();
        if (adapter.code.length == 0) revert InvalidContract();
        graduationAdapter = adapter;
        emit GraduationAdapterBound(adapter);
    }

    function bindRouter(address router_) external onlyOwner {
        if (router != address(0)) revert RouterAlreadyBound();
        _validateRouter(router_);
        router = router_;
        emit RouterBound(router_);
    }

    function scheduleRouter(address newRouter) external onlyOwner {
        if (router == address(0)) revert InvalidContract();
        if (pendingRouter != address(0)) revert RouterUpdateAlreadyScheduled();
        if (newRouter == router) revert InvalidContract();
        _validateRouter(newRouter);
        // Router recovery intentionally follows chain time and cannot be accelerated by the owner.
        // forge-lint: disable-next-line(block-timestamp)
        uint256 activateAt = block.timestamp + ROUTER_UPDATE_DELAY;
        pendingRouter = newRouter;
        pendingRouterActivationTime = activateAt;
        emit RouterUpdateScheduled(router, newRouter, activateAt);
    }

    function activateRouter() external onlyOwner {
        address newRouter = pendingRouter;
        if (newRouter == address(0)) revert RouterUpdateNotScheduled();
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < pendingRouterActivationTime) revert RouterUpdateNotReady();
        _validateRouter(newRouter);
        address previousRouter = router;
        pendingRouter = address(0);
        pendingRouterActivationTime = 0;
        router = newRouter;
        emit RouterUpdateActivated(previousRouter, newRouter);
    }

    function cancelRouterUpdate() external onlyOwnerOrGuardian {
        address cancelledRouter = pendingRouter;
        if (cancelledRouter == address(0)) revert RouterUpdateNotScheduled();
        pendingRouter = address(0);
        pendingRouterActivationTime = 0;
        emit RouterUpdateCancelled(cancelledRouter, msg.sender);
    }

    function setSwapsPaused(bool paused) external onlyOwner {
        swapsPaused = paused;
        emit SwapsPauseUpdated(paused);
    }

    function pauseSwaps() external onlyOwnerOrGuardian {
        swapsPaused = true;
        emit SwapsPauseUpdated(true);
    }

    function createPair(address tokenA, address tokenB) external returns (address pair) {
        (address token0, address token1) = _sortTokens(tokenA, tokenB);
        if (_isProtectedPumpPair(token0, token1)) revert ProtectedPumpPair();
        pair = _createPair(token0, token1, address(0), false);
    }

    function preparePumpPair(address pumpToken) external returns (address pair) {
        if (msg.sender != graduationAdapter || graduationAdapter == address(0)) revert Forbidden();
        if (!isPumpToken(pumpToken)) revert ProtectedPumpPair();
        (address token0, address token1) = _sortTokens(pumpToken, nusd);
        pair = _createPair(token0, token1, graduationAdapter, true);
    }

    function pairId(address tokenA, address tokenB) public pure returns (bytes32 id) {
        (address token0, address token1) = _sortTokens(tokenA, tokenB);
        id = keccak256(abi.encodePacked(token0, token1));
    }

    function isPumpToken(address token) public view returns (bool) {
        (bool success, bytes memory data) = pump.staticcall(abi.encodeWithSignature("status(address)", token));
        if (!success || data.length < 32) return false;
        uint256 lifecycle = abi.decode(data, (uint256));
        return lifecycle >= 1 && lifecycle <= 3;
    }

    function _createPair(address token0, address token1, address bootstrapper, bool protectedBootstrap)
        private
        returns (address pair)
    {
        if (token0.code.length == 0 || token1.code.length == 0) revert InvalidContract();
        if (getPair[token0][token1] != address(0)) revert PairExists();
        bytes32 id = keccak256(abi.encodePacked(token0, token1));
        pair = address(new ZeroXFiPair{ salt: id }(token0, token1, bootstrapper));
        getPair[token0][token1] = pair;
        getPair[token1][token0] = pair;
        isPair[pair] = true;
        allPairs.push(pair);
        emit PairCreated(token0, token1, pair, id, protectedBootstrap, allPairs.length);
    }

    function _isProtectedPumpPair(address token0, address token1) private view returns (bool) {
        if (token0 == nusd) return isPumpToken(token1);
        if (token1 == nusd) return isPumpToken(token0);
        return false;
    }

    function _validateRouter(address candidate) private view {
        if (candidate.code.length == 0) revert InvalidContract();
        (bool success, bytes memory data) = candidate.staticcall(abi.encodeWithSignature("factory()"));
        if (!success || data.length < 32 || abi.decode(data, (address)) != address(this)) revert InvalidContract();
    }

    function _sortTokens(address tokenA, address tokenB) private pure returns (address token0, address token1) {
        if (tokenA == tokenB) revert IdenticalTokens();
        (token0, token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        if (token0 == address(0)) revert InvalidContract();
    }
}
