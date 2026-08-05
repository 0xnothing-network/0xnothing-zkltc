// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { ZeroXFiFactory } from "../src/amm/ZeroXFiFactory.sol";
import { ZeroXFiPair } from "../src/amm/ZeroXFiPair.sol";
import { IControlledZeroXPump, PumpGraduationController } from "../src/graduation/PumpGraduationController.sol";
import { ZeroXFiGraduationAdapter } from "../src/graduation/ZeroXFiGraduationAdapter.sol";
import { IGraduationAdapter } from "../src/interfaces/IGraduationAdapter.sol";
import { TestBase } from "./TestBase.sol";
import { MockERC20 } from "./mocks/Mocks.sol";

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

contract PumpGraduationControllerTest is TestBase {
    address private constant USER = address(0xBEEF);
    address private constant GUARDIAN = address(0xCAFE);
    address private constant NEW_GUARDIAN = address(0xD00D);
    address private constant RECIPIENT = address(0xFEE);

    uint256 private constant TOKEN_RESERVE = 750_000_000 ether;
    uint256 private constant TOKEN_LIQUIDITY = 250_000_000 ether;
    uint256 private constant NUSD_LIQUIDITY = 1500 ether;
    uint256 private constant TERMINAL_PRICE_WAD = 6_000_000_000_000;

    MockERC20 private nusd;
    MockERC20 private pumpToken;
    ControllerMockPump private pump;
    ControllerMockPumpRouter private pumpRouter;
    ZeroXFiFactory private factory;
    ZeroXFiGraduationAdapter private adapter;
    PumpGraduationController private controller;

    function setUp() public {
        vm.warp(1_000_000);
        nusd = new MockERC20("Nothing USD", "NUSD");
        pumpToken = new MockERC20("Pump token", "PUMP");
        pump = new ControllerMockPump(address(nusd), address(this));
        pumpRouter = new ControllerMockPumpRouter(address(pump));
        pump.setGraduationRouter(address(pumpRouter));

        factory = new ZeroXFiFactory(address(this), address(nusd), address(pump));
        adapter = new ZeroXFiGraduationAdapter(address(factory), address(pumpRouter), address(nusd), address(pump));
        factory.bindGraduationAdapter(address(adapter));
        controller = new PumpGraduationController(address(pump), address(adapter), address(this), GUARDIAN);
        pumpRouter.allowAdapter(address(adapter));

        pump.transferAdmin(address(controller));
        pumpRouter.transferAdmin(address(controller));
        vm.prank(USER);
        controller.acceptPumpAdmin();
        vm.prank(USER);
        controller.acceptRouterAdmin();
    }

    function testEoaGovernanceCanManageControllerDirectly() public {
        PumpGraduationController directController =
            new PumpGraduationController(address(pump), address(adapter), USER, GUARDIAN);
        assertEq(directController.governance(), USER, "EOA governance bound");

        vm.prank(USER);
        directController.setGraduationsPaused(true);
        assertTrue(directController.graduationsPaused(), "EOA governance controls pause");

        vm.expectRevert(PumpGraduationController.Unauthorized.selector);
        directController.setGraduationsPaused(false);
    }

    function testPermissionlessGraduationPreparesAndSeedsExactPool() public {
        _readyMarket();
        PumpGraduationController.GraduationPreview memory preview = controller.previewGraduation(address(pumpToken));
        assertTrue(preview.ready, "market ready");
        assertEq(preview.pool, address(0), "pool not prepared");
        assertEq(preview.tokenAmount, TOKEN_LIQUIDITY, "token liquidity");
        assertEq(preview.nusdAmount, NUSD_LIQUIDITY, "NUSD liquidity");
        assertEq(preview.minimumLp, preview.expectedLp, "exact minimum LP");

        vm.prank(USER);
        IControlledZeroXPump.GraduationResult memory result = controller.graduateReady(address(pumpToken));

        assertEq(result.pool, factory.getPair(address(pumpToken), address(nusd)), "canonical pool");
        assertEq(result.lpToken, result.pool, "pair is LP token");
        assertEq(result.lpAmount, preview.expectedLp, "exact LP amount");
        assertEq(uint256(pump.status(address(pumpToken))), 3, "graduated lifecycle");
        assertEq(ZeroXFiPair(result.pool).bootstrapper(), address(0), "bootstrap completed");
        assertEq(IERC20(result.pool).balanceOf(address(pumpRouter)), result.lpAmount, "LP held by router");
        (uint112 reserve0, uint112 reserve1,) = ZeroXFiPair(result.pool).getReserves();
        uint256 tokenReserve = ZeroXFiPair(result.pool).token0() == address(pumpToken) ? reserve0 : reserve1;
        uint256 nusdReserve = ZeroXFiPair(result.pool).token0() == address(nusd) ? reserve0 : reserve1;
        assertEq(tokenReserve, TOKEN_LIQUIDITY, "exact token reserve");
        assertEq(nusdReserve, NUSD_LIQUIDITY, "exact NUSD reserve");
    }

    function testNonReadyMarketCannotCreateProtectedPool() public {
        pump.configureMarket(address(pumpToken), 1, TOKEN_RESERVE, NUSD_LIQUIDITY, TERMINAL_PRICE_WAD);
        vm.prank(USER);
        vm.expectRevert(PumpGraduationController.MarketNotReady.selector);
        controller.graduateReady(address(pumpToken));
        assertEq(factory.getPair(address(pumpToken), address(nusd)), address(0), "no early pool");
    }

    function testDisabledRouterCannotGraduate() public {
        _readyMarket();
        controller.disableRouter();
        vm.expectRevert(PumpGraduationController.RouterUnavailable.selector);
        controller.graduateReady(address(pumpToken));
    }

    function testAcceptPumpAdminIsPermissionlessButRequiresPendingController() public {
        ControllerMockPump secondPump = new ControllerMockPump(address(nusd), address(this));
        ControllerMockPumpRouter secondRouter = new ControllerMockPumpRouter(address(secondPump));
        secondPump.setGraduationRouter(address(secondRouter));
        ZeroXFiFactory secondFactory = new ZeroXFiFactory(address(this), address(nusd), address(secondPump));
        ZeroXFiGraduationAdapter secondAdapter = new ZeroXFiGraduationAdapter(
            address(secondFactory), address(secondRouter), address(nusd), address(secondPump)
        );
        secondFactory.bindGraduationAdapter(address(secondAdapter));
        PumpGraduationController secondController =
            new PumpGraduationController(address(secondPump), address(secondAdapter), address(this), GUARDIAN);

        vm.expectRevert(PumpGraduationController.PendingAdminMismatch.selector);
        secondController.acceptPumpAdmin();
        secondPump.transferAdmin(address(secondController));
        vm.prank(USER);
        secondController.acceptPumpAdmin();
        assertEq(secondPump.admin(), address(secondController), "controller accepted admin");
    }

    function testGuardianCanOnlyEmergencyPauseAndGovernanceCanUnpause() public {
        vm.prank(GUARDIAN);
        controller.emergencyPause();
        assertTrue(pump.paused(), "guardian paused Pump");
        assertTrue(controller.graduationsPaused(), "guardian paused graduations");
        assertFalse(pumpRouter.enabled(), "guardian disabled router");

        _readyMarket();
        vm.prank(USER);
        vm.expectRevert(PumpGraduationController.GraduationsPaused.selector);
        controller.graduateReady(address(pumpToken));

        vm.prank(GUARDIAN);
        vm.expectRevert(PumpGraduationController.Unauthorized.selector);
        controller.setPumpPaused(false);
        controller.setPumpPaused(false);
        assertFalse(pump.paused(), "governance unpaused Pump");
        assertFalse(controller.graduationsPaused(), "governance unpaused graduations");
    }

    function testEmergencyPauseStillStopsAutomationBeforeRouterAdminHandover() public {
        ControllerMockPump secondPump = new ControllerMockPump(address(nusd), address(this));
        ControllerMockPumpRouter secondRouter = new ControllerMockPumpRouter(address(secondPump));
        secondPump.setGraduationRouter(address(secondRouter));
        ZeroXFiFactory secondFactory = new ZeroXFiFactory(address(this), address(nusd), address(secondPump));
        ZeroXFiGraduationAdapter secondAdapter = new ZeroXFiGraduationAdapter(
            address(secondFactory), address(secondRouter), address(nusd), address(secondPump)
        );
        secondFactory.bindGraduationAdapter(address(secondAdapter));
        secondRouter.allowAdapter(address(secondAdapter));
        PumpGraduationController secondController =
            new PumpGraduationController(address(secondPump), address(secondAdapter), address(this), GUARDIAN);
        secondPump.transferAdmin(address(secondController));
        secondController.acceptPumpAdmin();

        vm.prank(GUARDIAN);
        secondController.emergencyPause();
        assertTrue(secondController.graduationsPaused(), "local graduation circuit breaker");
        assertTrue(secondPump.paused(), "Pump paused");
        assertTrue(secondRouter.enabled(), "router remains under its current admin");
    }

    function testEmergencyPauseStillDisablesRouterBeforePumpAdminHandover() public {
        ControllerMockPump secondPump = new ControllerMockPump(address(nusd), address(this));
        ControllerMockPumpRouter secondRouter = new ControllerMockPumpRouter(address(secondPump));
        secondPump.setGraduationRouter(address(secondRouter));
        ZeroXFiFactory secondFactory = new ZeroXFiFactory(address(this), address(nusd), address(secondPump));
        ZeroXFiGraduationAdapter secondAdapter = new ZeroXFiGraduationAdapter(
            address(secondFactory), address(secondRouter), address(nusd), address(secondPump)
        );
        secondFactory.bindGraduationAdapter(address(secondAdapter));
        secondRouter.allowAdapter(address(secondAdapter));
        PumpGraduationController secondController =
            new PumpGraduationController(address(secondPump), address(secondAdapter), address(this), GUARDIAN);
        secondRouter.transferAdmin(address(secondController));
        secondController.acceptRouterAdmin();

        vm.prank(GUARDIAN);
        secondController.emergencyPause();
        assertTrue(secondController.graduationsPaused(), "local graduation circuit breaker");
        assertFalse(secondPump.paused(), "Pump remains under its current admin");
        assertFalse(secondRouter.enabled(), "owned router disabled");
    }

    function testGovernanceRoutesFeesGuardianRotationAndAdminTransfer() public {
        pump.seedProtocolFees(5 ether);
        controller.withdrawProtocolFees(RECIPIENT, 2 ether);
        assertEq(nusd.balanceOf(RECIPIENT), 2 ether, "fees withdrawn");

        controller.setGuardian(NEW_GUARDIAN);
        assertEq(controller.guardian(), NEW_GUARDIAN, "guardian rotated");
        vm.expectRevert(PumpGraduationController.InvalidConfiguration.selector);
        controller.setGuardian(address(0));

        controller.transferPumpAdmin(USER);
        assertEq(pump.pendingAdmin(), USER, "admin transfer started");

        controller.scheduleAdapter();
        assertEq(pumpRouter.scheduledAdapter(), address(adapter), "only pinned adapter scheduled");
        controller.disableAdapter();
        assertFalse(pumpRouter.isAdapterAllowed(address(adapter)), "pinned adapter disabled");
        controller.scheduleRouterEnable();
        assertTrue(pumpRouter.enableScheduled(), "router enable scheduled");
        controller.disableRouter();
        assertFalse(pumpRouter.enabled(), "router disabled");
        controller.transferRouterAdmin(USER);
        assertEq(pumpRouter.pendingAdmin(), USER, "router admin transfer started");
    }

    function testOnlyGovernanceCanUseAdministrativeRoutes() public {
        vm.startPrank(USER);
        vm.expectRevert(PumpGraduationController.Unauthorized.selector);
        controller.setPumpPaused(true);
        vm.expectRevert(PumpGraduationController.Unauthorized.selector);
        controller.setGraduationsPaused(true);
        vm.expectRevert(PumpGraduationController.Unauthorized.selector);
        controller.withdrawProtocolFees(USER, 1);
        vm.expectRevert(PumpGraduationController.Unauthorized.selector);
        controller.transferPumpAdmin(USER);
        vm.expectRevert(PumpGraduationController.Unauthorized.selector);
        controller.scheduleAdapter();
        vm.expectRevert(PumpGraduationController.Unauthorized.selector);
        controller.disableAdapter();
        vm.expectRevert(PumpGraduationController.Unauthorized.selector);
        controller.scheduleRouterEnable();
        vm.expectRevert(PumpGraduationController.Unauthorized.selector);
        controller.disableRouter();
        vm.expectRevert(PumpGraduationController.Unauthorized.selector);
        controller.transferRouterAdmin(USER);
        vm.expectRevert(PumpGraduationController.Unauthorized.selector);
        controller.setGuardian(USER);
        vm.expectRevert(PumpGraduationController.Unauthorized.selector);
        controller.emergencyPause();
        vm.stopPrank();
    }

    function testControllerMustBecomeAdminBeforeGraduating() public {
        _readyMarket();
        controller.transferPumpAdmin(USER);
        vm.prank(USER);
        pump.acceptAdmin();

        vm.expectRevert(ControllerMockPump.Unauthorized.selector);
        controller.graduateReady(address(pumpToken));
        assertEq(factory.getPair(address(pumpToken), address(nusd)), address(0), "atomic pool preparation rollback");
    }

    function testConstructorRejectsWrongAdapterPumpTopology() public {
        ControllerMockPump otherPump = new ControllerMockPump(address(nusd), address(this));
        ControllerMockPumpRouter otherRouter = new ControllerMockPumpRouter(address(otherPump));
        otherPump.setGraduationRouter(address(otherRouter));
        ZeroXFiFactory otherFactory = new ZeroXFiFactory(address(this), address(nusd), address(otherPump));
        ZeroXFiGraduationAdapter otherAdapter = new ZeroXFiGraduationAdapter(
            address(otherFactory), address(otherRouter), address(nusd), address(otherPump)
        );
        otherFactory.bindGraduationAdapter(address(otherAdapter));

        vm.expectRevert(PumpGraduationController.InvalidConfiguration.selector);
        new PumpGraduationController(address(pump), address(otherAdapter), address(this), GUARDIAN);
    }

    function testAcceptRouterAdminIsPermissionlessButRequiresPendingController() public {
        ControllerMockPump secondPump = new ControllerMockPump(address(nusd), address(this));
        ControllerMockPumpRouter secondRouter = new ControllerMockPumpRouter(address(secondPump));
        secondPump.setGraduationRouter(address(secondRouter));
        ZeroXFiFactory secondFactory = new ZeroXFiFactory(address(this), address(nusd), address(secondPump));
        ZeroXFiGraduationAdapter secondAdapter = new ZeroXFiGraduationAdapter(
            address(secondFactory), address(secondRouter), address(nusd), address(secondPump)
        );
        secondFactory.bindGraduationAdapter(address(secondAdapter));
        PumpGraduationController secondController =
            new PumpGraduationController(address(secondPump), address(secondAdapter), address(this), GUARDIAN);

        vm.expectRevert(PumpGraduationController.PendingAdminMismatch.selector);
        secondController.acceptRouterAdmin();
        secondRouter.transferAdmin(address(secondController));
        vm.prank(USER);
        secondController.acceptRouterAdmin();
        assertEq(secondRouter.admin(), address(secondController), "controller accepted router admin");
    }

    function testAcceptProtocolAdminCompletesBothHandoversAtomically() public {
        ControllerMockPump secondPump = new ControllerMockPump(address(nusd), address(this));
        ControllerMockPumpRouter secondRouter = new ControllerMockPumpRouter(address(secondPump));
        secondPump.setGraduationRouter(address(secondRouter));
        ZeroXFiFactory secondFactory = new ZeroXFiFactory(address(this), address(nusd), address(secondPump));
        ZeroXFiGraduationAdapter secondAdapter = new ZeroXFiGraduationAdapter(
            address(secondFactory), address(secondRouter), address(nusd), address(secondPump)
        );
        secondFactory.bindGraduationAdapter(address(secondAdapter));
        PumpGraduationController secondController =
            new PumpGraduationController(address(secondPump), address(secondAdapter), address(this), GUARDIAN);

        secondPump.transferAdmin(address(secondController));
        vm.expectRevert(PumpGraduationController.PendingAdminMismatch.selector);
        secondController.acceptProtocolAdmin();
        assertEq(secondPump.admin(), address(this), "partial handover rolled back");

        secondRouter.transferAdmin(address(secondController));
        vm.prank(USER);
        secondController.acceptProtocolAdmin();
        assertEq(secondPump.admin(), address(secondController), "controller accepted Pump admin");
        assertEq(secondRouter.admin(), address(secondController), "controller accepted router admin");
    }

    function testGovernanceCanPauseOnlyGraduationsWithoutPausingPump() public {
        controller.setGraduationsPaused(true);
        assertTrue(controller.graduationsPaused(), "graduations paused");
        assertFalse(pump.paused(), "Pump remains active");

        _readyMarket();
        vm.expectRevert(PumpGraduationController.GraduationsPaused.selector);
        controller.graduateReady(address(pumpToken));

        controller.setGraduationsPaused(false);
        vm.prank(USER);
        controller.graduateReady(address(pumpToken));
        assertEq(uint256(pump.status(address(pumpToken))), 3, "graduation resumed");
    }

    function _readyMarket() private {
        pump.configureMarket(address(pumpToken), 2, TOKEN_RESERVE, NUSD_LIQUIDITY, TERMINAL_PRICE_WAD);
        pumpToken.mint(address(pump), TOKEN_LIQUIDITY);
        nusd.mint(address(pump), NUSD_LIQUIDITY);
    }
}
