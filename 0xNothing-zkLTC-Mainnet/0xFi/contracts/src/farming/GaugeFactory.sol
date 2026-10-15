// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { EmergencyGuardian } from "../access/EmergencyGuardian.sol";
import { IZeroXFiFactory } from "../interfaces/IZeroXFiFactory.sol";
import { LiquidityGauge } from "./LiquidityGauge.sol";

interface ISynthMintFeeVault {
    function nusd() external view returns (address);
    function syntheticAsset() external view returns (address);
    function mintFeeDistributor() external view returns (address);
}

interface ISyntheticAssetVaultBinding {
    function vault() external view returns (address);
}

contract GaugeFactory is EmergencyGuardian, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error FeeOnTransferUnsupported();
    error GaugeAlreadyExists();
    error GaugeNotFound();
    error InvalidAmount();
    error InvalidPair();
    error MintFeeRouteAlreadyBound();
    error UnauthorizedMintFeeVault();

    uint256 public constant MINT_FEE_REWARD_DURATION = 7 days;

    IERC20 public immutable nusd;
    IZeroXFiFactory public immutable dexFactory;

    mapping(address => address) public gaugeForPair;
    address[] public allGauges;
    mapping(address => address) public mintFeePairForVault;
    mapping(address => address) public mintFeeVaultForPair;
    mapping(address => uint256) public pendingMintFeesNusd;
    uint256 public totalPendingMintFeesNusd;

    event GaugeCreated(address indexed pair, address indexed gauge, uint256 gaugeCount);
    event GaugeFunded(address indexed pair, address indexed gauge, uint256 amount, uint256 duration);
    event MintFeeVaultBound(address indexed vault, address indexed pair, address indexed syntheticAsset);
    event MintFeeQueued(address indexed vault, address indexed pair, uint256 amountNusd, uint256 pendingNusd);
    event MintFeesFlushed(address indexed pair, address indexed gauge, uint256 amountNusd, uint256 duration);

    constructor(address initialOwner, address nusd_, address dexFactory_) EmergencyGuardian(initialOwner) {
        if (nusd_.code.length == 0 || dexFactory_.code.length == 0) revert InvalidPair();
        if (IZeroXFiFactory(dexFactory_).nusd() != nusd_) revert InvalidPair();
        nusd = IERC20(nusd_);
        dexFactory = IZeroXFiFactory(dexFactory_);
    }

    function allGaugesLength() external view returns (uint256) {
        return allGauges.length;
    }

    function createGauge(address pair) public returns (address gauge) {
        if (!dexFactory.isPair(pair)) revert InvalidPair();
        if (gaugeForPair[pair] != address(0)) revert GaugeAlreadyExists();
        gauge = address(new LiquidityGauge(pair, address(nusd), address(this)));
        gaugeForPair[pair] = gauge;
        allGauges.push(gauge);
        emit GaugeCreated(pair, gauge, allGauges.length);
    }

    function fundGauge(address pair, uint256 amount, uint256 duration) external onlyOwner nonReentrant {
        address gauge = gaugeForPair[pair];
        if (gauge == address(0)) revert GaugeNotFound();
        uint256 balanceBefore = nusd.balanceOf(gauge);
        nusd.safeTransferFrom(msg.sender, gauge, amount);
        if (nusd.balanceOf(gauge) != balanceBefore + amount) revert FeeOnTransferUnsupported();
        LiquidityGauge(gauge).notifyRewardAmount(amount, duration);
        emit GaugeFunded(pair, gauge, amount, duration);
    }

    /// @notice Permanently binds a synth vault's mint fees to its canonical synth/NUSD gauge.
    function bindMintFeeVault(address vault, address pair) external onlyOwner {
        if (vault == address(0) || pair == address(0) || vault.code.length == 0) revert InvalidPair();
        if (mintFeePairForVault[vault] != address(0) || mintFeeVaultForPair[pair] != address(0)) {
            revert MintFeeRouteAlreadyBound();
        }
        if (!dexFactory.isPair(pair) || gaugeForPair[pair] == address(0)) revert InvalidPair();

        ISynthMintFeeVault source = ISynthMintFeeVault(vault);
        address syntheticAsset = source.syntheticAsset();
        if (
            source.nusd() != address(nusd) || source.mintFeeDistributor() != address(this)
                || syntheticAsset == address(0) || syntheticAsset.code.length == 0
                || ISyntheticAssetVaultBinding(syntheticAsset).vault() != vault
                || dexFactory.getPair(syntheticAsset, address(nusd)) != pair
        ) revert InvalidPair();

        mintFeePairForVault[vault] = pair;
        mintFeeVaultForPair[pair] = vault;
        emit MintFeeVaultBound(vault, pair, syntheticAsset);
    }

    /// @dev Called by a bound vault after it has charged an exact NUSD mint fee.
    function routeMintFee(uint256 amountNusd) external nonReentrant returns (uint256 amountFlushedNusd) {
        address pair = mintFeePairForVault[msg.sender];
        if (pair == address(0) || mintFeeVaultForPair[pair] != msg.sender) revert UnauthorizedMintFeeVault();
        if (amountNusd == 0) revert InvalidAmount();

        uint256 balanceBefore = nusd.balanceOf(address(this));
        nusd.safeTransferFrom(msg.sender, address(this), amountNusd);
        if (nusd.balanceOf(address(this)) != balanceBefore + amountNusd) revert FeeOnTransferUnsupported();

        uint256 pendingAfter = pendingMintFeesNusd[pair] + amountNusd;
        pendingMintFeesNusd[pair] = pendingAfter;
        totalPendingMintFeesNusd += amountNusd;
        emit MintFeeQueued(msg.sender, pair, amountNusd, pendingAfter);
        amountFlushedNusd = _flushMintFees(pair);
    }

    /// @notice Starts queued fee rewards once the canonical gauge has active stake and a nonzero rate.
    function flushMintFees(address pair) external nonReentrant returns (uint256 amountFlushedNusd) {
        if (mintFeeVaultForPair[pair] == address(0)) revert GaugeNotFound();
        amountFlushedNusd = _flushMintFees(pair);
    }

    function setGaugeDepositsPaused(address pair, bool paused) external onlyOwner {
        _setGaugeDepositsPaused(pair, paused);
    }

    function pauseGaugeDeposits(address pair) external onlyOwnerOrGuardian {
        _setGaugeDepositsPaused(pair, true);
    }

    function _setGaugeDepositsPaused(address pair, bool paused) private {
        address gauge = gaugeForPair[pair];
        if (gauge == address(0)) revert GaugeNotFound();
        LiquidityGauge(gauge).setDepositsPaused(paused);
    }

    function _flushMintFees(address pair) private returns (uint256 amountFlushedNusd) {
        amountFlushedNusd = pendingMintFeesNusd[pair];
        if (amountFlushedNusd == 0) return 0;

        address gaugeAddress = gaugeForPair[pair];
        if (gaugeAddress == address(0)) revert GaugeNotFound();
        LiquidityGauge gauge = LiquidityGauge(gaugeAddress);
        if (gauge.totalSupply() == 0 || !_producesRewardRate(gauge, amountFlushedNusd)) return 0;

        pendingMintFeesNusd[pair] = 0;
        totalPendingMintFeesNusd -= amountFlushedNusd;
        uint256 balanceBefore = nusd.balanceOf(gaugeAddress);
        nusd.safeTransfer(gaugeAddress, amountFlushedNusd);
        if (nusd.balanceOf(gaugeAddress) != balanceBefore + amountFlushedNusd) {
            revert FeeOnTransferUnsupported();
        }
        gauge.notifyRewardAmount(amountFlushedNusd, MINT_FEE_REWARD_DURATION);
        emit MintFeesFlushed(pair, gaugeAddress, amountFlushedNusd, MINT_FEE_REWARD_DURATION);
    }

    function _producesRewardRate(LiquidityGauge gauge, uint256 newRewards) private view returns (bool) {
        uint256 distributable = newRewards;
        // The existing gauge rolls the unvested part of an active schedule into every top-up.
        if (gauge.pausedRewardDuration() != 0) {
            distributable += gauge.pausedRewardDuration() * gauge.rewardRate();
        } else {
            // forge-lint: disable-next-line(block-timestamp)
            if (block.timestamp < gauge.periodFinish()) {
                distributable += (gauge.periodFinish() - block.timestamp) * gauge.rewardRate();
            }
        }
        return distributable >= MINT_FEE_REWARD_DURATION;
    }
}
