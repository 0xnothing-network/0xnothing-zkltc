// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { IZeroXFiFactory } from "../interfaces/IZeroXFiFactory.sol";

contract ZeroXFiPair is ERC20, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error Forbidden();
    error InvalidRecipient();
    error InsufficientInputAmount();
    error InsufficientLiquidity();
    error InsufficientLiquidityBurned();
    error InsufficientLiquidityMinted();
    error InvariantViolation();
    error Overflow();
    error SwapsPaused();

    uint256 public constant MINIMUM_LIQUIDITY = 1000;
    uint256 public constant FEE_DENOMINATOR = 10_000;
    uint256 public constant LP_FEE_BPS = 50;
    address public constant MINIMUM_LIQUIDITY_RECIPIENT = address(1);

    address public immutable factory;
    address public immutable token0;
    address public immutable token1;
    address public bootstrapper;

    uint112 private reserve0;
    uint112 private reserve1;
    uint32 private blockTimestampLast;

    uint256 public price0CumulativeLast;
    uint256 public price1CumulativeLast;

    event Mint(address indexed sender, uint256 amount0, uint256 amount1, address indexed to, uint256 liquidity);
    event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to, uint256 liquidity);
    event Swap(
        address indexed sender,
        uint256 amount0In,
        uint256 amount1In,
        uint256 amount0Out,
        uint256 amount1Out,
        address indexed to
    );
    event Sync(uint112 reserve0, uint112 reserve1);
    event BootstrapCompleted(address indexed bootstrapper);
    event BootstrapDonationsSwept(address indexed sink, uint256 amount0, uint256 amount1);

    constructor(address token0_, address token1_, address bootstrapper_) ERC20("0xFi LP Token", "0xFI-LP") {
        if (token0_ == address(0) || token0_ >= token1_) revert Forbidden();
        factory = msg.sender;
        token0 = token0_;
        token1 = token1_;
        bootstrapper = bootstrapper_;
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, blockTimestampLast);
    }

    function mint(address to) external nonReentrant returns (uint256 liquidity) {
        if (to == address(0)) revert InvalidRecipient();

        uint256 supply = totalSupply();
        address initialBootstrapper = bootstrapper;
        if (supply == 0 && initialBootstrapper != address(0) && msg.sender != initialBootstrapper) revert Forbidden();

        (uint112 reserve0_, uint112 reserve1_) = (reserve0, reserve1);
        uint256 balance0 = IERC20(token0).balanceOf(address(this));
        uint256 balance1 = IERC20(token1).balanceOf(address(this));
        uint256 amount0 = balance0 - reserve0_;
        uint256 amount1 = balance1 - reserve1_;

        if (supply == 0) {
            uint256 rootK = Math.sqrt(amount0 * amount1);
            if (rootK <= MINIMUM_LIQUIDITY) revert InsufficientLiquidityMinted();
            liquidity = rootK - MINIMUM_LIQUIDITY;
            _mint(MINIMUM_LIQUIDITY_RECIPIENT, MINIMUM_LIQUIDITY);
        } else {
            liquidity = Math.min((amount0 * supply) / reserve0_, (amount1 * supply) / reserve1_);
        }
        if (liquidity == 0) revert InsufficientLiquidityMinted();

        _mint(to, liquidity);
        _updateReserves(balance0, balance1, reserve0_, reserve1_);

        if (supply == 0 && initialBootstrapper != address(0)) {
            bootstrapper = address(0);
            emit BootstrapCompleted(initialBootstrapper);
        }
        emit Mint(msg.sender, amount0, amount1, to, liquidity);
    }

    function burn(address to) external nonReentrant returns (uint256 amount0, uint256 amount1) {
        if (to == address(0) || to == token0 || to == token1) revert InvalidRecipient();

        uint256 balance0 = IERC20(token0).balanceOf(address(this));
        uint256 balance1 = IERC20(token1).balanceOf(address(this));
        uint256 liquidity = balanceOf(address(this));
        uint256 supply = totalSupply();
        if (liquidity == 0 || supply == 0) revert InsufficientLiquidityBurned();

        amount0 = (liquidity * balance0) / supply;
        amount1 = (liquidity * balance1) / supply;
        if (amount0 == 0 || amount1 == 0) revert InsufficientLiquidityBurned();

        _burn(address(this), liquidity);
        IERC20(token0).safeTransfer(to, amount0);
        IERC20(token1).safeTransfer(to, amount1);

        balance0 = IERC20(token0).balanceOf(address(this));
        balance1 = IERC20(token1).balanceOf(address(this));
        _updateReserves(balance0, balance1, reserve0, reserve1);
        emit Burn(msg.sender, amount0, amount1, to, liquidity);
    }

    function swap(uint256 amount0Out, uint256 amount1Out, address to) external nonReentrant {
        if (msg.sender != IZeroXFiFactory(factory).router()) revert Forbidden();
        if (IZeroXFiFactory(factory).swapsPaused()) revert SwapsPaused();
        if (amount0Out == 0 && amount1Out == 0) revert InsufficientInputAmount();
        (uint112 reserve0_, uint112 reserve1_) = (reserve0, reserve1);
        if (amount0Out >= reserve0_ || amount1Out >= reserve1_) revert InsufficientLiquidity();
        if (to == address(0) || to == token0 || to == token1) revert InvalidRecipient();

        if (amount0Out != 0) IERC20(token0).safeTransfer(to, amount0Out);
        if (amount1Out != 0) IERC20(token1).safeTransfer(to, amount1Out);

        uint256 balance0 = IERC20(token0).balanceOf(address(this));
        uint256 balance1 = IERC20(token1).balanceOf(address(this));
        uint256 amount0In =
            balance0 > uint256(reserve0_) - amount0Out ? balance0 - (uint256(reserve0_) - amount0Out) : 0;
        uint256 amount1In =
            balance1 > uint256(reserve1_) - amount1Out ? balance1 - (uint256(reserve1_) - amount1Out) : 0;
        if (amount0In == 0 && amount1In == 0) revert InsufficientInputAmount();

        uint256 balance0Adjusted = balance0 * FEE_DENOMINATOR - amount0In * LP_FEE_BPS;
        uint256 balance1Adjusted = balance1 * FEE_DENOMINATOR - amount1In * LP_FEE_BPS;
        if (
            balance0Adjusted * balance1Adjusted
                < uint256(reserve0_) * uint256(reserve1_) * FEE_DENOMINATOR * FEE_DENOMINATOR
        ) revert InvariantViolation();

        _updateReserves(balance0, balance1, reserve0_, reserve1_);
        emit Swap(msg.sender, amount0In, amount1In, amount0Out, amount1Out, to);
    }

    function skim(address to) external nonReentrant {
        if (to == address(0)) revert InvalidRecipient();
        if (totalSupply() == 0 && bootstrapper != address(0) && msg.sender != bootstrapper) revert Forbidden();
        IERC20(token0).safeTransfer(to, IERC20(token0).balanceOf(address(this)) - reserve0);
        IERC20(token1).safeTransfer(to, IERC20(token1).balanceOf(address(this)) - reserve1);
    }

    function sync() external nonReentrant {
        if (totalSupply() == 0 && bootstrapper != address(0) && msg.sender != bootstrapper) revert Forbidden();
        _updateReserves(
            IERC20(token0).balanceOf(address(this)), IERC20(token1).balanceOf(address(this)), reserve0, reserve1
        );
    }

    function sweepBootstrapDonations(address sink) external nonReentrant {
        if (msg.sender != bootstrapper || totalSupply() != 0 || sink == address(0)) revert Forbidden();
        uint256 amount0 = IERC20(token0).balanceOf(address(this));
        uint256 amount1 = IERC20(token1).balanceOf(address(this));
        if (amount0 != 0) IERC20(token0).safeTransfer(sink, amount0);
        if (amount1 != 0) IERC20(token1).safeTransfer(sink, amount1);
        _updateReserves(0, 0, reserve0, reserve1);
        emit BootstrapDonationsSwept(sink, amount0, amount1);
    }

    function _updateReserves(uint256 balance0, uint256 balance1, uint112 reserve0_, uint112 reserve1_) private {
        if (balance0 > type(uint112).max || balance1 > type(uint112).max) revert Overflow();
        uint32 blockTimestamp = uint32(block.timestamp);
        unchecked {
            uint32 timeElapsed = blockTimestamp - blockTimestampLast;
            if (timeElapsed != 0 && reserve0_ != 0 && reserve1_ != 0) {
                // UQ112x112 spot price is intentionally quantized before time weighting.
                // forge-lint: disable-next-line(divide-before-multiply)
                price0CumulativeLast += ((uint256(reserve1_) << 112) / reserve0_) * timeElapsed;
                // forge-lint: disable-next-line(divide-before-multiply)
                price1CumulativeLast += ((uint256(reserve0_) << 112) / reserve1_) * timeElapsed;
            }
        }
        // Both balances are bounded against uint112.max at the start of this function.
        // forge-lint: disable-next-line(unsafe-typecast)
        reserve0 = uint112(balance0);
        // forge-lint: disable-next-line(unsafe-typecast)
        reserve1 = uint112(balance1);
        blockTimestampLast = blockTimestamp;
        emit Sync(reserve0, reserve1);
    }
}
