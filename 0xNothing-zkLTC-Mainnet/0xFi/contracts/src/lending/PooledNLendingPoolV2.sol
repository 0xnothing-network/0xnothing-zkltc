// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { EmergencyGuardian } from "../access/EmergencyGuardian.sol";
import { IPriceOracle } from "../oracle/interfaces/IPriceOracle.sol";

interface IFeeSplitter {
    function distribute() external returns (uint256 amountN);
}

/// @title Pooled N lending v2
/// @notice A pooled N money market with isolated collateral configuration and socialized supplier yield/loss.
///         v1 lending with one change: protocol interest can no longer be withdrawn by the owner.
///         Anyone may sweep it to the immutable fee splitter, which splits it in the same call.
contract PooledNLendingPoolV2 is ERC20, EmergencyGuardian, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error InvalidConfiguration();
    error InvalidAmount();
    error InvalidRecipient();
    error UnsupportedCollateral();
    error TooManyCollateralAssets();
    error SupplyPaused();
    error BorrowPaused();
    error CollateralWithdrawalPaused();
    error SupplyCapExceeded();
    error BorrowCapExceeded();
    error CollateralCapExceeded();
    error InsufficientLiquidity();
    error InsufficientCollateral();
    error PositionHealthy();
    error ExactTransferRequired();
    error InsolventPool();
    error AccountHasBadDebt();
    error SlippageExceeded();
    error ProtocolInterestExceeded();
    error MarketNotActivated();
    error BootstrapUnavailable();

    uint256 public constant WAD = 1e18;
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant BORROW_APR_BPS = 450;
    uint256 public constant LENDER_APR_BPS = 400;
    uint256 public constant PROTOCOL_APR_BPS = 50;
    uint256 public constant CLOSE_FACTOR_BPS = 5000;
    /// @notice This pool takes one collateral asset, for good. Its liquidation reads the feed of
    ///         every asset an account holds, so a second asset would let one stale feed and a wei
    ///         of that asset hold up the liquidation of a whole account, and it has no safe way to
    ///         value a synthetic whose vault carries bad debt (2026-11 audit, D-03 and D-04). A
    ///         pool for another asset is another deployment.
    uint256 public constant MAX_COLLATERAL_ASSETS = 1;
    uint256 public constant SECONDS_PER_YEAR = 365 days;
    uint256 public constant MINIMUM_LOCKED_SHARES = 1000;
    bytes32 public constant IMPLEMENTATION_ID = keccak256("0xfi.lending.fixed-4.5-4-0.5.80-85-90.paused-bootstrap.v2");
    address public constant LOCKED_SHARE_RECIPIENT = address(1);

    struct CollateralConfig {
        address oracle;
        uint256 supplyCap;
        uint16 loanToValueBps;
        uint16 liquidationThresholdBps;
        uint16 liquidationBonusBps;
        uint8 decimals;
        bool enabled;
        uint16 marginCallThresholdBps;
    }

    struct LiquidationQuote {
        uint256 debtSharesToBurn;
        uint256 amountRepaidN;
        uint256 collateralOut;
    }

    IERC20 public immutable n;
    address public immutable feeSplitter;

    mapping(address => CollateralConfig) public collateralConfigs;
    mapping(address => mapping(address => uint256)) public collateralBalance;
    mapping(address => uint256) public totalCollateralByAsset;
    mapping(address => uint256) public debtSharesOf;
    mapping(address => uint256) public badDebtNByAccount;
    mapping(address => uint256) public protocolInterestWrittenOffByAccount;

    address[] private _collateralAssets;
    mapping(address => bool) private _knownCollateral;

    uint256 public totalDebtShares;
    uint256 public borrowIndexWad;
    uint256 public lastAccrualTimestamp;
    uint256 public totalBadDebtN;
    uint256 public cumulativeBadDebtN;
    uint256 public supplyCapN;
    uint256 public borrowCapN;
    uint256 public accruedProtocolInterestN;
    bool public supplyPaused;
    bool public borrowPaused;
    bool public collateralWithdrawalPaused;
    bool public activated;
    bool public bootstrapOpen;

    event InterestAccrued(uint256 previousBorrowIndexWad, uint256 newBorrowIndexWad, uint256 elapsedSeconds);
    event ProtocolInterestAccrued(uint256 amountN, uint256 accruedProtocolInterestN);
    event ProtocolInterestWithdrawn(address indexed recipient, uint256 amountN);
    event ProtocolInterestWrittenOff(uint256 amountN, uint256 accruedProtocolInterestN);
    event ProtocolInterestRestored(address indexed account, uint256 amountN, uint256 accruedProtocolInterestN);
    event Supplied(address indexed payer, address indexed account, uint256 amountN, uint256 sharesMinted);
    event Withdrawn(address indexed account, address indexed recipient, uint256 amountN, uint256 sharesBurned);
    event CollateralDeposited(address indexed payer, address indexed account, address indexed asset, uint256 amount);
    event CollateralWithdrawn(
        address indexed account, address indexed recipient, address indexed asset, uint256 amount
    );
    event Borrowed(address indexed account, address indexed recipient, uint256 amountN, uint256 debtSharesMinted);
    event Repaid(address indexed payer, address indexed account, uint256 amountN, uint256 debtSharesBurned);
    event Liquidated(
        address indexed liquidator,
        address indexed account,
        address indexed collateralAsset,
        uint256 amountRepaidN,
        uint256 collateralOut,
        address recipient
    );
    event BadDebtRecognized(address indexed account, uint256 amountN);
    event BadDebtRepaid(address indexed payer, address indexed account, uint256 amountN);
    event CollateralConfigured(
        address indexed asset,
        address indexed oracle,
        uint256 supplyCap,
        uint16 loanToValueBps,
        uint16 marginCallThresholdBps,
        uint16 liquidationThresholdBps,
        uint16 liquidationBonusBps,
        bool enabled
    );
    event CapsUpdated(uint256 supplyCapN, uint256 borrowCapN);
    event PausesUpdated(bool supplyPaused, bool borrowPaused, bool collateralWithdrawalPaused);
    event BootstrapSupplied(address indexed account, uint256 amountN, uint256 sharesMinted);
    event MarketActivated();

    constructor(
        address nAddress,
        address feeSplitterAddress,
        address initialOwner,
        uint256 initialSupplyCapN,
        uint256 initialBorrowCapN,
        bool initiallyActive
    ) ERC20("0xFi Pooled N", "xfiN") EmergencyGuardian(initialOwner) {
        if (
            nAddress == address(0) || nAddress.code.length == 0 || feeSplitterAddress.code.length == 0
                || initialSupplyCapN == 0
                || initialBorrowCapN == 0 || initialBorrowCapN > initialSupplyCapN
        ) revert InvalidConfiguration();
        if (IERC20Metadata(nAddress).decimals() != 18) revert InvalidConfiguration();

        n = IERC20(nAddress);
        feeSplitter = feeSplitterAddress;
        supplyCapN = initialSupplyCapN;
        borrowCapN = initialBorrowCapN;
        borrowIndexWad = WAD;
        lastAccrualTimestamp = block.timestamp;
        activated = initiallyActive;
        bootstrapOpen = !initiallyActive;
        if (!initiallyActive) {
            supplyPaused = true;
            borrowPaused = true;
            collateralWithdrawalPaused = true;
            emit PausesUpdated(true, true, true);
        }
    }

    function configureCollateral(
        address asset,
        address oracleAddress,
        uint256 collateralSupplyCap,
        uint16 loanToValueBps,
        uint16 marginCallThresholdBps,
        uint16 liquidationThresholdBps,
        uint16 liquidationBonusBps,
        bool enabled
    ) external onlyOwner {
        if (
            asset == address(0) || asset.code.length == 0 || asset == address(n) || oracleAddress == address(0)
                || oracleAddress.code.length == 0 || collateralSupplyCap == 0 || loanToValueBps == 0
                || loanToValueBps >= marginCallThresholdBps || marginCallThresholdBps >= liquidationThresholdBps
                || liquidationThresholdBps >= BPS_DENOMINATOR
                || liquidationBonusBps > BPS_DENOMINATOR - liquidationThresholdBps
                || collateralSupplyCap < totalCollateralByAsset[asset]
        ) revert InvalidConfiguration();

        uint8 assetDecimals = IERC20Metadata(asset).decimals();
        if (assetDecimals > 18) revert InvalidConfiguration();

        if (!_knownCollateral[asset]) {
            if (_collateralAssets.length >= MAX_COLLATERAL_ASSETS) revert TooManyCollateralAssets();
            _knownCollateral[asset] = true;
            _collateralAssets.push(asset);
        }

        collateralConfigs[asset] = CollateralConfig({
            oracle: oracleAddress,
            supplyCap: collateralSupplyCap,
            loanToValueBps: loanToValueBps,
            liquidationThresholdBps: liquidationThresholdBps,
            liquidationBonusBps: liquidationBonusBps,
            decimals: assetDecimals,
            enabled: enabled,
            marginCallThresholdBps: marginCallThresholdBps
        });
        emit CollateralConfigured(
            asset,
            oracleAddress,
            collateralSupplyCap,
            loanToValueBps,
            marginCallThresholdBps,
            liquidationThresholdBps,
            liquidationBonusBps,
            enabled
        );
    }

    function setCaps(uint256 newSupplyCapN, uint256 newBorrowCapN) external onlyOwner {
        uint256 managedAssets = totalAssetsN();
        uint256 borrowed = totalBorrowed();
        if (
            newSupplyCapN == 0 || newBorrowCapN == 0 || newBorrowCapN > newSupplyCapN
                || newSupplyCapN < managedAssets || _borrowExposureExceedsCap(borrowed, newBorrowCapN)
        ) revert InvalidConfiguration();
        supplyCapN = newSupplyCapN;
        borrowCapN = newBorrowCapN;
        emit CapsUpdated(newSupplyCapN, newBorrowCapN);
    }

    /// @notice Sends accrued protocol interest that is held in cash to the fee splitter, which
    ///         splits it in the same call. Permissionless; suppliers' assets are unchanged because
    ///         protocol interest is already excluded from `totalAssetsN()`.
    function sweepProtocolInterest() external nonReentrant returns (uint256 amountN) {
        _accrueInterest();
        amountN = _min(accruedProtocolInterestN, n.balanceOf(address(this)));
        if (amountN == 0) revert ProtocolInterestExceeded();
        accruedProtocolInterestN -= amountN;
        _pushExact(n, feeSplitter, amountN);
        IFeeSplitter(feeSplitter).distribute();
        emit ProtocolInterestWithdrawn(feeSplitter, amountN);
    }

    function setPauses(bool pauseSupply, bool pauseBorrow, bool pauseCollateralWithdrawal) external onlyOwner {
        if (!activated && (!pauseSupply || !pauseBorrow || !pauseCollateralWithdrawal)) {
            revert MarketNotActivated();
        }
        // Collateral is never held while borrowing is open: an account could repay everything,
        // take its collateral out and borrow the same amount again on less.
        if (pauseCollateralWithdrawal && !pauseBorrow) revert InvalidConfiguration();
        supplyPaused = pauseSupply;
        borrowPaused = pauseBorrow;
        collateralWithdrawalPaused = pauseCollateralWithdrawal;
        emit PausesUpdated(pauseSupply, pauseBorrow, pauseCollateralWithdrawal);
    }

    function pauseRiskOperations() external onlyOwnerOrGuardian {
        supplyPaused = true;
        borrowPaused = true;
        collateralWithdrawalPaused = true;
        emit PausesUpdated(true, true, true);
    }

    function accrueInterest() external returns (uint256 newBorrowIndexWad) {
        _accrueInterest();
        return borrowIndexWad;
    }

    /// @notice Seeds an inactive migration pool while public risk-increasing actions remain blocked.
    /// @dev Available exactly once to the owner that deployed the inactive pool.
    function bootstrapSupply(uint256 amountN, address onBehalfOf)
        external
        onlyOwner
        nonReentrant
        returns (uint256 sharesMinted)
    {
        if (
            activated || !bootstrapOpen || !supplyPaused || !borrowPaused || !collateralWithdrawalPaused
                || totalSupply() != 0
        ) revert BootstrapUnavailable();
        bootstrapOpen = false;
        sharesMinted = _supplyN(amountN, onBehalfOf);
        emit BootstrapSupplied(onBehalfOf, amountN, sharesMinted);
    }

    /// @notice Opens a fully bootstrapped migration pool in one owner-controlled state transition.
    function activateRiskOperations() external onlyOwner {
        if (
            activated || bootstrapOpen || totalSupply() <= MINIMUM_LOCKED_SHARES || totalBorrowed() != 0
                || totalBadDebtN != 0 || _collateralAssets.length == 0
        ) revert BootstrapUnavailable();
        activated = true;
        supplyPaused = false;
        borrowPaused = false;
        collateralWithdrawalPaused = false;
        emit MarketActivated();
        emit PausesUpdated(false, false, false);
    }

    function supply(uint256 amountN, address onBehalfOf) external nonReentrant returns (uint256 sharesMinted) {
        if (!activated) revert MarketNotActivated();
        if (supplyPaused) revert SupplyPaused();
        return _supplyN(amountN, onBehalfOf);
    }

    function _supplyN(uint256 amountN, address onBehalfOf) private returns (uint256 sharesMinted) {
        if (onBehalfOf == address(0)) revert InvalidRecipient();
        if (amountN == 0) revert InvalidAmount();

        _accrueInterest();

        uint256 managedAssetsBefore = _totalAssetsAtIndex(borrowIndexWad);
        if (managedAssetsBefore > supplyCapN || amountN > supplyCapN - managedAssetsBefore) {
            revert SupplyCapExceeded();
        }

        uint256 shareSupply = totalSupply();
        if (shareSupply == 0) {
            if (amountN <= MINIMUM_LOCKED_SHARES) revert InvalidAmount();
            sharesMinted = amountN - MINIMUM_LOCKED_SHARES;
        } else {
            if (managedAssetsBefore == 0) revert InsolventPool();
            sharesMinted = Math.mulDiv(amountN, shareSupply, managedAssetsBefore);
        }
        if (sharesMinted == 0) revert InvalidAmount();

        _pullExact(n, msg.sender, amountN);
        if (shareSupply == 0) _mint(LOCKED_SHARE_RECIPIENT, MINIMUM_LOCKED_SHARES);
        _mint(onBehalfOf, sharesMinted);
        emit Supplied(msg.sender, onBehalfOf, amountN, sharesMinted);
    }

    function withdraw(uint256 amountN, address recipient) external nonReentrant returns (uint256 sharesBurned) {
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();
        if (amountN == 0) revert InvalidAmount();
        _accrueInterest();

        uint256 managedAssets = _totalAssetsAtIndex(borrowIndexWad);
        uint256 shareSupply = totalSupply();
        if (shareSupply == 0 || amountN > n.balanceOf(address(this))) revert InsufficientLiquidity();
        sharesBurned = _mulDivUp(amountN, shareSupply, managedAssets);
        if (sharesBurned == 0 || sharesBurned > balanceOf(msg.sender)) revert InvalidAmount();

        _burn(msg.sender, sharesBurned);
        _pushExact(n, recipient, amountN);
        emit Withdrawn(msg.sender, recipient, amountN, sharesBurned);
    }

    function redeem(uint256 shares, address recipient) external nonReentrant returns (uint256 amountN) {
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();
        if (shares == 0 || shares > balanceOf(msg.sender)) revert InvalidAmount();
        _accrueInterest();

        amountN = Math.mulDiv(shares, _totalAssetsAtIndex(borrowIndexWad), totalSupply());
        if (amountN == 0) revert InvalidAmount();
        if (amountN > n.balanceOf(address(this))) revert InsufficientLiquidity();

        _burn(msg.sender, shares);
        _pushExact(n, recipient, amountN);
        emit Withdrawn(msg.sender, recipient, amountN, shares);
    }

    function depositCollateral(address asset, uint256 amount, address onBehalfOf) external nonReentrant {
        if (!activated) revert MarketNotActivated();
        CollateralConfig storage config = collateralConfigs[asset];
        if (!_knownCollateral[asset] || !config.enabled) revert UnsupportedCollateral();
        if (onBehalfOf == address(0)) revert InvalidRecipient();
        if (amount == 0) revert InvalidAmount();

        uint256 totalAfter = totalCollateralByAsset[asset] + amount;
        if (totalAfter > config.supplyCap) revert CollateralCapExceeded();
        _pullExact(IERC20(asset), msg.sender, amount);
        collateralBalance[onBehalfOf][asset] += amount;
        totalCollateralByAsset[asset] = totalAfter;
        emit CollateralDeposited(msg.sender, onBehalfOf, asset, amount);
    }

    function withdrawCollateral(address asset, uint256 amount, address recipient) external nonReentrant {
        if (!_knownCollateral[asset]) revert UnsupportedCollateral();
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();
        uint256 balance = collateralBalance[msg.sender][asset];
        if (amount == 0 || amount > balance) revert InvalidAmount();

        bool hasDebt = debtSharesOf[msg.sender] != 0;
        if (hasDebt && collateralWithdrawalPaused) revert CollateralWithdrawalPaused();

        collateralBalance[msg.sender][asset] = balance - amount;
        totalCollateralByAsset[asset] -= amount;
        if (hasDebt) {
            uint256 debt = debtBalance(msg.sender);
            (, uint256 borrowingCapacity,,) = _accountCollateralValues(msg.sender);
            if (debt > borrowingCapacity) revert InsufficientCollateral();
        }

        _pushExact(IERC20(asset), recipient, amount);
        emit CollateralWithdrawn(msg.sender, recipient, asset, amount);
    }

    function borrow(uint256 amountN, address recipient) external nonReentrant returns (uint256 debtSharesMinted) {
        if (!activated) revert MarketNotActivated();
        if (borrowPaused) revert BorrowPaused();
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();
        if (amountN == 0) revert InvalidAmount();
        if (badDebtNByAccount[msg.sender] != 0) revert AccountHasBadDebt();

        _accrueInterest();
        if (amountN > n.balanceOf(address(this))) revert InsufficientLiquidity();

        debtSharesMinted = _mulDivUp(amountN, WAD, borrowIndexWad);
        uint256 accountSharesAfter = debtSharesOf[msg.sender] + debtSharesMinted;
        uint256 totalSharesAfter = totalDebtShares + debtSharesMinted;
        uint256 accountDebtAfter = _debtAtShares(accountSharesAfter, borrowIndexWad);
        uint256 totalDebtAfter = _debtAtShares(totalSharesAfter, borrowIndexWad);
        if (_borrowExposureExceedsCap(totalDebtAfter, borrowCapN)) revert BorrowCapExceeded();

        (, uint256 borrowingCapacity,,) = _accountCollateralValues(msg.sender);
        if (accountDebtAfter > borrowingCapacity) revert InsufficientCollateral();

        debtSharesOf[msg.sender] = accountSharesAfter;
        totalDebtShares = totalSharesAfter;
        _pushExact(n, recipient, amountN);
        emit Borrowed(msg.sender, recipient, amountN, debtSharesMinted);
    }

    function repay(uint256 maximumAmountN, address onBehalfOf)
        external
        nonReentrant
        returns (uint256 amountRepaidN)
    {
        if (onBehalfOf == address(0)) revert InvalidRecipient();
        if (maximumAmountN == 0) revert InvalidAmount();
        _accrueInterest();

        (uint256 debtSharesBurned, uint256 amountRepaid) = _debtBurnQuote(onBehalfOf, maximumAmountN);
        debtSharesOf[onBehalfOf] -= debtSharesBurned;
        totalDebtShares -= debtSharesBurned;
        _pullExact(n, msg.sender, amountRepaid);
        emit Repaid(msg.sender, onBehalfOf, amountRepaid, debtSharesBurned);
        return amountRepaid;
    }

    function liquidate(
        address account,
        address collateralAsset,
        uint256 maximumRepayN,
        uint256 minimumCollateralOut,
        address recipient
    ) external nonReentrant returns (uint256 amountRepaidN, uint256 collateralOut) {
        if (account == address(0) || recipient == address(0) || recipient == address(this)) {
            revert InvalidRecipient();
        }
        if (maximumRepayN == 0) revert InvalidAmount();
        if (!_knownCollateral[collateralAsset]) revert UnsupportedCollateral();
        _accrueInterest();

        (,,, uint256 liquidationCapacity) = _accountCollateralValues(account);
        uint256 accountDebt = _debtAtShares(debtSharesOf[account], borrowIndexWad);
        if (accountDebt == 0 || accountDebt < liquidationCapacity) revert PositionHealthy();

        LiquidationQuote memory quote = _liquidationQuote(account, collateralAsset, maximumRepayN, accountDebt);
        if (quote.collateralOut < minimumCollateralOut) revert SlippageExceeded();

        debtSharesOf[account] -= quote.debtSharesToBurn;
        totalDebtShares -= quote.debtSharesToBurn;
        collateralBalance[account][collateralAsset] -= quote.collateralOut;
        totalCollateralByAsset[collateralAsset] -= quote.collateralOut;

        _pullExact(n, msg.sender, quote.amountRepaidN);
        _pushExact(IERC20(collateralAsset), recipient, quote.collateralOut);

        if (!_hasAnyCollateral(account) && debtSharesOf[account] != 0) {
            uint256 badDebt = _debtAtShares(debtSharesOf[account], borrowIndexWad);
            totalDebtShares -= debtSharesOf[account];
            debtSharesOf[account] = 0;
            badDebtNByAccount[account] += badDebt;
            totalBadDebtN += badDebt;
            cumulativeBadDebtN += badDebt;
            _writeOffProtocolInterest(account, badDebt);
            emit BadDebtRecognized(account, badDebt);
        }

        amountRepaidN = quote.amountRepaidN;
        collateralOut = quote.collateralOut;
        emit Liquidated(msg.sender, account, collateralAsset, amountRepaidN, collateralOut, recipient);
    }

    function repayBadDebt(address account, uint256 maximumAmountN)
        external
        nonReentrant
        returns (uint256 amountRepaidN)
    {
        uint256 badDebt = badDebtNByAccount[account];
        if (badDebt == 0 || maximumAmountN == 0) revert InvalidAmount();
        amountRepaidN = _min(badDebt, maximumAmountN);
        badDebtNByAccount[account] = badDebt - amountRepaidN;
        totalBadDebtN -= amountRepaidN;
        uint256 protocolRestored = _min(protocolInterestWrittenOffByAccount[account], amountRepaidN);
        if (protocolRestored != 0) {
            protocolInterestWrittenOffByAccount[account] -= protocolRestored;
            accruedProtocolInterestN += protocolRestored;
            emit ProtocolInterestRestored(account, protocolRestored, accruedProtocolInterestN);
        }
        _pullExact(n, msg.sender, amountRepaidN);
        emit BadDebtRepaid(msg.sender, account, amountRepaidN);
    }

    function totalBorrowed() public view returns (uint256) {
        (uint256 previewIndex,) = _previewAccrual();
        return _debtAtShares(totalDebtShares, previewIndex);
    }

    function protocolInterestN() public view returns (uint256) {
        (, uint256 previewProtocolInterest) = _previewAccrual();
        return previewProtocolInterest;
    }

    function totalSupplied() external view returns (uint256) {
        return totalAssetsN();
    }

    function totalAssetsN() public view returns (uint256) {
        (uint256 previewIndex, uint256 previewProtocolInterest) = _previewAccrual();
        uint256 grossAssets = n.balanceOf(address(this)) + _debtAtShares(totalDebtShares, previewIndex);
        if (previewProtocolInterest > grossAssets) revert InsolventPool();
        return grossAssets - previewProtocolInterest;
    }

    function availableLiquidity() external view returns (uint256) {
        return n.balanceOf(address(this));
    }

    function debtBalance(address account) public view returns (uint256) {
        (uint256 previewIndex,) = _previewAccrual();
        return _debtAtShares(debtSharesOf[account], previewIndex);
    }

    function supplyBalance(address account) public view returns (uint256) {
        uint256 shareSupply = totalSupply();
        if (shareSupply == 0) return 0;
        return Math.mulDiv(balanceOf(account), totalAssetsN(), shareSupply);
    }

    function maxWithdraw(address account) external view returns (uint256) {
        return _min(supplyBalance(account), n.balanceOf(address(this)));
    }

    function healthFactor(address account) public view returns (uint256) {
        uint256 debt = debtBalance(account);
        if (debt == 0) return type(uint256).max;
        (,,, uint256 liquidationCapacity) = _accountCollateralValues(account);
        return Math.mulDiv(liquidationCapacity, WAD, debt);
    }

    function accountLiquidity(address account)
        external
        view
        returns (uint256 borrowingCapacityN, uint256 liquidationCapacityN, uint256 debtN)
    {
        (, borrowingCapacityN,, liquidationCapacityN) = _accountCollateralValues(account);
        debtN = debtBalance(account);
    }

    function accountRisk(address account)
        external
        view
        returns (
            uint256 collateralValueN,
            uint256 borrowingCapacityN,
            uint256 marginCallCapacityN,
            uint256 liquidationCapacityN,
            uint256 debtN,
            uint256 currentLtvBps
        )
    {
        (
            collateralValueN, borrowingCapacityN, marginCallCapacityN, liquidationCapacityN
        ) = _accountCollateralValues(account);
        debtN = debtBalance(account);
        currentLtvBps = collateralValueN == 0 ? 0 : _mulDivUp(debtN, BPS_DENOMINATOR, collateralValueN);
    }

    function maxBorrow(address account) external view returns (uint256 amountN) {
        if (borrowPaused || badDebtNByAccount[account] != 0) return 0;
        (uint256 previewIndex,) = _previewAccrual();
        (, uint256 borrowingCapacity,,) = _accountCollateralValues(account);
        uint256 accountDebt = _debtAtShares(debtSharesOf[account], previewIndex);
        if (accountDebt >= borrowingCapacity) return 0;

        uint256 totalDebt = _debtAtShares(totalDebtShares, previewIndex);
        if (totalBadDebtN >= borrowCapN || totalDebt >= borrowCapN - totalBadDebtN) return 0;
        amountN = _min(
            n.balanceOf(address(this)),
            _min(borrowingCapacity - accountDebt, borrowCapN - totalBadDebtN - totalDebt)
        );
        // Debt shares round upward, so leave one wei of headroom for a quote used by a later transaction.
        return amountN > 1 ? amountN - 1 : 0;
    }

    function maxWithdrawCollateral(address account, address asset) external view returns (uint256 amount) {
        if (!_knownCollateral[asset]) return 0;
        uint256 balance = collateralBalance[account][asset];
        if (balance == 0) return 0;
        uint256 debt = debtBalance(account);
        if (debt == 0) return balance;
        if (collateralWithdrawalPaused) return 0;

        (, uint256 borrowingCapacity,,) = _accountCollateralValues(account);
        if (debt >= borrowingCapacity) return 0;
        CollateralConfig storage config = collateralConfigs[asset];
        if (!config.enabled || config.loanToValueBps == 0) return balance;

        (uint256 priceWad,,) = IPriceOracle(config.oracle).readPriceWad();
        uint256 scale = 10 ** config.decimals;
        uint256 currentContribution =
            Math.mulDiv(Math.mulDiv(balance, priceWad, scale), config.loanToValueBps, BPS_DENOMINATOR);
        amount =
            Math.mulDiv(borrowingCapacity - debt, scale * BPS_DENOMINATOR, priceWad * uint256(config.loanToValueBps));
        amount = _min(amount, balance);

        uint256 remainingValue = Math.mulDiv(balance - amount, priceWad, scale);
        uint256 remainingContribution = Math.mulDiv(remainingValue, config.loanToValueBps, BPS_DENOMINATOR);
        uint256 capacityAfter = borrowingCapacity - currentContribution + remainingContribution;
        if (capacityAfter < debt && amount != 0) amount -= 1;
    }

    function borrowRatePerSecondWad() public pure returns (uint256) {
        return Math.mulDiv(BORROW_APR_BPS, WAD, BPS_DENOMINATOR * SECONDS_PER_YEAR);
    }

    function borrowRate() external pure returns (uint256) {
        return Math.mulDiv(BORROW_APR_BPS, WAD, BPS_DENOMINATOR);
    }

    function lenderRate() external pure returns (uint256) {
        return Math.mulDiv(LENDER_APR_BPS, WAD, BPS_DENOMINATOR);
    }

    function protocolRate() external pure returns (uint256) {
        return Math.mulDiv(PROTOCOL_APR_BPS, WAD, BPS_DENOMINATOR);
    }

    function supplyRatePerSecondWad() public view returns (uint256) {
        uint256 borrowed = totalBorrowed();
        uint256 supplierAssets = totalAssetsN();
        uint256 utilization = _utilizationWad(borrowed, supplierAssets);
        uint256 lenderRatePerSecond = Math.mulDiv(LENDER_APR_BPS, WAD, BPS_DENOMINATOR * SECONDS_PER_YEAR);
        return Math.mulDiv(lenderRatePerSecond, utilization, WAD);
    }

    function supplyRate() external view returns (uint256) {
        return supplyRatePerSecondWad() * SECONDS_PER_YEAR;
    }

    function collateralAssets() external view returns (address[] memory) {
        return _collateralAssets;
    }

    function collateralAssetCount() external view returns (uint256) {
        return _collateralAssets.length;
    }

    function collateralAssetAt(uint256 index) external view returns (address) {
        return _collateralAssets[index];
    }

    function isLiquidatable(address account) external view returns (bool) {
        uint256 debt = debtBalance(account);
        if (debt == 0) return false;
        (,,, uint256 liquidationCapacity) = _accountCollateralValues(account);
        return debt >= liquidationCapacity;
    }

    function isMarginCalled(address account) external view returns (bool) {
        uint256 debt = debtBalance(account);
        if (debt == 0) return false;
        (,, uint256 marginCallCapacity,) = _accountCollateralValues(account);
        return debt >= marginCallCapacity;
    }

    function _liquidationQuote(address account, address collateralAsset, uint256 maximumRepayN, uint256 accountDebt)
        internal
        view
        returns (LiquidationQuote memory quote)
    {
        CollateralConfig storage config = collateralConfigs[collateralAsset];
        uint256 availableCollateral = collateralBalance[account][collateralAsset];
        if (availableCollateral == 0) revert InsufficientCollateral();

        (uint256 priceWad,,) = IPriceOracle(config.oracle).readPriceWad();
        uint256 repaymentBudget;
        {
            uint256 closeLimit = Math.mulDiv(accountDebt, CLOSE_FACTOR_BPS, BPS_DENOMINATOR);
            if (closeLimit == 0) closeLimit = accountDebt;
            repaymentBudget = _min(maximumRepayN, closeLimit);
        }
        uint256 collateralRepaymentLimit = _mulDivUp(
            _mulDivUp(availableCollateral, priceWad, 10 ** config.decimals),
            BPS_DENOMINATOR,
            BPS_DENOMINATOR + config.liquidationBonusBps
        );

        // Exhaust collateral only after paying its full value, including debt-share rounding.
        // This also lets the existing bad-debt accounting clear positions without leaving dust.
        if (repaymentBudget >= collateralRepaymentLimit) {
            quote.debtSharesToBurn = _mulDivUp(collateralRepaymentLimit, WAD, borrowIndexWad);
            quote.debtSharesToBurn = _min(quote.debtSharesToBurn, debtSharesOf[account]);
            quote.amountRepaidN = _debtAtShares(quote.debtSharesToBurn, borrowIndexWad);
            if (quote.amountRepaidN <= repaymentBudget) {
                quote.collateralOut = availableCollateral;
                return quote;
            }
        }

        repaymentBudget = _min(repaymentBudget, collateralRepaymentLimit);
        if (repaymentBudget == 0) revert InsufficientCollateral();

        (quote.debtSharesToBurn, quote.amountRepaidN) = _debtBurnQuote(account, repaymentBudget);
        // Rounding either conversion upward can award whole low-decimal tokens for dust N.
        uint256 repaymentWithBonus =
            Math.mulDiv(quote.amountRepaidN, BPS_DENOMINATOR + config.liquidationBonusBps, BPS_DENOMINATOR);
        quote.collateralOut = Math.mulDiv(repaymentWithBonus, 10 ** config.decimals, priceWad);
        if (quote.collateralOut == 0) revert InsufficientCollateral();
        if (quote.collateralOut > availableCollateral) quote.collateralOut = availableCollateral;
    }

    function _debtBurnQuote(address account, uint256 maximumAmountN)
        internal
        view
        returns (uint256 sharesToBurn, uint256 amountRepaidN)
    {
        uint256 accountShares = debtSharesOf[account];
        if (accountShares == 0) revert InvalidAmount();
        uint256 fullDebt = _debtAtShares(accountShares, borrowIndexWad);
        if (maximumAmountN >= fullDebt) return (accountShares, fullDebt);

        sharesToBurn = Math.mulDiv(maximumAmountN, WAD, borrowIndexWad);
        if (sharesToBurn == 0) revert InvalidAmount();
        amountRepaidN = _debtAtShares(sharesToBurn, borrowIndexWad);
        if (amountRepaidN > maximumAmountN) {
            sharesToBurn -= 1;
            if (sharesToBurn == 0) revert InvalidAmount();
            amountRepaidN = _debtAtShares(sharesToBurn, borrowIndexWad);
        }
    }

    function _accountCollateralValues(address account)
        internal
        view
        returns (
            uint256 collateralValueN,
            uint256 borrowingCapacityN,
            uint256 marginCallCapacityN,
            uint256 liquidationCapacityN
        )
    {
        uint256 length = _collateralAssets.length;
        for (uint256 i; i < length; ++i) {
            address asset = _collateralAssets[i];
            uint256 amount = collateralBalance[account][asset];
            if (amount == 0) continue;

            CollateralConfig storage config = collateralConfigs[asset];
            (uint256 priceWad,,) = IPriceOracle(config.oracle).readPriceWad();
            uint256 assetValueN = Math.mulDiv(amount, priceWad, 10 ** config.decimals);
            collateralValueN += assetValueN;
            if (config.enabled) {
                borrowingCapacityN += Math.mulDiv(assetValueN, config.loanToValueBps, BPS_DENOMINATOR);
            }
            marginCallCapacityN += Math.mulDiv(assetValueN, config.marginCallThresholdBps, BPS_DENOMINATOR);
            liquidationCapacityN += Math.mulDiv(assetValueN, config.liquidationThresholdBps, BPS_DENOMINATOR);
        }
    }

    function _hasAnyCollateral(address account) internal view returns (bool) {
        uint256 length = _collateralAssets.length;
        for (uint256 i; i < length; ++i) {
            if (collateralBalance[account][_collateralAssets[i]] != 0) return true;
        }
        return false;
    }

    function _accrueInterest() internal {
        uint256 previousIndex = borrowIndexWad;
        uint256 previousProtocolInterest = accruedProtocolInterestN;
        uint256 currentTimestamp = block.timestamp;
        uint256 elapsed = currentTimestamp - lastAccrualTimestamp;
        if (elapsed == 0) return;

        (uint256 nextIndex, uint256 nextProtocolInterest) = _previewAccrual();
        borrowIndexWad = nextIndex;
        accruedProtocolInterestN = nextProtocolInterest;
        lastAccrualTimestamp = currentTimestamp;
        emit InterestAccrued(previousIndex, nextIndex, elapsed);
        if (nextProtocolInterest != previousProtocolInterest) {
            emit ProtocolInterestAccrued(nextProtocolInterest - previousProtocolInterest, nextProtocolInterest);
        }
    }

    function _previewAccrual() internal view returns (uint256 nextIndex, uint256 nextProtocolInterest) {
        nextIndex = borrowIndexWad;
        nextProtocolInterest = accruedProtocolInterestN;
        uint256 elapsed = block.timestamp - lastAccrualTimestamp;
        if (elapsed == 0 || totalDebtShares == 0) return (nextIndex, nextProtocolInterest);

        uint256 previousDebt = _debtAtShares(totalDebtShares, nextIndex);
        uint256 indexIncrease = Math.mulDiv(nextIndex, BORROW_APR_BPS * elapsed, BPS_DENOMINATOR * SECONDS_PER_YEAR);
        nextIndex += indexIncrease;
        uint256 grossInterestN = _debtAtShares(totalDebtShares, nextIndex) - previousDebt;
        nextProtocolInterest += Math.mulDiv(grossInterestN, PROTOCOL_APR_BPS, BORROW_APR_BPS);
    }

    function _utilizationWad(uint256 borrowed, uint256 supplierAssets) internal pure returns (uint256) {
        if (borrowed == 0 || supplierAssets == 0) return 0;
        if (borrowed >= supplierAssets) return WAD;
        return Math.mulDiv(borrowed, WAD, supplierAssets);
    }

    function _totalAssetsAtIndex(uint256 indexWad) internal view returns (uint256) {
        uint256 grossAssets = n.balanceOf(address(this)) + _debtAtShares(totalDebtShares, indexWad);
        if (accruedProtocolInterestN > grossAssets) revert InsolventPool();
        return grossAssets - accruedProtocolInterestN;
    }

    function _debtAtShares(uint256 shares, uint256 indexWad) internal pure returns (uint256) {
        if (shares == 0) return 0;
        return _mulDivUp(shares, indexWad, WAD);
    }

    function _borrowExposureExceedsCap(uint256 activeDebtN, uint256 capN) internal view returns (bool) {
        return activeDebtN > capN || totalBadDebtN > capN - activeDebtN;
    }

    function _writeOffProtocolInterest(address account, uint256 badDebtN) internal {
        uint256 amountWrittenOff = _min(accruedProtocolInterestN, badDebtN);
        if (amountWrittenOff == 0) return;
        accruedProtocolInterestN -= amountWrittenOff;
        protocolInterestWrittenOffByAccount[account] += amountWrittenOff;
        emit ProtocolInterestWrittenOff(amountWrittenOff, accruedProtocolInterestN);
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
