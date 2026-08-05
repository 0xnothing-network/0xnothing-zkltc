// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { IZeroXFiFactory } from "../interfaces/IZeroXFiFactory.sol";
import { IZeroXFiPair } from "../interfaces/IZeroXFiPair.sol";
import { IWzkLTC } from "../interfaces/IWzkLTC.sol";

contract ZeroXFiRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    error DeadlineExpired();
    error ExcessiveInputAmount();
    error FeeOnTransferUnsupported();
    error InsufficientAmount();
    error InsufficientRouterFeeBalance();
    error InsufficientLiquidity();
    error InsufficientLiquidityMinted();
    error InsufficientOutputAmount();
    error InvalidPath();
    error InvalidRecipient();
    error NativeTransferFailed();
    error PairNotFound();
    error UnauthorizedFeeWithdrawal();
    error UnauthorizedNativeSender();

    uint256 public constant FEE_DENOMINATOR = 10_000;
    uint256 public constant LP_FEE_BPS = 50;
    uint256 public constant PROTOCOL_FEE_BPS = 10;
    uint256 public constant ROUTE_SURCHARGE_BPS = 10;
    uint256 public constant MAX_HOPS = 3;

    IZeroXFiFactory public immutable factory;
    IWzkLTC public immutable wzkLTC;
    mapping(address => uint256) public accruedRouterFees;

    event RouterFeeAccrued(
        address indexed payer, address indexed token, uint256 protocolFee, uint256 routeSurcharge, uint256 totalFee
    );
    event RouterFeeWithdrawn(address indexed token, address indexed recipient, uint256 amount);

    struct AddLiquidityParams {
        address tokenA;
        address tokenB;
        uint256 amountADesired;
        uint256 amountBDesired;
        uint256 amountAMin;
        uint256 amountBMin;
        uint256 minimumLiquidity;
        address to;
        uint256 deadline;
    }

    struct AddLiquidityNativeParams {
        address token;
        uint256 amountTokenDesired;
        uint256 amountTokenMin;
        uint256 amountNativeMin;
        uint256 minimumLiquidity;
        address to;
        uint256 deadline;
    }

    struct RemoveLiquidityParams {
        address tokenA;
        address tokenB;
        uint256 liquidity;
        uint256 amountAMin;
        uint256 amountBMin;
        address to;
        uint256 deadline;
    }

    struct RemoveLiquidityNativeParams {
        address token;
        uint256 liquidity;
        uint256 amountTokenMin;
        uint256 amountNativeMin;
        address to;
        uint256 deadline;
    }

    constructor(address factory_, address wzkLTC_) {
        if (factory_.code.length == 0 || wzkLTC_.code.length == 0) revert PairNotFound();
        factory = IZeroXFiFactory(factory_);
        wzkLTC = IWzkLTC(wzkLTC_);
    }

    receive() external payable {
        if (msg.sender != address(wzkLTC)) revert UnauthorizedNativeSender();
    }

    function withdrawRouterFees(address token, address recipient, uint256 amount) external nonReentrant {
        if (msg.sender != factory.owner()) revert UnauthorizedFeeWithdrawal();
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();
        if (amount == 0) revert InsufficientAmount();
        uint256 available = accruedRouterFees[token];
        if (amount > available) revert InsufficientRouterFeeBalance();
        accruedRouterFees[token] = available - amount;
        _safeTransferExact(token, recipient, amount);
        emit RouterFeeWithdrawn(token, recipient, amount);
    }

    function addLiquidity(AddLiquidityParams calldata params)
        external
        nonReentrant
        returns (uint256 amountA, uint256 amountB, uint256 liquidity)
    {
        _checkDeadlineAndRecipient(params.deadline, params.to);
        address pair;
        (pair, amountA, amountB) = _prepareLiquidity(
            params.tokenA,
            params.tokenB,
            params.amountADesired,
            params.amountBDesired,
            params.amountAMin,
            params.amountBMin
        );
        _safeTransferFromExact(params.tokenA, msg.sender, pair, amountA);
        _safeTransferFromExact(params.tokenB, msg.sender, pair, amountB);
        liquidity = IZeroXFiPair(pair).mint(params.to);
        if (liquidity < params.minimumLiquidity) revert InsufficientLiquidityMinted();
    }

    function addLiquidityNative(AddLiquidityNativeParams calldata params)
        external
        payable
        nonReentrant
        returns (uint256 amountToken, uint256 amountNative, uint256 liquidity)
    {
        _checkDeadlineAndRecipient(params.deadline, params.to);
        if (msg.value == 0) revert InsufficientAmount();

        address pair;
        (pair, amountToken, amountNative) = _prepareLiquidity(
            params.token,
            address(wzkLTC),
            params.amountTokenDesired,
            msg.value,
            params.amountTokenMin,
            params.amountNativeMin
        );
        _safeTransferFromExact(params.token, msg.sender, pair, amountToken);
        wzkLTC.deposit{ value: amountNative }();
        _safeTransferExact(address(wzkLTC), pair, amountNative);
        liquidity = IZeroXFiPair(pair).mint(params.to);
        if (liquidity < params.minimumLiquidity) revert InsufficientLiquidityMinted();

        if (msg.value > amountNative) _safeTransferNative(msg.sender, msg.value - amountNative);
    }

    function removeLiquidity(RemoveLiquidityParams calldata params)
        external
        nonReentrant
        returns (uint256 amountA, uint256 amountB)
    {
        _checkDeadlineAndRecipient(params.deadline, params.to);
        address pair = _requirePair(params.tokenA, params.tokenB);
        _safeTransferFromExact(pair, msg.sender, pair, params.liquidity);

        uint256 balanceABefore = IERC20(params.tokenA).balanceOf(params.to);
        uint256 balanceBBefore = IERC20(params.tokenB).balanceOf(params.to);
        (uint256 amount0, uint256 amount1) = IZeroXFiPair(pair).burn(params.to);
        (address token0,) = _sortTokens(params.tokenA, params.tokenB);
        (amountA, amountB) = params.tokenA == token0 ? (amount0, amount1) : (amount1, amount0);
        if (amountA < params.amountAMin || amountB < params.amountBMin) revert InsufficientOutputAmount();
        if (
            IERC20(params.tokenA).balanceOf(params.to) != balanceABefore + amountA
                || IERC20(params.tokenB).balanceOf(params.to) != balanceBBefore + amountB
        ) revert FeeOnTransferUnsupported();
    }

    function removeLiquidityNative(RemoveLiquidityNativeParams calldata params)
        external
        nonReentrant
        returns (uint256 amountToken, uint256 amountNative)
    {
        _checkDeadlineAndRecipient(params.deadline, params.to);
        address pair = _requirePair(params.token, address(wzkLTC));
        _safeTransferFromExact(pair, msg.sender, pair, params.liquidity);

        uint256 tokenBefore = IERC20(params.token).balanceOf(address(this));
        uint256 wrappedBefore = IERC20(address(wzkLTC)).balanceOf(address(this));
        (uint256 amount0, uint256 amount1) = IZeroXFiPair(pair).burn(address(this));
        (address token0,) = _sortTokens(params.token, address(wzkLTC));
        (amountToken, amountNative) = params.token == token0 ? (amount0, amount1) : (amount1, amount0);
        if (amountToken < params.amountTokenMin || amountNative < params.amountNativeMin) {
            revert InsufficientOutputAmount();
        }
        if (
            IERC20(params.token).balanceOf(address(this)) != tokenBefore + amountToken
                || IERC20(address(wzkLTC)).balanceOf(address(this)) != wrappedBefore + amountNative
        ) revert FeeOnTransferUnsupported();

        _safeTransferExact(params.token, params.to, amountToken);
        wzkLTC.withdraw(amountNative);
        _safeTransferNative(params.to, amountNative);
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external nonReentrant returns (uint256[] memory amounts) {
        _checkDeadlineAndRecipient(deadline, to);
        amounts = getAmountsOut(amountIn, path);
        if (amounts[amounts.length - 1] < amountOutMin) revert InsufficientOutputAmount();

        address firstPair = _requirePair(path[0], path[1]);
        _collectTokenInput(path[0], msg.sender, firstPair, amountIn, path.length);
        uint256 outputBefore = IERC20(path[path.length - 1]).balanceOf(to);
        _swap(amounts, path, to);
        if (IERC20(path[path.length - 1]).balanceOf(to) != outputBefore + amounts[amounts.length - 1]) {
            revert FeeOnTransferUnsupported();
        }
    }

    function swapExactNativeForTokens(uint256 amountOutMin, address[] calldata path, address to, uint256 deadline)
        external
        payable
        nonReentrant
        returns (uint256[] memory amounts)
    {
        _checkDeadlineAndRecipient(deadline, to);
        if (path.length < 2 || path[0] != address(wzkLTC) || msg.value == 0) revert InvalidPath();
        amounts = getAmountsOut(msg.value, path);
        if (amounts[amounts.length - 1] < amountOutMin) revert InsufficientOutputAmount();

        address firstPair = _requirePair(path[0], path[1]);
        (uint256 protocolFee, uint256 routeSurcharge, uint256 totalFee) = _routerFeeBreakdown(msg.value, path.length);
        wzkLTC.deposit{ value: msg.value }();
        _accrueRouterFee(address(wzkLTC), msg.sender, protocolFee, routeSurcharge, totalFee);
        _safeTransferExact(address(wzkLTC), firstPair, msg.value - totalFee);
        uint256 outputBefore = IERC20(path[path.length - 1]).balanceOf(to);
        _swap(amounts, path, to);
        if (IERC20(path[path.length - 1]).balanceOf(to) != outputBefore + amounts[amounts.length - 1]) {
            revert FeeOnTransferUnsupported();
        }
    }

    function swapExactTokensForNative(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external nonReentrant returns (uint256[] memory amounts) {
        _checkDeadlineAndRecipient(deadline, to);
        if (path.length < 2 || path[path.length - 1] != address(wzkLTC)) revert InvalidPath();
        amounts = getAmountsOut(amountIn, path);
        uint256 amountOut = amounts[amounts.length - 1];
        if (amountOut < amountOutMin) revert InsufficientOutputAmount();

        address firstPair = _requirePair(path[0], path[1]);
        _collectTokenInput(path[0], msg.sender, firstPair, amountIn, path.length);
        uint256 wrappedBefore = IERC20(address(wzkLTC)).balanceOf(address(this));
        _swap(amounts, path, address(this));
        if (IERC20(address(wzkLTC)).balanceOf(address(this)) != wrappedBefore + amountOut) {
            revert FeeOnTransferUnsupported();
        }
        wzkLTC.withdraw(amountOut);
        _safeTransferNative(to, amountOut);
    }

    function getAmountsOut(uint256 amountIn, address[] calldata path) public view returns (uint256[] memory amounts) {
        if (amountIn == 0) revert InvalidPath();
        _validatePath(path);
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        uint256 hopAmountIn = amountIn;
        for (uint256 i; i < path.length - 1; ++i) {
            (uint256 reserveIn, uint256 reserveOut) = getReserves(path[i], path[i + 1]);
            amounts[i + 1] = i == 0
                ? getFirstHopAmountOut(hopAmountIn, reserveIn, reserveOut, path.length)
                : getAmountOut(hopAmountIn, reserveIn, reserveOut);
            hopAmountIn = amounts[i + 1];
        }
    }

    function routerFeeFor(uint256 amountIn, uint256 pathLength) public pure returns (uint256 totalFee) {
        (,, totalFee) = _routerFeeBreakdown(amountIn, pathLength);
    }

    function routerFeeBpsForPathLength(uint256 pathLength) public pure returns (uint256) {
        if (pathLength < 2 || pathLength > MAX_HOPS + 1) revert InvalidPath();
        return PROTOCOL_FEE_BPS + (pathLength > 2 ? ROUTE_SURCHARGE_BPS : 0);
    }

    function getFirstHopAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut, uint256 pathLength)
        public
        pure
        returns (uint256 amountOut)
    {
        amountOut = _getAmountOutWithFee(
            amountIn, reserveIn, reserveOut, LP_FEE_BPS + routerFeeBpsForPathLength(pathLength)
        );
    }

    function getReserves(address tokenA, address tokenB) public view returns (uint256 reserveA, uint256 reserveB) {
        address pair = _requirePair(tokenA, tokenB);
        (uint112 reserve0, uint112 reserve1,) = IZeroXFiPair(pair).getReserves();
        (address token0,) = _sortTokens(tokenA, tokenB);
        (reserveA, reserveB) = tokenA == token0 ? (reserve0, reserve1) : (reserve1, reserve0);
    }

    function quote(uint256 amountA, uint256 reserveA, uint256 reserveB) public pure returns (uint256 amountB) {
        if (amountA == 0) revert InsufficientAmount();
        if (reserveA == 0 || reserveB == 0) revert InsufficientLiquidity();
        amountB = (amountA * reserveB) / reserveA;
    }

    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut)
        public
        pure
        returns (uint256 amountOut)
    {
        amountOut = _getAmountOutWithFee(amountIn, reserveIn, reserveOut, LP_FEE_BPS);
    }

    function _getAmountOutWithFee(uint256 amountIn, uint256 reserveIn, uint256 reserveOut, uint256 feeBps)
        private
        pure
        returns (uint256 amountOut)
    {
        if (amountIn == 0) revert InsufficientAmount();
        if (reserveIn == 0 || reserveOut == 0) revert InsufficientLiquidity();
        uint256 amountInWithFee = amountIn * (FEE_DENOMINATOR - feeBps);
        amountOut = (amountInWithFee * reserveOut) / (reserveIn * FEE_DENOMINATOR + amountInWithFee);
        if (amountOut == 0) revert InsufficientOutputAmount();
    }

    function _prepareLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin
    ) private returns (address pair, uint256 amountA, uint256 amountB) {
        if (amountADesired == 0 || amountBDesired == 0) revert InsufficientAmount();
        pair = factory.getPair(tokenA, tokenB);
        if (pair == address(0)) pair = factory.createPair(tokenA, tokenB);

        (uint256 reserveA, uint256 reserveB) = getReserves(tokenA, tokenB);
        if (reserveA == 0 && reserveB == 0) {
            (amountA, amountB) = (amountADesired, amountBDesired);
        } else {
            uint256 amountBOptimal = quote(amountADesired, reserveA, reserveB);
            if (amountBOptimal <= amountBDesired) {
                if (amountBOptimal < amountBMin) revert InsufficientAmount();
                (amountA, amountB) = (amountADesired, amountBOptimal);
            } else {
                uint256 amountAOptimal = quote(amountBDesired, reserveB, reserveA);
                if (amountAOptimal > amountADesired || amountAOptimal < amountAMin) revert ExcessiveInputAmount();
                (amountA, amountB) = (amountAOptimal, amountBDesired);
            }
        }
        if (amountA < amountAMin || amountB < amountBMin) revert InsufficientAmount();
    }

    function _collectTokenInput(
        address token,
        address payer,
        address firstPair,
        uint256 grossAmount,
        uint256 pathLength
    ) private {
        (uint256 protocolFee, uint256 routeSurcharge, uint256 totalFee) = _routerFeeBreakdown(grossAmount, pathLength);
        if (totalFee != 0) {
            _safeTransferFromExact(token, payer, address(this), totalFee);
            _accrueRouterFee(token, payer, protocolFee, routeSurcharge, totalFee);
        }
        _safeTransferFromExact(token, payer, firstPair, grossAmount - totalFee);
    }

    function _accrueRouterFee(
        address token,
        address payer,
        uint256 protocolFee,
        uint256 routeSurcharge,
        uint256 totalFee
    ) private {
        if (totalFee == 0) return;
        accruedRouterFees[token] += totalFee;
        emit RouterFeeAccrued(payer, token, protocolFee, routeSurcharge, totalFee);
    }

    function _routerFeeBreakdown(uint256 amountIn, uint256 pathLength)
        private
        pure
        returns (uint256 protocolFee, uint256 routeSurcharge, uint256 totalFee)
    {
        if (pathLength < 2 || pathLength > MAX_HOPS + 1) revert InvalidPath();
        protocolFee = Math.mulDiv(amountIn, PROTOCOL_FEE_BPS, FEE_DENOMINATOR);
        uint256 totalFeeBps = routerFeeBpsForPathLength(pathLength);
        totalFee = Math.mulDiv(amountIn, totalFeeBps, FEE_DENOMINATOR);
        routeSurcharge = totalFee - protocolFee;
    }

    function _validatePath(address[] calldata path) private pure {
        uint256 length = path.length;
        if (length < 2 || length > MAX_HOPS + 1) revert InvalidPath();
        for (uint256 i; i < length; ++i) {
            if (path[i] == address(0)) revert InvalidPath();
            for (uint256 j; j < i; ++j) {
                if (path[i] == path[j]) revert InvalidPath();
            }
        }
    }

    function _swap(uint256[] memory amounts, address[] calldata path, address finalRecipient) private {
        for (uint256 i; i < path.length - 1; ++i) {
            (address input, address output) = (path[i], path[i + 1]);
            (address token0,) = _sortTokens(input, output);
            uint256 amountOut = amounts[i + 1];
            (uint256 amount0Out, uint256 amount1Out) =
                input == token0 ? (uint256(0), amountOut) : (amountOut, uint256(0));
            address recipient = i < path.length - 2 ? _requirePair(output, path[i + 2]) : finalRecipient;
            IZeroXFiPair(_requirePair(input, output)).swap(amount0Out, amount1Out, recipient);
        }
    }

    function _requirePair(address tokenA, address tokenB) private view returns (address pair) {
        pair = factory.getPair(tokenA, tokenB);
        if (pair == address(0)) revert PairNotFound();
    }

    function _safeTransferFromExact(address token, address from, address to, uint256 amount) private {
        uint256 beforeBalance = IERC20(token).balanceOf(to);
        IERC20(token).safeTransferFrom(from, to, amount);
        if (IERC20(token).balanceOf(to) != beforeBalance + amount) revert FeeOnTransferUnsupported();
    }

    function _safeTransferExact(address token, address to, uint256 amount) private {
        uint256 beforeBalance = IERC20(token).balanceOf(to);
        IERC20(token).safeTransfer(to, amount);
        if (IERC20(token).balanceOf(to) != beforeBalance + amount) revert FeeOnTransferUnsupported();
    }

    function _safeTransferNative(address to, uint256 amount) private {
        (bool success,) = payable(to).call{ value: amount }("");
        if (!success) revert NativeTransferFailed();
    }

    function _checkDeadlineAndRecipient(uint256 deadline, address recipient) private view {
        // User deadlines intentionally follow the chain timestamp; small validator skew cannot bypass min-out checks.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (recipient == address(0)) revert InvalidRecipient();
    }

    function _sortTokens(address tokenA, address tokenB) private pure returns (address token0, address token1) {
        if (tokenA == tokenB || tokenA == address(0) || tokenB == address(0)) revert InvalidPath();
        (token0, token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
    }
}
