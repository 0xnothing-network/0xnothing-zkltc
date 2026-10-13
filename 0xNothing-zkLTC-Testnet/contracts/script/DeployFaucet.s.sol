// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestnetFaucet} from "../src/nusd/TestnetFaucet.sol";

interface VmFaucet {
    function addr(uint256 privateKey) external returns (address keyAddress);
    function envUint(string calldata key) external returns (uint256 value);
    function envOr(string calldata key, address defaultValue) external returns (address value);
    function envOr(string calldata key, uint256 defaultValue) external returns (uint256 value);
    function serializeAddress(string calldata objectKey, string calldata valueKey, address value)
        external
        returns (string memory json);
    function serializeUint(string calldata objectKey, string calldata valueKey, uint256 value)
        external
        returns (string memory json);
    function serializeBool(string calldata objectKey, string calldata valueKey, bool value)
        external
        returns (string memory json);
    function writeJson(string calldata json, string calldata path) external;
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}

/// @notice Separate LiteForge faucet deploy. Do not pass `--broadcast` until approved.
contract DeployFaucet {
    error WrongChain(uint256 expectedChainId, uint256 actualChainId);
    error InvalidFaucetParameters();
    error InvalidNusd();

    VmFaucet private constant vm = VmFaucet(address(uint160(uint256(keccak256("hevm cheat code")))));

    address public constant DEFAULT_NUSD = 0x677D63c78E77E0b1971530e1494Caee4Bd7d631e;
    uint256 public constant DEFAULT_NATIVE_DRIP = 0.05 ether;
    uint256 public constant DEFAULT_NUSD_DRIP = 25 ether;
    uint256 public constant DEFAULT_COOLDOWN = 8 hours;
    uint256 public constant DEFAULT_DAILY_NATIVE_CAP = 2 ether;
    uint256 public constant DEFAULT_DAILY_NUSD_CAP = 1_000 ether;

    event FaucetDeployed(address indexed faucet, address indexed nusd, address indexed admin);

    function run() external returns (TestnetFaucet faucet) {
        if (block.chainid != 4441) revert WrongChain(4441, block.chainid);

        uint256 privateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(privateKey);
        address protocolAdmin = vm.envOr("PROTOCOL_ADMIN", deployer);
        address nusd = vm.envOr("NUSD_ADDRESS", DEFAULT_NUSD);
        uint256 nativeDrip = vm.envOr("FAUCET_NATIVE_DRIP", DEFAULT_NATIVE_DRIP);
        uint256 nusdDrip = vm.envOr("FAUCET_NUSD_DRIP", DEFAULT_NUSD_DRIP);
        uint256 cooldownSeconds = vm.envOr("FAUCET_COOLDOWN", DEFAULT_COOLDOWN);
        uint256 dailyNativeCap = vm.envOr("FAUCET_DAILY_NATIVE_CAP", DEFAULT_DAILY_NATIVE_CAP);
        uint256 dailyNusdCap = vm.envOr("FAUCET_DAILY_NUSD_CAP", DEFAULT_DAILY_NUSD_CAP);

        validateFaucetParameters(nusd, nativeDrip, nusdDrip, cooldownSeconds, dailyNativeCap, dailyNusdCap);

        vm.startBroadcast(privateKey);
        faucet = new TestnetFaucet(
            nusd, protocolAdmin, nativeDrip, nusdDrip, cooldownSeconds, dailyNativeCap, dailyNusdCap
        );
        vm.stopBroadcast();

        if (faucet.nusd() != nusd || faucet.admin() != protocolAdmin) revert InvalidFaucetParameters();
        _writeManifest(faucet, protocolAdmin, nusd);
        emit FaucetDeployed(address(faucet), nusd, protocolAdmin);
    }

    function validateFaucetParameters(
        address nusd,
        uint256 nativeDrip,
        uint256 nusdDrip,
        uint256 cooldownSeconds,
        uint256 dailyNativeCap,
        uint256 dailyNusdCap
    ) public pure {
        if (nusd == address(0)) revert InvalidNusd();
        if (
            nativeDrip == 0 || nusdDrip == 0 || cooldownSeconds < 1 minutes || cooldownSeconds > 7 days
                || dailyNativeCap < nativeDrip || dailyNusdCap < nusdDrip
        ) revert InvalidFaucetParameters();
    }

    function _writeManifest(TestnetFaucet faucet, address protocolAdmin, address nusd) private {
        string memory objectKey = "faucet";
        vm.serializeBool(objectKey, "broadcasted", false);
        vm.serializeUint(objectKey, "chainId", block.chainid);
        vm.serializeAddress(objectKey, "nusd", nusd);
        vm.serializeAddress(objectKey, "admin", protocolAdmin);
        vm.serializeUint(objectKey, "nativeDrip", faucet.nativeDrip());
        vm.serializeUint(objectKey, "nusdDrip", faucet.nusdDrip());
        vm.serializeUint(objectKey, "cooldownSeconds", faucet.cooldownSeconds());
        vm.serializeUint(objectKey, "dailyNativeCap", faucet.dailyNativeCap());
        vm.serializeUint(objectKey, "dailyNusdCap", faucet.dailyNusdCap());
        string memory json = vm.serializeAddress(objectKey, "faucet", address(faucet));
        vm.writeJson(json, "./deployments/faucet.json");
    }
}
