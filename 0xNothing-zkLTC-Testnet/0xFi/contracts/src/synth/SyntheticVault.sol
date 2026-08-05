// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { EmergencyGuardian } from "../access/EmergencyGuardian.sol";
import { IPriceOracle } from "../oracle/interfaces/IPriceOracle.sol";
import { SyntheticAsset } from "./SyntheticAsset.sol";

interface ISynthSafetyReserve {
    function nusd() external view returns (address);
    function sponsorshipActive() external view returns (bool);
    function allocationsPaused() external view returns (bool);
    function freeReserveNusd() external view returns (uint256);
    function allocateToVault(uint256 amountNusd) external;
    function releaseFromVault(uint256 amountNusd) external;
    function recordVaultLoss(uint256 amountNusd) external;
}

interface ISynthMintFeeDistributor {
    function nusd() external view returns (address);
    function routeMintFee(uint256 amountNusd) external returns (uint256 amountFlushedNusd);
}

/// @notice One isolated synthetic vault with user-owned and protocol-reserve NUSD accounting.
contract SyntheticVault is EmergencyGuardian, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error InvalidConfiguration();
    error InvalidAmount();
    error InvalidRecipient();
    error MintPaused();
    error WithdrawPaused();
    error ExactTransferRequired();
    error InsufficientCollateral();
    error PositionHealthy();
    error DebtCeilingExceeded();
    error AccountHasBadDebt();
    error SlippageExceeded();
    error MintFeeExceeded(uint256 feeNusd, uint256 maximumFeeNusd);

    uint256 public constant WAD = 1e18;
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant USER_SPONSORED_RATIO_BPS = 10_000;
    uint256 public constant RESERVE_SPONSORED_RATIO_BPS = 5000;
    uint256 public constant MINIMUM_COLLATERAL_RATIO_BPS = 15_000;
    uint256 public constant LIQUIDATION_RATIO_BPS = 12_500;
    uint256 public constant LIQUIDATION_BONUS_BPS = 500;
    uint256 public constant CLOSE_FACTOR_BPS = 5000;
    uint256 public constant MINT_FEE_BPS = 10;

    struct Position {
        uint256 userCollateralNusd;
        uint256 reserveCollateralNusd;
        uint256 debtSynthetic;
    }

    IERC20 public immutable nusd;
    SyntheticAsset public immutable syntheticAsset;
    IPriceOracle public immutable oracle;
    ISynthSafetyReserve public immutable safetyReserve;
    ISynthMintFeeDistributor public immutable mintFeeDistributor;

    mapping(address => Position) public positions;
    mapping(address => uint256) public badDebtSyntheticByAccount;

    uint256 public totalUserCollateralNusd;
    uint256 public totalReserveCollateralNusd;
    uint256 public totalDebtSynthetic;
    uint256 public totalBadDebtSynthetic;
    uint256 public debtCeilingSynthetic;
    bool public mintPaused;
    bool public withdrawPaused;

    event CollateralDeposited(address indexed payer, address indexed account, uint256 amountNusd);
    event ReserveCollateralAllocated(address indexed account, uint256 amountNusd);
    event ReserveCollateralReleased(address indexed account, uint256 amountNusd);
    event ReserveCollateralLost(address indexed account, uint256 amountNusd);
    event SyntheticMinted(
        address indexed account, address indexed recipient, uint256 amountSynthetic, uint256 debtAfter
    );
    event SyntheticRepaid(address indexed payer, address indexed account, uint256 amountSynthetic, uint256 debtAfter);
    event CollateralWithdrawn(address indexed account, address indexed recipient, uint256 amountNusd);
    event PositionLiquidated(
        address indexed liquidator,
        address indexed account,
        address indexed recipient,
        uint256 repaidSynthetic,
        uint256 seizedNusd
    );
    event BadDebtRecognized(address indexed account, uint256 amountSynthetic);
    event BadDebtCovered(address indexed payer, address indexed account, uint256 amountSynthetic);
    event DebtCeilingUpdated(uint256 previousCeilingSynthetic, uint256 newCeilingSynthetic);
    event MintPauseUpdated(bool paused);
    event WithdrawPauseUpdated(bool paused);
    event MintFeePaid(address indexed account, uint256 indexed amountSynthetic, uint256 amountNusd);

    constructor(
        address nusdAddress,
        address syntheticAssetAddress,
        address oracleAddress,
        address safetyReserveAddress,
        address mintFeeDistributorAddress,
        address initialOwner,
        uint256 initialDebtCeilingSynthetic
    ) EmergencyGuardian(initialOwner) {
        if (
            nusdAddress == address(0) || nusdAddress.code.length == 0 || syntheticAssetAddress == address(0)
                || syntheticAssetAddress.code.length == 0 || oracleAddress == address(0)
                || oracleAddress.code.length == 0 || safetyReserveAddress == address(0)
                || safetyReserveAddress.code.length == 0 || nusdAddress == syntheticAssetAddress
                || mintFeeDistributorAddress == address(0) || mintFeeDistributorAddress.code.length == 0
                || initialDebtCeilingSynthetic == 0
        ) revert InvalidConfiguration();
        if (IERC20Metadata(nusdAddress).decimals() != 18) revert InvalidConfiguration();
        if (ISynthSafetyReserve(safetyReserveAddress).nusd() != nusdAddress) revert InvalidConfiguration();
        if (ISynthMintFeeDistributor(mintFeeDistributorAddress).nusd() != nusdAddress) {
            revert InvalidConfiguration();
        }

        nusd = IERC20(nusdAddress);
        syntheticAsset = SyntheticAsset(syntheticAssetAddress);
        oracle = IPriceOracle(oracleAddress);
        safetyReserve = ISynthSafetyReserve(safetyReserveAddress);
        mintFeeDistributor = ISynthMintFeeDistributor(mintFeeDistributorAddress);
        debtCeilingSynthetic = initialDebtCeilingSynthetic;
        IERC20(nusdAddress).forceApprove(safetyReserveAddress, type(uint256).max);
    }

    function depositCollateral(uint256 amountNusd, address onBehalfOf) external nonReentrant {
        _depositCollateral(msg.sender, onBehalfOf, amountNusd);
    }

    function depositAndMint(
        uint256 collateralAmountNusd,
        uint256 syntheticAmount,
        uint256 maximumFeeNusd,
        address recipient
    ) external nonReentrant {
        _depositCollateral(msg.sender, msg.sender, collateralAmountNusd);
        _mintSynthetic(msg.sender, syntheticAmount, maximumFeeNusd, recipient);
    }

    function mint(uint256 amountSynthetic, uint256 maximumFeeNusd, address recipient) external nonReentrant {
        _mintSynthetic(msg.sender, amountSynthetic, maximumFeeNusd, recipient);
    }

    function repay(uint256 maximumAmountSynthetic, address onBehalfOf)
        public
        nonReentrant
        returns (uint256 amountRepaidSynthetic)
    {
        amountRepaidSynthetic = _repay(msg.sender, onBehalfOf, maximumAmountSynthetic);
    }

    function repayAndWithdraw(uint256 maximumRepaySynthetic, uint256 collateralAmountNusd, address recipient)
        external
        nonReentrant
        returns (uint256 amountRepaidSynthetic)
    {
        if (maximumRepaySynthetic != 0) {
            amountRepaidSynthetic = _repay(msg.sender, msg.sender, maximumRepaySynthetic);
        }
        if (collateralAmountNusd != 0) _withdrawCollateral(msg.sender, collateralAmountNusd, recipient);
    }

    function withdrawCollateral(uint256 amountNusd, address recipient) external nonReentrant {
        _withdrawCollateral(msg.sender, amountNusd, recipient);
    }

    function releaseExcessReserveCollateral(address account)
        external
        nonReentrant
        returns (uint256 amountReleasedNusd)
    {
        if (account == address(0)) revert InvalidRecipient();
        amountReleasedNusd = _releaseExcessReserveCollateral(account);
    }

    function liquidate(
        address account,
        uint256 maximumRepaySynthetic,
        uint256 minimumCollateralOutNusd,
        address recipient
    ) external nonReentrant returns (uint256 repaidSynthetic, uint256 collateralOutNusd) {
        if (account == address(0) || recipient == address(0) || recipient == address(this)) {
            revert InvalidRecipient();
        }
        if (maximumRepaySynthetic == 0) revert InvalidAmount();

        (uint256 priceWad,,) = oracle.readPriceWad();
        Position storage accountPosition = positions[account];
        uint256 availableCollateral = accountPosition.userCollateralNusd + accountPosition.reserveCollateralNusd;
        if (
            accountPosition.debtSynthetic == 0
                || _isCollateralized(
                    availableCollateral, accountPosition.debtSynthetic, priceWad, LIQUIDATION_RATIO_BPS
                )
        ) revert PositionHealthy();

        (repaidSynthetic, collateralOutNusd) =
            _liquidationQuote(accountPosition, maximumRepaySynthetic, priceWad, availableCollateral);
        if (collateralOutNusd < minimumCollateralOutNusd) revert SlippageExceeded();

        accountPosition.debtSynthetic -= repaidSynthetic;
        totalDebtSynthetic -= repaidSynthetic;
        _applyLiquidationCollateralLoss(account, accountPosition, collateralOutNusd);

        _pullExact(IERC20(address(syntheticAsset)), msg.sender, repaidSynthetic);
        syntheticAsset.burn(repaidSynthetic);
        _recognizeBadDebtIfEmpty(account, accountPosition);

        _pushExact(nusd, recipient, collateralOutNusd);
        emit PositionLiquidated(msg.sender, account, recipient, repaidSynthetic, collateralOutNusd);
    }

    function _liquidationQuote(
        Position storage accountPosition,
        uint256 maximumRepaySynthetic,
        uint256 priceWad,
        uint256 availableCollateral
    ) internal view returns (uint256 repaidSynthetic, uint256 collateralOutNusd) {
        uint256 closeLimit = Math.mulDiv(accountPosition.debtSynthetic, CLOSE_FACTOR_BPS, BPS_DENOMINATOR);
        if (closeLimit == 0) closeLimit = accountPosition.debtSynthetic;
        repaidSynthetic = _min(maximumRepaySynthetic, _min(closeLimit, accountPosition.debtSynthetic));

        uint256 maximumBaseValueNusd =
            Math.mulDiv(availableCollateral, BPS_DENOMINATOR, BPS_DENOMINATOR + LIQUIDATION_BONUS_BPS);
        uint256 collateralLimitedRepay = Math.mulDiv(maximumBaseValueNusd, WAD, priceWad);
        bool exhaustsCollateral = collateralLimitedRepay <= repaidSynthetic;
        repaidSynthetic = _min(repaidSynthetic, collateralLimitedRepay);
        if (repaidSynthetic == 0) revert InsufficientCollateral();

        collateralOutNusd = _liquidationCollateralOut(repaidSynthetic, priceWad);
        if (exhaustsCollateral || collateralOutNusd > availableCollateral) collateralOutNusd = availableCollateral;
    }

    function _applyLiquidationCollateralLoss(
        address account,
        Position storage accountPosition,
        uint256 collateralOutNusd
    ) internal {
        // User collateral absorbs liquidation first. Otherwise an account could
        // self-liquidate with its freshly minted synth and extract reserve NUSD.
        uint256 userLoss = _min(collateralOutNusd, accountPosition.userCollateralNusd);
        if (userLoss != 0) {
            accountPosition.userCollateralNusd -= userLoss;
            totalUserCollateralNusd -= userLoss;
        }
        uint256 reserveLoss = collateralOutNusd - userLoss;
        if (reserveLoss != 0) {
            accountPosition.reserveCollateralNusd -= reserveLoss;
            totalReserveCollateralNusd -= reserveLoss;
            safetyReserve.recordVaultLoss(reserveLoss);
            emit ReserveCollateralLost(account, reserveLoss);
        }
    }

    function _recognizeBadDebtIfEmpty(address account, Position storage accountPosition) internal {
        if (
            accountPosition.userCollateralNusd != 0 || accountPosition.reserveCollateralNusd != 0
                || accountPosition.debtSynthetic == 0
        ) return;
        uint256 badDebt = accountPosition.debtSynthetic;
        accountPosition.debtSynthetic = 0;
        totalDebtSynthetic -= badDebt;
        totalBadDebtSynthetic += badDebt;
        badDebtSyntheticByAccount[account] += badDebt;
        emit BadDebtRecognized(account, badDebt);
    }

    function coverBadDebt(address account, uint256 maximumAmountSynthetic)
        external
        nonReentrant
        returns (uint256 amountCoveredSynthetic)
    {
        uint256 accountBadDebt = badDebtSyntheticByAccount[account];
        if (accountBadDebt == 0 || maximumAmountSynthetic == 0) revert InvalidAmount();
        amountCoveredSynthetic = _min(accountBadDebt, maximumAmountSynthetic);

        badDebtSyntheticByAccount[account] = accountBadDebt - amountCoveredSynthetic;
        totalBadDebtSynthetic -= amountCoveredSynthetic;
        _pullExact(IERC20(address(syntheticAsset)), msg.sender, amountCoveredSynthetic);
        syntheticAsset.burn(amountCoveredSynthetic);
        emit BadDebtCovered(msg.sender, account, amountCoveredSynthetic);
    }

    function setDebtCeilingSynthetic(uint256 newCeilingSynthetic) external onlyOwner {
        uint256 outstanding = totalDebtSynthetic + totalBadDebtSynthetic;
        if (newCeilingSynthetic == 0 || newCeilingSynthetic < outstanding) revert InvalidConfiguration();
        uint256 previous = debtCeilingSynthetic;
        debtCeilingSynthetic = newCeilingSynthetic;
        emit DebtCeilingUpdated(previous, newCeilingSynthetic);
    }

    function setMintPaused(bool paused) external onlyOwner {
        mintPaused = paused;
        emit MintPauseUpdated(paused);
    }

    function setWithdrawPaused(bool paused) external onlyOwner {
        withdrawPaused = paused;
        emit WithdrawPauseUpdated(paused);
    }

    function pauseMinting() external onlyOwnerOrGuardian {
        mintPaused = true;
        emit MintPauseUpdated(true);
    }

    function pauseWithdrawals() external onlyOwnerOrGuardian {
        withdrawPaused = true;
        emit WithdrawPauseUpdated(true);
    }

    function totalCollateralNusd() public view returns (uint256) {
        return totalUserCollateralNusd + totalReserveCollateralNusd;
    }

    function debtValueNusd(address account) public view returns (uint256) {
        (uint256 priceWad,,) = oracle.readPriceWad();
        return _debtValueNusd(positions[account].debtSynthetic, priceWad);
    }

    function collateralRatioBps(address account) public view returns (uint256) {
        Position storage accountPosition = positions[account];
        if (accountPosition.debtSynthetic == 0) return type(uint256).max;
        (uint256 priceWad,,) = oracle.readPriceWad();
        uint256 debtValue = _debtValueNusd(accountPosition.debtSynthetic, priceWad);
        return Math.mulDiv(
            accountPosition.userCollateralNusd + accountPosition.reserveCollateralNusd, BPS_DENOMINATOR, debtValue
        );
    }

    function healthFactorWad(address account) public view returns (uint256) {
        Position storage accountPosition = positions[account];
        if (accountPosition.debtSynthetic == 0) return type(uint256).max;
        (uint256 priceWad,,) = oracle.readPriceWad();
        uint256 liquidationRequirement =
            _requiredCollateral(accountPosition.debtSynthetic, priceWad, LIQUIDATION_RATIO_BPS);
        return Math.mulDiv(
            accountPosition.userCollateralNusd + accountPosition.reserveCollateralNusd, WAD, liquidationRequirement
        );
    }

    function position(address account)
        external
        view
        returns (
            uint256 userCollateralNusd,
            uint256 reserveCollateralNusd,
            uint256 debtSynthetic,
            uint256 accountHealthFactorWad,
            uint256 maxWithdrawableNusd
        )
    {
        Position storage accountPosition = positions[account];
        userCollateralNusd = accountPosition.userCollateralNusd;
        reserveCollateralNusd = accountPosition.reserveCollateralNusd;
        debtSynthetic = accountPosition.debtSynthetic;
        accountHealthFactorWad = healthFactorWad(account);
        maxWithdrawableNusd = maxUserCollateralWithdrawable(account);
    }

    function maxMintableSynthetic(address account) external view returns (uint256 amountSynthetic) {
        if (badDebtSyntheticByAccount[account] != 0) return 0;
        (uint256 priceWad,,) = oracle.readPriceWad();
        Position storage accountPosition = positions[account];
        uint256 maximumDebtSynthetic = _maximumDebtWithExistingCollateral(
            accountPosition.userCollateralNusd, accountPosition.reserveCollateralNusd, priceWad
        );

        if (safetyReserve.sponsorshipActive()) {
            uint256 availableReserve = accountPosition.reserveCollateralNusd;
            if (!safetyReserve.allocationsPaused()) availableReserve += safetyReserve.freeReserveNusd();
            uint256 userMaximum = _maximumDebtSynthetic(accountPosition.userCollateralNusd, priceWad, 10_000);
            uint256 reserveMaximum = _maximumDebtSynthetic(availableReserve, priceWad, 5000);
            uint256 sponsoredMaximum = _min(userMaximum, reserveMaximum);
            if (sponsoredMaximum > maximumDebtSynthetic) maximumDebtSynthetic = sponsoredMaximum;
        }

        uint256 collateralHeadroom = maximumDebtSynthetic > accountPosition.debtSynthetic
            ? maximumDebtSynthetic - accountPosition.debtSynthetic
            : 0;
        return _min(collateralHeadroom, _debtCeilingHeadroom());
    }

    function quoteDepositAndMint(address account, uint256 collateralAmountNusd)
        public
        view
        returns (uint256 syntheticAmount, uint256 reserveRequiredNusd, bool oneToOneAvailable)
    {
        if (account == address(0) || badDebtSyntheticByAccount[account] != 0) return (0, 0, false);
        (uint256 priceWad,,) = oracle.readPriceWad();
        Position storage accountPosition = positions[account];
        uint256 userAfter = accountPosition.userCollateralNusd + collateralAmountNusd;
        uint256 ceilingHeadroom = _debtCeilingHeadroom();
        uint256 sponsoredInputCapacity = _maximumDebtSynthetic(collateralAmountNusd, priceWad, USER_SPONSORED_RATIO_BPS);
        uint256 sponsoredPostMaximum = _maximumDebtSynthetic(userAfter, priceWad, USER_SPONSORED_RATIO_BPS);
        uint256 sponsoredPostHeadroom = sponsoredPostMaximum > accountPosition.debtSynthetic
            ? sponsoredPostMaximum - accountPosition.debtSynthetic
            : 0;
        uint256 sponsoredAmount = _min(sponsoredInputCapacity, _min(sponsoredPostHeadroom, ceilingHeadroom));
        uint256 sponsoredDebtAfter = accountPosition.debtSynthetic + sponsoredAmount;

        if (sponsoredAmount != 0 && safetyReserve.sponsorshipActive()) {
            uint256 reserveTarget = _requiredCollateral(sponsoredDebtAfter, priceWad, RESERVE_SPONSORED_RATIO_BPS);
            reserveRequiredNusd = reserveTarget > accountPosition.reserveCollateralNusd
                ? reserveTarget - accountPosition.reserveCollateralNusd
                : 0;
            bool allocationAvailable = reserveRequiredNusd == 0
                || (!safetyReserve.allocationsPaused() && reserveRequiredNusd <= safetyReserve.freeReserveNusd());
            if (allocationAvailable) {
                syntheticAmount = sponsoredAmount;
                return (syntheticAmount, reserveRequiredNusd, true);
            }
        }

        uint256 unsponsoredInputCapacity =
            _maximumDebtSynthetic(collateralAmountNusd, priceWad, MINIMUM_COLLATERAL_RATIO_BPS);
        uint256 unsponsoredPostMaximum =
            _maximumDebtWithExistingCollateral(userAfter, accountPosition.reserveCollateralNusd, priceWad);
        uint256 unsponsoredPostHeadroom = unsponsoredPostMaximum > accountPosition.debtSynthetic
            ? unsponsoredPostMaximum - accountPosition.debtSynthetic
            : 0;
        syntheticAmount = _min(unsponsoredInputCapacity, _min(unsponsoredPostHeadroom, ceilingHeadroom));
        return (syntheticAmount, 0, false);
    }

    function maxUserCollateralWithdrawable(address account) public view returns (uint256 amountNusd) {
        Position storage accountPosition = positions[account];
        if (accountPosition.debtSynthetic == 0) return accountPosition.userCollateralNusd;
        (uint256 priceWad,,) = oracle.readPriceWad();

        uint256 reserveTarget =
            _requiredCollateral(accountPosition.debtSynthetic, priceWad, RESERVE_SPONSORED_RATIO_BPS);
        uint256 minimumUser = _minimumUserCollateral(
            accountPosition.debtSynthetic, priceWad, _min(accountPosition.reserveCollateralNusd, reserveTarget)
        );
        if (safetyReserve.sponsorshipActive()) {
            uint256 availableReserve = _min(accountPosition.reserveCollateralNusd, reserveTarget);
            if (!safetyReserve.allocationsPaused()) availableReserve += safetyReserve.freeReserveNusd();
            if (availableReserve >= reserveTarget) {
                minimumUser = _requiredCollateral(accountPosition.debtSynthetic, priceWad, USER_SPONSORED_RATIO_BPS);
            }
        }
        return accountPosition.userCollateralNusd > minimumUser ? accountPosition.userCollateralNusd - minimumUser : 0;
    }

    function quoteMintForCollateral(uint256 collateralAmountNusd) external view returns (uint256 amountSynthetic) {
        (amountSynthetic,,) = quoteDepositAndMint(msg.sender, collateralAmountNusd);
    }

    function quoteMintFee(uint256 amountSynthetic) public view returns (uint256 feeNusd) {
        if (amountSynthetic == 0) return 0;
        (uint256 priceWad,,) = oracle.readPriceWad();
        return _mintFeeNusd(amountSynthetic, priceWad);
    }

    function quoteCollateralForMint(uint256 amountSynthetic) external view returns (uint256 collateralAmountNusd) {
        if (badDebtSyntheticByAccount[msg.sender] != 0) revert AccountHasBadDebt();
        if (amountSynthetic > _debtCeilingHeadroom()) revert DebtCeilingExceeded();
        (uint256 priceWad,,) = oracle.readPriceWad();
        Position storage accountPosition = positions[msg.sender];
        uint256 debtAfter = accountPosition.debtSynthetic + amountSynthetic;
        uint256 totalRequired = _requiredCollateral(debtAfter, priceWad, MINIMUM_COLLATERAL_RATIO_BPS);
        uint256 reserveTarget = _requiredCollateral(debtAfter, priceWad, RESERVE_SPONSORED_RATIO_BPS);
        uint256 usableReserve = _min(accountPosition.reserveCollateralNusd, reserveTarget);
        uint256 currentTotal = accountPosition.userCollateralNusd + usableReserve;
        uint256 userRequired = _requiredCollateral(debtAfter, priceWad, USER_SPONSORED_RATIO_BPS);
        if (currentTotal >= totalRequired && accountPosition.userCollateralNusd >= userRequired) return 0;

        if (safetyReserve.sponsorshipActive()) {
            uint256 reserveRequired = reserveTarget - usableReserve;
            if (
                reserveRequired == 0
                    || (!safetyReserve.allocationsPaused() && reserveRequired <= safetyReserve.freeReserveNusd())
            ) {
                return userRequired > accountPosition.userCollateralNusd
                    ? userRequired - accountPosition.userCollateralNusd
                    : 0;
            }
        }
        uint256 totalShortfall = totalRequired > currentTotal ? totalRequired - currentTotal : 0;
        uint256 userShortfall =
            userRequired > accountPosition.userCollateralNusd ? userRequired - accountPosition.userCollateralNusd : 0;
        return totalShortfall > userShortfall ? totalShortfall : userShortfall;
    }

    function isLiquidatable(address account) external view returns (bool) {
        Position storage accountPosition = positions[account];
        if (accountPosition.debtSynthetic == 0) return false;
        (uint256 priceWad,,) = oracle.readPriceWad();
        return !_isCollateralized(
            accountPosition.userCollateralNusd + accountPosition.reserveCollateralNusd,
            accountPosition.debtSynthetic,
            priceWad,
            LIQUIDATION_RATIO_BPS
        );
    }

    function _depositCollateral(address payer, address account, uint256 amountNusd) internal {
        if (account == address(0)) revert InvalidRecipient();
        if (amountNusd == 0) revert InvalidAmount();
        _pullExact(nusd, payer, amountNusd);
        positions[account].userCollateralNusd += amountNusd;
        totalUserCollateralNusd += amountNusd;
        emit CollateralDeposited(payer, account, amountNusd);
    }

    function _mintSynthetic(address account, uint256 amountSynthetic, uint256 maximumFeeNusd, address recipient)
        internal
    {
        if (mintPaused) revert MintPaused();
        if (amountSynthetic == 0) revert InvalidAmount();
        if (recipient == address(0)) revert InvalidRecipient();
        if (badDebtSyntheticByAccount[account] != 0) revert AccountHasBadDebt();

        (uint256 priceWad,,) = oracle.readPriceWad();
        uint256 feeNusd = _mintFeeNusd(amountSynthetic, priceWad);
        if (feeNusd > maximumFeeNusd) revert MintFeeExceeded(feeNusd, maximumFeeNusd);
        uint256 outstanding = totalDebtSynthetic + totalBadDebtSynthetic;
        if (outstanding > debtCeilingSynthetic || amountSynthetic > debtCeilingSynthetic - outstanding) {
            revert DebtCeilingExceeded();
        }

        Position storage accountPosition = positions[account];
        uint256 debtAfter = accountPosition.debtSynthetic + amountSynthetic;
        _capReserveCollateralToTarget(account, debtAfter, priceWad);
        if (!_positionCollateralValid(accountPosition, debtAfter, priceWad)) {
            _ensureSponsoredCollateral(account, accountPosition, debtAfter, priceWad);
        }

        if (!_positionCollateralValid(accountPosition, debtAfter, priceWad)) revert InsufficientCollateral();

        _collectMintFee(account, amountSynthetic, feeNusd);
        accountPosition.debtSynthetic = debtAfter;
        totalDebtSynthetic += amountSynthetic;
        syntheticAsset.mint(recipient, amountSynthetic);
        emit SyntheticMinted(account, recipient, amountSynthetic, debtAfter);
    }

    function _collectMintFee(address payer, uint256 amountSynthetic, uint256 feeNusd) internal {
        uint256 collateralBalanceBefore = nusd.balanceOf(address(this));
        _pullExact(nusd, payer, feeNusd);
        nusd.forceApprove(address(mintFeeDistributor), feeNusd);
        mintFeeDistributor.routeMintFee(feeNusd);
        nusd.forceApprove(address(mintFeeDistributor), 0);
        if (nusd.balanceOf(address(this)) != collateralBalanceBefore) revert ExactTransferRequired();
        emit MintFeePaid(payer, amountSynthetic, feeNusd);
    }

    function _repay(address payer, address account, uint256 maximumAmountSynthetic)
        internal
        returns (uint256 amountRepaidSynthetic)
    {
        if (account == address(0)) revert InvalidRecipient();
        Position storage accountPosition = positions[account];
        if (accountPosition.debtSynthetic == 0 || maximumAmountSynthetic == 0) revert InvalidAmount();

        amountRepaidSynthetic = _min(maximumAmountSynthetic, accountPosition.debtSynthetic);
        accountPosition.debtSynthetic -= amountRepaidSynthetic;
        totalDebtSynthetic -= amountRepaidSynthetic;
        _pullExact(IERC20(address(syntheticAsset)), payer, amountRepaidSynthetic);
        syntheticAsset.burn(amountRepaidSynthetic);

        if (accountPosition.debtSynthetic == 0 && accountPosition.reserveCollateralNusd != 0) {
            _releaseReserveCollateral(account, accountPosition.reserveCollateralNusd);
        } else if (accountPosition.reserveCollateralNusd != 0) {
            _releaseExcessReserveCollateralIfOracleAvailable(account);
        }
        emit SyntheticRepaid(payer, account, amountRepaidSynthetic, accountPosition.debtSynthetic);
    }

    function _withdrawCollateral(address account, uint256 amountNusd, address recipient) internal {
        if (withdrawPaused) revert WithdrawPaused();
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();
        Position storage accountPosition = positions[account];
        if (amountNusd == 0 || amountNusd > accountPosition.userCollateralNusd) revert InvalidAmount();

        uint256 userAfter = accountPosition.userCollateralNusd - amountNusd;
        if (accountPosition.debtSynthetic != 0) {
            (uint256 priceWad,,) = oracle.readPriceWad();
            _capReserveCollateralToTarget(account, accountPosition.debtSynthetic, priceWad);
            if (!_positionCollateralValid(
                    userAfter, accountPosition.reserveCollateralNusd, accountPosition.debtSynthetic, priceWad
                )) {
                _ensureSponsoredWithdrawal(account, accountPosition, userAfter, priceWad);
            }
            if (!_positionCollateralValid(
                    userAfter, accountPosition.reserveCollateralNusd, accountPosition.debtSynthetic, priceWad
                )) {
                revert InsufficientCollateral();
            }
        } else if (accountPosition.reserveCollateralNusd != 0) {
            _releaseReserveCollateral(account, accountPosition.reserveCollateralNusd);
        }

        accountPosition.userCollateralNusd = userAfter;
        totalUserCollateralNusd -= amountNusd;
        if (accountPosition.debtSynthetic != 0) _releaseExcessReserveCollateral(account);
        _pushExact(nusd, recipient, amountNusd);
        emit CollateralWithdrawn(account, recipient, amountNusd);
    }

    function _ensureSponsoredCollateral(
        address account,
        Position storage accountPosition,
        uint256 debtAfter,
        uint256 priceWad
    ) internal returns (bool) {
        if (!safetyReserve.sponsorshipActive()) return false;
        uint256 userRequired = _requiredCollateral(debtAfter, priceWad, USER_SPONSORED_RATIO_BPS);
        if (accountPosition.userCollateralNusd < userRequired) return false;
        uint256 reserveTarget = _requiredCollateral(debtAfter, priceWad, RESERVE_SPONSORED_RATIO_BPS);
        if (reserveTarget <= accountPosition.reserveCollateralNusd) return true;

        uint256 allocation = reserveTarget - accountPosition.reserveCollateralNusd;
        if (safetyReserve.allocationsPaused() || allocation > safetyReserve.freeReserveNusd()) return false;
        _allocateReserveCollateral(account, allocation);
        return true;
    }

    function _ensureSponsoredWithdrawal(
        address account,
        Position storage accountPosition,
        uint256 userAfter,
        uint256 priceWad
    ) internal returns (bool) {
        if (!safetyReserve.sponsorshipActive()) return false;
        uint256 userRequired = _requiredCollateral(accountPosition.debtSynthetic, priceWad, USER_SPONSORED_RATIO_BPS);
        if (userAfter < userRequired) return false;
        uint256 reserveTarget =
            _requiredCollateral(accountPosition.debtSynthetic, priceWad, RESERVE_SPONSORED_RATIO_BPS);
        if (reserveTarget <= accountPosition.reserveCollateralNusd) return true;

        uint256 allocation = reserveTarget - accountPosition.reserveCollateralNusd;
        if (safetyReserve.allocationsPaused() || allocation > safetyReserve.freeReserveNusd()) return false;
        _allocateReserveCollateral(account, allocation);
        return true;
    }

    function _allocateReserveCollateral(address account, uint256 amountNusd) internal {
        safetyReserve.allocateToVault(amountNusd);
        positions[account].reserveCollateralNusd += amountNusd;
        totalReserveCollateralNusd += amountNusd;
        emit ReserveCollateralAllocated(account, amountNusd);
    }

    function _capReserveCollateralToTarget(address account, uint256 debtSynthetic, uint256 priceWad) internal {
        uint256 reserveTarget = _requiredCollateral(debtSynthetic, priceWad, RESERVE_SPONSORED_RATIO_BPS);
        uint256 reserveCollateral = positions[account].reserveCollateralNusd;
        if (reserveCollateral > reserveTarget) {
            _releaseReserveCollateral(account, reserveCollateral - reserveTarget);
        }
    }

    function _releaseExcessReserveCollateral(address account) internal returns (uint256 amountReleasedNusd) {
        Position storage accountPosition = positions[account];
        uint256 reserveCollateral = accountPosition.reserveCollateralNusd;
        if (reserveCollateral == 0) return 0;
        if (accountPosition.debtSynthetic == 0) {
            amountReleasedNusd = reserveCollateral;
        } else {
            (uint256 priceWad,,) = oracle.readPriceWad();
            uint256 totalRequired =
                _requiredCollateral(accountPosition.debtSynthetic, priceWad, MINIMUM_COLLATERAL_RATIO_BPS);
            uint256 reserveNeeded = totalRequired > accountPosition.userCollateralNusd
                ? totalRequired - accountPosition.userCollateralNusd
                : 0;
            if (reserveCollateral <= reserveNeeded) return 0;
            amountReleasedNusd = reserveCollateral - reserveNeeded;
        }
        _releaseReserveCollateral(account, amountReleasedNusd);
    }

    function _releaseExcessReserveCollateralIfOracleAvailable(address account) internal {
        Position storage accountPosition = positions[account];
        try oracle.readPriceWad() returns (uint256 priceWad, uint256, uint80) {
            uint256 totalRequired =
                _requiredCollateral(accountPosition.debtSynthetic, priceWad, MINIMUM_COLLATERAL_RATIO_BPS);
            uint256 reserveNeeded = totalRequired > accountPosition.userCollateralNusd
                ? totalRequired - accountPosition.userCollateralNusd
                : 0;
            if (accountPosition.reserveCollateralNusd > reserveNeeded) {
                _releaseReserveCollateral(account, accountPosition.reserveCollateralNusd - reserveNeeded);
            }
        } catch { }
    }

    function _releaseReserveCollateral(address account, uint256 amountNusd) internal {
        Position storage accountPosition = positions[account];
        accountPosition.reserveCollateralNusd -= amountNusd;
        totalReserveCollateralNusd -= amountNusd;
        safetyReserve.releaseFromVault(amountNusd);
        emit ReserveCollateralReleased(account, amountNusd);
    }

    function _maximumDebtSynthetic(uint256 collateralNusd, uint256 priceWad, uint256 ratioBps)
        internal
        pure
        returns (uint256)
    {
        uint256 maximumDebtValue = Math.mulDiv(collateralNusd, BPS_DENOMINATOR, ratioBps);
        return Math.mulDiv(maximumDebtValue, WAD, priceWad);
    }

    function _maximumDebtWithExistingCollateral(
        uint256 userCollateralNusd,
        uint256 reserveCollateralNusd,
        uint256 priceWad
    ) internal pure returns (uint256) {
        uint256 userMaximum = _maximumDebtSynthetic(userCollateralNusd, priceWad, USER_SPONSORED_RATIO_BPS);
        uint256 combinedMaximum =
            _maximumDebtSynthetic(userCollateralNusd + reserveCollateralNusd, priceWad, MINIMUM_COLLATERAL_RATIO_BPS);
        return _min(userMaximum, combinedMaximum);
    }

    function _minimumUserCollateral(uint256 debtSynthetic, uint256 priceWad, uint256 usableReserveNusd)
        internal
        pure
        returns (uint256)
    {
        uint256 userRequired = _requiredCollateral(debtSynthetic, priceWad, USER_SPONSORED_RATIO_BPS);
        uint256 totalRequired = _requiredCollateral(debtSynthetic, priceWad, MINIMUM_COLLATERAL_RATIO_BPS);
        uint256 combinedShortfall = totalRequired > usableReserveNusd ? totalRequired - usableReserveNusd : 0;
        return userRequired > combinedShortfall ? userRequired : combinedShortfall;
    }

    function _positionCollateralValid(Position storage accountPosition, uint256 debtSynthetic, uint256 priceWad)
        internal
        view
        returns (bool)
    {
        return _positionCollateralValid(
            accountPosition.userCollateralNusd, accountPosition.reserveCollateralNusd, debtSynthetic, priceWad
        );
    }

    function _positionCollateralValid(
        uint256 userCollateralNusd,
        uint256 reserveCollateralNusd,
        uint256 debtSynthetic,
        uint256 priceWad
    ) internal pure returns (bool) {
        if (debtSynthetic == 0) return true;
        return userCollateralNusd >= _requiredCollateral(debtSynthetic, priceWad, USER_SPONSORED_RATIO_BPS)
            && reserveCollateralNusd <= _requiredCollateral(debtSynthetic, priceWad, RESERVE_SPONSORED_RATIO_BPS)
            && _isCollateralized(
            userCollateralNusd + reserveCollateralNusd, debtSynthetic, priceWad, MINIMUM_COLLATERAL_RATIO_BPS
        );
    }

    function _debtCeilingHeadroom() internal view returns (uint256) {
        uint256 outstanding = totalDebtSynthetic + totalBadDebtSynthetic;
        return outstanding < debtCeilingSynthetic ? debtCeilingSynthetic - outstanding : 0;
    }

    function _isCollateralized(uint256 collateralNusd, uint256 debtSynthetic, uint256 priceWad, uint256 ratioBps)
        internal
        pure
        returns (bool)
    {
        if (debtSynthetic == 0) return true;
        return collateralNusd >= _requiredCollateral(debtSynthetic, priceWad, ratioBps);
    }

    function _requiredCollateral(uint256 debtSynthetic, uint256 priceWad, uint256 ratioBps)
        internal
        pure
        returns (uint256)
    {
        return _mulDivUp(_debtValueNusd(debtSynthetic, priceWad), ratioBps, BPS_DENOMINATOR);
    }

    function _debtValueNusd(uint256 debtSynthetic, uint256 priceWad) internal pure returns (uint256) {
        return _mulDivUp(debtSynthetic, priceWad, WAD);
    }

    function _mintFeeNusd(uint256 amountSynthetic, uint256 priceWad) internal pure returns (uint256) {
        uint256 notionalNusd = _mulDivUp(amountSynthetic, priceWad, WAD);
        return _mulDivUp(notionalNusd, MINT_FEE_BPS, BPS_DENOMINATOR);
    }

    function _liquidationCollateralOut(uint256 repaySynthetic, uint256 priceWad) internal pure returns (uint256) {
        uint256 baseValueNusd = _debtValueNusd(repaySynthetic, priceWad);
        return _mulDivUp(baseValueNusd, BPS_DENOMINATOR + LIQUIDATION_BONUS_BPS, BPS_DENOMINATOR);
    }

    function _pullExact(IERC20 token, address from, uint256 amount) internal {
        uint256 balanceBefore = token.balanceOf(address(this));
        token.safeTransferFrom(from, address(this), amount);
        uint256 balanceAfter = token.balanceOf(address(this));
        if (balanceAfter < balanceBefore || balanceAfter - balanceBefore != amount) revert ExactTransferRequired();
    }

    function _pushExact(IERC20 token, address recipient, uint256 amount) internal {
        uint256 senderBefore = token.balanceOf(address(this));
        uint256 recipientBefore = token.balanceOf(recipient);
        token.safeTransfer(recipient, amount);
        uint256 senderAfter = token.balanceOf(address(this));
        uint256 recipientAfter = token.balanceOf(recipient);
        if (
            senderBefore < senderAfter || senderBefore - senderAfter != amount || recipientAfter < recipientBefore
                || recipientAfter - recipientBefore != amount
        ) revert ExactTransferRequired();
    }

    function _mulDivUp(uint256 x, uint256 y, uint256 denominator) internal pure returns (uint256 result) {
        result = Math.mulDiv(x, y, denominator);
        if (mulmod(x, y, denominator) != 0) result += 1;
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}
