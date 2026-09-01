// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { IControlledZeroXPump } from "../../src/graduation/PumpGraduationController.sol";
import { IGraduationAdapter } from "../../src/interfaces/IGraduationAdapter.sol";
import { MockERC20 } from "./TokenMocks.sol";

contract ControllerMockPumpRouter {
    using SafeERC20 for IERC20;

    error OnlyPump();
    error Unauthorized();

    address public immutable pump;
    address public admin;
    address public pendingAdmin;
    bool public enabled = true;
    bool public enableScheduled;
    address public scheduledAdapter;
    mapping(address => bool) public isAdapterAllowed;

    constructor(address pump_) {
        pump = pump_;
        admin = msg.sender;
    }

    function allowAdapter(address adapter) external {
        isAdapterAllowed[adapter] = true;
    }

    function scheduleAdapter(address adapter) external {
        if (msg.sender != admin) revert Unauthorized();
        scheduledAdapter = adapter;
    }

    function disableAdapter(address adapter) external {
        if (msg.sender != admin) revert Unauthorized();
        isAdapterAllowed[adapter] = false;
    }

    function scheduleEnable() external {
        if (msg.sender != admin) revert Unauthorized();
        enableScheduled = true;
    }

    function disableRouter() external {
        if (msg.sender != admin) revert Unauthorized();
        enabled = false;
        enableScheduled = false;
    }

    function transferAdmin(address newAdmin) external {
        if (msg.sender != admin) revert Unauthorized();
        pendingAdmin = newAdmin;
    }

    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert Unauthorized();
        admin = msg.sender;
        pendingAdmin = address(0);
    }

    function executeGraduation(
        address adapter,
        address token,
        address nusd,
        uint256 tokenAmount,
        uint256 nusdAmount,
        uint256 minimumLp,
        uint256 deadline
    ) external returns (IGraduationAdapter.GraduationResult memory result) {
        if (msg.sender != pump) revert OnlyPump();
        require(enabled && isAdapterAllowed[adapter], "ROUTER_UNAVAILABLE");
        IERC20(token).safeTransferFrom(msg.sender, address(this), tokenAmount);
        IERC20(nusd).safeTransferFrom(msg.sender, address(this), nusdAmount);
        IERC20(token).forceApprove(adapter, tokenAmount);
        IERC20(nusd).forceApprove(adapter, nusdAmount);
        result = IGraduationAdapter(adapter)
            .graduate(
                IGraduationAdapter.GraduationParams({
                    token: token,
                    nusd: nusd,
                    tokenAmount: tokenAmount,
                    nusdAmount: nusdAmount,
                    minimumLp: minimumLp,
                    deadline: deadline,
                    lpRecipient: address(this)
                })
            );
        IERC20(token).forceApprove(adapter, 0);
        IERC20(nusd).forceApprove(adapter, 0);
    }
}

contract ControllerMockPump {
    using SafeERC20 for IERC20;

    error MarketNotReady();
    error Unauthorized();

    uint8 private constant READY = 2;
    uint8 private constant GRADUATED = 3;

    struct Market {
        address creator;
        uint256 tokenReserve;
        uint256 realNusdReserve;
        uint256 virtualTokenReserve;
        uint256 virtualNusdReserve;
        uint256 totalNusdVolume;
        uint64 createdAt;
        uint8 lifecycle;
        address dex;
        bytes32 dexPairId;
        address pool;
    }

    address public immutable NUSD;
    address public graduationRouter;
    address public admin;
    address public pendingAdmin;
    bool public paused;
    uint256 public accruedProtocolFeesNusd;
    mapping(address => Market) public markets;
    mapping(address => uint256) public spotPriceNusdWad;

    constructor(address nusd_, address admin_) {
        NUSD = nusd_;
        admin = admin_;
    }

    function setGraduationRouter(address router) external {
        graduationRouter = router;
    }

    function configureMarket(
        address token,
        uint8 lifecycle,
        uint256 tokenReserve,
        uint256 realNusdReserve,
        uint256 priceWad
    ) external {
        markets[token] = Market({
            creator: msg.sender,
            tokenReserve: tokenReserve,
            realNusdReserve: realNusdReserve,
            virtualTokenReserve: tokenReserve,
            virtualNusdReserve: realNusdReserve,
            totalNusdVolume: 0,
            createdAt: uint64(block.timestamp),
            lifecycle: lifecycle,
            dex: address(0),
            dexPairId: bytes32(0),
            pool: address(0)
        });
        spotPriceNusdWad[token] = priceWad;
    }

    function status(address token) external view returns (uint8) {
        return markets[token].lifecycle;
    }

    function graduate(address token, address adapter, uint256 minimumLp, uint256 deadline)
        external
        returns (IControlledZeroXPump.GraduationResult memory result)
    {
        if (msg.sender != admin) revert Unauthorized();
        Market storage market = markets[token];
        if (market.lifecycle != READY) revert MarketNotReady();

        uint256 nusdAmount = market.realNusdReserve;
        uint256 tokenAmount = Math.mulDiv(nusdAmount, 1e18, spotPriceNusdWad[token]);
        IERC20(token).forceApprove(graduationRouter, tokenAmount);
        IERC20(NUSD).forceApprove(graduationRouter, nusdAmount);
        IGraduationAdapter.GraduationResult memory adapterResult = ControllerMockPumpRouter(graduationRouter)
            .executeGraduation(adapter, token, NUSD, tokenAmount, nusdAmount, minimumLp, deadline);
        IERC20(token).forceApprove(graduationRouter, 0);
        IERC20(NUSD).forceApprove(graduationRouter, 0);

        market.tokenReserve = 0;
        market.realNusdReserve = 0;
        market.lifecycle = GRADUATED;
        market.dex = adapterResult.dex;
        market.dexPairId = adapterResult.pairId;
        market.pool = adapterResult.pool;
        result = IControlledZeroXPump.GraduationResult({
            dex: adapterResult.dex,
            pairId: adapterResult.pairId,
            pool: adapterResult.pool,
            lpToken: adapterResult.lpToken,
            lpAmount: adapterResult.lpAmount
        });
    }

    function setPaused(bool paused_) external {
        if (msg.sender != admin) revert Unauthorized();
        paused = paused_;
    }

    function seedProtocolFees(uint256 amount) external {
        MockERC20(NUSD).mint(address(this), amount);
        accruedProtocolFeesNusd += amount;
    }

    function withdrawProtocolFees(address recipient, uint256 amountNusd) external {
        if (msg.sender != admin) revert Unauthorized();
        accruedProtocolFeesNusd -= amountNusd;
        IERC20(NUSD).safeTransfer(recipient, amountNusd);
    }

    function transferAdmin(address newAdmin) external {
        if (msg.sender != admin) revert Unauthorized();
        pendingAdmin = newAdmin;
    }

    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert Unauthorized();
        admin = msg.sender;
        pendingAdmin = address(0);
    }
}
