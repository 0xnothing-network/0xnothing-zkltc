// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { IZeroXFiFactoryV2 } from "../interfaces/IZeroXFiFactoryV2.sol";
import { IZeroXFiPair } from "../interfaces/IZeroXFiPair.sol";
import { IWzkLTC } from "../interfaces/IWzkLTC.sol";

interface IFeeSplitter {
    function distribute() external returns (uint256 amountNusd);
}

/// @title 0xFi router v2
/// @notice Pairs keep their 0.5% LP fee. On top, the router charges a protocol fee that is always
///         paid in a base asset (NUSD or WzkLTC), at the first base asset on the path:
///         - 0.1% when either end of the path is a base asset (TOKEN/NUSD, TOKEN/zkLTC, NUSD/zkLTC);
///         - 0.3% for a cross swap, where both ends are ordinary tokens (TOKEN1 -> base -> TOKEN2).
///         If the input is a base asset the fee comes out of the input. Otherwise the router takes
///         delivery of the base asset after the first hop, keeps the fee and forwards the rest, so
///         `amountOutMin` is always checked against what the user really receives.
///         Accrued NUSD fees go to the fee splitter (50% reward pool / 50% treasury) and WzkLTC fees
///         to the treasury, through a permissionless call. There is no admin.
contract ZeroXFiRouterV2 is ReentrancyGuard {
    using SafeERC20 for IERC20;

    error DeadlineExpired();
    error ExcessiveInputAmount();
    error FeeOnTransferUnsupported();
    error InsufficientAmount();
    error InsufficientLiquidity();
    error InsufficientLiquidityMinted();
    error InsufficientOutputAmount();
    error InvalidConfiguration();
    error InvalidPath();
    error InvalidRecipient();
    error NativeTransferFailed();
    error NothingToDistribute();
    error PairNotFound();
    error UnauthorizedNativeSender();

    uint256 public constant FEE_DENOMINATOR = 10_000;
    uint256 public constant LP_FEE_BPS = 50;
    uint256 public constant DIRECT_FEE_BPS = 10;
    uint256 public constant CROSS_FEE_BPS = 30;
    uint256 public constant MAX_HOPS = 3;

    IZeroXFiFactoryV2 public immutable factory;
    IWzkLTC public immutable wzkLTC;
    address public immutable nusd;
    address public immutable feeSplitter;
    address public immutable treasury;
    mapping(address => uint256) public accruedRouterFees;

    event RouterFeeAccrued(address indexed payer, address indexed token, uint256 feeBps, uint256 fee);
    event RouterFeesDistributed(
        address indexed caller, address indexed token, address indexed recipient, uint256 amount
    );

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

    /// @dev `amounts[0]` is the gross input; every later entry is the amount of that token moving on
    ///      (or delivered), net of the router fee where it is charged. `feeIndex` is 0 or 1.
    struct SwapQuote {
        uint256[] amounts;
        uint256 feeIndex;
        uint256 feeBps;
        uint256 fee;
    }

    constructor(address factory_, address wzkLTC_, address feeSplitter_, address treasury_) {
        if (
            factory_.code.length == 0 || wzkLTC_.code.length == 0 || feeSplitter_.code.length == 0
                || treasury_ == address(0) || IZeroXFiFactoryV2(factory_).wzkLTC() != wzkLTC_
        ) revert InvalidConfiguration();
        factory = IZeroXFiFactoryV2(factory_);
        wzkLTC = IWzkLTC(wzkLTC_);
        nusd = IZeroXFiFactoryV2(factory_).nusd();
        feeSplitter = feeSplitter_;
        treasury = treasury_;
    }

    receive() external payable {
        if (msg.sender != address(wzkLTC)) revert UnauthorizedNativeSender();
    }

    // ---------------------------------------------------------------- fees

    /// @notice Sends accrued fees out: NUSD to the fee splitter (split in the same call), WzkLTC to
    ///         the treasury. Permissionless.
    function distributeFees(address token) external nonReentrant returns (uint256 amount) {
        amount = accruedRouterFees[token];
        if (amount == 0) revert NothingToDistribute();
        accruedRouterFees[token] = 0;
        address recipient;
        if (token == nusd) {
            recipient = feeSplitter;
            _safeTransferExact(token, recipient, amount);
            IFeeSplitter(recipient).distribute();
        } else {
            // Fees only ever accrue in the two base assets.
            recipient = treasury;
            _safeTransferExact(token, recipient, amount);
        }
        emit RouterFeesDistributed(msg.sender, token, recipient, amount);
    }

    // ---------------------------------------------------------------- liquidity (unchanged from v1)

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

    // ---------------------------------------------------------------- swaps

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external nonReentrant returns (uint256[] memory amounts) {
        _checkDeadlineAndRecipient(deadline, to);
        SwapQuote memory q = quoteSwap(amountIn, path);
        amounts = q.amounts;
        if (amounts[amounts.length - 1] < amountOutMin) revert InsufficientOutputAmount();

        address output = path[path.length - 1];
        uint256 outputBefore = IERC20(output).balanceOf(to);
        _fundFirstPair(q, path, msg.sender);
        _swap(q, path, to);
        if (IERC20(output).balanceOf(to) != outputBefore + amounts[amounts.length - 1]) {
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
        SwapQuote memory q = quoteSwap(msg.value, path);
        amounts = q.amounts;
        if (amounts[amounts.length - 1] < amountOutMin) revert InsufficientOutputAmount();

        address output = path[path.length - 1];
        uint256 outputBefore = IERC20(output).balanceOf(to);
        // WzkLTC is a base asset, so the fee is always taken from the wrapped input here.
        wzkLTC.deposit{ value: msg.value }();
        _accrueFee(address(wzkLTC), msg.sender, q.feeBps, q.fee);
        _safeTransferExact(address(wzkLTC), _requirePair(path[0], path[1]), msg.value - q.fee);
        _swap(q, path, to);
        if (IERC20(output).balanceOf(to) != outputBefore + amounts[amounts.length - 1]) {
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
        SwapQuote memory q = quoteSwap(amountIn, path);
        amounts = q.amounts;
        uint256 amountOut = amounts[amounts.length - 1];
        if (amountOut < amountOutMin) revert InsufficientOutputAmount();

        uint256 wrappedBefore = IERC20(address(wzkLTC)).balanceOf(address(this));
        _fundFirstPair(q, path, msg.sender);
        _swap(q, path, address(this));
        // When the fee is charged on the final WzkLTC leg, the router also keeps that fee.
        uint256 retainedFee = q.feeIndex == path.length - 1 ? q.fee : 0;
        if (IERC20(address(wzkLTC)).balanceOf(address(this)) != wrappedBefore + amountOut + retainedFee) {
            revert FeeOnTransferUnsupported();
        }
        wzkLTC.withdraw(amountOut);
        _safeTransferNative(to, amountOut);
    }

    // ---------------------------------------------------------------- quotes

    /// @notice v1-compatible quote: `amounts[last]` is what the recipient receives after every fee.
    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory) {
        return quoteSwap(amountIn, path).amounts;
    }

    /// @notice Full quote, including where the router fee is charged, its rate and its amount.
    ///         The fee token is `path[feeIndex]`.
    function quoteSwap(uint256 amountIn, address[] calldata path) public view returns (SwapQuote memory q) {
        if (amountIn == 0) revert InsufficientAmount();
        _validatePath(path);
        uint256 length = path.length;
        bool baseIn = factory.isBaseToken(path[0]);
        // Every pair holds a base asset, so a non-base input always meets one on the first hop.
        if (!baseIn && !factory.isBaseToken(path[1])) revert InvalidPath();
        q.feeIndex = baseIn ? 0 : 1;
        q.feeBps = baseIn || factory.isBaseToken(path[length - 1]) ? DIRECT_FEE_BPS : CROSS_FEE_BPS;
        q.amounts = new uint256[](length);
        q.amounts[0] = amountIn;

        uint256 hopAmountIn = amountIn;
        if (baseIn) {
            q.fee = Math.mulDiv(amountIn, q.feeBps, FEE_DENOMINATOR);
            hopAmountIn = amountIn - q.fee;
        }
        for (uint256 i; i < length - 1; ++i) {
            (uint256 reserveIn, uint256 reserveOut) = getReserves(path[i], path[i + 1]);
            uint256 amountOut = getAmountOut(hopAmountIn, reserveIn, reserveOut);
            if (i + 1 == q.feeIndex) {
                q.fee = Math.mulDiv(amountOut, q.feeBps, FEE_DENOMINATOR);
                amountOut -= q.fee;
                if (amountOut == 0) revert InsufficientOutputAmount();
            }
            q.amounts[i + 1] = amountOut;
            hopAmountIn = amountOut;
        }
    }

    /// @notice Router fee rate for a path: 10 bps if either end is NUSD or WzkLTC, else 30 bps.
    function routerFeeBpsForPath(address[] calldata path) external view returns (uint256) {
        _validatePath(path);
        return factory.isBaseToken(path[0]) || factory.isBaseToken(path[path.length - 1])
            ? DIRECT_FEE_BPS
            : CROSS_FEE_BPS;
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

    /// @notice One pair hop at the 0.5% LP fee.
    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut)
        public
        pure
        returns (uint256 amountOut)
    {
        if (amountIn == 0) revert InsufficientAmount();
        if (reserveIn == 0 || reserveOut == 0) revert InsufficientLiquidity();
        uint256 amountInWithFee = amountIn * (FEE_DENOMINATOR - LP_FEE_BPS);
        amountOut = (amountInWithFee * reserveOut) / (reserveIn * FEE_DENOMINATOR + amountInWithFee);
        if (amountOut == 0) revert InsufficientOutputAmount();
    }

    // ---------------------------------------------------------------- internals

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

    /// @dev Pulls the ERC-20 input. A base-asset input pays its fee to the router first.
    function _fundFirstPair(SwapQuote memory q, address[] calldata path, address payer) private {
        address firstPair = _requirePair(path[0], path[1]);
        uint256 amountIn = q.amounts[0];
        if (q.feeIndex == 0 && q.fee != 0) {
            _safeTransferFromExact(path[0], payer, address(this), q.fee);
            _accrueFee(path[0], payer, q.feeBps, q.fee);
        }
        _safeTransferFromExact(path[0], payer, firstPair, q.feeIndex == 0 ? amountIn - q.fee : amountIn);
    }

    /// @dev Runs every hop. On the fee hop the router takes delivery, keeps the fee and forwards
    ///      the rest to the next pair, or to the final recipient when it is the last hop.
    function _swap(SwapQuote memory q, address[] calldata path, address finalRecipient) private {
        uint256 lastIndex = path.length - 1;
        for (uint256 i; i < lastIndex; ++i) {
            address next = i + 1 < lastIndex ? _requirePair(path[i + 1], path[i + 2]) : finalRecipient;
            if (i + 1 == q.feeIndex) _feeHop(path[i], path[i + 1], q, next);
            else _pairSwap(path[i], path[i + 1], q.amounts[i + 1], next);
        }
    }

    function _feeHop(address input, address output, SwapQuote memory q, address next) private {
        uint256 net = q.amounts[q.feeIndex];
        uint256 heldBefore = IERC20(output).balanceOf(address(this));
        _pairSwap(input, output, net + q.fee, address(this));
        if (IERC20(output).balanceOf(address(this)) != heldBefore + net + q.fee) revert FeeOnTransferUnsupported();
        _accrueFee(output, msg.sender, q.feeBps, q.fee);
        if (next != address(this)) _safeTransferExact(output, next, net);
    }

    function _pairSwap(address input, address output, uint256 amountOut, address recipient) private {
        (address token0,) = _sortTokens(input, output);
        (uint256 amount0Out, uint256 amount1Out) = input == token0 ? (uint256(0), amountOut) : (amountOut, uint256(0));
        IZeroXFiPair(_requirePair(input, output)).swap(amount0Out, amount1Out, recipient);
    }

    function _accrueFee(address token, address payer, uint256 feeBps, uint256 fee) private {
        if (fee == 0) return;
        accruedRouterFees[token] += fee;
        emit RouterFeeAccrued(payer, token, feeBps, fee);
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
