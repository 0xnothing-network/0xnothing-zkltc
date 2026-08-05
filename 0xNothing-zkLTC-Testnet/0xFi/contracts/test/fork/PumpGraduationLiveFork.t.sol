// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IControlledZeroXPump, PumpGraduationController } from "../../src/graduation/PumpGraduationController.sol";
import { TestBase } from "../TestBase.sol";

interface ILivePumpGraduation {
    function admin() external view returns (address);
    function getAllTokens() external view returns (address[] memory);
    function status(address token) external view returns (uint8);
    function transferAdmin(address newAdmin) external;
}

interface ILiveGraduationRouter {
    function admin() external view returns (address);
    function enabled() external view returns (bool);
    function enableAt() external view returns (uint256);
    function adapterActivationTime(address adapter) external view returns (uint256);
    function isAdapterAllowed(address adapter) external view returns (bool);
    function scheduleAdapter(address adapter) external;
    function activateAdapter(address adapter) external;
    function scheduleEnable() external;
    function enableRouter() external;
    function transferAdmin(address newAdmin) external;
}

contract PumpGraduationLiveForkTest is TestBase {
    address private constant PUMP = 0x4a0Eaf310e3659aA9B360fD44e90208c31Dbe0e2;
    address private constant ROUTER = 0xDCf571C4b03A86c5e15B48864C1aCbB6A8085904;
    address private constant ADAPTER = 0x935e05f60a05110c29eFA7e3a632dfe38123963e;
    address private constant TIMELOCK = 0x5F4145733F1B7Eb25f176A9B95e27fB6E2205F22;
    address private constant GUARDIAN = address(0xCAFE);
    address private constant CALLER = address(0xBEEF);

    function testLiveReadyMarketGraduatesOnFork() public {
        string memory rpcUrl = vm.envOr("LITVM_FORK_RPC_URL", string(""));
        if (bytes(rpcUrl).length == 0) return;
        vm.createSelectFork(rpcUrl);

        ILivePumpGraduation pump = ILivePumpGraduation(PUMP);
        ILiveGraduationRouter router = ILiveGraduationRouter(ROUTER);
        address currentAdmin = pump.admin();
        assertEq(router.admin(), currentAdmin, "Pump and router admin mismatch");

        PumpGraduationController controller = new PumpGraduationController(PUMP, ADAPTER, TIMELOCK, GUARDIAN);
        _activateRouter(router, currentAdmin);

        vm.prank(currentAdmin);
        pump.transferAdmin(address(controller));
        vm.prank(currentAdmin);
        router.transferAdmin(address(controller));
        vm.prank(CALLER);
        controller.acceptProtocolAdmin();

        address token = _firstReadyToken(pump);
        PumpGraduationController.GraduationPreview memory preview = controller.previewGraduation(token);
        assertTrue(preview.ready, "fork market is not READY");
        assertGt(preview.expectedLp, 0, "expected LP is zero");

        vm.prank(CALLER);
        IControlledZeroXPump.GraduationResult memory result = controller.graduateReady(token);
        assertEq(uint256(pump.status(token)), 3, "market did not graduate");
        assertTrue(result.pool.code.length > 0, "pool has no bytecode");
        assertEq(result.lpAmount, preview.expectedLp, "LP output drifted");
    }

    function _activateRouter(ILiveGraduationRouter router, address currentAdmin) private {
        uint256 readyAt = block.timestamp;
        if (!router.isAdapterAllowed(ADAPTER)) {
            uint256 adapterReadyAt = router.adapterActivationTime(ADAPTER);
            if (adapterReadyAt == 0) {
                vm.prank(currentAdmin);
                router.scheduleAdapter(ADAPTER);
                adapterReadyAt = router.adapterActivationTime(ADAPTER);
            }
            readyAt = adapterReadyAt > readyAt ? adapterReadyAt : readyAt;
        }
        if (!router.enabled()) {
            uint256 routerReadyAt = router.enableAt();
            if (routerReadyAt == 0) {
                vm.prank(currentAdmin);
                router.scheduleEnable();
                routerReadyAt = router.enableAt();
            }
            readyAt = routerReadyAt > readyAt ? routerReadyAt : readyAt;
        }
        vm.warp(readyAt);
        if (!router.isAdapterAllowed(ADAPTER)) router.activateAdapter(ADAPTER);
        if (!router.enabled()) router.enableRouter();
    }

    function _firstReadyToken(ILivePumpGraduation pump) private view returns (address readyToken) {
        address[] memory tokens = pump.getAllTokens();
        for (uint256 i; i < tokens.length; ++i) {
            if (pump.status(tokens[i]) == 2) return tokens[i];
        }
        revert("No READY live market");
    }
}
