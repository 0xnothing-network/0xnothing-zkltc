// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Clones} from "../common/Clones.sol";
import {IERC20Minimal, SafeTransferLib} from "../common/SafeTransferLib.sol";
import {MathX} from "../common/MathX.sol";
import {ReentrancyGuard} from "../common/ReentrancyGuard.sol";
import {TwoStepAdmin} from "../common/TwoStepAdmin.sol";
import {IGraduationAdapter} from "../graduation/interfaces/IGraduationAdapter.sol";
import {IGraduationRouter} from "../graduation/interfaces/IGraduationRouter.sol";
import {PumpToken} from "./PumpToken.sol";

interface IFeeSplitter {
    function distribute() external returns (uint256 amountNusd);
}

/// @title 0xPump
/// @notice Bonding-curve launchpad. Every protocol fee goes to the fee splitter by a permissionless
///         call, and selling stays open while paused.
///         Each market keeps the parameters it was created with (trade fee, curve, graduation
///         target): the parameter admin can tune them, within bounds, for markets created later
///         only, so a change never touches a market that already exists.
contract ZeroXPumpV2 is TwoStepAdmin, ReentrancyGuard {
    using Clones for address;

    error InvalidConfiguration();
    error InvalidMetadata();
    error MarketNotFound();
    error MarketNotTrading();
    error MarketNotReady();
    error DeadlineExpired();
    error InvalidAmount();
    error SlippageExceeded();
    error ContractPaused();
    error AssetTransferMismatch();
    error InsufficientProtocolFees();
    error InvalidCommitment();
    error InvalidReservation();

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant WAD = 1e18;
    /// @notice Bounds on what the parameter admin may set for new markets.
    uint256 public constant MAX_TRADE_FEE_BPS = 100;
    uint256 public constant MAX_CREATE_FEE_NUSD = 100e18;
    uint256 public constant MAX_NAME_LENGTH = 64;
    uint256 public constant MAX_SYMBOL_LENGTH = 16;
    uint256 public constant MAX_URI_LENGTH = 200;

    enum Lifecycle {
        NONE,
        TRADING,
        READY,
        GRADUATED
    }

    struct Market {
        address creator;
        uint256 tokenReserve;
        uint256 realNusdReserve;
        uint256 virtualTokenReserve;
        uint256 virtualNusdReserve;
        uint256 totalNusdVolume;
        uint64 createdAt;
        Lifecycle lifecycle;
        address dex;
        bytes32 dexPairId;
        address pool;
    }

    /// @notice The terms a market was created with; they never change afterwards.
    struct MarketParams {
        uint16 tradeFeeBps;
        /// @dev Fully diluted market-cap target, in 18-decimal NUSD.
        uint120 graduationThresholdNusd;
        /// @dev Real NUSD reserve at which the curve reaches the market-cap target.
        uint120 graduationReserveThresholdNusd;
    }

    address public immutable NUSD;
    /// @notice Receives every protocol fee (creation fees and trade fees).
    address public immutable feeRecipient;
    address public immutable vault;
    IGraduationRouter public immutable graduationRouter;
    address public immutable tokenImplementation;
    uint256 public immutable tokenTotalSupply;
    uint256 public immutable initialVirtualTokenReserve;

    /// @notice Tunes the terms of future markets; separate from `admin`, the graduation controller.
    address public paramAdmin;
    address public pendingParamAdmin;

    // Terms for the next market created.
    uint128 public createFee;
    uint128 public initialVirtualNusdReserve;
    MarketParams private _nextParams;

    mapping(address => Market) public markets;
    mapping(address => MarketParams) public marketParams;
    /// @dev Creation fee paid for a reservation, plus one (zero means no reservation).
    mapping(address => mapping(bytes32 => uint256)) private _reservations;
    mapping(address => mapping(bytes32 => address)) public createdTokenByContentHash;
    mapping(address => address[]) private _tokensByCreator;
    address[] private _allTokens;

    uint256 public accruedProtocolFeesNusd;
    uint256 public totalRealNusdReserves;
    bool public paused;

    event TokenCreated(
        address indexed token,
        address indexed creator,
        bytes32 indexed contentHash,
        string name,
        string symbol,
        string metadataURI,
        string imageURI,
        uint256 totalSupply,
        uint256 curveTokenSupply,
        uint256 virtualNusdReserve,
        uint256 virtualTokenReserve,
        uint256 graduationThresholdNusd,
        uint256 graduationReserveThresholdNusd,
        uint256 creationFeeNusd
    );
    event CreationFeePaid(address indexed owner, bytes32 indexed contentHash, uint256 creationFeeNusd);
    event TokenTraded(
        address indexed token,
        address indexed trader,
        bool indexed isBuy,
        uint256 tokenAmount,
        uint256 curveNusdAmount,
        uint256 userNusdAmount,
        uint256 feeNusd,
        uint256 realNusdReserveAfter,
        uint256 tokenReserveAfter,
        uint256 virtualNusdReserveAfter,
        uint256 virtualTokenReserveAfter,
        uint256 circulatingSupplyAfter,
        uint256 spotPriceNusdWad,
        uint256 curveProgressBps
    );
    event TokenReadyForGraduation(
        address indexed token, uint256 realNusdReserve, uint256 tokenReserve, uint256 thresholdNusd
    );
    event TokenCurveReopened(address indexed token, uint256 realNusdReserve, uint256 tokenReserve);
    event TokenGraduated(
        address indexed token,
        address indexed dex,
        bytes32 indexed pairId,
        address pool,
        uint256 nusdLiquidity,
        uint256 tokenLiquidity,
        uint256 lpAmount,
        address lpRecipient
    );
    event ProtocolFeesDistributed(address indexed caller, address indexed recipient, uint256 amountNusd);
    event PauseUpdated(bool paused);
    event MarketParamsUpdated(
        uint256 createFee,
        uint256 tradeFeeBps,
        uint256 virtualNusdReserve,
        uint256 graduationThresholdNusd,
        uint256 graduationReserveThresholdNusd
    );
    event ParamAdminTransferStarted(address indexed currentAdmin, address indexed pendingAdmin);
    event ParamAdminTransferred(address indexed previousAdmin, address indexed newAdmin);

    constructor(
        address nusdAddress,
        address nusdVault,
        address router,
        address protocolFeeRecipient,
        address initialAdmin,
        address initialParamAdmin,
        uint256 totalSupply,
        uint256 virtualNusdReserve,
        uint256 graduationMarketCapNusd,
        uint256 initialCreateFeeNusd,
        uint256 initialTradeFeeBps
    ) TwoStepAdmin(initialAdmin) {
        if (
            nusdAddress.code.length == 0 || nusdVault.code.length == 0 || router.code.length == 0
                || totalSupply == 0 || protocolFeeRecipient == address(0) || initialParamAdmin == address(0)
        ) revert InvalidConfiguration();

        NUSD = nusdAddress;
        feeRecipient = protocolFeeRecipient;
        vault = nusdVault;
        graduationRouter = IGraduationRouter(router);
        tokenTotalSupply = totalSupply;
        initialVirtualTokenReserve = totalSupply;
        tokenImplementation = address(new PumpToken());
        paramAdmin = initialParamAdmin;
        emit ParamAdminTransferred(address(0), initialParamAdmin);
        _setMarketParams(
            totalSupply, initialCreateFeeNusd, initialTradeFeeBps, virtualNusdReserve, graduationMarketCapNusd
        );
    }

    function reserveMarket(bytes32 contentHash) external nonReentrant {
        if (paused) revert ContractPaused();
        if (contentHash == bytes32(0)) revert InvalidCommitment();
        if (
            _reservations[msg.sender][contentHash] != 0
                || createdTokenByContentHash[msg.sender][contentHash] != address(0)
        ) revert InvalidReservation();

        uint256 fee = createFee;
        if (fee != 0) {
            _pullExactNusd(msg.sender, fee);
            accruedProtocolFeesNusd += fee;
        }
        _reservations[msg.sender][contentHash] = fee + 1;
        emit CreationFeePaid(msg.sender, contentHash, fee);
    }

    function createMarket(
        string calldata name,
        string calldata symbol,
        string calldata metadataURI,
        string calldata imageURI,
        bytes32 contentHash
    ) external nonReentrant returns (address token) {
        if (paused) revert ContractPaused();
        _validateMetadata(name, symbol, metadataURI, imageURI);
        if (contentHash == bytes32(0)) revert InvalidCommitment();
        uint256 reservation = _reservations[msg.sender][contentHash];
        if (reservation == 0 || createdTokenByContentHash[msg.sender][contentHash] != address(0)) {
            revert InvalidReservation();
        }
        _reservations[msg.sender][contentHash] = 0;

        token = tokenImplementation.clone();
        PumpToken(token).initialize(name, symbol, metadataURI, imageURI, tokenTotalSupply, address(this));

        MarketParams memory params = _nextParams;
        uint256 virtualNusdReserve = initialVirtualNusdReserve;
        markets[token] = Market({
            creator: msg.sender,
            tokenReserve: tokenTotalSupply,
            realNusdReserve: 0,
            virtualTokenReserve: initialVirtualTokenReserve,
            virtualNusdReserve: virtualNusdReserve,
            totalNusdVolume: 0,
            createdAt: uint64(block.timestamp),
            lifecycle: Lifecycle.TRADING,
            dex: address(0),
            dexPairId: bytes32(0),
            pool: address(0)
        });
        marketParams[token] = params;
        _allTokens.push(token);
        _tokensByCreator[msg.sender].push(token);
        createdTokenByContentHash[msg.sender][contentHash] = token;

        emit TokenCreated(
            token,
            msg.sender,
            contentHash,
            name,
            symbol,
            metadataURI,
            imageURI,
            tokenTotalSupply,
            tokenTotalSupply,
            virtualNusdReserve,
            initialVirtualTokenReserve,
            params.graduationThresholdNusd,
            params.graduationReserveThresholdNusd,
            reservation - 1
        );
    }

    function buy(address token, uint256 maxNusdIn, uint256 minTokenOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 tokenOut, uint256 userNusdAmount)
    {
        if (paused) revert ContractPaused();
        if (block.timestamp > deadline) revert DeadlineExpired();
        Market storage market = _tradingMarket(token);
        MarketParams memory params = marketParams[token];

        uint256 curveNusdAmount;
        uint256 feeNusd;
        bool readyAfter;
        (tokenOut, curveNusdAmount, userNusdAmount, feeNusd, readyAfter) = _quoteBuy(market, params, maxNusdIn);
        if (tokenOut == 0 || curveNusdAmount == 0) revert InvalidAmount();
        if (tokenOut < minTokenOut) revert SlippageExceeded();

        _pullExactNusd(msg.sender, userNusdAmount);
        market.realNusdReserve += curveNusdAmount;
        market.virtualNusdReserve += curveNusdAmount;
        market.tokenReserve -= tokenOut;
        market.virtualTokenReserve -= tokenOut;
        market.totalNusdVolume += curveNusdAmount;
        totalRealNusdReserves += curveNusdAmount;
        accruedProtocolFeesNusd += feeNusd;

        SafeTransferLib.safeTransfer(token, msg.sender, tokenOut);
        _emitTrade(token, msg.sender, true, tokenOut, curveNusdAmount, userNusdAmount, feeNusd, market, params);

        if (readyAfter) {
            market.lifecycle = Lifecycle.READY;
            emit TokenReadyForGraduation(
                token, market.realNusdReserve, market.tokenReserve, params.graduationThresholdNusd
            );
        }
    }

    function sell(address token, uint256 tokenIn, uint256 minNusdOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 userNusdAmount)
    {
        // Selling back into the curve stays open while paused: a pause stops new exposure
        // (create/buy) but must never trap holders if the admin is absent.
        if (block.timestamp > deadline) revert DeadlineExpired();
        Market storage market = _sellableMarket(token);
        MarketParams memory params = marketParams[token];
        bool reopenCurve = market.lifecycle == Lifecycle.READY;

        uint256 curveNusdAmount;
        uint256 feeNusd;
        (curveNusdAmount, userNusdAmount, feeNusd) = _quoteSell(market, params, tokenIn);
        if (curveNusdAmount == 0 || userNusdAmount == 0) revert InvalidAmount();
        if (userNusdAmount < minNusdOut) revert SlippageExceeded();

        uint256 balanceBefore = IERC20Minimal(token).balanceOf(address(this));
        SafeTransferLib.safeTransferFrom(token, msg.sender, address(this), tokenIn);
        if (IERC20Minimal(token).balanceOf(address(this)) != balanceBefore + tokenIn) {
            revert AssetTransferMismatch();
        }

        market.tokenReserve += tokenIn;
        market.virtualTokenReserve += tokenIn;
        market.realNusdReserve -= curveNusdAmount;
        market.virtualNusdReserve -= curveNusdAmount;
        market.totalNusdVolume += curveNusdAmount;
        totalRealNusdReserves -= curveNusdAmount;
        accruedProtocolFeesNusd += feeNusd;
        if (reopenCurve) market.lifecycle = Lifecycle.TRADING;

        SafeTransferLib.safeTransfer(NUSD, msg.sender, userNusdAmount);
        _emitTrade(token, msg.sender, false, tokenIn, curveNusdAmount, userNusdAmount, feeNusd, market, params);
        if (reopenCurve) {
            emit TokenCurveReopened(token, market.realNusdReserve, market.tokenReserve);
        }
    }

    function graduate(address token, address adapter, uint256 minimumLp, uint256 deadline)
        external
        onlyAdmin
        nonReentrant
        returns (IGraduationAdapter.GraduationResult memory result)
    {
        if (block.timestamp > deadline) revert DeadlineExpired();
        Market storage market = _market(token);
        if (market.lifecycle != Lifecycle.READY) revert MarketNotReady();
        if (adapter == address(0) || minimumLp == 0) revert InvalidAmount();

        uint256 nusdLiquidity = market.realNusdReserve;
        uint256 priceWad = _spotPrice(market);
        uint256 tokenLiquidity = MathX.mulDiv(nusdLiquidity, WAD, priceWad);
        if (tokenLiquidity == 0 || tokenLiquidity > market.tokenReserve) revert InvalidConfiguration();

        uint256 tokensToBurn = market.tokenReserve - tokenLiquidity;
        if (tokensToBurn > 0) PumpToken(token).burn(tokensToBurn);

        market.tokenReserve = tokenLiquidity;
        market.realNusdReserve = 0;
        market.lifecycle = Lifecycle.GRADUATED;
        totalRealNusdReserves -= nusdLiquidity;

        SafeTransferLib.forceApprove(token, address(graduationRouter), tokenLiquidity);
        SafeTransferLib.forceApprove(NUSD, address(graduationRouter), nusdLiquidity);
        result = graduationRouter.executeGraduation(
            adapter, token, NUSD, tokenLiquidity, nusdLiquidity, minimumLp, deadline
        );
        SafeTransferLib.forceApprove(token, address(graduationRouter), 0);
        SafeTransferLib.forceApprove(NUSD, address(graduationRouter), 0);

        market.tokenReserve = 0;
        market.dex = result.dex;
        market.dexPairId = result.pairId;
        market.pool = result.pool;

        emit TokenGraduated(
            token,
            result.dex,
            result.pairId,
            result.pool,
            nusdLiquidity,
            tokenLiquidity,
            result.lpAmount,
            graduationRouter.lpRecipient()
        );
    }

    /// @notice Sends every accrued protocol fee to the fee splitter, which splits it in the same
    ///         call. Permissionless.
    function distributeFees() external nonReentrant returns (uint256 amountNusd) {
        amountNusd = accruedProtocolFeesNusd;
        if (amountNusd == 0) revert InsufficientProtocolFees();
        accruedProtocolFeesNusd = 0;
        SafeTransferLib.safeTransfer(NUSD, feeRecipient, amountNusd);
        IFeeSplitter(feeRecipient).distribute();
        emit ProtocolFeesDistributed(msg.sender, feeRecipient, amountNusd);
    }

    function setPaused(bool newPaused) external onlyAdmin {
        paused = newPaused;
        emit PauseUpdated(newPaused);
    }

    // ---------------------------------------------------------------- parameter admin

    /// @notice Terms for markets created from now on. Existing markets keep their own.
    function setMarketParams(
        uint256 newCreateFeeNusd,
        uint256 newTradeFeeBps,
        uint256 virtualNusdReserve,
        uint256 graduationMarketCapNusd
    ) external {
        if (msg.sender != paramAdmin) revert Unauthorized();
        _setMarketParams(
            tokenTotalSupply, newCreateFeeNusd, newTradeFeeBps, virtualNusdReserve, graduationMarketCapNusd
        );
    }

    function transferParamAdmin(address newParamAdmin) external {
        if (msg.sender != paramAdmin) revert Unauthorized();
        if (newParamAdmin == address(0)) revert ZeroAddress();
        pendingParamAdmin = newParamAdmin;
        emit ParamAdminTransferStarted(msg.sender, newParamAdmin);
    }

    function acceptParamAdmin() external {
        if (msg.sender != pendingParamAdmin) revert Unauthorized();
        address previous = paramAdmin;
        paramAdmin = msg.sender;
        pendingParamAdmin = address(0);
        emit ParamAdminTransferred(previous, msg.sender);
    }

    // ---------------------------------------------------------------- views

    function quoteBuy(address token, uint256 maxNusdIn)
        external
        view
        returns (uint256 tokenOut, uint256 curveNusdAmount, uint256 userNusdAmount, uint256 feeNusd, bool readyAfter)
    {
        return _quoteBuy(_tradingMarket(token), marketParams[token], maxNusdIn);
    }

    function quoteSell(address token, uint256 tokenIn)
        external
        view
        returns (uint256 curveNusdAmount, uint256 userNusdAmount, uint256 feeNusd)
    {
        return _quoteSell(_sellableMarket(token), marketParams[token], tokenIn);
    }

    /// @notice Whether `owner` has paid for a creation slot under `contentHash` that is still unused.
    function creationReservations(address owner, bytes32 contentHash) external view returns (bool) {
        return _reservations[owner][contentHash] != 0;
    }

    function status(address token) external view returns (uint8) {
        return uint8(_market(token).lifecycle);
    }

    function spotPriceNusdWad(address token) public view returns (uint256) {
        return _spotPrice(_market(token));
    }

    function curveProgressBps(address token) public view returns (uint256) {
        Market storage market = _market(token);
        if (market.lifecycle == Lifecycle.GRADUATED) return BPS_DENOMINATOR;
        return _progressBps(market, marketParams[token]);
    }

    /// @notice Trade fee for markets created from now on; a market's own fee is in `marketParams`.
    function tradeFeeBps() external view returns (uint256) {
        return _nextParams.tradeFeeBps;
    }

    /// @notice Market-cap target for markets created from now on.
    function graduationThresholdNusd() external view returns (uint256) {
        return _nextParams.graduationThresholdNusd;
    }

    /// @notice Reserve target for markets created from now on.
    function graduationReserveThresholdNusd() external view returns (uint256) {
        return _nextParams.graduationReserveThresholdNusd;
    }

    function nusd() external view returns (address) {
        return NUSD;
    }

    function totalMarkets() external view returns (uint256) {
        return _allTokens.length;
    }

    function getAllTokens() external view returns (address[] memory) {
        return _allTokens;
    }

    function getTokensByCreator(address creator) external view returns (address[] memory) {
        return _tokensByCreator[creator];
    }

    function accountedNusdBalance() external view returns (uint256) {
        return totalRealNusdReserves + accruedProtocolFeesNusd;
    }

    // ---------------------------------------------------------------- internals

    /// @dev Applies the constructor's curve checks to every future set of terms, so no admin
    ///      setting can produce a curve that cannot graduate.
    function _setMarketParams(
        uint256 totalSupply,
        uint256 newCreateFeeNusd,
        uint256 newTradeFeeBps,
        uint256 virtualNusdReserve,
        uint256 graduationMarketCapNusd
    ) private {
        if (
            newCreateFeeNusd > MAX_CREATE_FEE_NUSD || newTradeFeeBps > MAX_TRADE_FEE_BPS || virtualNusdReserve == 0
                || virtualNusdReserve > type(uint120).max || graduationMarketCapNusd <= virtualNusdReserve
                || graduationMarketCapNusd > type(uint120).max
        ) revert InvalidConfiguration();
        if (MathX.mulDiv(virtualNusdReserve, WAD, totalSupply) == 0) revert InvalidConfiguration();

        uint256 reserveThresholdNusd = MathX.sqrtUp(virtualNusdReserve * graduationMarketCapNusd) - virtualNusdReserve;
        if (reserveThresholdNusd == 0) revert InvalidConfiguration();

        uint256 terminalVirtualNusd = virtualNusdReserve + reserveThresholdNusd;
        uint256 terminalTokenReserve =
            totalSupply - MathX.mulDiv(reserveThresholdNusd, totalSupply, terminalVirtualNusd);
        if (terminalTokenReserve == 0) revert InvalidConfiguration();
        uint256 terminalSpotPrice = MathX.mulDiv(terminalVirtualNusd, WAD, terminalTokenReserve);
        if (terminalSpotPrice == 0) revert InvalidConfiguration();
        if (MathX.mulDiv(terminalSpotPrice, totalSupply, WAD) < graduationMarketCapNusd) {
            revert InvalidConfiguration();
        }
        uint256 terminalTokenLiquidity = MathX.mulDiv(reserveThresholdNusd, WAD, terminalSpotPrice);
        if (terminalTokenLiquidity == 0 || terminalTokenLiquidity > terminalTokenReserve) {
            revert InvalidConfiguration();
        }

        // Every value was bounds-checked above.
        // forge-lint: disable-next-line(unsafe-typecast)
        createFee = uint128(newCreateFeeNusd);
        // forge-lint: disable-next-line(unsafe-typecast)
        initialVirtualNusdReserve = uint128(virtualNusdReserve);
        _nextParams = MarketParams({
            // forge-lint: disable-next-line(unsafe-typecast)
            tradeFeeBps: uint16(newTradeFeeBps),
            // forge-lint: disable-next-line(unsafe-typecast)
            graduationThresholdNusd: uint120(graduationMarketCapNusd),
            // forge-lint: disable-next-line(unsafe-typecast)
            graduationReserveThresholdNusd: uint120(reserveThresholdNusd)
        });
        emit MarketParamsUpdated(
            newCreateFeeNusd, newTradeFeeBps, virtualNusdReserve, graduationMarketCapNusd, reserveThresholdNusd
        );
    }

    function _quoteBuy(Market storage market, MarketParams memory params, uint256 maxNusdIn)
        internal
        view
        returns (uint256 tokenOut, uint256 curveNusdAmount, uint256 userNusdAmount, uint256 feeNusd, bool readyAfter)
    {
        if (maxNusdIn == 0) return (0, 0, 0, 0, false);
        uint256 reserveThreshold = params.graduationReserveThresholdNusd;
        uint256 remainingNusd = reserveThreshold - market.realNusdReserve;
        uint256 maximumGross = ((remainingNusd * BPS_DENOMINATOR) - 1) / (BPS_DENOMINATOR - params.tradeFeeBps);
        userNusdAmount = MathX.min(maxNusdIn, maximumGross);
        feeNusd = MathX.mulDiv(userNusdAmount, params.tradeFeeBps, BPS_DENOMINATOR);
        curveNusdAmount = userNusdAmount - feeNusd;
        if (curveNusdAmount == 0) return (0, 0, 0, 0, false);

        tokenOut =
            MathX.mulDiv(curveNusdAmount, market.virtualTokenReserve, market.virtualNusdReserve + curveNusdAmount);
        if (tokenOut > market.tokenReserve) tokenOut = market.tokenReserve;
        readyAfter = market.realNusdReserve + curveNusdAmount >= reserveThreshold;
    }

    function _quoteSell(Market storage market, MarketParams memory params, uint256 tokenIn)
        internal
        view
        returns (uint256 curveNusdAmount, uint256 userNusdAmount, uint256 feeNusd)
    {
        if (tokenIn == 0) return (0, 0, 0);
        curveNusdAmount = MathX.mulDiv(tokenIn, market.virtualNusdReserve, market.virtualTokenReserve + tokenIn);
        if (curveNusdAmount > market.realNusdReserve) curveNusdAmount = market.realNusdReserve;
        feeNusd = MathX.mulDiv(curveNusdAmount, params.tradeFeeBps, BPS_DENOMINATOR);
        userNusdAmount = curveNusdAmount - feeNusd;
    }

    function _emitTrade(
        address token,
        address trader,
        bool isBuy,
        uint256 tokenAmount,
        uint256 curveNusdAmount,
        uint256 userNusdAmount,
        uint256 feeNusd,
        Market storage market,
        MarketParams memory params
    ) internal {
        emit TokenTraded(
            token,
            trader,
            isBuy,
            tokenAmount,
            curveNusdAmount,
            userNusdAmount,
            feeNusd,
            market.realNusdReserve,
            market.tokenReserve,
            market.virtualNusdReserve,
            market.virtualTokenReserve,
            tokenTotalSupply - market.tokenReserve,
            _spotPrice(market),
            _progressBps(market, params)
        );
    }

    function _progressBps(Market storage market, MarketParams memory params) internal view returns (uint256) {
        return MathX.min(
            BPS_DENOMINATOR,
            MathX.mulDiv(market.realNusdReserve, BPS_DENOMINATOR, params.graduationReserveThresholdNusd)
        );
    }

    function _spotPrice(Market storage market) internal view returns (uint256) {
        return MathX.mulDiv(market.virtualNusdReserve, WAD, market.virtualTokenReserve);
    }

    function _pullExactNusd(address from, uint256 amount) internal {
        uint256 balanceBefore = IERC20Minimal(NUSD).balanceOf(address(this));
        SafeTransferLib.safeTransferFrom(NUSD, from, address(this), amount);
        if (IERC20Minimal(NUSD).balanceOf(address(this)) != balanceBefore + amount) {
            revert AssetTransferMismatch();
        }
    }

    function _validateMetadata(
        string calldata name,
        string calldata symbol,
        string calldata metadataURI,
        string calldata imageURI
    ) internal pure {
        uint256 nameLength = bytes(name).length;
        uint256 symbolLength = bytes(symbol).length;
        if (
            nameLength == 0 || nameLength > MAX_NAME_LENGTH || symbolLength == 0 || symbolLength > MAX_SYMBOL_LENGTH
                || !_validIpfsUri(metadataURI) || !_validIpfsUri(imageURI)
        ) revert InvalidMetadata();
    }

    function _validIpfsUri(string calldata uri) internal pure returns (bool) {
        bytes calldata value = bytes(uri);
        if (value.length < 8 || value.length > MAX_URI_LENGTH) return false;
        return value[0] == "i" && value[1] == "p" && value[2] == "f" && value[3] == "s" && value[4] == ":"
            && value[5] == "/" && value[6] == "/";
    }

    function _market(address token) internal view returns (Market storage market) {
        market = markets[token];
        if (market.lifecycle == Lifecycle.NONE) revert MarketNotFound();
    }

    function _tradingMarket(address token) internal view returns (Market storage market) {
        market = _market(token);
        if (market.lifecycle != Lifecycle.TRADING) revert MarketNotTrading();
    }

    function _sellableMarket(address token) internal view returns (Market storage market) {
        market = _market(token);
        if (market.lifecycle != Lifecycle.TRADING && market.lifecycle != Lifecycle.READY) {
            revert MarketNotTrading();
        }
    }
}
