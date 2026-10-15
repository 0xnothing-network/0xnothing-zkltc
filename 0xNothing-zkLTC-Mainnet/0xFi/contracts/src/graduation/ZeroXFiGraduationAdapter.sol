// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IGraduationAdapter } from "../interfaces/IGraduationAdapter.sol";
import { IZeroXFiFactory } from "../interfaces/IZeroXFiFactory.sol";
import { IZeroXFiPair } from "../interfaces/IZeroXFiPair.sol";

contract ZeroXFiGraduationAdapter is IGraduationAdapter, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error AssetTransferMismatch();
    error DeadlineExpired();
    error InvalidConfiguration();
    error InvalidGraduationCaller();
    error InvalidPoolState();
    error MinimumLiquidityNotMet();

    address public constant DONATION_SINK = address(1);

    IZeroXFiFactory public immutable factory;
    address public immutable pumpRouter;
    address public immutable nusd;
    address public immutable pump;

    event PumpPoolPrepared(address indexed token, address indexed pool, bytes32 indexed pairId);
    event PumpLiquidityBootstrapped(
        address indexed token,
        address indexed pool,
        uint256 tokenAmount,
        uint256 nusdAmount,
        uint256 lpAmount,
        address lpRecipient
    );

    constructor(address factory_, address pumpRouter_, address nusd_, address pump_) {
        if (
            factory_.code.length == 0 || pumpRouter_.code.length == 0 || nusd_.code.length == 0
                || pump_.code.length == 0
        ) {
            revert InvalidConfiguration();
        }
        IZeroXFiFactory configuredFactory = IZeroXFiFactory(factory_);
        if (configuredFactory.nusd() != nusd_ || configuredFactory.pump() != pump_) revert InvalidConfiguration();
        if (_readAddress(pumpRouter_, bytes4(keccak256("pump()"))) != pump_) revert InvalidConfiguration();
        if (_readAddress(pump_, bytes4(keccak256("graduationRouter()"))) != pumpRouter_) {
            revert InvalidConfiguration();
        }
        if (_readAddress(pump_, bytes4(keccak256("NUSD()"))) != nusd_) revert InvalidConfiguration();

        factory = configuredFactory;
        pumpRouter = pumpRouter_;
        nusd = nusd_;
        pump = pump_;
    }

    function preparePool(address token) external returns (address pair) {
        pair = factory.getPair(token, nusd);
        if (pair == address(0)) pair = factory.preparePumpPair(token);
        if (
            !factory.isPair(pair) || IZeroXFiPair(pair).bootstrapper() != address(this)
                || IZeroXFiPair(pair).totalSupply() != 0
        ) revert InvalidPoolState();
        emit PumpPoolPrepared(token, pair, factory.pairId(token, nusd));
    }

    function lpTokenFor(address token, address nusd_) external view returns (address lpToken) {
        if (nusd_ != nusd || !factory.isPumpToken(token)) return address(0);
        lpToken = factory.getPair(token, nusd_);
        if (lpToken == address(0) || !factory.isPair(lpToken)) return address(0);
    }

    function graduate(GraduationParams calldata params) external nonReentrant returns (GraduationResult memory result) {
        if (msg.sender != pumpRouter) revert InvalidGraduationCaller();
        // The deadline limits execution lifetime; reserve and exact-transfer checks remain authoritative.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > params.deadline) revert DeadlineExpired();
        if (
            params.token == address(0) || params.nusd != nusd || params.tokenAmount == 0 || params.nusdAmount == 0
                || params.minimumLp == 0 || params.lpRecipient != pumpRouter
        ) revert InvalidConfiguration();

        address pair = factory.getPair(params.token, params.nusd);
        if (
            pair == address(0) || !factory.isPair(pair) || IZeroXFiPair(pair).bootstrapper() != address(this)
                || IZeroXFiPair(pair).totalSupply() != 0
        ) revert InvalidPoolState();

        // Direct ERC-20 transfers cannot be rejected. Sweep pre-bootstrap donations
        // to an unreachable sink so they cannot grief or alter the terminal price.
        IZeroXFiPair(pair).sweepBootstrapDonations(DONATION_SINK);
        _requireEmptyPair(pair, params.token, params.nusd);

        uint256 tokenBalanceBefore = IERC20(params.token).balanceOf(address(this));
        uint256 nusdBalanceBefore = IERC20(params.nusd).balanceOf(address(this));
        _safeTransferFromExact(params.token, msg.sender, address(this), params.tokenAmount);
        _safeTransferFromExact(params.nusd, msg.sender, address(this), params.nusdAmount);
        _safeTransferExact(params.token, pair, params.tokenAmount);
        _safeTransferExact(params.nusd, pair, params.nusdAmount);

        uint256 lpBalanceBefore = IERC20(pair).balanceOf(params.lpRecipient);
        uint256 lpAmount = IZeroXFiPair(pair).mint(params.lpRecipient);
        if (lpAmount < params.minimumLp) revert MinimumLiquidityNotMet();
        if (IERC20(pair).balanceOf(params.lpRecipient) != lpBalanceBefore + lpAmount) revert AssetTransferMismatch();
        if (
            IERC20(params.token).balanceOf(address(this)) != tokenBalanceBefore
                || IERC20(params.nusd).balanceOf(address(this)) != nusdBalanceBefore
        ) revert AssetTransferMismatch();

        _requireExactSeededReserves(pair, params.token, params.tokenAmount, params.nusdAmount);

        bytes32 id = factory.pairId(params.token, params.nusd);
        result = GraduationResult({ dex: address(factory), pairId: id, pool: pair, lpToken: pair, lpAmount: lpAmount });
        emit PumpLiquidityBootstrapped(
            params.token, pair, params.tokenAmount, params.nusdAmount, lpAmount, params.lpRecipient
        );
    }

    function _requireEmptyPair(address pair, address token, address nusd_) private view {
        (uint112 reserve0, uint112 reserve1,) = IZeroXFiPair(pair).getReserves();
        if (
            reserve0 != 0 || reserve1 != 0 || IZeroXFiPair(pair).totalSupply() != 0
                || IERC20(token).balanceOf(pair) != 0 || IERC20(nusd_).balanceOf(pair) != 0
        ) revert InvalidPoolState();
    }

    function _requireExactSeededReserves(address pair, address token, uint256 tokenAmount, uint256 nusdAmount)
        private
        view
    {
        (uint112 reserve0, uint112 reserve1,) = IZeroXFiPair(pair).getReserves();
        uint256 expected0 = IZeroXFiPair(pair).token0() == token ? tokenAmount : nusdAmount;
        uint256 expected1 = IZeroXFiPair(pair).token0() == token ? nusdAmount : tokenAmount;
        if (
            reserve0 != expected0 || reserve1 != expected1
                || IERC20(IZeroXFiPair(pair).token0()).balanceOf(pair) != expected0
                || IERC20(IZeroXFiPair(pair).token1()).balanceOf(pair) != expected1
                || IZeroXFiPair(pair).bootstrapper() != address(0)
        ) revert InvalidPoolState();
    }

    function _safeTransferFromExact(address token, address from, address to, uint256 amount) private {
        uint256 balanceBefore = IERC20(token).balanceOf(to);
        IERC20(token).safeTransferFrom(from, to, amount);
        if (IERC20(token).balanceOf(to) != balanceBefore + amount) revert AssetTransferMismatch();
    }

    function _safeTransferExact(address token, address to, uint256 amount) private {
        uint256 balanceBefore = IERC20(token).balanceOf(to);
        IERC20(token).safeTransfer(to, amount);
        if (IERC20(token).balanceOf(to) != balanceBefore + amount) revert AssetTransferMismatch();
    }

    function _readAddress(address target, bytes4 selector) private view returns (address value) {
        (bool success, bytes memory data) = target.staticcall(abi.encodeWithSelector(selector));
        if (!success || data.length < 32) revert InvalidConfiguration();
        value = abi.decode(data, (address));
    }
}
