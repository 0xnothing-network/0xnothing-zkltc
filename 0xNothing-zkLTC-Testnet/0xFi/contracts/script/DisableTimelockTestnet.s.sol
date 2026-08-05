// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { TimelockController } from "@openzeppelin/contracts/governance/TimelockController.sol";

import { PumpGraduationController } from "../src/graduation/PumpGraduationController.sol";

interface VmDisableTimelock {
    function addr(uint256 privateKey) external returns (address keyAddress);
    function envUint(string calldata key) external returns (uint256 value);
    function serializeAddress(string calldata objectKey, string calldata valueKey, address value)
        external
        returns (string memory json);
    function serializeBool(string calldata objectKey, string calldata valueKey, bool value)
        external
        returns (string memory json);
    function serializeBytes32(string calldata objectKey, string calldata valueKey, bytes32 value)
        external
        returns (string memory json);
    function serializeString(string calldata objectKey, string calldata valueKey, string calldata value)
        external
        returns (string memory json);
    function serializeUint(string calldata objectKey, string calldata valueKey, uint256 value)
        external
        returns (string memory json);
    function writeJson(string calldata json, string calldata path) external;
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}

interface IOwnable2StepDirect {
    function owner() external view returns (address);
    function pendingOwner() external view returns (address);
    function transferOwnership(address newOwner) external;
}

interface IPumpDirectAdmin {
    function admin() external view returns (address);
    function pendingAdmin() external view returns (address);
    function transferAdmin(address newAdmin) external;
}

interface IPumpRouterDirectAdmin {
    function admin() external view returns (address);
    function pendingAdmin() external view returns (address);
    function enabled() external view returns (bool);
    function isAdapterAllowed(address adapter) external view returns (bool);
    function enableAt() external view returns (uint256);
    function adapterActivationTime(address adapter) external view returns (uint256);
    function activateAdapter(address adapter) external;
    function enableRouter() external;
    function transferAdmin(address newAdmin) external;
}

