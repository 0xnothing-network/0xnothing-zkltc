// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface VmActivateGraduation {
    function envUint(string calldata key) external returns (uint256 value);
    function envAddress(string calldata key) external returns (address value);
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}

interface IPumpGraduationRouterActivation {
    function enabled() external view returns (bool);
    function enableAt() external view returns (uint256);
    function isAdapterAllowed(address adapter) external view returns (bool);
    function adapterActivationTime(address adapter) external view returns (uint256);
    function activateAdapter(address adapter) external;
    function enableRouter() external;
}

/// @notice Opens Pump graduation once the router delay scheduled by Deploy0xFiMainnet has passed.
///         Both calls are open to anyone, so any funded key can run this; it holds no privilege.
contract ActivateGraduationMainnet {
    error UnexpectedConfiguration(string what);
    /// @dev The times the two calls become available; zero means that one was never scheduled.
    error NotOpenYet(uint256 adapterAvailableAt, uint256 routerAvailableAt, uint256 currentTime);
    error WrongChain(uint256 expectedChainId, uint256 actualChainId);

    VmActivateGraduation private constant vm =
        VmActivateGraduation(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 private constant TESTNET_CHAIN_ID = 4441;

    function run() external {
        uint256 expectedChainId = vm.envUint("MAINNET_CHAIN_ID");
        if (expectedChainId == TESTNET_CHAIN_ID || block.chainid != expectedChainId) {
            revert WrongChain(expectedChainId, block.chainid);
        }
        IPumpGraduationRouterActivation router =
            IPumpGraduationRouterActivation(vm.envAddress("MAINNET_PUMP_GRADUATION_ROUTER"));
        address adapter = vm.envAddress("MAINNET_PUMP_GRADUATION_ADAPTER");

        // Say when, instead of letting the router's own check fail with an error this root cannot name.
        uint256 adapterAt = router.adapterActivationTime(adapter);
        uint256 routerAt = router.enableAt();
        // forge-lint: disable-next-line(block-timestamp)
        bool adapterDue = router.isAdapterAllowed(adapter) || (adapterAt != 0 && block.timestamp >= adapterAt);
        // forge-lint: disable-next-line(block-timestamp)
        bool routerDue = router.enabled() || (routerAt != 0 && block.timestamp >= routerAt);
        if (!adapterDue || !routerDue) revert NotOpenYet(adapterAt, routerAt, block.timestamp);

        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));
        if (!router.isAdapterAllowed(adapter)) router.activateAdapter(adapter);
        if (!router.enabled()) router.enableRouter();
        vm.stopBroadcast();

        if (!router.enabled() || !router.isAdapterAllowed(adapter)) revert UnexpectedConfiguration("graduation is not open");
    }
}
