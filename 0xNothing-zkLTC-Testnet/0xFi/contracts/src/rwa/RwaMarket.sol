// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { RwaPriceOracle } from "./RwaPriceOracle.sol";

/// @notice Prefunded spot market. Never mints an RWA or promises offchain redemption.
/// @dev Only conventional non-rebasing, exact-transfer ERC20s are supported.
/// Liquidity/inventory donations are permanent; owner can only withdraw earned fees.
contract RwaMarket is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error InvalidConfiguration();
    error TradingPaused();
    error InvalidAmount();
    error Expired();
    error Slippage();
    error InsufficientLiquidity();
    error DailyLimit();
    error UnsupportedToken();
    error InvalidRecipient();

    uint256 public constant FEE_BPS = 100;
    IERC20 public immutable asset;
    IERC20 public immutable settlement;
    RwaPriceOracle public immutable oracle;
    uint8 public immutable assetDecimals;
    uint8 public immutable settlementDecimals;
    uint256 public immutable reserveFloor;
    uint256 public immutable maxTradeValue;
    uint256 public immutable dailySellLimit;
    uint256 public feeReserve;
    uint256 public sellDay;
    uint256 public soldToday;
    bool public paused = true;

    event Trade(address indexed trader, bool indexed buySide, uint256 assetAmount, uint256 gross, uint256 fee);
    event Funded(address indexed sender, address indexed token, uint256 amount);
    event FeesWithdrawn(address indexed recipient, uint256 amount);
    event FeesReinvested(uint256 amount);
    event PauseChanged(bool paused);

    constructor(
        address owner_,
        address asset_,
        address settlement_,
        address[4] memory sources,
        uint256 maxAge,
        uint256 deviationBps,
        uint256 floor,
        uint256 tradeLimit,
        uint256 sellLimit
    ) Ownable(owner_) {
        if (
            asset_ == settlement_ || asset_.code.length == 0 || settlement_.code.length == 0 || floor == 0
                || tradeLimit == 0 || sellLimit < tradeLimit
        ) revert InvalidConfiguration();
        uint8 a = IERC20Metadata(asset_).decimals();
        uint8 s = IERC20Metadata(settlement_).decimals();
        if (a > 18 || s > 18) revert InvalidConfiguration();
        asset = IERC20(asset_);
        settlement = IERC20(settlement_);
        assetDecimals = a;
        settlementDecimals = s;
        oracle = new RwaPriceOracle(sources, maxAge, deviationBps);
        reserveFloor = floor;
        maxTradeValue = tradeLimit;
        dailySellLimit = sellLimit;
    }

    /// @return gross Value in settlement base units, before fee.
    /// @return fee One percent, rounded up to a settlement base unit.
    /// @return total Buy cost including fee, or sell proceeds after fee.
    function quote(bool buySide, uint256 amount) public view returns (uint256 gross, uint256 fee, uint256 total) {
        if (paused) revert TradingPaused();
        if (amount == 0) revert InvalidAmount();
        (uint256 price,,) = oracle.readPriceWad();
        // a<=18,s<=18: denominator<=1e36; full precision mulDiv avoids an
        // intermediate WAD rounding step and never rounds a buy down.
        uint256 denominator = 10 ** assetDecimals * 10 ** (18 - settlementDecimals);
        gross = Math.mulDiv(amount, price, denominator, buySide ? Math.Rounding.Ceil : Math.Rounding.Floor);
        if (gross == 0 || gross > maxTradeValue) revert InvalidAmount();
        fee = Math.mulDiv(gross, FEE_BPS, 10_000, Math.Rounding.Ceil);
        if (!buySide && fee >= gross) revert InvalidAmount();
        total = buySide ? gross + fee : gross - fee;
        if (buySide) {
            if (amount > asset.balanceOf(address(this))) revert InsufficientLiquidity();
        } else {
            if (gross > availableLiquidity()) revert InsufficientLiquidity();
            if (gross > remainingDailySell()) revert DailyLimit();
        }
    }

    function buy(uint256 amount, uint256 maxCost, uint256 deadline) external nonReentrant {
        if (block.timestamp > deadline) revert Expired();
        (uint256 gross, uint256 fee, uint256 total) = quote(true, amount);
        if (total > maxCost) revert Slippage();
        feeReserve += fee;
        _pull(settlement, total);
        _push(asset, msg.sender, amount);
        emit Trade(msg.sender, true, amount, gross, fee);
    }

    function sell(uint256 amount, uint256 minProceeds, uint256 deadline) external nonReentrant {
        if (block.timestamp > deadline) revert Expired();
        (uint256 gross, uint256 fee, uint256 total) = quote(false, amount);
        if (total < minProceeds) revert Slippage();
        uint256 today = block.timestamp / 1 days;
        if (sellDay != today) {
            sellDay = today;
            soldToday = 0;
        }
        soldToday += gross;
        feeReserve += fee;
        _pull(asset, amount);
        _push(settlement, msg.sender, total);
        emit Trade(msg.sender, false, amount, gross, fee);
    }

    function availableLiquidity() public view returns (uint256) {
        uint256 balance = settlement.balanceOf(address(this));
        uint256 protected = reserveFloor + feeReserve;
        return balance > protected ? balance - protected : 0;
    }

    function remainingDailySell() public view returns (uint256) {
        return sellDay == block.timestamp / 1 days ? dailySellLimit - soldToday : dailySellLimit;
    }

    function withdrawableFees() public view returns (uint256) {
        uint256 balance = settlement.balanceOf(address(this));
        return balance > reserveFloor ? Math.min(feeReserve, balance - reserveFloor) : 0;
    }

    function fund(bool assetSide, uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        IERC20 token = assetSide ? asset : settlement;
        _pull(token, amount);
        emit Funded(msg.sender, address(token), amount);
    }

    function withdrawFees(address recipient, uint256 amount) external onlyOwner nonReentrant {
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();
        if (amount == 0 || amount > withdrawableFees()) revert InsufficientLiquidity();
        feeReserve -= amount;
        _push(settlement, recipient, amount);
        emit FeesWithdrawn(recipient, amount);
    }

    function reinvestFees(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0 || amount > feeReserve) revert InvalidAmount();
        feeReserve -= amount;
        emit FeesReinvested(amount);
    }

    function setPaused(bool value) external onlyOwner {
        if (!value) {
            oracle.readPriceWad();
            if (availableLiquidity() == 0 || asset.balanceOf(address(this)) == 0) revert InsufficientLiquidity();
        }
        paused = value;
        emit PauseChanged(value);
    }

    function _pull(IERC20 token, uint256 amount) private {
        uint256 beforeBalance = token.balanceOf(address(this));
        uint256 senderBefore = token.balanceOf(msg.sender);
        token.safeTransferFrom(msg.sender, address(this), amount);
        if (
            token.balanceOf(address(this)) != beforeBalance + amount || senderBefore < amount
                || token.balanceOf(msg.sender) != senderBefore - amount
        ) revert UnsupportedToken();
    }

    function _push(IERC20 token, address recipient, uint256 amount) private {
        uint256 beforeBalance = token.balanceOf(address(this));
        uint256 recipientBefore = token.balanceOf(recipient);
        token.safeTransfer(recipient, amount);
        if (
            token.balanceOf(address(this)) != beforeBalance - amount
                || token.balanceOf(recipient) != recipientBefore + amount
        ) revert UnsupportedToken();
    }
}