/// @notice Testnet-only migration that keeps the deployer as direct protocol owner and governance.
contract DisableTimelockTestnet {
    error InvalidState();
    error RouterNotReady(uint256 readyAt, uint256 currentTime);
    error WrongChain(uint256 expectedChainId, uint256 actualChainId);
    error WrongDeployer(address expected, address actual);

    VmDisableTimelock private constant vm = VmDisableTimelock(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 private constant CHAIN_ID = 4441;
    address private constant DEPLOYER = 0x58633401dCc383F010688e950878000000000000;
    address private constant TIMELOCK = 0x5F4145733F1B7Eb25f176A9B95e27fB6E2205F22;
    address private constant PUMP = 0x4a0Eaf310e3659aA9B360fD44e90208c31Dbe0e2;
    address private constant ROUTER = 0xDCf571C4b03A86c5e15B48864C1aCbB6A8085904;
    address private constant ADAPTER = 0x935e05f60a05110c29eFA7e3a632dfe38123963e;

    bytes32 private constant CORE_OPERATION = 0xd8a32ab2cb94461c5ec7f74380beea9b0d1a17bb98797fd46920d1c32d69c057;
    bytes32 private constant MIGRATION_OPERATION = 0x0c33b8c3b0536dd89e9763e43752f749f41ab936fa55881e59126ef24205cd8e;

    address private constant DEX_FACTORY = 0xe33fE815c2e12DC83b69397CeD12b09849Fa9C0D;
    address private constant LEGACY_GAUGE_FACTORY = 0x61A6F5Bc18E1FD4788195062A2C9fB3D79c7A129;
    address private constant LEGACY_NBTC_VAULT = 0xda3056c2954111d90584B49DA7919F904104aa84;
    address private constant LEGACY_NETH_VAULT = 0x499EbE48882b94bbE9A7CE60b977B9eDf621eDEf;
    address private constant LEGACY_LENDING = 0x34576B88603eDEbD364A4824d6F6d23bd785fF72;
    address private constant GAUGE_FACTORY = 0x36F425fddc59d281c6ddEaDAc34B32E6f039EB13;
    address private constant NBTC_VAULT = 0x620fB32a1e113aA3D1121baC0c65f919569dF1d3;
    address private constant NETH_VAULT = 0xA7dA20a8a0d833eFcc0B2ca8189011FCFeab7465;
    address private constant LENDING = 0x123b46508E2265E93172519F71fa02de6E68053B;

    function run() external returns (PumpGraduationController controller) {
        if (block.chainid != CHAIN_ID) revert WrongChain(CHAIN_ID, block.chainid);
        uint256 privateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(privateKey);
        if (deployer != DEPLOYER) revert WrongDeployer(DEPLOYER, deployer);

        IPumpRouterDirectAdmin router = IPumpRouterDirectAdmin(ROUTER);
        uint256 readyAt = router.enableAt();
        uint256 adapterAt = router.adapterActivationTime(ADAPTER);
        // Activation readiness is defined by the router's onchain timelock.
        // forge-lint: disable-next-line(block-timestamp)
        if (!router.enabled() && (readyAt == 0 || block.timestamp < readyAt)) {
            revert RouterNotReady(readyAt, block.timestamp);
        }
        // forge-lint: disable-next-line(block-timestamp)
        if (!router.isAdapterAllowed(ADAPTER) && (adapterAt == 0 || block.timestamp < adapterAt)) {
            revert RouterNotReady(adapterAt, block.timestamp);
        }

        address[] memory ownedTargets = _ownedTargets();
        _requireDirectOwnershipState(ownedTargets);
        IPumpDirectAdmin pump = IPumpDirectAdmin(PUMP);
        if (
            pump.admin() != DEPLOYER || router.admin() != DEPLOYER || pump.pendingAdmin() != address(0)
                || router.pendingAdmin() != address(0)
        ) revert InvalidState();

        vm.startBroadcast(privateKey);

        TimelockController timelock = TimelockController(payable(TIMELOCK));
        if (timelock.isOperationPending(CORE_OPERATION)) timelock.cancel(CORE_OPERATION);
        if (timelock.isOperationPending(MIGRATION_OPERATION)) timelock.cancel(MIGRATION_OPERATION);

        for (uint256 i; i < ownedTargets.length; ++i) {
            IOwnable2StepDirect target = IOwnable2StepDirect(ownedTargets[i]);
            if (target.pendingOwner() != address(0)) target.transferOwnership(address(0));
        }

        controller = new PumpGraduationController(PUMP, ADAPTER, DEPLOYER, DEPLOYER);

        if (!router.isAdapterAllowed(ADAPTER)) router.activateAdapter(ADAPTER);
        if (!router.enabled()) router.enableRouter();

        pump.transferAdmin(address(controller));
        router.transferAdmin(address(controller));
        controller.acceptProtocolAdmin();

        vm.stopBroadcast();

        _validate(controller, ownedTargets, timelock, pump, router);
        _writeResult(controller);
    }

    function _ownedTargets() private pure returns (address[] memory targets) {
        targets = new address[](9);
        targets[0] = DEX_FACTORY;
        targets[1] = LEGACY_GAUGE_FACTORY;
        targets[2] = LEGACY_NBTC_VAULT;
        targets[3] = LEGACY_NETH_VAULT;
        targets[4] = LEGACY_LENDING;
        targets[5] = GAUGE_FACTORY;
        targets[6] = NBTC_VAULT;
        targets[7] = NETH_VAULT;
        targets[8] = LENDING;
    }

    function _requireDirectOwnershipState(address[] memory targets) private view {
        for (uint256 i; i < targets.length; ++i) {
            IOwnable2StepDirect target = IOwnable2StepDirect(targets[i]);
            if (target.owner() != DEPLOYER) revert InvalidState();
            address pending = target.pendingOwner();
            if (pending != address(0) && pending != TIMELOCK) revert InvalidState();
        }
    }

    function _validate(
        PumpGraduationController controller,
        address[] memory targets,
        TimelockController timelock,
        IPumpDirectAdmin pump,
        IPumpRouterDirectAdmin router
    ) private view {
        if (timelock.isOperationPending(CORE_OPERATION) || timelock.isOperationPending(MIGRATION_OPERATION)) {
            revert InvalidState();
        }
        for (uint256 i; i < targets.length; ++i) {
            IOwnable2StepDirect target = IOwnable2StepDirect(targets[i]);
            if (target.owner() != DEPLOYER || target.pendingOwner() != address(0)) revert InvalidState();
        }
        if (
            controller.governance() != DEPLOYER || controller.guardian() != DEPLOYER
                || address(controller.pump()) != PUMP || address(controller.adapter()) != ADAPTER
                || address(controller.router()) != ROUTER || pump.admin() != address(controller)
                || router.admin() != address(controller) || pump.pendingAdmin() != address(0)
                || router.pendingAdmin() != address(0) || !router.enabled() || !router.isAdapterAllowed(ADAPTER)
        ) revert InvalidState();
    }

    function _writeResult(PumpGraduationController controller) private {
        string memory key = "directGovernance";
        vm.serializeBool(key, "broadcasted", false);
        vm.serializeUint(key, "chainId", CHAIN_ID);
        vm.serializeUint(key, "scriptExecutionBlock", block.number);
        vm.serializeAddress(key, "deployer", DEPLOYER);
        vm.serializeAddress(key, "governance", DEPLOYER);
        vm.serializeAddress(key, "guardian", DEPLOYER);
        vm.serializeAddress(key, "pumpGraduationController", address(controller));
        vm.serializeBytes32(key, "cancelledCoreOperationId", CORE_OPERATION);
        vm.serializeBytes32(key, "cancelledMigrationOperationId", MIGRATION_OPERATION);
        vm.serializeString(key, "status", "direct-governance-prediction");
        string memory json = vm.serializeString(key, "governanceMode", "direct-deployer-no-timelock");
        vm.writeJson(json, "./deployments/direct-governance.json");
    }
}
