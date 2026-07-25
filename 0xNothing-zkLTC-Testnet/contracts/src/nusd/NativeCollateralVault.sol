// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MathX} from "../common/MathX.sol";
import {ReentrancyGuard} from "../common/ReentrancyGuard.sol";
import {RoleControl} from "../common/RoleControl.sol";
import {SafeTransferLib} from "../common/SafeTransferLib.sol";
import {DIAOracleAdapter} from "./DIAOracleAdapter.sol";

interface INUSDVaultToken {
    function mint(address to, uint256 amount) external;
    function burnFrom(address account, uint256 amount) external;
}

contract NativeCollateralVault is RoleControl, ReentrancyGuard {
    using MathX for uint256;

    error InvalidConfiguration();
    error InvalidAmount();
    error InvalidRecipient();
    error RiskOperationsPaused();
    error InsufficientCollateral();
    error PositionHealthy();
    error SlippageExceeded();
    error NoExcessNative();
    error DebtCeilingExceeded();
    error LiquidationsPaused();

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant WAD = 1e18;
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    struct Position {
        uint256 collateralWei;
        uint256 debtNusd;
    }

    INUSDVaultToken public immutable nusd;
    DIAOracleAdapter public immutable oracle;
    uint256 public immutable minimumCollateralRatioBps;
    uint256 public immutable liquidationRatioBps;
    uint256 public immutable liquidationBonusBps;
    uint256 public immutable closeFactorBps;
    uint256 public immutable debtCeilingNusd;

    mapping(address => Position) public positions;
    mapping(address => uint256) public cumulativeBadDebtNusdByAccount;
    uint256 public totalCollateralWei;
    uint256 public totalDebtNusd;
    uint256 public totalBadDebtNusd;
    bool public riskOperationsPaused;
    bool public liquidationsPaused;

    event CollateralDeposited(address indexed account, uint256 amountWei, uint256 collateralAfter);
    event NUSDMinted(address indexed account, address indexed recipient, uint256 amountNusd, uint256 debtAfter);
    event NUSDRepaid(address indexed payer, address indexed account, uint256 amountNusd, uint256 debtAfter);
    event CollateralWithdrawn(
        address indexed account, address indexed recipient, uint256 amountWei, uint256 collateralAfter
    );
    event PositionLiquidated(
        address indexed liquidator,
        address indexed account,
        address indexed recipient,
        uint256 debtRepaidNusd,
        uint256 collateralSeizedWei
    );
    event RiskOperationsPauseUpdated(bool paused);
    event LiquidationsPauseUpdated(bool paused);
    event ExcessNativeSwept(address indexed recipient, uint256 amountWei);
    event BadDebtRecognized(address indexed account, uint256 amountNusd, uint256 totalBadDebtNusd);
    event BadDebtCovered(address indexed payer, uint256 amountNusd, uint256 remainingBadDebtNusd);

    constructor(
        address nusdAddress,
        address oracleAdapter,
        address initialAdmin,
        uint256 minimumRatioBps,
        uint256 liquidationRatio,
        uint256 liquidationBonus,
        uint256 closeFactor,
        uint256 debtCeiling
    ) RoleControl(initialAdmin) {
        if (
            nusdAddress == address(0) || nusdAddress.code.length == 0 || oracleAdapter == address(0)
                || oracleAdapter.code.length == 0 || minimumRatioBps <= liquidationRatio
                || liquidationRatio < BPS_DENOMINATOR || liquidationBonus > 2_000 || closeFactor == 0
                || closeFactor > BPS_DENOMINATOR || debtCeiling == 0
        ) revert InvalidConfiguration();

        nusd = INUSDVaultToken(nusdAddress);
        oracle = DIAOracleAdapter(oracleAdapter);
        minimumCollateralRatioBps = minimumRatioBps;
        liquidationRatioBps = liquidationRatio;
        liquidationBonusBps = liquidationBonus;
        closeFactorBps = closeFactor;
        debtCeilingNusd = debtCeiling;
        _grantRole(PAUSER_ROLE, initialAdmin);
    }

    receive() external payable {
        _creditDeposit(msg.sender, msg.value);
    }

    function deposit() external payable {
        _creditDeposit(msg.sender, msg.value);
    }

    function depositAndMint(uint256 amountNusd, address recipient) external payable nonReentrant {
        _creditDeposit(msg.sender, msg.value);
        _mintAgainstPosition(msg.sender, amountNusd, recipient);
    }

    function mintNusd(uint256 amountNusd, address recipient) external nonReentrant {
        _mintAgainstPosition(msg.sender, amountNusd, recipient);
    }

    function repay(uint256 amountNusd, address account) public nonReentrant {
        _repay(msg.sender, account, amountNusd);
    }

    function repayAndWithdraw(uint256 repayAmountNusd, uint256 collateralAmountWei, address recipient)
        external
        nonReentrant
    {
        if (repayAmountNusd > 0) _repay(msg.sender, msg.sender, repayAmountNusd);
        if (collateralAmountWei > 0) _withdraw(msg.sender, collateralAmountWei, recipient);
    }

    function withdrawCollateral(uint256 amountWei, address recipient) external nonReentrant {
        _withdraw(msg.sender, amountWei, recipient);
    }

    function liquidate(address account, uint256 maxDebtToRepayNusd, uint256 minCollateralOutWei, address recipient)
        external
        nonReentrant
        returns (uint256 debtRepaidNusd, uint256 collateralOutWei)
    {
        if (liquidationsPaused) revert LiquidationsPaused();
        if (account == address(0) || recipient == address(0)) revert InvalidRecipient();
        if (maxDebtToRepayNusd == 0) revert InvalidAmount();

        (uint256 priceWad,,) = oracle.readPriceWad();
        Position storage position = positions[account];
        if (position.debtNusd == 0 || _isHealthy(position, priceWad, liquidationRatioBps)) {
            revert PositionHealthy();
        }

        uint256 closeLimit = MathX.mulDiv(position.debtNusd, closeFactorBps, BPS_DENOMINATOR);
        if (closeLimit == 0) closeLimit = position.debtNusd;

        uint256 positionValueNusd = MathX.mulDiv(position.collateralWei, priceWad, WAD);
        uint256 repayLimitByCollateral =
            MathX.mulDiv(positionValueNusd, BPS_DENOMINATOR, BPS_DENOMINATOR + liquidationBonusBps);

        debtRepaidNusd = MathX.min(maxDebtToRepayNusd, position.debtNusd);
        debtRepaidNusd = MathX.min(debtRepaidNusd, closeLimit);
        debtRepaidNusd = MathX.min(debtRepaidNusd, repayLimitByCollateral);
        if (debtRepaidNusd == 0) revert InsufficientCollateral();

        uint256 baseCollateralWei = MathX.mulDiv(debtRepaidNusd, WAD, priceWad);
        collateralOutWei = MathX.mulDiv(baseCollateralWei, BPS_DENOMINATOR + liquidationBonusBps, BPS_DENOMINATOR);
        if (debtRepaidNusd == repayLimitByCollateral) collateralOutWei = position.collateralWei;
        if (collateralOutWei > position.collateralWei) collateralOutWei = position.collateralWei;
        if (collateralOutWei < minCollateralOutWei) revert SlippageExceeded();

        nusd.burnFrom(msg.sender, debtRepaidNusd);
        position.debtNusd -= debtRepaidNusd;
        position.collateralWei -= collateralOutWei;
        totalDebtNusd -= debtRepaidNusd;
        totalCollateralWei -= collateralOutWei;

        if (position.collateralWei == 0 && position.debtNusd > 0) {
            uint256 badDebtNusd = position.debtNusd;
            position.debtNusd = 0;
            totalDebtNusd -= badDebtNusd;
            totalBadDebtNusd += badDebtNusd;
            cumulativeBadDebtNusdByAccount[account] += badDebtNusd;
            emit BadDebtRecognized(account, badDebtNusd, totalBadDebtNusd);
        }

        SafeTransferLib.safeTransferNative(recipient, collateralOutWei);
        emit PositionLiquidated(msg.sender, account, recipient, debtRepaidNusd, collateralOutWei);
    }

    function coverBadDebt(uint256 amountNusd) external nonReentrant {
        if (amountNusd == 0 || amountNusd > totalBadDebtNusd) revert InvalidAmount();
        nusd.burnFrom(msg.sender, amountNusd);
        totalBadDebtNusd -= amountNusd;
        emit BadDebtCovered(msg.sender, amountNusd, totalBadDebtNusd);
    }

    function setRiskOperationsPaused(bool paused) external onlyRole(PAUSER_ROLE) {
        riskOperationsPaused = paused;
        emit RiskOperationsPauseUpdated(paused);
    }

    function setLiquidationsPaused(bool paused) external onlyRole(PAUSER_ROLE) {
        liquidationsPaused = paused;
        emit LiquidationsPauseUpdated(paused);
    }

    function sweepExcessNative(address recipient, uint256 amountWei)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        nonReentrant
    {
        if (recipient == address(0)) revert InvalidRecipient();
        uint256 excess = address(this).balance - totalCollateralWei;
        if (amountWei == 0 || amountWei > excess) revert NoExcessNative();
        SafeTransferLib.safeTransferNative(recipient, amountWei);
        emit ExcessNativeSwept(recipient, amountWei);
    }

    function collateralValueNusd(address account) public view returns (uint256 valueNusd) {
        (uint256 priceWad,,) = oracle.readPriceWad();
        valueNusd = MathX.mulDiv(positions[account].collateralWei, priceWad, WAD);
    }

    function collateralRatioBps(address account) public view returns (uint256 ratioBps) {
        Position storage position = positions[account];
        if (position.debtNusd == 0) return type(uint256).max;
        (uint256 priceWad,,) = oracle.readPriceWad();
        ratioBps = MathX.mulDiv(MathX.mulDiv(position.collateralWei, priceWad, WAD), BPS_DENOMINATOR, position.debtNusd);
    }

    function maxMintableNusd(address account) external view returns (uint256 amountNusd) {
        Position storage position = positions[account];
        (uint256 priceWad,,) = oracle.readPriceWad();
        uint256 maximumDebt = MathX.mulDiv(
            MathX.mulDiv(position.collateralWei, priceWad, WAD), BPS_DENOMINATOR, minimumCollateralRatioBps
        );
        uint256 collateralHeadroom = maximumDebt > position.debtNusd ? maximumDebt - position.debtNusd : 0;
        uint256 outstandingNusd = totalDebtNusd + totalBadDebtNusd;
        uint256 ceilingHeadroom = outstandingNusd < debtCeilingNusd ? debtCeilingNusd - outstandingNusd : 0;
        return MathX.min(collateralHeadroom, ceilingHeadroom);
    }

    function quoteMintForCollateral(uint256 collateralWei) external view returns (uint256 amountNusd) {
        (uint256 priceWad,,) = oracle.readPriceWad();
        amountNusd =
            MathX.mulDiv(MathX.mulDiv(collateralWei, priceWad, WAD), BPS_DENOMINATOR, minimumCollateralRatioBps);
    }

    function isLiquidatable(address account) external view returns (bool) {
        Position storage position = positions[account];
        if (position.debtNusd == 0) return false;
        (uint256 priceWad,,) = oracle.readPriceWad();
        return !_isHealthy(position, priceWad, liquidationRatioBps);
    }

    function _creditDeposit(address account, uint256 amountWei) internal {
        if (amountWei == 0) revert InvalidAmount();
        positions[account].collateralWei += amountWei;
        totalCollateralWei += amountWei;
        emit CollateralDeposited(account, amountWei, positions[account].collateralWei);
    }

    function _mintAgainstPosition(address account, uint256 amountNusd, address recipient) internal {
        if (riskOperationsPaused) revert RiskOperationsPaused();
        if (amountNusd == 0) revert InvalidAmount();
        if (recipient == address(0)) revert InvalidRecipient();

        (uint256 priceWad,,) = oracle.readPriceWad();
        Position storage position = positions[account];
        uint256 outstandingNusd = totalDebtNusd + totalBadDebtNusd;
        if (outstandingNusd > debtCeilingNusd || amountNusd > debtCeilingNusd - outstandingNusd) {
            revert DebtCeilingExceeded();
        }
        uint256 debtAfter = position.debtNusd + amountNusd;
        Position memory proposed = Position(position.collateralWei, debtAfter);
        if (!_isHealthyMemory(proposed, priceWad, minimumCollateralRatioBps)) revert InsufficientCollateral();

        position.debtNusd = debtAfter;
        totalDebtNusd += amountNusd;
        nusd.mint(recipient, amountNusd);
        emit NUSDMinted(account, recipient, amountNusd, debtAfter);
    }

    function _repay(address payer, address account, uint256 amountNusd) internal {
        if (account == address(0)) revert InvalidRecipient();
        Position storage position = positions[account];
        if (amountNusd == 0 || amountNusd > position.debtNusd) revert InvalidAmount();

        nusd.burnFrom(payer, amountNusd);
        position.debtNusd -= amountNusd;
        totalDebtNusd -= amountNusd;
        emit NUSDRepaid(payer, account, amountNusd, position.debtNusd);
    }

    function _withdraw(address account, uint256 amountWei, address recipient) internal {
        if (riskOperationsPaused) revert RiskOperationsPaused();
        if (recipient == address(0)) revert InvalidRecipient();
        Position storage position = positions[account];
        if (amountWei == 0 || amountWei > position.collateralWei) revert InvalidAmount();

        uint256 collateralAfter = position.collateralWei - amountWei;
        if (position.debtNusd > 0) {
            (uint256 priceWad,,) = oracle.readPriceWad();
            Position memory proposed = Position(collateralAfter, position.debtNusd);
            if (!_isHealthyMemory(proposed, priceWad, minimumCollateralRatioBps)) revert InsufficientCollateral();
        }

        position.collateralWei = collateralAfter;
        totalCollateralWei -= amountWei;
        SafeTransferLib.safeTransferNative(recipient, amountWei);
        emit CollateralWithdrawn(account, recipient, amountWei, collateralAfter);
    }

    function _isHealthy(Position storage position, uint256 priceWad, uint256 requiredRatioBps)
        internal
        view
        returns (bool)
    {
        if (position.debtNusd == 0) return true;
        uint256 valueNusd = MathX.mulDiv(position.collateralWei, priceWad, WAD);
        return MathX.mulDiv(valueNusd, BPS_DENOMINATOR, position.debtNusd) >= requiredRatioBps;
    }

    function _isHealthyMemory(Position memory position, uint256 priceWad, uint256 requiredRatioBps)
        internal
        pure
        returns (bool)
    {
        if (position.debtNusd == 0) return true;
        uint256 valueNusd = MathX.mulDiv(position.collateralWei, priceWad, WAD);
        return MathX.mulDiv(valueNusd, BPS_DENOMINATOR, position.debtNusd) >= requiredRatioBps;
    }
}
