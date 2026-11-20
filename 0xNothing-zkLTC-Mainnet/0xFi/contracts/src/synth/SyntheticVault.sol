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
    function n() external view returns (address);
    function sponsorshipActive() external view returns (bool);
    function allocationsPaused() external view returns (bool);
    function authorizedVault(address vault) external view returns (bool);
    function freeReserveN() external view returns (uint256);
    function allocateToVault(uint256 amountN) external;
    function releaseFromVault(uint256 amountN) external;
    function recordVaultLoss(uint256 amountN) external;
}

interface ISynthMintFeeDistributor {
    function n() external view returns (address);
    function mintFeePairForVault(address vault) external view returns (address);
    function mintFeeVaultForPair(address pair) external view returns (address);
    function routeMintFee(uint256 amountN) external returns (uint256 amountFlushedN);
}

/// @notice One isolated synthetic vault with user-owned and protocol-reserve N accounting.
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
    error MintFeeExceeded(uint256 feeN, uint256 maximumFeeN);
    error MarketNotActivated();
    error ActivationUnavailable();

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
        uint256 userCollateralN;
        uint256 reserveCollateralN;
        uint256 debtSynthetic;
    }

    IERC20 public immutable n;
    SyntheticAsset public immutable syntheticAsset;
    IPriceOracle public immutable oracle;
    ISynthSafetyReserve public immutable safetyReserve;
    ISynthMintFeeDistributor public immutable mintFeeDistributor;

    mapping(address => Position) public positions;
    mapping(address => uint256) public badDebtSyntheticByAccount;

    uint256 public totalUserCollateralN;
    uint256 public totalReserveCollateralN;
    uint256 public totalDebtSynthetic;
    uint256 public totalBadDebtSynthetic;
    uint256 public debtCeilingSynthetic;
    bool public mintPaused;
    bool public withdrawPaused;
    bool public activated;

    event CollateralDeposited(address indexed payer, address indexed account, uint256 amountN);
    event ReserveCollateralAllocated(address indexed account, uint256 amountN);
    event ReserveCollateralReleased(address indexed account, uint256 amountN);
    event ReserveCollateralLost(address indexed account, uint256 amountN);
    event SyntheticMinted(
        address indexed account, address indexed recipient, uint256 amountSynthetic, uint256 debtAfter
    );
    event SyntheticRepaid(address indexed payer, address indexed account, uint256 amountSynthetic, uint256 debtAfter);
    event CollateralWithdrawn(address indexed account, address indexed recipient, uint256 amountN);
    event PositionLiquidated(
        address indexed liquidator,
        address indexed account,
        address indexed recipient,
        uint256 repaidSynthetic,
        uint256 seizedN
    );
    event BadDebtRecognized(address indexed account, uint256 amountSynthetic);
    event BadDebtCovered(address indexed payer, address indexed account, uint256 amountSynthetic);
    event DebtCeilingUpdated(uint256 previousCeilingSynthetic, uint256 newCeilingSynthetic);
    event MintPauseUpdated(bool paused);
    event WithdrawPauseUpdated(bool paused);
    event MintFeePaid(address indexed account, uint256 indexed amountSynthetic, uint256 amountN);
    event MarketActivated();

    constructor(
        address nAddress,
        address syntheticAssetAddress,
        address oracleAddress,
        address safetyReserveAddress,
        address mintFeeDistributorAddress,
        address initialOwner,
        uint256 initialDebtCeilingSynthetic,
        bool initiallyActive
    ) EmergencyGuardian(initialOwner) {
        if (
            nAddress == address(0) || nAddress.code.length == 0 || syntheticAssetAddress == address(0)
                || syntheticAssetAddress.code.length == 0 || oracleAddress == address(0)
                || oracleAddress.code.length == 0 || safetyReserveAddress == address(0)
                || safetyReserveAddress.code.length == 0 || nAddress == syntheticAssetAddress
                || mintFeeDistributorAddress == address(0) || mintFeeDistributorAddress.code.length == 0
                || initialDebtCeilingSynthetic == 0
        ) revert InvalidConfiguration();
        if (IERC20Metadata(nAddress).decimals() != 18) revert InvalidConfiguration();
        if (ISynthSafetyReserve(safetyReserveAddress).n() != nAddress) revert InvalidConfiguration();
        if (ISynthMintFeeDistributor(mintFeeDistributorAddress).n() != nAddress) {
            revert InvalidConfiguration();
        }

        n = IERC20(nAddress);
        syntheticAsset = SyntheticAsset(syntheticAssetAddress);
        oracle = IPriceOracle(oracleAddress);
        safetyReserve = ISynthSafetyReserve(safetyReserveAddress);
        mintFeeDistributor = ISynthMintFeeDistributor(mintFeeDistributorAddress);
        debtCeilingSynthetic = initialDebtCeilingSynthetic;
        activated = initiallyActive;
        if (!initiallyActive) {
            mintPaused = true;
            withdrawPaused = true;
            emit MintPauseUpdated(true);
            emit WithdrawPauseUpdated(true);
        }
        IERC20(nAddress).forceApprove(safetyReserveAddress, type(uint256).max);
    }

    function depositCollateral(uint256 amountN, address onBehalfOf) external nonReentrant {
        _depositCollateral(msg.sender, onBehalfOf, amountN);
    }

    function depositAndMint(
        uint256 collateralAmountN,
        uint256 syntheticAmount,
        uint256 maximumFeeN,
        address recipient
    ) external nonReentrant {
        _depositCollateral(msg.sender, msg.sender, collateralAmountN);
        _mintSynthetic(msg.sender, syntheticAmount, maximumFeeN, recipient);
    }

    function mint(uint256 amountSynthetic, uint256 maximumFeeN, address recipient) external nonReentrant {
        _mintSynthetic(msg.sender, amountSynthetic, maximumFeeN, recipient);
    }

    function repay(uint256 maximumAmountSynthetic, address onBehalfOf)
        public
        nonReentrant
        returns (uint256 amountRepaidSynthetic)
    {
        amountRepaidSynthetic = _repay(msg.sender, onBehalfOf, maximumAmountSynthetic);
    }

    function repayAndWithdraw(uint256 maximumRepaySynthetic, uint256 collateralAmountN, address recipient)
        external
        nonReentrant
        returns (uint256 amountRepaidSynthetic)
    {
        if (maximumRepaySynthetic != 0) {
            amountRepaidSynthetic = _repay(msg.sender, msg.sender, maximumRepaySynthetic);
        }
        if (collateralAmountN != 0) _withdrawCollateral(msg.sender, collateralAmountN, recipient);
    }

    function withdrawCollateral(uint256 amountN, address recipient) external nonReentrant {
        _withdrawCollateral(msg.sender, amountN, recipient);
    }

    function releaseExcessReserveCollateral(address account)
        external
        nonReentrant
        returns (uint256 amountReleasedN)
    {
        if (account == address(0)) revert InvalidRecipient();
        amountReleasedN = _releaseExcessReserveCollateral(account);
    }

    function liquidate(
        address account,
        uint256 maximumRepaySynthetic,
        uint256 minimumCollateralOutN,
        address recipient
    ) external nonReentrant returns (uint256 repaidSynthetic, uint256 collateralOutN) {
        if (account == address(0) || recipient == address(0) || recipient == address(this)) {
            revert InvalidRecipient();
        }
        if (maximumRepaySynthetic == 0) revert InvalidAmount();

        (uint256 priceWad,,) = oracle.readPriceWad();
        Position storage accountPosition = positions[account];
        uint256 availableCollateral = accountPosition.userCollateralN + accountPosition.reserveCollateralN;
        if (
            accountPosition.debtSynthetic == 0
                || _isCollateralized(
                    availableCollateral, accountPosition.debtSynthetic, priceWad, LIQUIDATION_RATIO_BPS
                )
        ) revert PositionHealthy();

        (repaidSynthetic, collateralOutN) =
            _liquidationQuote(accountPosition, maximumRepaySynthetic, priceWad, availableCollateral);
        if (collateralOutN < minimumCollateralOutN) revert SlippageExceeded();

        accountPosition.debtSynthetic -= repaidSynthetic;
        totalDebtSynthetic -= repaidSynthetic;
        _applyLiquidationCollateralLoss(account, accountPosition, collateralOutN);

        _pullExact(IERC20(address(syntheticAsset)), msg.sender, repaidSynthetic);
        syntheticAsset.burn(repaidSynthetic);
        _recognizeBadDebtIfEmpty(account, accountPosition);

        _pushExact(n, recipient, collateralOutN);
        emit PositionLiquidated(msg.sender, account, recipient, repaidSynthetic, collateralOutN);
    }

    function _liquidationQuote(
        Position storage accountPosition,
        uint256 maximumRepaySynthetic,
        uint256 priceWad,
        uint256 availableCollateral
    ) internal view returns (uint256 repaidSynthetic, uint256 collateralOutN) {
        uint256 closeLimit = Math.mulDiv(accountPosition.debtSynthetic, CLOSE_FACTOR_BPS, BPS_DENOMINATOR);
        if (closeLimit == 0) closeLimit = accountPosition.debtSynthetic;
        repaidSynthetic = _min(maximumRepaySynthetic, _min(closeLimit, accountPosition.debtSynthetic));

        uint256 maximumBaseValueN =
            Math.mulDiv(availableCollateral, BPS_DENOMINATOR, BPS_DENOMINATOR + LIQUIDATION_BONUS_BPS);
        uint256 collateralLimitedRepay = Math.mulDiv(maximumBaseValueN, WAD, priceWad);
        // Collateral worth less than one unit of the synthetic rounds to zero here. Left at zero it
        // would make the position impossible to liquidate, so its debt could never be written
        // off. One unit takes the dust, and the write-off follows.
        if (collateralLimitedRepay == 0) collateralLimitedRepay = 1;
        bool exhaustsCollateral = collateralLimitedRepay <= repaidSynthetic;
        repaidSynthetic = _min(repaidSynthetic, collateralLimitedRepay);
        if (repaidSynthetic == 0) revert InsufficientCollateral();

        collateralOutN = _liquidationCollateralOut(repaidSynthetic, priceWad);
        if (exhaustsCollateral || collateralOutN > availableCollateral) collateralOutN = availableCollateral;
    }

    function _applyLiquidationCollateralLoss(
        address account,
        Position storage accountPosition,
        uint256 collateralOutN
    ) internal {
        // User collateral absorbs liquidation first. Otherwise an account could
        // self-liquidate with its freshly minted synth and extract reserve N.
        uint256 userLoss = _min(collateralOutN, accountPosition.userCollateralN);
        if (userLoss != 0) {
            accountPosition.userCollateralN -= userLoss;
            totalUserCollateralN -= userLoss;
        }
        uint256 reserveLoss = collateralOutN - userLoss;
        if (reserveLoss != 0) {
            accountPosition.reserveCollateralN -= reserveLoss;
            totalReserveCollateralN -= reserveLoss;
            safetyReserve.recordVaultLoss(reserveLoss);
            emit ReserveCollateralLost(account, reserveLoss);
        }
    }

    function _recognizeBadDebtIfEmpty(address account, Position storage accountPosition) internal {
        if (
            accountPosition.userCollateralN != 0 || accountPosition.reserveCollateralN != 0
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
        if (!activated && !paused) revert MarketNotActivated();
        mintPaused = paused;
        emit MintPauseUpdated(paused);
    }

    function setWithdrawPaused(bool paused) external onlyOwner {
        if (!activated && !paused) revert MarketNotActivated();
        withdrawPaused = paused;
        emit WithdrawPauseUpdated(paused);
    }

    /// @notice Opens an inactive migration vault only after all permanent routes are bound.
    function activateRiskOperations() external onlyOwner {
        address feePair = mintFeeDistributor.mintFeePairForVault(address(this));
        if (
            activated || !mintPaused || !withdrawPaused || syntheticAsset.vault() != address(this)
                || !safetyReserve.authorizedVault(address(this)) || feePair == address(0)
                || mintFeeDistributor.mintFeeVaultForPair(feePair) != address(this)
        ) revert ActivationUnavailable();
        activated = true;
        mintPaused = false;
        withdrawPaused = false;
        emit MarketActivated();
        emit MintPauseUpdated(false);
        emit WithdrawPauseUpdated(false);
    }

    function pauseMinting() external onlyOwnerOrGuardian {
        mintPaused = true;
        emit MintPauseUpdated(true);
    }

    /// @notice Holds the collateral of every account that has debt, and stops minting with it, so
    ///         that an account's own collateral behind debt can only grow (a share put in by the
    ///         Safety Reserve is not held by this pause). Repaying, liquidating and leaving without
    ///         debt stay open; liquidators need synthetic that already circulates. Only the owner
    ///         lifts the pause.
    function pauseWithdrawals() external onlyOwnerOrGuardian {
        withdrawPaused = true;
        emit WithdrawPauseUpdated(true);
    }

    function totalCollateralN() public view returns (uint256) {
        return totalUserCollateralN + totalReserveCollateralN;
    }

    function debtValueN(address account) public view returns (uint256) {
        (uint256 priceWad,,) = oracle.readPriceWad();
        return _debtValueN(positions[account].debtSynthetic, priceWad);
    }

    function collateralRatioBps(address account) public view returns (uint256) {
        Position storage accountPosition = positions[account];
        if (accountPosition.debtSynthetic == 0) return type(uint256).max;
        (uint256 priceWad,,) = oracle.readPriceWad();
        uint256 debtValue = _debtValueN(accountPosition.debtSynthetic, priceWad);
        return Math.mulDiv(
            accountPosition.userCollateralN + accountPosition.reserveCollateralN, BPS_DENOMINATOR, debtValue
        );
    }

    function healthFactorWad(address account) public view returns (uint256) {
        Position storage accountPosition = positions[account];
        if (accountPosition.debtSynthetic == 0) return type(uint256).max;
        (uint256 priceWad,,) = oracle.readPriceWad();
        uint256 liquidationRequirement =
            _requiredCollateral(accountPosition.debtSynthetic, priceWad, LIQUIDATION_RATIO_BPS);
        return Math.mulDiv(
            accountPosition.userCollateralN + accountPosition.reserveCollateralN, WAD, liquidationRequirement
        );
    }

    function position(address account)
        external
        view
        returns (
            uint256 userCollateralN,
            uint256 reserveCollateralN,
            uint256 debtSynthetic,
            uint256 accountHealthFactorWad,
            uint256 maxWithdrawableN
        )
    {
        Position storage accountPosition = positions[account];
        userCollateralN = accountPosition.userCollateralN;
        reserveCollateralN = accountPosition.reserveCollateralN;
        debtSynthetic = accountPosition.debtSynthetic;
        accountHealthFactorWad = healthFactorWad(account);
        maxWithdrawableN = maxUserCollateralWithdrawable(account);
    }

    function maxMintableSynthetic(address account) external view returns (uint256 amountSynthetic) {
        if (badDebtSyntheticByAccount[account] != 0) return 0;
        (uint256 priceWad,,) = oracle.readPriceWad();
        Position storage accountPosition = positions[account];
        uint256 maximumDebtSynthetic = _maximumDebtWithExistingCollateral(
            accountPosition.userCollateralN, accountPosition.reserveCollateralN, priceWad
        );

        if (safetyReserve.sponsorshipActive()) {
            uint256 availableReserve = accountPosition.reserveCollateralN;
            if (!safetyReserve.allocationsPaused()) availableReserve += safetyReserve.freeReserveN();
            uint256 userMaximum = _maximumDebtSynthetic(accountPosition.userCollateralN, priceWad, 10_000);
            uint256 reserveMaximum = _maximumDebtSynthetic(availableReserve, priceWad, 5000);
            uint256 sponsoredMaximum = _min(userMaximum, reserveMaximum);
            if (sponsoredMaximum > maximumDebtSynthetic) maximumDebtSynthetic = sponsoredMaximum;
        }

        uint256 collateralHeadroom = maximumDebtSynthetic > accountPosition.debtSynthetic
            ? maximumDebtSynthetic - accountPosition.debtSynthetic
            : 0;
        return _min(collateralHeadroom, _debtCeilingHeadroom());
    }

    function quoteDepositAndMint(address account, uint256 collateralAmountN)
        public
        view
        returns (uint256 syntheticAmount, uint256 reserveRequiredN, bool oneToOneAvailable)
    {
        if (account == address(0) || badDebtSyntheticByAccount[account] != 0) return (0, 0, false);
        (uint256 priceWad,,) = oracle.readPriceWad();
        Position storage accountPosition = positions[account];
        uint256 userAfter = accountPosition.userCollateralN + collateralAmountN;
        uint256 ceilingHeadroom = _debtCeilingHeadroom();
        uint256 sponsoredInputCapacity = _maximumDebtSynthetic(collateralAmountN, priceWad, USER_SPONSORED_RATIO_BPS);
        uint256 sponsoredPostMaximum = _maximumDebtSynthetic(userAfter, priceWad, USER_SPONSORED_RATIO_BPS);
        uint256 sponsoredPostHeadroom = sponsoredPostMaximum > accountPosition.debtSynthetic
            ? sponsoredPostMaximum - accountPosition.debtSynthetic
            : 0;
        uint256 sponsoredAmount = _min(sponsoredInputCapacity, _min(sponsoredPostHeadroom, ceilingHeadroom));
        uint256 sponsoredDebtAfter = accountPosition.debtSynthetic + sponsoredAmount;

        if (sponsoredAmount != 0 && safetyReserve.sponsorshipActive()) {
            uint256 reserveTarget = _requiredCollateral(sponsoredDebtAfter, priceWad, RESERVE_SPONSORED_RATIO_BPS);
            reserveRequiredN = reserveTarget > accountPosition.reserveCollateralN
                ? reserveTarget - accountPosition.reserveCollateralN
                : 0;
            bool allocationAvailable = reserveRequiredN == 0
                || (!safetyReserve.allocationsPaused() && reserveRequiredN <= safetyReserve.freeReserveN());
            if (allocationAvailable) {
                syntheticAmount = sponsoredAmount;
                return (syntheticAmount, reserveRequiredN, true);
            }
        }

        uint256 unsponsoredInputCapacity =
            _maximumDebtSynthetic(collateralAmountN, priceWad, MINIMUM_COLLATERAL_RATIO_BPS);
        uint256 unsponsoredPostMaximum =
            _maximumDebtWithExistingCollateral(userAfter, accountPosition.reserveCollateralN, priceWad);
        uint256 unsponsoredPostHeadroom = unsponsoredPostMaximum > accountPosition.debtSynthetic
            ? unsponsoredPostMaximum - accountPosition.debtSynthetic
            : 0;
        syntheticAmount = _min(unsponsoredInputCapacity, _min(unsponsoredPostHeadroom, ceilingHeadroom));
        return (syntheticAmount, 0, false);
    }

    function maxUserCollateralWithdrawable(address account) public view returns (uint256 amountN) {
        Position storage accountPosition = positions[account];
        if (accountPosition.debtSynthetic == 0) return accountPosition.userCollateralN;
        (uint256 priceWad,,) = oracle.readPriceWad();

        uint256 reserveTarget =
            _requiredCollateral(accountPosition.debtSynthetic, priceWad, RESERVE_SPONSORED_RATIO_BPS);
        uint256 minimumUser = _minimumUserCollateral(
            accountPosition.debtSynthetic, priceWad, _min(accountPosition.reserveCollateralN, reserveTarget)
        );
        if (safetyReserve.sponsorshipActive()) {
            uint256 availableReserve = _min(accountPosition.reserveCollateralN, reserveTarget);
            if (!safetyReserve.allocationsPaused()) availableReserve += safetyReserve.freeReserveN();
            if (availableReserve >= reserveTarget) {
                minimumUser = _requiredCollateral(accountPosition.debtSynthetic, priceWad, USER_SPONSORED_RATIO_BPS);
            }
        }
        return accountPosition.userCollateralN > minimumUser ? accountPosition.userCollateralN - minimumUser : 0;
    }

    function quoteMintForCollateral(uint256 collateralAmountN) external view returns (uint256 amountSynthetic) {
        (amountSynthetic,,) = quoteDepositAndMint(msg.sender, collateralAmountN);
    }

    function quoteMintFee(uint256 amountSynthetic) public view returns (uint256 feeN) {
        if (amountSynthetic == 0) return 0;
        (uint256 priceWad,,) = oracle.readPriceWad();
        return _mintFeeN(amountSynthetic, priceWad);
    }

    function quoteCollateralForMint(uint256 amountSynthetic) external view returns (uint256 collateralAmountN) {
        if (badDebtSyntheticByAccount[msg.sender] != 0) revert AccountHasBadDebt();
        if (amountSynthetic > _debtCeilingHeadroom()) revert DebtCeilingExceeded();
        (uint256 priceWad,,) = oracle.readPriceWad();
        Position storage accountPosition = positions[msg.sender];
        uint256 debtAfter = accountPosition.debtSynthetic + amountSynthetic;
        uint256 totalRequired = _requiredCollateral(debtAfter, priceWad, MINIMUM_COLLATERAL_RATIO_BPS);
        uint256 reserveTarget = _requiredCollateral(debtAfter, priceWad, RESERVE_SPONSORED_RATIO_BPS);
        uint256 usableReserve = _min(accountPosition.reserveCollateralN, reserveTarget);
        uint256 currentTotal = accountPosition.userCollateralN + usableReserve;
        uint256 userRequired = _requiredCollateral(debtAfter, priceWad, USER_SPONSORED_RATIO_BPS);
        if (currentTotal >= totalRequired && accountPosition.userCollateralN >= userRequired) return 0;

        if (safetyReserve.sponsorshipActive()) {
            uint256 reserveRequired = reserveTarget - usableReserve;
            if (
                reserveRequired == 0
                    || (!safetyReserve.allocationsPaused() && reserveRequired <= safetyReserve.freeReserveN())
            ) {
                return userRequired > accountPosition.userCollateralN
                    ? userRequired - accountPosition.userCollateralN
                    : 0;
            }
        }
        uint256 totalShortfall = totalRequired > currentTotal ? totalRequired - currentTotal : 0;
        uint256 userShortfall =
            userRequired > accountPosition.userCollateralN ? userRequired - accountPosition.userCollateralN : 0;
        return totalShortfall > userShortfall ? totalShortfall : userShortfall;
    }

    function isLiquidatable(address account) external view returns (bool) {
        Position storage accountPosition = positions[account];
        if (accountPosition.debtSynthetic == 0) return false;
        (uint256 priceWad,,) = oracle.readPriceWad();
        return !_isCollateralized(
            accountPosition.userCollateralN + accountPosition.reserveCollateralN,
            accountPosition.debtSynthetic,
            priceWad,
            LIQUIDATION_RATIO_BPS
        );
    }

    function _depositCollateral(address payer, address account, uint256 amountN) internal {
        if (!activated) revert MarketNotActivated();
        if (account == address(0)) revert InvalidRecipient();
        if (amountN == 0) revert InvalidAmount();
        _pullExact(n, payer, amountN);
        positions[account].userCollateralN += amountN;
        totalUserCollateralN += amountN;
        emit CollateralDeposited(payer, account, amountN);
    }

    function _mintSynthetic(address account, uint256 amountSynthetic, uint256 maximumFeeN, address recipient)
        internal
    {
        if (!activated) revert MarketNotActivated();
        // No debt is opened while withdrawals are held: otherwise an account repays everything,
        // takes its collateral out and mints the same debt again on less.
        if (mintPaused || withdrawPaused) revert MintPaused();
        if (amountSynthetic == 0) revert InvalidAmount();
        if (recipient == address(0)) revert InvalidRecipient();
        if (badDebtSyntheticByAccount[account] != 0) revert AccountHasBadDebt();

        (uint256 priceWad,,) = oracle.readPriceWad();
        uint256 feeN = _mintFeeN(amountSynthetic, priceWad);
        if (feeN > maximumFeeN) revert MintFeeExceeded(feeN, maximumFeeN);
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

        _collectMintFee(account, amountSynthetic, feeN);
        accountPosition.debtSynthetic = debtAfter;
        totalDebtSynthetic += amountSynthetic;
        syntheticAsset.mint(recipient, amountSynthetic);
        emit SyntheticMinted(account, recipient, amountSynthetic, debtAfter);
    }

    function _collectMintFee(address payer, uint256 amountSynthetic, uint256 feeN) internal {
        uint256 collateralBalanceBefore = n.balanceOf(address(this));
        _pullExact(n, payer, feeN);
        n.forceApprove(address(mintFeeDistributor), feeN);
        mintFeeDistributor.routeMintFee(feeN);
        n.forceApprove(address(mintFeeDistributor), 0);
        if (n.balanceOf(address(this)) != collateralBalanceBefore) revert ExactTransferRequired();
        emit MintFeePaid(payer, amountSynthetic, feeN);
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

        if (accountPosition.debtSynthetic == 0 && accountPosition.reserveCollateralN != 0) {
            _releaseReserveCollateral(account, accountPosition.reserveCollateralN);
        } else if (accountPosition.reserveCollateralN != 0) {
            _releaseExcessReserveCollateralIfOracleAvailable(account);
        }
        emit SyntheticRepaid(payer, account, amountRepaidSynthetic, accountPosition.debtSynthetic);
    }

    function _withdrawCollateral(address account, uint256 amountN, address recipient) internal {
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();
        Position storage accountPosition = positions[account];
        // The pause holds collateral that still backs debt. An account that owes nothing can always
        // leave, also in the same call that repays the last of its debt.
        if (withdrawPaused && accountPosition.debtSynthetic != 0) revert WithdrawPaused();
        if (amountN == 0 || amountN > accountPosition.userCollateralN) revert InvalidAmount();

        uint256 userAfter = accountPosition.userCollateralN - amountN;
        if (accountPosition.debtSynthetic != 0) {
            (uint256 priceWad,,) = oracle.readPriceWad();
            _capReserveCollateralToTarget(account, accountPosition.debtSynthetic, priceWad);
            if (!_positionCollateralValid(
                    userAfter, accountPosition.reserveCollateralN, accountPosition.debtSynthetic, priceWad
                )) {
                _ensureSponsoredWithdrawal(account, accountPosition, userAfter, priceWad);
            }
            if (!_positionCollateralValid(
                    userAfter, accountPosition.reserveCollateralN, accountPosition.debtSynthetic, priceWad
                )) {
                revert InsufficientCollateral();
            }
        } else if (accountPosition.reserveCollateralN != 0) {
            _releaseReserveCollateral(account, accountPosition.reserveCollateralN);
        }

        accountPosition.userCollateralN = userAfter;
        totalUserCollateralN -= amountN;
        if (accountPosition.debtSynthetic != 0) _releaseExcessReserveCollateral(account);
        _pushExact(n, recipient, amountN);
        emit CollateralWithdrawn(account, recipient, amountN);
    }

    function _ensureSponsoredCollateral(
        address account,
        Position storage accountPosition,
        uint256 debtAfter,
        uint256 priceWad
    ) internal returns (bool) {
        if (!safetyReserve.sponsorshipActive()) return false;
        uint256 userRequired = _requiredCollateral(debtAfter, priceWad, USER_SPONSORED_RATIO_BPS);
        if (accountPosition.userCollateralN < userRequired) return false;
        uint256 reserveTarget = _requiredCollateral(debtAfter, priceWad, RESERVE_SPONSORED_RATIO_BPS);
        if (reserveTarget <= accountPosition.reserveCollateralN) return true;

        uint256 allocation = reserveTarget - accountPosition.reserveCollateralN;
        if (safetyReserve.allocationsPaused() || allocation > safetyReserve.freeReserveN()) return false;
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
        if (reserveTarget <= accountPosition.reserveCollateralN) return true;

        uint256 allocation = reserveTarget - accountPosition.reserveCollateralN;
        if (safetyReserve.allocationsPaused() || allocation > safetyReserve.freeReserveN()) return false;
        _allocateReserveCollateral(account, allocation);
        return true;
    }

    function _allocateReserveCollateral(address account, uint256 amountN) internal {
        safetyReserve.allocateToVault(amountN);
        positions[account].reserveCollateralN += amountN;
        totalReserveCollateralN += amountN;
        emit ReserveCollateralAllocated(account, amountN);
    }

    function _capReserveCollateralToTarget(address account, uint256 debtSynthetic, uint256 priceWad) internal {
        uint256 reserveTarget = _requiredCollateral(debtSynthetic, priceWad, RESERVE_SPONSORED_RATIO_BPS);
        uint256 reserveCollateral = positions[account].reserveCollateralN;
        if (reserveCollateral > reserveTarget) {
            _releaseReserveCollateral(account, reserveCollateral - reserveTarget);
        }
    }

    function _releaseExcessReserveCollateral(address account) internal returns (uint256 amountReleasedN) {
        Position storage accountPosition = positions[account];
        uint256 reserveCollateral = accountPosition.reserveCollateralN;
        if (reserveCollateral == 0) return 0;
        if (accountPosition.debtSynthetic == 0) {
            amountReleasedN = reserveCollateral;
        } else {
            (uint256 priceWad,,) = oracle.readPriceWad();
            uint256 totalRequired =
                _requiredCollateral(accountPosition.debtSynthetic, priceWad, MINIMUM_COLLATERAL_RATIO_BPS);
            uint256 reserveNeeded = totalRequired > accountPosition.userCollateralN
                ? totalRequired - accountPosition.userCollateralN
                : 0;
            if (reserveCollateral <= reserveNeeded) return 0;
            amountReleasedN = reserveCollateral - reserveNeeded;
        }
        _releaseReserveCollateral(account, amountReleasedN);
    }

    function _releaseExcessReserveCollateralIfOracleAvailable(address account) internal {
        Position storage accountPosition = positions[account];
        try oracle.readPriceWad() returns (uint256 priceWad, uint256, uint80) {
            uint256 totalRequired =
                _requiredCollateral(accountPosition.debtSynthetic, priceWad, MINIMUM_COLLATERAL_RATIO_BPS);
            uint256 reserveNeeded = totalRequired > accountPosition.userCollateralN
                ? totalRequired - accountPosition.userCollateralN
                : 0;
            if (accountPosition.reserveCollateralN > reserveNeeded) {
                _releaseReserveCollateral(account, accountPosition.reserveCollateralN - reserveNeeded);
            }
        } catch { }
    }

    function _releaseReserveCollateral(address account, uint256 amountN) internal {
        Position storage accountPosition = positions[account];
        accountPosition.reserveCollateralN -= amountN;
        totalReserveCollateralN -= amountN;
        safetyReserve.releaseFromVault(amountN);
        emit ReserveCollateralReleased(account, amountN);
    }

    function _maximumDebtSynthetic(uint256 collateralN, uint256 priceWad, uint256 ratioBps)
        internal
        pure
        returns (uint256)
    {
        uint256 maximumDebtValue = Math.mulDiv(collateralN, BPS_DENOMINATOR, ratioBps);
        return Math.mulDiv(maximumDebtValue, WAD, priceWad);
    }

    function _maximumDebtWithExistingCollateral(
        uint256 userCollateralN,
        uint256 reserveCollateralN,
        uint256 priceWad
    ) internal pure returns (uint256) {
        uint256 userMaximum = _maximumDebtSynthetic(userCollateralN, priceWad, USER_SPONSORED_RATIO_BPS);
        uint256 combinedMaximum =
            _maximumDebtSynthetic(userCollateralN + reserveCollateralN, priceWad, MINIMUM_COLLATERAL_RATIO_BPS);
        return _min(userMaximum, combinedMaximum);
    }

    function _minimumUserCollateral(uint256 debtSynthetic, uint256 priceWad, uint256 usableReserveN)
        internal
        pure
        returns (uint256)
    {
        uint256 userRequired = _requiredCollateral(debtSynthetic, priceWad, USER_SPONSORED_RATIO_BPS);
        uint256 totalRequired = _requiredCollateral(debtSynthetic, priceWad, MINIMUM_COLLATERAL_RATIO_BPS);
        uint256 combinedShortfall = totalRequired > usableReserveN ? totalRequired - usableReserveN : 0;
        return userRequired > combinedShortfall ? userRequired : combinedShortfall;
    }

    function _positionCollateralValid(Position storage accountPosition, uint256 debtSynthetic, uint256 priceWad)
        internal
        view
        returns (bool)
    {
        return _positionCollateralValid(
            accountPosition.userCollateralN, accountPosition.reserveCollateralN, debtSynthetic, priceWad
        );
    }

    function _positionCollateralValid(
        uint256 userCollateralN,
        uint256 reserveCollateralN,
        uint256 debtSynthetic,
        uint256 priceWad
    ) internal pure returns (bool) {
        if (debtSynthetic == 0) return true;
        return userCollateralN >= _requiredCollateral(debtSynthetic, priceWad, USER_SPONSORED_RATIO_BPS)
            && reserveCollateralN <= _requiredCollateral(debtSynthetic, priceWad, RESERVE_SPONSORED_RATIO_BPS)
            && _isCollateralized(
            userCollateralN + reserveCollateralN, debtSynthetic, priceWad, MINIMUM_COLLATERAL_RATIO_BPS
        );
    }

    function _debtCeilingHeadroom() internal view returns (uint256) {
        uint256 outstanding = totalDebtSynthetic + totalBadDebtSynthetic;
        return outstanding < debtCeilingSynthetic ? debtCeilingSynthetic - outstanding : 0;
    }

    function _isCollateralized(uint256 collateralN, uint256 debtSynthetic, uint256 priceWad, uint256 ratioBps)
        internal
        pure
        returns (bool)
    {
        if (debtSynthetic == 0) return true;
        return collateralN >= _requiredCollateral(debtSynthetic, priceWad, ratioBps);
    }

    function _requiredCollateral(uint256 debtSynthetic, uint256 priceWad, uint256 ratioBps)
        internal
        pure
        returns (uint256)
    {
        return _mulDivUp(_debtValueN(debtSynthetic, priceWad), ratioBps, BPS_DENOMINATOR);
    }

    function _debtValueN(uint256 debtSynthetic, uint256 priceWad) internal pure returns (uint256) {
        return _mulDivUp(debtSynthetic, priceWad, WAD);
    }

    function _mintFeeN(uint256 amountSynthetic, uint256 priceWad) internal pure returns (uint256) {
        uint256 notionalN = _mulDivUp(amountSynthetic, priceWad, WAD);
        return _mulDivUp(notionalN, MINT_FEE_BPS, BPS_DENOMINATOR);
    }

    function _liquidationCollateralOut(uint256 repaySynthetic, uint256 priceWad) internal pure returns (uint256) {
        uint256 baseValueN = _debtValueN(repaySynthetic, priceWad);
        return _mulDivUp(baseValueN, BPS_DENOMINATOR + LIQUIDATION_BONUS_BPS, BPS_DENOMINATOR);
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
