// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MathX} from "../common/MathX.sol";
import {ReentrancyGuard} from "../common/ReentrancyGuard.sol";
import {IERC20Minimal, SafeTransferLib} from "../common/SafeTransferLib.sol";
import {IGraduationAdapter} from "./interfaces/IGraduationAdapter.sol";
import {IUniswapV2Factory} from "./interfaces/IUniswapV2Factory.sol";
import {IUniswapV2Pair} from "./interfaces/IUniswapV2Pair.sol";

/// @notice Seeds a Uniswap V2 token/NUSD pair from Pump graduation reserves.
/// @dev Skims donations before minting, quotes minLP from live reserves, and
///      rejects a *final* reserve/deposit price outside `maxPriceDeviationBps`
///      unless both live reserves are dust versus the deposit. Empty pairs keep
///      the classic `sqrt(amount0 * amount1) - MINIMUM_LIQUIDITY` floor.
contract UniswapV2GraduationAdapter is IGraduationAdapter, ReentrancyGuard {
    error InvalidConfiguration();
    error InvalidGraduationCaller();
    error DeadlineExpired();
    error InvalidPoolState();
    error PriceDeviationExceeded(uint256 reservePriceWad, uint256 depositPriceWad, uint256 allowedDeviationWad);
    error MinimumLiquidityNotMet();
    error AssetTransferMismatch();

    uint256 public constant WAD = 1e18;
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MINIMUM_LIQUIDITY = 1_000;
    /// @notice Hard cap for the constructor `maxPriceDeviationBps` argument.
    uint256 public constant MAX_PRICE_DEVIATION_BPS = 200;
    /// @notice Per-side reserve share of the graduation deposit treated as dust.
    uint256 public constant DUST_RESERVE_BPS = 100;
    address public constant DONATION_SINK = address(1);

    IUniswapV2Factory public immutable factory;
    address public immutable nusd;
    address public immutable pumpRouter;
    uint256 public immutable maxPriceDeviationBps;
    uint256 public immutable slippageBps;

    event PumpPoolPrepared(address indexed token, address indexed pool, bytes32 indexed pairId);
    event PumpLiquidityBootstrapped(
        address indexed token,
        address indexed pool,
        uint256 tokenAmount,
        uint256 nusdAmount,
        uint256 lpAmount,
        address lpRecipient
    );

    constructor(
        address factory_,
        address nusd_,
        address pumpRouter_,
        uint256 maxPriceDeviationBps_,
        uint256 slippageBps_
    ) {
        if (
            factory_ == address(0) || factory_.code.length == 0 || nusd_ == address(0) || nusd_.code.length == 0
                || pumpRouter_ == address(0) || pumpRouter_.code.length == 0
                || maxPriceDeviationBps_ > MAX_PRICE_DEVIATION_BPS || slippageBps_ > 1_000
        ) revert InvalidConfiguration();

        factory = IUniswapV2Factory(factory_);
        nusd = nusd_;
        pumpRouter = pumpRouter_;
        maxPriceDeviationBps = maxPriceDeviationBps_;
        slippageBps = slippageBps_;
    }

    function preparePool(address token) external returns (address pair) {
        if (token == address(0) || token == nusd || token.code.length == 0) revert InvalidConfiguration();
        pair = factory.getPair(token, nusd);
        if (pair == address(0)) pair = factory.createPair(token, nusd);
        if (pair == address(0) || pair.code.length == 0) revert InvalidPoolState();
        emit PumpPoolPrepared(token, pair, _pairId(token, nusd));
    }

    function lpTokenFor(address token, address nusd_) external view returns (address lpToken) {
        if (nusd_ != nusd || token == address(0) || token == nusd) return address(0);
        lpToken = factory.getPair(token, nusd_);
        if (lpToken == address(0) || lpToken.code.length == 0) return address(0);
    }

    function quoteMinimumLp(address token, address nusd_, uint256 tokenAmount, uint256 nusdAmount)
        external
        view
        returns (uint256 minimumLp)
    {
        if (nusd_ != nusd || token == address(0) || tokenAmount == 0 || nusdAmount == 0) {
            revert InvalidConfiguration();
        }
        address pair = factory.getPair(token, nusd);
        (uint256 expected,) = _expectedLp(pair, token, tokenAmount, nusdAmount);
        minimumLp = _applySlippage(expected);
        if (minimumLp == 0) revert InvalidConfiguration();
    }

    function graduate(GraduationParams calldata params) external nonReentrant returns (GraduationResult memory result) {
        if (msg.sender != pumpRouter) revert InvalidGraduationCaller();
        if (block.timestamp > params.deadline) revert DeadlineExpired();
        if (
            params.token == address(0) || params.nusd != nusd || params.tokenAmount == 0 || params.nusdAmount == 0
                || params.minimumLp == 0 || params.lpRecipient == address(0)
        ) revert InvalidConfiguration();

        address pair = factory.getPair(params.token, params.nusd);
        if (pair == address(0) || pair.code.length == 0) revert InvalidPoolState();

        IUniswapV2Pair(pair).skim(DONATION_SINK);
        (uint256 expectedLp,) = _expectedLp(pair, params.token, params.tokenAmount, params.nusdAmount);
        uint256 quotedMin = _applySlippage(expectedLp);
        if (params.minimumLp > quotedMin) revert MinimumLiquidityNotMet();

        uint256 tokenBalanceBefore = IERC20Minimal(params.token).balanceOf(address(this));
        uint256 nusdBalanceBefore = IERC20Minimal(params.nusd).balanceOf(address(this));
        _transferFromExact(params.token, msg.sender, address(this), params.tokenAmount);
        _transferFromExact(params.nusd, msg.sender, address(this), params.nusdAmount);
        _transferExact(params.token, pair, params.tokenAmount);
        _transferExact(params.nusd, pair, params.nusdAmount);

        uint256 lpBalanceBefore = IERC20Minimal(pair).balanceOf(params.lpRecipient);
        uint256 lpAmount = IUniswapV2Pair(pair).mint(params.lpRecipient);
        if (lpAmount < params.minimumLp || lpAmount < quotedMin) revert MinimumLiquidityNotMet();
        if (IERC20Minimal(pair).balanceOf(params.lpRecipient) != lpBalanceBefore + lpAmount) {
            revert AssetTransferMismatch();
        }
        if (
            IERC20Minimal(params.token).balanceOf(address(this)) != tokenBalanceBefore
                || IERC20Minimal(params.nusd).balanceOf(address(this)) != nusdBalanceBefore
        ) revert AssetTransferMismatch();

        result = GraduationResult({
            dex: address(factory),
            pairId: _pairId(params.token, params.nusd),
            pool: pair,
            lpToken: pair,
            lpAmount: lpAmount
        });
        emit PumpLiquidityBootstrapped(
            params.token, pair, params.tokenAmount, params.nusdAmount, lpAmount, params.lpRecipient
        );
    }

    function _expectedLp(address pair, address token, uint256 tokenAmount, uint256 nusdAmount)
        private
        view
        returns (uint256 expectedLp, bool existingReserves)
    {
        if (pair == address(0) || IUniswapV2Pair(pair).totalSupply() == 0) {
            uint256 rootK = MathX.sqrt(tokenAmount * nusdAmount);
            if (rootK <= MINIMUM_LIQUIDITY) revert InvalidPoolState();
            return (rootK - MINIMUM_LIQUIDITY, false);
        }

        (uint256 reserveToken, uint256 reserveNusd) = _orderedReserves(pair, token);
        if (reserveToken == 0 || reserveNusd == 0) revert InvalidPoolState();
        _checkPriceDeviation(reserveToken, reserveNusd, tokenAmount, nusdAmount);

        uint256 supply = IUniswapV2Pair(pair).totalSupply();
        uint256 lpFromToken = MathX.mulDiv(tokenAmount, supply, reserveToken);
        uint256 lpFromNusd = MathX.mulDiv(nusdAmount, supply, reserveNusd);
        expectedLp = lpFromToken < lpFromNusd ? lpFromToken : lpFromNusd;
        if (expectedLp == 0) revert InvalidPoolState();
        existingReserves = true;
    }

    /// @dev Dust pairs and tiny skews must not brick READY. Compare the *final*
    ///      pool price after the deposit against the deposit ratio; skip the
    ///      check entirely when both live reserves are dust versus that deposit.
    function _checkPriceDeviation(uint256 reserveToken, uint256 reserveNusd, uint256 tokenAmount, uint256 nusdAmount)
        private
        view
    {
        if (_isDustReserves(reserveToken, reserveNusd, tokenAmount, nusdAmount)) return;

        uint256 depositPriceWad = MathX.mulDiv(nusdAmount, WAD, tokenAmount);
        uint256 finalPriceWad = MathX.mulDiv(reserveNusd + nusdAmount, WAD, reserveToken + tokenAmount);
        uint256 difference =
            finalPriceWad > depositPriceWad ? finalPriceWad - depositPriceWad : depositPriceWad - finalPriceWad;
        uint256 allowed = MathX.mulDiv(depositPriceWad, maxPriceDeviationBps, BPS_DENOMINATOR);
        if (difference > allowed) revert PriceDeviationExceeded(finalPriceWad, depositPriceWad, allowed);
    }

    function _isDustReserves(uint256 reserveToken, uint256 reserveNusd, uint256 tokenAmount, uint256 nusdAmount)
        private
        pure
        returns (bool)
    {
        return reserveToken <= MathX.mulDiv(tokenAmount, DUST_RESERVE_BPS, BPS_DENOMINATOR)
            && reserveNusd <= MathX.mulDiv(nusdAmount, DUST_RESERVE_BPS, BPS_DENOMINATOR);
    }

    function _orderedReserves(address pair, address token)
        private
        view
        returns (uint256 reserveToken, uint256 reserveNusd)
    {
        (uint112 reserve0, uint112 reserve1,) = IUniswapV2Pair(pair).getReserves();
        if (IUniswapV2Pair(pair).token0() == token) {
            reserveToken = reserve0;
            reserveNusd = reserve1;
        } else {
            reserveToken = reserve1;
            reserveNusd = reserve0;
        }
    }

    function _applySlippage(uint256 expectedLp) private view returns (uint256) {
        return MathX.mulDiv(expectedLp, BPS_DENOMINATOR - slippageBps, BPS_DENOMINATOR);
    }

    function _pairId(address token, address nusd_) private pure returns (bytes32) {
        (address tokenA, address tokenB) = token < nusd_ ? (token, nusd_) : (nusd_, token);
        return keccak256(abi.encodePacked(tokenA, tokenB));
    }

    function _transferFromExact(address token, address from, address to, uint256 amount) private {
        uint256 balanceBefore = IERC20Minimal(token).balanceOf(to);
        SafeTransferLib.safeTransferFrom(token, from, to, amount);
        if (IERC20Minimal(token).balanceOf(to) != balanceBefore + amount) revert AssetTransferMismatch();
    }

    function _transferExact(address token, address to, uint256 amount) private {
        uint256 balanceBefore = IERC20Minimal(token).balanceOf(to);
        SafeTransferLib.safeTransfer(token, to, amount);
        if (IERC20Minimal(token).balanceOf(to) != balanceBefore + amount) revert AssetTransferMismatch();
    }
}
