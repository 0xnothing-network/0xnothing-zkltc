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
    function distribute() external returns (uint256 amountN);
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
    uint256 public constant MAX_CREATE_FEE_N = 100e18;
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
        uint256 realNReserve;
        uint256 virtualTokenReserve;
        uint256 virtualNReserve;
        uint256 totalNVolume;
        uint64 createdAt;
        Lifecycle lifecycle;
        address dex;
        bytes32 dexPairId;
        address pool;
    }

    /// @notice The terms a market was created with; they never change afterwards.
    struct MarketParams {
        uint16 tradeFeeBps;
        /// @dev Fully diluted market-cap target, in 18-decimal N.
        uint120 graduationThresholdN;
        /// @dev Real N reserve at which the curve reaches the market-cap target.
        uint120 graduationReserveThresholdN;
    }

    address public immutable N;
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
    uint128 public initialVirtualNReserve;
    MarketParams private _nextParams;

    mapping(address => Market) public markets;
    mapping(address => MarketParams) public marketParams;
    /// @dev Creation fee paid for a reservation, plus one (zero means no reservation).
    mapping(address => mapping(bytes32 => uint256)) private _reservations;
    mapping(address => mapping(bytes32 => address)) public createdTokenByContentHash;
    mapping(address => address[]) private _tokensByCreator;
    address[] private _allTokens;

    uint256 public accruedProtocolFeesN;
    uint256 public totalRealNReserves;
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
        uint256 virtualNReserve,
        uint256 virtualTokenReserve,
        uint256 graduationThresholdN,
        uint256 graduationReserveThresholdN,
        uint256 creationFeeN
    );
    event CreationFeePaid(address indexed owner, bytes32 indexed contentHash, uint256 creationFeeN);
    event TokenTraded(
        address indexed token,
        address indexed trader,
        bool indexed isBuy,
        uint256 tokenAmount,
        uint256 curveNAmount,
        uint256 userNAmount,
        uint256 feeN,
        uint256 realNReserveAfter,
        uint256 tokenReserveAfter,
        uint256 virtualNReserveAfter,
        uint256 virtualTokenReserveAfter,
        uint256 circulatingSupplyAfter,
        uint256 spotPriceNWad,
        uint256 curveProgressBps
    );
    event TokenReadyForGraduation(
        address indexed token, uint256 realNReserve, uint256 tokenReserve, uint256 thresholdN
    );
    event TokenCurveReopened(address indexed token, uint256 realNReserve, uint256 tokenReserve);
    event TokenGraduated(
        address indexed token,
        address indexed dex,
        bytes32 indexed pairId,
        address pool,
        uint256 nLiquidity,
        uint256 tokenLiquidity,
        uint256 lpAmount,
        address lpRecipient
    );
    event ProtocolFeesDistributed(address indexed caller, address indexed recipient, uint256 amountN);
    event PauseUpdated(bool paused);
    event MarketParamsUpdated(
        uint256 createFee,
        uint256 tradeFeeBps,
        uint256 virtualNReserve,
        uint256 graduationThresholdN,
        uint256 graduationReserveThresholdN
    );
    event ParamAdminTransferStarted(address indexed currentAdmin, address indexed pendingAdmin);
    event ParamAdminTransferred(address indexed previousAdmin, address indexed newAdmin);

    constructor(
        address nAddress,
        address nVault,
        address router,
        address protocolFeeRecipient,
        address initialAdmin,
        address initialParamAdmin,
        uint256 totalSupply,
        uint256 virtualNReserve,
        uint256 graduationMarketCapN,
        uint256 initialCreateFeeN,
        uint256 initialTradeFeeBps
    ) TwoStepAdmin(initialAdmin) {
        if (
            nAddress.code.length == 0 || nVault.code.length == 0 || router.code.length == 0
                || totalSupply == 0 || protocolFeeRecipient == address(0) || initialParamAdmin == address(0)
        ) revert InvalidConfiguration();

        N = nAddress;
        feeRecipient = protocolFeeRecipient;
        vault = nVault;
        graduationRouter = IGraduationRouter(router);
        tokenTotalSupply = totalSupply;
        initialVirtualTokenReserve = totalSupply;
        tokenImplementation = address(new PumpToken());
        paramAdmin = initialParamAdmin;
        emit ParamAdminTransferred(address(0), initialParamAdmin);
        _setMarketParams(
            totalSupply, initialCreateFeeN, initialTradeFeeBps, virtualNReserve, graduationMarketCapN
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
            _pullExactN(msg.sender, fee);
            accruedProtocolFeesN += fee;
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
        uint256 virtualNReserve = initialVirtualNReserve;
        markets[token] = Market({
            creator: msg.sender,
            tokenReserve: tokenTotalSupply,
            realNReserve: 0,
            virtualTokenReserve: initialVirtualTokenReserve,
            virtualNReserve: virtualNReserve,
            totalNVolume: 0,
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
            virtualNReserve,
            initialVirtualTokenReserve,
            params.graduationThresholdN,
            params.graduationReserveThresholdN,
            reservation - 1
        );
    }

    function buy(address token, uint256 maxNIn, uint256 minTokenOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 tokenOut, uint256 userNAmount)
    {
        if (paused) revert ContractPaused();
        if (block.timestamp > deadline) revert DeadlineExpired();
        Market storage market = _tradingMarket(token);
        MarketParams memory params = marketParams[token];

        uint256 curveNAmount;
        uint256 feeN;
        bool readyAfter;
        (tokenOut, curveNAmount, userNAmount, feeN, readyAfter) = _quoteBuy(market, params, maxNIn);
        if (tokenOut == 0 || curveNAmount == 0) revert InvalidAmount();
        if (tokenOut < minTokenOut) revert SlippageExceeded();

        _pullExactN(msg.sender, userNAmount);
        market.realNReserve += curveNAmount;
        market.virtualNReserve += curveNAmount;
        market.tokenReserve -= tokenOut;
        market.virtualTokenReserve -= tokenOut;
        market.totalNVolume += curveNAmount;
        totalRealNReserves += curveNAmount;
        accruedProtocolFeesN += feeN;

        SafeTransferLib.safeTransfer(token, msg.sender, tokenOut);
        _emitTrade(token, msg.sender, true, tokenOut, curveNAmount, userNAmount, feeN, market, params);

        if (readyAfter) {
            market.lifecycle = Lifecycle.READY;
            emit TokenReadyForGraduation(
                token, market.realNReserve, market.tokenReserve, params.graduationThresholdN
            );
        }
    }

    function sell(address token, uint256 tokenIn, uint256 minNOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 userNAmount)
    {
        // Selling back into the curve stays open while paused: a pause stops new exposure
        // (create/buy) but must never trap holders if the admin is absent.
        if (block.timestamp > deadline) revert DeadlineExpired();
        Market storage market = _sellableMarket(token);
        MarketParams memory params = marketParams[token];
        bool reopenCurve = market.lifecycle == Lifecycle.READY;

        uint256 curveNAmount;
        uint256 feeN;
        (curveNAmount, userNAmount, feeN) = _quoteSell(market, params, tokenIn);
        if (curveNAmount == 0 || userNAmount == 0) revert InvalidAmount();
        if (userNAmount < minNOut) revert SlippageExceeded();

        uint256 balanceBefore = IERC20Minimal(token).balanceOf(address(this));
        SafeTransferLib.safeTransferFrom(token, msg.sender, address(this), tokenIn);
        if (IERC20Minimal(token).balanceOf(address(this)) != balanceBefore + tokenIn) {
            revert AssetTransferMismatch();
        }

        market.tokenReserve += tokenIn;
        market.virtualTokenReserve += tokenIn;
        market.realNReserve -= curveNAmount;
        market.virtualNReserve -= curveNAmount;
        market.totalNVolume += curveNAmount;
        totalRealNReserves -= curveNAmount;
        accruedProtocolFeesN += feeN;
        if (reopenCurve) market.lifecycle = Lifecycle.TRADING;

        SafeTransferLib.safeTransfer(N, msg.sender, userNAmount);
        _emitTrade(token, msg.sender, false, tokenIn, curveNAmount, userNAmount, feeN, market, params);
        if (reopenCurve) {
            emit TokenCurveReopened(token, market.realNReserve, market.tokenReserve);
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

        uint256 nLiquidity = market.realNReserve;
        uint256 priceWad = _spotPrice(market);
        uint256 tokenLiquidity = MathX.mulDiv(nLiquidity, WAD, priceWad);
        if (tokenLiquidity == 0 || tokenLiquidity > market.tokenReserve) revert InvalidConfiguration();

        uint256 tokensToBurn = market.tokenReserve - tokenLiquidity;
        if (tokensToBurn > 0) PumpToken(token).burn(tokensToBurn);

        market.tokenReserve = tokenLiquidity;
        market.realNReserve = 0;
        market.lifecycle = Lifecycle.GRADUATED;
        totalRealNReserves -= nLiquidity;

        SafeTransferLib.forceApprove(token, address(graduationRouter), tokenLiquidity);
        SafeTransferLib.forceApprove(N, address(graduationRouter), nLiquidity);
        result = graduationRouter.executeGraduation(
            adapter, token, N, tokenLiquidity, nLiquidity, minimumLp, deadline
        );
        SafeTransferLib.forceApprove(token, address(graduationRouter), 0);
        SafeTransferLib.forceApprove(N, address(graduationRouter), 0);

        market.tokenReserve = 0;
        market.dex = result.dex;
        market.dexPairId = result.pairId;
        market.pool = result.pool;

        emit TokenGraduated(
            token,
            result.dex,
            result.pairId,
            result.pool,
            nLiquidity,
            tokenLiquidity,
            result.lpAmount,
            graduationRouter.lpRecipient()
        );
    }

    /// @notice Sends every accrued protocol fee to the fee splitter, which splits it in the same
    ///         call. Permissionless.
    function distributeFees() external nonReentrant returns (uint256 amountN) {
        amountN = accruedProtocolFeesN;
        if (amountN == 0) revert InsufficientProtocolFees();
        accruedProtocolFeesN = 0;
        SafeTransferLib.safeTransfer(N, feeRecipient, amountN);
        IFeeSplitter(feeRecipient).distribute();
        emit ProtocolFeesDistributed(msg.sender, feeRecipient, amountN);
    }

    function setPaused(bool newPaused) external onlyAdmin {
        paused = newPaused;
        emit PauseUpdated(newPaused);
    }

    // ---------------------------------------------------------------- parameter admin

    /// @notice Terms for markets created from now on. Existing markets keep their own.
    function setMarketParams(
        uint256 newCreateFeeN,
        uint256 newTradeFeeBps,
        uint256 virtualNReserve,
        uint256 graduationMarketCapN
    ) external {
        if (msg.sender != paramAdmin) revert Unauthorized();
        _setMarketParams(
            tokenTotalSupply, newCreateFeeN, newTradeFeeBps, virtualNReserve, graduationMarketCapN
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

    function quoteBuy(address token, uint256 maxNIn)
        external
        view
        returns (uint256 tokenOut, uint256 curveNAmount, uint256 userNAmount, uint256 feeN, bool readyAfter)
    {
        return _quoteBuy(_tradingMarket(token), marketParams[token], maxNIn);
    }

    function quoteSell(address token, uint256 tokenIn)
        external
        view
        returns (uint256 curveNAmount, uint256 userNAmount, uint256 feeN)
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

    function spotPriceNWad(address token) public view returns (uint256) {
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
    function graduationThresholdN() external view returns (uint256) {
        return _nextParams.graduationThresholdN;
    }

    /// @notice Reserve target for markets created from now on.
    function graduationReserveThresholdN() external view returns (uint256) {
        return _nextParams.graduationReserveThresholdN;
    }

    function n() external view returns (address) {
        return N;
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

    function accountedNBalance() external view returns (uint256) {
        return totalRealNReserves + accruedProtocolFeesN;
    }

    // ---------------------------------------------------------------- internals

    /// @dev Applies the constructor's curve checks to every future set of terms, so no admin
    ///      setting can produce a curve that cannot graduate.
    function _setMarketParams(
        uint256 totalSupply,
        uint256 newCreateFeeN,
        uint256 newTradeFeeBps,
        uint256 virtualNReserve,
        uint256 graduationMarketCapN
    ) private {
        if (
            newCreateFeeN > MAX_CREATE_FEE_N || newTradeFeeBps > MAX_TRADE_FEE_BPS || virtualNReserve == 0
                || virtualNReserve > type(uint120).max || graduationMarketCapN <= virtualNReserve
                || graduationMarketCapN > type(uint120).max
        ) revert InvalidConfiguration();
        if (MathX.mulDiv(virtualNReserve, WAD, totalSupply) == 0) revert InvalidConfiguration();

        uint256 reserveThresholdN = MathX.sqrtUp(virtualNReserve * graduationMarketCapN) - virtualNReserve;
        if (reserveThresholdN == 0) revert InvalidConfiguration();

        uint256 terminalVirtualN = virtualNReserve + reserveThresholdN;
        uint256 terminalTokenReserve =
            totalSupply - MathX.mulDiv(reserveThresholdN, totalSupply, terminalVirtualN);
        if (terminalTokenReserve == 0) revert InvalidConfiguration();
        uint256 terminalSpotPrice = MathX.mulDiv(terminalVirtualN, WAD, terminalTokenReserve);
        if (terminalSpotPrice == 0) revert InvalidConfiguration();
        if (MathX.mulDiv(terminalSpotPrice, totalSupply, WAD) < graduationMarketCapN) {
            revert InvalidConfiguration();
        }
        uint256 terminalTokenLiquidity = MathX.mulDiv(reserveThresholdN, WAD, terminalSpotPrice);
        if (terminalTokenLiquidity == 0 || terminalTokenLiquidity > terminalTokenReserve) {
            revert InvalidConfiguration();
        }

        // Every value was bounds-checked above.
        // forge-lint: disable-next-line(unsafe-typecast)
        createFee = uint128(newCreateFeeN);
        // forge-lint: disable-next-line(unsafe-typecast)
        initialVirtualNReserve = uint128(virtualNReserve);
        _nextParams = MarketParams({
            // forge-lint: disable-next-line(unsafe-typecast)
            tradeFeeBps: uint16(newTradeFeeBps),
            // forge-lint: disable-next-line(unsafe-typecast)
            graduationThresholdN: uint120(graduationMarketCapN),
            // forge-lint: disable-next-line(unsafe-typecast)
            graduationReserveThresholdN: uint120(reserveThresholdN)
        });
        emit MarketParamsUpdated(
            newCreateFeeN, newTradeFeeBps, virtualNReserve, graduationMarketCapN, reserveThresholdN
        );
    }

    function _quoteBuy(Market storage market, MarketParams memory params, uint256 maxNIn)
        internal
        view
        returns (uint256 tokenOut, uint256 curveNAmount, uint256 userNAmount, uint256 feeN, bool readyAfter)
    {
        if (maxNIn == 0) return (0, 0, 0, 0, false);
        uint256 reserveThreshold = params.graduationReserveThresholdN;
        uint256 remainingN = reserveThreshold - market.realNReserve;
        // The largest payment whose share after the fee still fits below the threshold.
        uint256 maximumGross = (remainingN * BPS_DENOMINATOR) / (BPS_DENOMINATOR - params.tradeFeeBps);
        userNAmount = MathX.min(maxNIn, maximumGross);
        feeN = MathX.mulDiv(userNAmount, params.tradeFeeBps, BPS_DENOMINATOR);
        curveNAmount = userNAmount - feeN;
        if (curveNAmount == 0) return (0, 0, 0, 0, false);

        tokenOut =
            MathX.mulDiv(curveNAmount, market.virtualTokenReserve, market.virtualNReserve + curveNAmount);
        if (tokenOut > market.tokenReserve) tokenOut = market.tokenReserve;
        readyAfter = market.realNReserve + curveNAmount >= reserveThreshold;
    }

    function _quoteSell(Market storage market, MarketParams memory params, uint256 tokenIn)
        internal
        view
        returns (uint256 curveNAmount, uint256 userNAmount, uint256 feeN)
    {
        if (tokenIn == 0) return (0, 0, 0);
        curveNAmount = MathX.mulDiv(tokenIn, market.virtualNReserve, market.virtualTokenReserve + tokenIn);
        if (curveNAmount > market.realNReserve) curveNAmount = market.realNReserve;
        feeN = MathX.mulDiv(curveNAmount, params.tradeFeeBps, BPS_DENOMINATOR);
        userNAmount = curveNAmount - feeN;
    }

    function _emitTrade(
        address token,
        address trader,
        bool isBuy,
        uint256 tokenAmount,
        uint256 curveNAmount,
        uint256 userNAmount,
        uint256 feeN,
        Market storage market,
        MarketParams memory params
    ) internal {
        emit TokenTraded(
            token,
            trader,
            isBuy,
            tokenAmount,
            curveNAmount,
            userNAmount,
            feeN,
            market.realNReserve,
            market.tokenReserve,
            market.virtualNReserve,
            market.virtualTokenReserve,
            tokenTotalSupply - market.tokenReserve,
            _spotPrice(market),
            _progressBps(market, params)
        );
    }

    function _progressBps(Market storage market, MarketParams memory params) internal view returns (uint256) {
        return MathX.min(
            BPS_DENOMINATOR,
            MathX.mulDiv(market.realNReserve, BPS_DENOMINATOR, params.graduationReserveThresholdN)
        );
    }

    function _spotPrice(Market storage market) internal view returns (uint256) {
        return MathX.mulDiv(market.virtualNReserve, WAD, market.virtualTokenReserve);
    }

    function _pullExactN(address from, uint256 amount) internal {
        uint256 balanceBefore = IERC20Minimal(N).balanceOf(address(this));
        SafeTransferLib.safeTransferFrom(N, from, address(this), amount);
        if (IERC20Minimal(N).balanceOf(address(this)) != balanceBefore + amount) {
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
