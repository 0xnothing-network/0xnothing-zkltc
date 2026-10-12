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

contract ZeroXPump is TwoStepAdmin, ReentrancyGuard {
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
    uint256 public constant CREATE_FEE_NUSD = 1e18;
    uint256 public constant TRADE_FEE_BPS = 10;
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

    address public immutable NUSD;
    address public immutable vault;
    IGraduationRouter public immutable graduationRouter;
    address public immutable tokenImplementation;
    uint256 public immutable tokenTotalSupply;
    uint256 public immutable initialVirtualNusdReserve;
    uint256 public immutable initialVirtualTokenReserve;
    /// @notice Fully diluted market-cap target, denominated in 18-decimal NUSD.
    uint256 public immutable graduationThresholdNusd;
    /// @notice Real NUSD reserve required for the curve to reach the market-cap target.
    uint256 public immutable graduationReserveThresholdNusd;

    mapping(address => Market) public markets;
    mapping(address => mapping(bytes32 => bool)) public creationReservations;
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
    event ProtocolFeesWithdrawn(address indexed recipient, uint256 amountNusd);
    event PauseUpdated(bool paused);

    constructor(
        address nusdAddress,
        address nusdVault,
        address router,
        address initialAdmin,
        uint256 totalSupply,
        uint256 virtualNusdReserve,
        uint256 graduationMarketCapNusd
    ) TwoStepAdmin(initialAdmin) {
        if (
            nusdAddress == address(0) || nusdAddress.code.length == 0 || nusdVault == address(0)
                || nusdVault.code.length == 0 || router == address(0) || router.code.length == 0 || totalSupply == 0
                || virtualNusdReserve == 0 || virtualNusdReserve > type(uint128).max
                || graduationMarketCapNusd <= virtualNusdReserve || graduationMarketCapNusd > type(uint128).max
        ) revert InvalidConfiguration();
        if (MathX.mulDiv(virtualNusdReserve, WAD, totalSupply) == 0) {
            revert InvalidConfiguration();
        }

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

        NUSD = nusdAddress;
        vault = nusdVault;
        graduationRouter = IGraduationRouter(router);
        tokenTotalSupply = totalSupply;
        initialVirtualNusdReserve = virtualNusdReserve;
        initialVirtualTokenReserve = totalSupply;
        graduationThresholdNusd = graduationMarketCapNusd;
        graduationReserveThresholdNusd = reserveThresholdNusd;
        tokenImplementation = address(new PumpToken());
    }

    function reserveMarket(bytes32 contentHash) external nonReentrant {
        if (paused) revert ContractPaused();
        if (contentHash == bytes32(0)) revert InvalidCommitment();
        if (
            creationReservations[msg.sender][contentHash]
                || createdTokenByContentHash[msg.sender][contentHash] != address(0)
        ) revert InvalidReservation();

        _pullExactNusd(msg.sender, CREATE_FEE_NUSD);
        accruedProtocolFeesNusd += CREATE_FEE_NUSD;
        creationReservations[msg.sender][contentHash] = true;
        emit CreationFeePaid(msg.sender, contentHash, CREATE_FEE_NUSD);
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
        if (
            !creationReservations[msg.sender][contentHash]
                || createdTokenByContentHash[msg.sender][contentHash] != address(0)
        ) revert InvalidReservation();
        creationReservations[msg.sender][contentHash] = false;

        token = tokenImplementation.clone();
        PumpToken(token).initialize(name, symbol, metadataURI, imageURI, tokenTotalSupply, address(this));

        markets[token] = Market({
            creator: msg.sender,
            tokenReserve: tokenTotalSupply,
            realNusdReserve: 0,
            virtualTokenReserve: initialVirtualTokenReserve,
            virtualNusdReserve: initialVirtualNusdReserve,
            totalNusdVolume: 0,
            createdAt: uint64(block.timestamp),
            lifecycle: Lifecycle.TRADING,
            dex: address(0),
            dexPairId: bytes32(0),
            pool: address(0)
        });
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
            initialVirtualNusdReserve,
            initialVirtualTokenReserve,
            graduationThresholdNusd,
            graduationReserveThresholdNusd,
            CREATE_FEE_NUSD
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

        uint256 curveNusdAmount;
        uint256 feeNusd;
        bool readyAfter;
        (tokenOut, curveNusdAmount, userNusdAmount, feeNusd, readyAfter) = _quoteBuy(market, maxNusdIn);
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
        _emitTrade(token, msg.sender, true, tokenOut, curveNusdAmount, userNusdAmount, feeNusd, market);

        if (readyAfter) {
            market.lifecycle = Lifecycle.READY;
            emit TokenReadyForGraduation(token, market.realNusdReserve, market.tokenReserve, graduationThresholdNusd);
        }
    }

    function sell(address token, uint256 tokenIn, uint256 minNusdOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 userNusdAmount)
    {
        if (paused) revert ContractPaused();
        if (block.timestamp > deadline) revert DeadlineExpired();
        Market storage market = _sellableMarket(token);
        bool reopenCurve = market.lifecycle == Lifecycle.READY;

        uint256 curveNusdAmount;
        uint256 feeNusd;
        (curveNusdAmount, userNusdAmount, feeNusd) = _quoteSell(market, tokenIn);
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
        _emitTrade(token, msg.sender, false, tokenIn, curveNusdAmount, userNusdAmount, feeNusd, market);
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

    function withdrawProtocolFees(address recipient, uint256 amountNusd) external onlyAdmin nonReentrant {
        if (recipient == address(0) || amountNusd == 0 || amountNusd > accruedProtocolFeesNusd) {
            revert InsufficientProtocolFees();
        }
        accruedProtocolFeesNusd -= amountNusd;
        SafeTransferLib.safeTransfer(NUSD, recipient, amountNusd);
        emit ProtocolFeesWithdrawn(recipient, amountNusd);
    }

    function setPaused(bool newPaused) external onlyAdmin {
        paused = newPaused;
        emit PauseUpdated(newPaused);
    }

    function quoteBuy(address token, uint256 maxNusdIn)
        external
        view
        returns (uint256 tokenOut, uint256 curveNusdAmount, uint256 userNusdAmount, uint256 feeNusd, bool readyAfter)
    {
        return _quoteBuy(_tradingMarketView(token), maxNusdIn);
    }

    function quoteSell(address token, uint256 tokenIn)
        external
        view
        returns (uint256 curveNusdAmount, uint256 userNusdAmount, uint256 feeNusd)
    {
        return _quoteSell(_sellableMarketView(token), tokenIn);
    }

    function status(address token) external view returns (uint8) {
        return uint8(_marketView(token).lifecycle);
    }

    function spotPriceNusdWad(address token) public view returns (uint256) {
        return _spotPrice(_marketView(token));
    }

    function curveProgressBps(address token) public view returns (uint256) {
        Market storage market = _marketView(token);
        if (market.lifecycle == Lifecycle.GRADUATED) return BPS_DENOMINATOR;
        return MathX.min(
            BPS_DENOMINATOR, MathX.mulDiv(market.realNusdReserve, BPS_DENOMINATOR, graduationReserveThresholdNusd)
        );
    }

    function createFee() external pure returns (uint256) {
        return CREATE_FEE_NUSD;
    }

    function tradeFeeBps() external pure returns (uint256) {
        return TRADE_FEE_BPS;
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

    function _quoteBuy(Market storage market, uint256 maxNusdIn)
        internal
        view
        returns (uint256 tokenOut, uint256 curveNusdAmount, uint256 userNusdAmount, uint256 feeNusd, bool readyAfter)
    {
        if (maxNusdIn == 0) return (0, 0, 0, 0, false);
        uint256 remainingNusd = graduationReserveThresholdNusd - market.realNusdReserve;
        uint256 maximumGross = ((remainingNusd * BPS_DENOMINATOR) - 1) / (BPS_DENOMINATOR - TRADE_FEE_BPS);
        userNusdAmount = MathX.min(maxNusdIn, maximumGross);
        feeNusd = MathX.mulDiv(userNusdAmount, TRADE_FEE_BPS, BPS_DENOMINATOR);
        curveNusdAmount = userNusdAmount - feeNusd;
        if (curveNusdAmount == 0) return (0, 0, 0, 0, false);

        tokenOut =
            MathX.mulDiv(curveNusdAmount, market.virtualTokenReserve, market.virtualNusdReserve + curveNusdAmount);
        if (tokenOut > market.tokenReserve) tokenOut = market.tokenReserve;
        readyAfter = market.realNusdReserve + curveNusdAmount >= graduationReserveThresholdNusd;
    }

    function _quoteSell(Market storage market, uint256 tokenIn)
        internal
        view
        returns (uint256 curveNusdAmount, uint256 userNusdAmount, uint256 feeNusd)
    {
        if (tokenIn == 0) return (0, 0, 0);
        curveNusdAmount = MathX.mulDiv(tokenIn, market.virtualNusdReserve, market.virtualTokenReserve + tokenIn);
        if (curveNusdAmount > market.realNusdReserve) curveNusdAmount = market.realNusdReserve;
        feeNusd = MathX.mulDiv(curveNusdAmount, TRADE_FEE_BPS, BPS_DENOMINATOR);
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
        Market storage market
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
            MathX.min(
                BPS_DENOMINATOR, MathX.mulDiv(market.realNusdReserve, BPS_DENOMINATOR, graduationReserveThresholdNusd)
            )
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

    function _marketView(address token) internal view returns (Market storage market) {
        market = _market(token);
    }

    function _tradingMarket(address token) internal view returns (Market storage market) {
        market = _market(token);
        if (market.lifecycle != Lifecycle.TRADING) revert MarketNotTrading();
    }

    function _tradingMarketView(address token) internal view returns (Market storage market) {
        market = _tradingMarket(token);
    }

    function _sellableMarket(address token) internal view returns (Market storage market) {
        market = _market(token);
        if (market.lifecycle != Lifecycle.TRADING && market.lifecycle != Lifecycle.READY) {
            revert MarketNotTrading();
        }
    }

    function _sellableMarketView(address token) internal view returns (Market storage market) {
        market = _sellableMarket(token);
    }
}
