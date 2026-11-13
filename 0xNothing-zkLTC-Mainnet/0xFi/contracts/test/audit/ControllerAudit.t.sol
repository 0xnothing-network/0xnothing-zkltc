// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ZeroXFiFactoryV2 } from "../../src/amm/ZeroXFiFactoryV2.sol";
import { WzkLTC } from "../../src/amm/WzkLTC.sol";
import { ZeroXFiGraduationAdapter } from "../../src/graduation/ZeroXFiGraduationAdapter.sol";
import { PumpGraduationController } from "../../src/graduation/PumpGraduationController.sol";
import { TestBase } from "../helpers/TestBase.sol";
import { MockERC20 } from "../mocks/TokenMocks.sol";

/// The two-step admin of the core Pump and of its graduation router (contracts/src/common/TwoStepAdmin.sol).
contract TwoStepAdminMock {
    address public admin;
    address public pendingAdmin;

    constructor() {
        admin = msg.sender;
    }

    function transferAdmin(address newAdmin) external {
        require(msg.sender == admin, "ONLY_ADMIN");
        pendingAdmin = newAdmin;
    }

    function acceptAdmin() external {
        require(msg.sender == pendingAdmin, "ONLY_PENDING");
        admin = pendingAdmin;
        pendingAdmin = address(0);
    }
}

contract AdminPumpMock is TwoStepAdminMock {
    address public immutable NUSD;
    address public graduationRouter;
    bool public paused;

    constructor(address nusd) {
        NUSD = nusd;
    }

    function setPaused(bool newPaused) external {
        require(msg.sender == admin, "ONLY_ADMIN");
        paused = newPaused;
    }

    function setGraduationRouter(address router) external {
        graduationRouter = router;
    }

    function status(address) external pure returns (uint256) {
        return 0;
    }
}

contract AdminRouterMock is TwoStepAdminMock {
    address public immutable pump;

    constructor(address pump_) {
        pump = pump_;
    }
}

/// Review finding R-F-03 of the 2026-11 audit. The deploy script hands the Pump admin and the
/// graduation router admin to the controller in three transactions: two transfers and one
/// acceptProtocolAdmin(). The controller's single accept functions are open to anyone, and
/// acceptProtocolAdmin() used to revert unless both transfers were still pending, so one call by a
/// stranger between the transactions stopped the deployment. It now completes whatever is pending.
contract ControllerAuditTest is TestBase {
    address private constant GOVERNANCE = address(0x60);
    address private constant GUARDIAN = address(0x6A);
    address private constant STRANGER = address(0xBAD);

    AdminPumpMock private pump;
    AdminRouterMock private pumpRouter;
    PumpGraduationController private controller;

    function setUp() public {
        MockERC20 nusd = new MockERC20("Nothing USD", "NUSD");
        pump = new AdminPumpMock(address(nusd));
        pumpRouter = new AdminRouterMock(address(pump));
        pump.setGraduationRouter(address(pumpRouter));
        ZeroXFiFactoryV2 factory = new ZeroXFiFactoryV2(address(this), address(nusd), address(new WzkLTC()), address(pump));
        ZeroXFiGraduationAdapter adapter =
            new ZeroXFiGraduationAdapter(address(factory), address(pumpRouter), address(nusd), address(pump));
        factory.bindGraduationAdapter(address(adapter));
        controller = new PumpGraduationController(address(pump), address(adapter), GOVERNANCE, GUARDIAN);
    }

    function _handedOver() private view returns (bool) {
        return pump.admin() == address(controller) && pumpRouter.admin() == address(controller);
    }

    function testAudit_RF03_acceptsBothWhenBothArePending() public {
        pump.transferAdmin(address(controller));
        pumpRouter.transferAdmin(address(controller));
        controller.acceptProtocolAdmin();
        assertTrue(_handedOver(), "both handed over");
    }

    function testAudit_RF03_aStrangerAcceptingOneSideDoesNotStopTheOther() public {
        pump.transferAdmin(address(controller));
        vm.prank(STRANGER);
        controller.acceptPumpAdmin(); // lands between the script's transactions
        pumpRouter.transferAdmin(address(controller));
        vm.prank(STRANGER);
        controller.acceptRouterAdmin();
        assertTrue(_handedOver(), "the stranger only did the script's work");
        controller.acceptProtocolAdmin(); // the script's own call still goes through
        assertTrue(_handedOver(), "and changes nothing");
    }

    function testAudit_RF03_completesTheSideThatIsStillPending() public {
        pump.transferAdmin(address(controller));
        pumpRouter.transferAdmin(address(controller));
        vm.prank(STRANGER);
        controller.acceptPumpAdmin();
        assertEq(pumpRouter.admin(), address(this), "router not accepted yet");
        controller.acceptProtocolAdmin();
        assertTrue(_handedOver(), "the remaining side was accepted");
    }

    function testAudit_RF03_stillRevertsWhenASideWasNeverOffered() public {
        pump.transferAdmin(address(controller));
        vm.expectRevert(PumpGraduationController.PendingAdminMismatch.selector);
        controller.acceptProtocolAdmin();
        assertEq(pump.admin(), address(this), "nothing was accepted half-way");
    }

    /// Finding R2-F-01 of the second review. setPumpPaused(false) also wrote the graduation pause,
    /// so reopening the Pump silently lifted a graduation pause that governance had set for
    /// another reason. Pausing the Pump still holds graduations; reopening it leaves that pause
    /// alone, and it is lifted by its own call.
    function testAudit_R2F01_reopeningThePumpDoesNotLiftTheGraduationPause() public {
        pump.transferAdmin(address(controller));
        pumpRouter.transferAdmin(address(controller));
        controller.acceptProtocolAdmin();

        vm.startPrank(GOVERNANCE);
        controller.setGraduationsPaused(true); // a doubt about the adapter: graduations only
        controller.setPumpPaused(true); // later, for another reason
        assertTrue(pump.paused(), "the Pump is paused");
        controller.setPumpPaused(false);
        vm.stopPrank();
        assertFalse(pump.paused(), "the Pump is open again");
        assertTrue(controller.graduationsPaused(), "the graduation pause still stands");

        vm.startPrank(GOVERNANCE);
        controller.setGraduationsPaused(false);
        controller.setPumpPaused(true);
        assertTrue(controller.graduationsPaused(), "pausing the Pump holds graduations too");
        controller.setPumpPaused(false);
        assertTrue(controller.graduationsPaused(), "reopening it does not release them");
        controller.setGraduationsPaused(false);
        vm.stopPrank();
        assertFalse(controller.graduationsPaused(), "they are released by their own call");
    }
}
