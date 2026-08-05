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

/// @notice A pooled NUSD money market with isolated collateral configuration and socialized supplier yield/loss.
contract PooledNUSDLendingPool is ERC20, EmergencyGuardian, ReentrancyGuard {
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

    uint256 public constant WAD = 1e18;
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant BORROW_APR_BPS = 450;
    uint256 public constant LENDER_APR_BPS = 400;
    uint256 public constant PROTOCOL_APR_BPS = 50;
    uint256 public constant CLOSE_FACTOR_BPS = 5000;
    uint256 public constant MAX_COLLATERAL_ASSETS = 8;
    uint256 public constant SECONDS_PER_YEAR = 365 days;
    uint256 public constant MINIMUM_LOCKED_SHARES = 1000;
    bytes32 public constant IMPLEMENTATION_ID = keccak256("0xfi.lending.fixed-4.5-4-0.5.80-85-90.v1");
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
        uint256 amountRepaidNusd;
        uint256 collateralOut;
    }

    IERC20 public immutable nusd;

    mapping(address => CollateralConfig) public collateralConfigs;
    mapping(address => mapping(address => uint256)) public collateralBalance;
    mapping(address => uint256) public totalCollateralByAsset;
    mapping(address => uint256) public debtSharesOf;
    mapping(address => uint256) public badDebtNusdByAccount;
    mapping(address => uint256) public protocolInterestWrittenOffByAccount;

    address[] private _collateralAssets;
    mapping(address => bool) private _knownCollateral;

    uint256 public totalDebtShares;
    uint256 public borrowIndexWad;
    uint256 public lastAccrualTimestamp;
    uint256 public totalBadDebtNusd;
    uint256 public cumulativeBadDebtNusd;
    uint256 public supplyCapNusd;
    uint256 public borrowCapNusd;
    uint256 public accruedProtocolInterestNusd;
    bool public supplyPaused;
    bool public borrowPaused;
    bool public collateralWithdrawalPaused;

    event InterestAccrued(uint256 previousBorrowIndexWad, uint256 newBorrowIndexWad, uint256 elapsedSeconds);
    event ProtocolInterestAccrued(uint256 amountNusd, uint256 accruedProtocolInterestNusd);
    event ProtocolInterestWithdrawn(address indexed recipient, uint256 amountNusd);
    event ProtocolInterestWrittenOff(uint256 amountNusd, uint256 accruedProtocolInterestNusd);
    event ProtocolInterestRestored(address indexed account, uint256 amountNusd, uint256 accruedProtocolInterestNusd);
    event Supplied(address indexed payer, address indexed account, uint256 amountNusd, uint256 sharesMinted);
    event Withdrawn(address indexed account, address indexed recipient, uint256 amountNusd, uint256 sharesBurned);
    event CollateralDeposited(address indexed payer, address indexed account, address indexed asset, uint256 amount);
    event CollateralWithdrawn(
        address indexed account, address indexed recipient, address indexed asset, uint256 amount
    );
    event Borrowed(address indexed account, address indexed recipient, uint256 amountNusd, uint256 debtSharesMinted);
    event Repaid(address indexed payer, address indexed account, uint256 amountNusd, uint256 debtSharesBurned);
    event Liquidated(
        address indexed liquidator,
        address indexed account,
        address indexed collateralAsset,
        uint256 amountRepaidNusd,
        uint256 collateralOut,
        address recipient
    );
    event BadDebtRecognized(address indexed account, uint256 amountNusd);
    event BadDebtRepaid(address indexed payer, address indexed account, uint256 amountNusd);
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
    event CapsUpdated(uint256 supplyCapNusd, uint256 borrowCapNusd);
    event PausesUpdated(bool supplyPaused, bool borrowPaused, bool collateralWithdrawalPaused);

    constructor(
        address nusdAddress,
        address initialOwner,
        uint256 initialSupplyCapNusd,
        uint256 initialBorrowCapNusd
    ) ERC20("0xFi Pooled NUSD", "xfiNUSD") EmergencyGuardian(initialOwner) {
        if (
            nusdAddress == address(0) || nusdAddress.code.length == 0 || initialSupplyCapNusd == 0
                || initialBorrowCapNusd == 0 || initialBorrowCapNusd > initialSupplyCapNusd
        ) revert InvalidConfiguration();
        if (IERC20Metadata(nusdAddress).decimals() != 18) revert InvalidConfiguration();

        nusd = IERC20(nusdAddress);
        supplyCapNusd = initialSupplyCapNusd;
        borrowCapNusd = initialBorrowCapNusd;
        borrowIndexWad = WAD;
        lastAccrualTimestamp = block.timestamp;
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
            asset == address(0) || asset.code.length == 0 || asset == address(nusd) || oracleAddress == address(0)
                || oracleAddress.code.length == 0 || collateralSupplyCap == 0 || loanToValueBps == 0
                || loanToValueBps >= marginCallThresholdBps
                || marginCallThresholdBps >= liquidationThresholdBps
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

    function setCaps(uint256 newSupplyCapNusd, uint256 newBorrowCapNusd) external onlyOwner {
        uint256 managedAssets = totalAssetsNusd();
        uint256 borrowed = totalBorrowed();
        if (
            newSupplyCapNusd == 0 || newBorrowCapNusd == 0 || newBorrowCapNusd > newSupplyCapNusd
                || newSupplyCapNusd < managedAssets || _borrowExposureExceedsCap(borrowed, newBorrowCapNusd)
        ) revert InvalidConfiguration();
        supplyCapNusd = newSupplyCapNusd;
        borrowCapNusd = newBorrowCapNusd;
        emit CapsUpdated(newSupplyCapNusd, newBorrowCapNusd);
    }

    function withdrawProtocolInterest(uint256 amountNusd, address recipient) external onlyOwner nonReentrant {
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();
        if (amountNusd == 0) revert InvalidAmount();
        _accrueInterest();
        if (amountNusd > accruedProtocolInterestNusd || amountNusd > nusd.balanceOf(address(this))) {
            revert ProtocolInterestExceeded();
        }

        accruedProtocolInterestNusd -= amountNusd;
        _pushExact(nusd, recipient, amountNusd);
        emit ProtocolInterestWithdrawn(recipient, amountNusd);
    }

    function setPauses(bool pauseSupply, bool pauseBorrow, bool pauseCollateralWithdrawal) external onlyOwner {
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

    function supply(uint256 amountNusd, address onBehalfOf) external nonReentrant returns (uint256 sharesMinted) {
        if (supplyPaused) revert SupplyPaused();
        if (onBehalfOf == address(0)) revert InvalidRecipient();
        if (amountNusd == 0) revert InvalidAmount();

        _accrueInterest();

        uint256 managedAssetsBefore = _totalAssetsAtIndex(borrowIndexWad);
        if (managedAssetsBefore > supplyCapNusd || amountNusd > supplyCapNusd - managedAssetsBefore) {
            revert SupplyCapExceeded();
        }

        uint256 shareSupply = totalSupply();
        if (shareSupply == 0) {
            if (amountNusd <= MINIMUM_LOCKED_SHARES) revert InvalidAmount();
            sharesMinted = amountNusd - MINIMUM_LOCKED_SHARES;
        } else {
            if (managedAssetsBefore == 0) revert InsolventPool();
            sharesMinted = Math.mulDiv(amountNusd, shareSupply, managedAssetsBefore);
        }
        if (sharesMinted == 0) revert InvalidAmount();

        _pullExact(nusd, msg.sender, amountNusd);
        if (shareSupply == 0) _mint(LOCKED_SHARE_RECIPIENT, MINIMUM_LOCKED_SHARES);
        _mint(onBehalfOf, sharesMinted);
        emit Supplied(msg.sender, onBehalfOf, amountNusd, sharesMinted);
    }

    function withdraw(uint256 amountNusd, address recipient) external nonReentrant returns (uint256 sharesBurned) {
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();
        if (amountNusd == 0) revert InvalidAmount();
        _accrueInterest();

        uint256 managedAssets = _totalAssetsAtIndex(borrowIndexWad);
        uint256 shareSupply = totalSupply();
        if (shareSupply == 0 || amountNusd > nusd.balanceOf(address(this))) revert InsufficientLiquidity();
        sharesBurned = _mulDivUp(amountNusd, shareSupply, managedAssets);
        if (sharesBurned == 0 || sharesBurned > balanceOf(msg.sender)) revert InvalidAmount();

        _burn(msg.sender, sharesBurned);
        _pushExact(nusd, recipient, amountNusd);
        emit Withdrawn(msg.sender, recipient, amountNusd, sharesBurned);
    }

    function redeem(uint256 shares, address recipient) external nonReentrant returns (uint256 amountNusd) {
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();
        if (shares == 0 || shares > balanceOf(msg.sender)) revert InvalidAmount();
        _accrueInterest();

        amountNusd = Math.mulDiv(shares, _totalAssetsAtIndex(borrowIndexWad), totalSupply());
        if (amountNusd == 0) revert InvalidAmount();
        if (amountNusd > nusd.balanceOf(address(this))) revert InsufficientLiquidity();

        _burn(msg.sender, shares);
        _pushExact(nusd, recipient, amountNusd);
        emit Withdrawn(msg.sender, recipient, amountNusd, shares);
    }

    function depositCollateral(address asset, uint256 amount, address onBehalfOf) external nonReentrant {
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

    function borrow(uint256 amountNusd, address recipient) external nonReentrant returns (uint256 debtSharesMinted) {
        if (borrowPaused) revert BorrowPaused();
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();
        if (amountNusd == 0) revert InvalidAmount();
        if (badDebtNusdByAccount[msg.sender] != 0) revert AccountHasBadDebt();

        _accrueInterest();
        if (amountNusd > nusd.balanceOf(address(this))) revert InsufficientLiquidity();

        debtSharesMinted = _mulDivUp(amountNusd, WAD, borrowIndexWad);
        uint256 accountSharesAfter = debtSharesOf[msg.sender] + debtSharesMinted;
        uint256 totalSharesAfter = totalDebtShares + debtSharesMinted;
        uint256 accountDebtAfter = _debtAtShares(accountSharesAfter, borrowIndexWad);
        uint256 totalDebtAfter = _debtAtShares(totalSharesAfter, borrowIndexWad);
        if (_borrowExposureExceedsCap(totalDebtAfter, borrowCapNusd)) revert BorrowCapExceeded();

        (, uint256 borrowingCapacity,,) = _accountCollateralValues(msg.sender);
        if (accountDebtAfter > borrowingCapacity) revert InsufficientCollateral();

        debtSharesOf[msg.sender] = accountSharesAfter;
        totalDebtShares = totalSharesAfter;
        _pushExact(nusd, recipient, amountNusd);
        emit Borrowed(msg.sender, recipient, amountNusd, debtSharesMinted);
    }

    function repay(uint256 maximumAmountNusd, address onBehalfOf)
        external
        nonReentrant
        returns (uint256 amountRepaidNusd)
    {
        if (onBehalfOf == address(0)) revert InvalidRecipient();
        if (maximumAmountNusd == 0) revert InvalidAmount();
        _accrueInterest();

        (uint256 debtSharesBurned, uint256 amountRepaid) = _debtBurnQuote(onBehalfOf, maximumAmountNusd);
        debtSharesOf[onBehalfOf] -= debtSharesBurned;
        totalDebtShares -= debtSharesBurned;
        _pullExact(nusd, msg.sender, amountRepaid);
        emit Repaid(msg.sender, onBehalfOf, amountRepaid, debtSharesBurned);
        return amountRepaid;
    }

    function liquidate(
        address account,
        address collateralAsset,
        uint256 maximumRepayNusd,
        uint256 minimumCollateralOut,
        address recipient
    ) external nonReentrant returns (uint256 amountRepaidNusd, uint256 collateralOut) {
        if (account == address(0) || recipient == address(0) || recipient == address(this)) {
            revert InvalidRecipient();
        }
        if (maximumRepayNusd == 0) revert InvalidAmount();
        if (!_knownCollateral[collateralAsset]) revert UnsupportedCollateral();
        _accrueInterest();

        (,,, uint256 liquidationCapacity) = _accountCollateralValues(account);
        uint256 accountDebt = _debtAtShares(debtSharesOf[account], borrowIndexWad);
        if (accountDebt == 0 || accountDebt < liquidationCapacity) revert PositionHealthy();

        LiquidationQuote memory quote = _liquidationQuote(account, collateralAsset, maximumRepayNusd, accountDebt);
        if (quote.collateralOut < minimumCollateralOut) revert SlippageExceeded();

        debtSharesOf[account] -= quote.debtSharesToBurn;
        totalDebtShares -= quote.debtSharesToBurn;
        collateralBalance[account][collateralAsset] -= quote.collateralOut;
        totalCollateralByAsset[collateralAsset] -= quote.collateralOut;

        _pullExact(nusd, msg.sender, quote.amountRepaidNusd);
        _pushExact(IERC20(collateralAsset), recipient, quote.collateralOut);

        if (!_hasAnyCollateral(account) && debtSharesOf[account] != 0) {
            uint256 badDebt = _debtAtShares(debtSharesOf[account], borrowIndexWad);
            totalDebtShares -= debtSharesOf[account];
            debtSharesOf[account] = 0;
            badDebtNusdByAccount[account] += badDebt;
            totalBadDebtNusd += badDebt;
            cumulativeBadDebtNusd += badDebt;
            _writeOffProtocolInterest(account, badDebt);
            emit BadDebtRecognized(account, badDebt);
        }

        amountRepaidNusd = quote.amountRepaidNusd;
        collateralOut = quote.collateralOut;
        emit Liquidated(msg.sender, account, collateralAsset, amountRepaidNusd, collateralOut, recipient);
    }

    function repayBadDebt(address account, uint256 maximumAmountNusd)
        external
        nonReentrant
        returns (uint256 amountRepaidNusd)
    {
        uint256 badDebt = badDebtNusdByAccount[account];
        if (badDebt == 0 || maximumAmountNusd == 0) revert InvalidAmount();
        amountRepaidNusd = _min(badDebt, maximumAmountNusd);
        badDebtNusdByAccount[account] = badDebt - amountRepaidNusd;
        totalBadDebtNusd -= amountRepaidNusd;
        uint256 protocolRestored = _min(protocolInterestWrittenOffByAccount[account], amountRepaidNusd);
        if (protocolRestored != 0) {
            protocolInterestWrittenOffByAccount[account] -= protocolRestored;
            accruedProtocolInterestNusd += protocolRestored;
            emit ProtocolInterestRestored(account, protocolRestored, accruedProtocolInterestNusd);
        }
        _pullExact(nusd, msg.sender, amountRepaidNusd);
        emit BadDebtRepaid(msg.sender, account, amountRepaidNusd);
    }

    function totalBorrowed() public view returns (uint256) {
        (uint256 previewIndex,) = _previewAccrual();
        return _debtAtShares(totalDebtShares, previewIndex);
    }

    function protocolInterestNusd() public view returns (uint256) {
        (, uint256 previewProtocolInterest) = _previewAccrual();
        return previewProtocolInterest;
    }

    function totalSupplied() external view returns (uint256) {
        return totalAssetsNusd();
    }

    function totalAssetsNusd() public view returns (uint256) {
        (uint256 previewIndex, uint256 previewProtocolInterest) = _previewAccrual();
        uint256 grossAssets = nusd.balanceOf(address(this)) + _debtAtShares(totalDebtShares, previewIndex);
        if (previewProtocolInterest > grossAssets) revert InsolventPool();
        return grossAssets - previewProtocolInterest;
    }

    function availableLiquidity() external view returns (uint256) {
        return nusd.balanceOf(address(this));
    }

    function debtBalance(address account) public view returns (uint256) {
        (uint256 previewIndex,) = _previewAccrual();
        return _debtAtShares(debtSharesOf[account], previewIndex);
    }

    function supplyBalance(address account) public view returns (uint256) {
        uint256 shareSupply = totalSupply();
        if (shareSupply == 0) return 0;
        return Math.mulDiv(balanceOf(account), totalAssetsNusd(), shareSupply);
    }

    function maxWithdraw(address account) external view returns (uint256) {
        return _min(supplyBalance(account), nusd.balanceOf(address(this)));
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
        returns (uint256 borrowingCapacityNusd, uint256 liquidationCapacityNusd, uint256 debtNusd)
    {
        (, borrowingCapacityNusd,, liquidationCapacityNusd) = _accountCollateralValues(account);
        debtNusd = debtBalance(account);
    }

    function accountRisk(address account)
        external
        view
        returns (
            uint256 collateralValueNusd,
            uint256 borrowingCapacityNusd,
            uint256 marginCallCapacityNusd,
            uint256 liquidationCapacityNusd,
            uint256 debtNusd,
            uint256 currentLtvBps
        )
    {
        (collateralValueNusd, borrowingCapacityNusd, marginCallCapacityNusd, liquidationCapacityNusd) =
            _accountCollateralValues(account);
        debtNusd = debtBalance(account);
        currentLtvBps = collateralValueNusd == 0 ? 0 : _mulDivUp(debtNusd, BPS_DENOMINATOR, collateralValueNusd);
    }

    function maxBorrow(address account) external view returns (uint256 amountNusd) {
        if (borrowPaused || badDebtNusdByAccount[account] != 0) return 0;
        (uint256 previewIndex,) = _previewAccrual();
        (, uint256 borrowingCapacity,,) = _accountCollateralValues(account);
        uint256 accountDebt = _debtAtShares(debtSharesOf[account], previewIndex);
        if (accountDebt >= borrowingCapacity) return 0;

        uint256 totalDebt = _debtAtShares(totalDebtShares, previewIndex);
        if (totalBadDebtNusd >= borrowCapNusd || totalDebt >= borrowCapNusd - totalBadDebtNusd) return 0;
        amountNusd = _min(
            nusd.balanceOf(address(this)),
            _min(borrowingCapacity - accountDebt, borrowCapNusd - totalBadDebtNusd - totalDebt)
        );
        // Debt shares round upward, so leave one wei of headroom for a quote used by a later transaction.
        return amountNusd > 1 ? amountNusd - 1 : 0;
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
        uint256 currentContribution = Math.mulDiv(
            Math.mulDiv(balance, priceWad, scale), config.loanToValueBps, BPS_DENOMINATOR
        );
        amount = Math.mulDiv(
            borrowingCapacity - debt,
            scale * BPS_DENOMINATOR,
            priceWad * uint256(config.loanToValueBps)
        );
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
        uint256 supplierAssets = totalAssetsNusd();
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

    function _liquidationQuote(address account, address collateralAsset, uint256 maximumRepayNusd, uint256 accountDebt)
        internal
        view
        returns (LiquidationQuote memory quote)
    {
        CollateralConfig storage config = collateralConfigs[collateralAsset];
        uint256 availableCollateral = collateralBalance[account][collateralAsset];
        if (availableCollateral == 0) revert InsufficientCollateral();

        (uint256 priceWad,,) = IPriceOracle(config.oracle).readPriceWad();
        uint256 closeLimit = Math.mulDiv(accountDebt, CLOSE_FACTOR_BPS, BPS_DENOMINATOR);
        if (closeLimit == 0) closeLimit = accountDebt;
        uint256 repaymentBudget = _min(maximumRepayNusd, closeLimit);

        uint256 collateralValueNusd = Math.mulDiv(availableCollateral, priceWad, 10 ** config.decimals);
        uint256 collateralRepaymentLimit =
            Math.mulDiv(collateralValueNusd, BPS_DENOMINATOR, BPS_DENOMINATOR + config.liquidationBonusBps);
        repaymentBudget = _min(repaymentBudget, collateralRepaymentLimit);
        if (repaymentBudget == 0) revert InsufficientCollateral();

        (quote.debtSharesToBurn, quote.amountRepaidNusd) = _debtBurnQuote(account, repaymentBudget);
        uint256 baseCollateral = _mulDivUp(quote.amountRepaidNusd, 10 ** config.decimals, priceWad);
        quote.collateralOut = _mulDivUp(baseCollateral, BPS_DENOMINATOR + config.liquidationBonusBps, BPS_DENOMINATOR);
        if (quote.collateralOut > availableCollateral) quote.collateralOut = availableCollateral;
    }

    function _debtBurnQuote(address account, uint256 maximumAmountNusd)
        internal
        view
        returns (uint256 sharesToBurn, uint256 amountRepaidNusd)
    {
        uint256 accountShares = debtSharesOf[account];
        if (accountShares == 0) revert InvalidAmount();
        uint256 fullDebt = _debtAtShares(accountShares, borrowIndexWad);
        if (maximumAmountNusd >= fullDebt) return (accountShares, fullDebt);

        sharesToBurn = Math.mulDiv(maximumAmountNusd, WAD, borrowIndexWad);
        if (sharesToBurn == 0) revert InvalidAmount();
        amountRepaidNusd = _debtAtShares(sharesToBurn, borrowIndexWad);
        if (amountRepaidNusd > maximumAmountNusd) {
            sharesToBurn -= 1;
            if (sharesToBurn == 0) revert InvalidAmount();
            amountRepaidNusd = _debtAtShares(sharesToBurn, borrowIndexWad);
        }
    }

    function _accountCollateralValues(address account)
        internal
        view
        returns (
            uint256 collateralValueNusd,
            uint256 borrowingCapacityNusd,
            uint256 marginCallCapacityNusd,
            uint256 liquidationCapacityNusd
        )
    {
        uint256 length = _collateralAssets.length;
        for (uint256 i; i < length; ++i) {
            address asset = _collateralAssets[i];
            uint256 amount = collateralBalance[account][asset];
            if (amount == 0) continue;

            CollateralConfig storage config = collateralConfigs[asset];
            (uint256 priceWad,,) = IPriceOracle(config.oracle).readPriceWad();
            uint256 assetValueNusd = Math.mulDiv(amount, priceWad, 10 ** config.decimals);
            collateralValueNusd += assetValueNusd;
            if (config.enabled) {
                borrowingCapacityNusd += Math.mulDiv(assetValueNusd, config.loanToValueBps, BPS_DENOMINATOR);
            }
            marginCallCapacityNusd +=
                Math.mulDiv(assetValueNusd, config.marginCallThresholdBps, BPS_DENOMINATOR);
            liquidationCapacityNusd +=
                Math.mulDiv(assetValueNusd, config.liquidationThresholdBps, BPS_DENOMINATOR);
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
        uint256 previousProtocolInterest = accruedProtocolInterestNusd;
        uint256 currentTimestamp = block.timestamp;
        uint256 elapsed = currentTimestamp - lastAccrualTimestamp;
        if (elapsed == 0) return;

        (uint256 nextIndex, uint256 nextProtocolInterest) = _previewAccrual();
        borrowIndexWad = nextIndex;
        accruedProtocolInterestNusd = nextProtocolInterest;
        lastAccrualTimestamp = currentTimestamp;
        emit InterestAccrued(previousIndex, nextIndex, elapsed);
        if (nextProtocolInterest != previousProtocolInterest) {
            emit ProtocolInterestAccrued(
                nextProtocolInterest - previousProtocolInterest, nextProtocolInterest
            );
        }
    }

    function _previewAccrual() internal view returns (uint256 nextIndex, uint256 nextProtocolInterest) {
        nextIndex = borrowIndexWad;
        nextProtocolInterest = accruedProtocolInterestNusd;
        uint256 elapsed = block.timestamp - lastAccrualTimestamp;
        if (elapsed == 0 || totalDebtShares == 0) return (nextIndex, nextProtocolInterest);

        uint256 previousDebt = _debtAtShares(totalDebtShares, nextIndex);
        uint256 indexIncrease =
            Math.mulDiv(nextIndex, BORROW_APR_BPS * elapsed, BPS_DENOMINATOR * SECONDS_PER_YEAR);
        nextIndex += indexIncrease;
        uint256 grossInterestNusd = _debtAtShares(totalDebtShares, nextIndex) - previousDebt;
        nextProtocolInterest += Math.mulDiv(grossInterestNusd, PROTOCOL_APR_BPS, BORROW_APR_BPS);
    }

    function _utilizationWad(uint256 borrowed, uint256 supplierAssets) internal pure returns (uint256) {
        if (borrowed == 0 || supplierAssets == 0) return 0;
        if (borrowed >= supplierAssets) return WAD;
        return Math.mulDiv(borrowed, WAD, supplierAssets);
    }

    function _totalAssetsAtIndex(uint256 indexWad) internal view returns (uint256) {
        uint256 grossAssets = nusd.balanceOf(address(this)) + _debtAtShares(totalDebtShares, indexWad);
        if (accruedProtocolInterestNusd > grossAssets) revert InsolventPool();
        return grossAssets - accruedProtocolInterestNusd;
    }

    function _debtAtShares(uint256 shares, uint256 indexWad) internal pure returns (uint256) {
        if (shares == 0) return 0;
        return _mulDivUp(shares, indexWad, WAD);
    }

    function _borrowExposureExceedsCap(uint256 activeDebtNusd, uint256 capNusd) internal view returns (bool) {
        return activeDebtNusd > capNusd || totalBadDebtNusd > capNusd - activeDebtNusd;
    }

    function _writeOffProtocolInterest(address account, uint256 badDebtNusd) internal {
        uint256 amountWrittenOff = _min(accruedProtocolInterestNusd, badDebtNusd);
        if (amountWrittenOff == 0) return;
        accruedProtocolInterestNusd -= amountWrittenOff;
        protocolInterestWrittenOffByAccount[account] += amountWrittenOff;
        emit ProtocolInterestWrittenOff(amountWrittenOff, accruedProtocolInterestNusd);
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
