// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DIAOracleAdapter} from "../src/nusd/DIAOracleAdapter.sol";
import {OracleNUSD} from "../src/nusd/OracleNUSD.sol";
import {ZeroXPump} from "../src/pump/ZeroXPump.sol";
import {GraduationRouter} from "../src/graduation/GraduationRouter.sol";
import {PermanentLiquidityLocker} from "../src/graduation/PermanentLiquidityLocker.sol";

interface VmDeploy {
    function addr(uint256 privateKey) external returns (address keyAddress);
    function envUint(string calldata key) external returns (uint256 value);
    function envAddress(string calldata key) external returns (address value);
    function envBool(string calldata key) external returns (bool value);
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
    function serializeString(string calldata objectKey, string calldata valueKey, string calldata value)
        external
        returns (string memory json);
    function writeJson(string calldata json, string calldata path) external;
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}

contract DeployMainnet {
    error MainnetReleaseNotApproved();
    error InvalidExpectedChainId(uint256 chainId);
    error WrongChain(uint256 expectedChainId, uint256 actualChainId);
    error UnexpectedOracleNusdConfiguration();
    error UnexpectedPumpConfiguration();
    error UnsafeInitialGraduationState();

    VmDeploy private constant vm = VmDeploy(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 public constant PUMP_INITIAL_MARKET_CAP_NUSD = 1_500 ether;
    uint256 public constant PUMP_GRADUATION_MARKET_CAP_NUSD = 6_000 ether;
    uint256 public constant PUMP_GRADUATION_RESERVE_NUSD = 1_500 ether;
    uint256 public constant NUSD_SUPPLY_CEILING = type(uint256).max;

    struct Deployment {
        DIAOracleAdapter oracle;
        OracleNUSD oracleNusd;
        PermanentLiquidityLocker locker;
        GraduationRouter router;
        ZeroXPump pump;
    }

    event DeploymentCompleted(
        uint256 indexed chainId,
        address indexed pump,
        address indexed oracleNusd,
        address diaOracleAdapter,
        address router,
        address locker,
        address protocolAdmin,
        uint256 supplyCeilingNusd
    );

    function run() external returns (Deployment memory deployment) {
        uint256 expectedChainId = vm.envUint("EXPECTED_MAINNET_CHAIN_ID");
        if (!vm.envBool("MAINNET_RELEASE_APPROVED")) revert MainnetReleaseNotApproved();
        if (expectedChainId == 0 || expectedChainId == 4441 || expectedChainId == 31_337) {
            revert InvalidExpectedChainId(expectedChainId);
        }
        if (block.chainid != expectedChainId) revert WrongChain(expectedChainId, block.chainid);

        uint256 privateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(privateKey);
        address protocolAdmin = vm.envOr("PROTOCOL_ADMIN", deployer);
        address diaFeed = vm.envAddress("DIA_LTC_USD_FEED");
        uint256 maxPriceAge = vm.envOr("DIA_MAX_PRICE_AGE", uint256(90 minutes));
        uint256 routerDelay = vm.envOr("GRADUATION_TIMELOCK", uint256(7 days));
        uint256 totalSupply = vm.envOr("PUMP_TOKEN_TOTAL_SUPPLY", uint256(1_000_000_000 ether));

        vm.startBroadcast(privateKey);

        deployment.oracle = new DIAOracleAdapter(diaFeed, maxPriceAge);
        deployment.oracleNusd = new OracleNUSD(deployment.oracle, protocolAdmin, NUSD_SUPPLY_CEILING);

        deployment.locker = new PermanentLiquidityLocker(deployer);
        deployment.router = new GraduationRouter(deployer, routerDelay, address(deployment.locker));
        deployment.pump = new ZeroXPump(
            address(deployment.oracleNusd),
            address(deployment.oracleNusd),
            address(deployment.router),
            protocolAdmin,
            totalSupply,
            PUMP_INITIAL_MARKET_CAP_NUSD,
            PUMP_GRADUATION_MARKET_CAP_NUSD
        );
        if (deployment.pump.graduationReserveThresholdNusd() != PUMP_GRADUATION_RESERVE_NUSD) {
            revert MainnetReleaseNotApproved();
        }
        deployment.router.bindPump(address(deployment.pump));
        deployment.locker.bindRouter(address(deployment.router));

        if (
            address(deployment.oracleNusd.oracle()) != address(deployment.oracle)
                || deployment.oracleNusd.vault() != address(deployment.oracleNusd)
                || deployment.oracleNusd.supplyCeilingNusd() != NUSD_SUPPLY_CEILING
                || deployment.oracleNusd.mintPaused() || deployment.oracleNusd.redeemPaused()
        ) revert UnexpectedOracleNusdConfiguration();
        if (
            deployment.pump.initialVirtualNusdReserve() != PUMP_INITIAL_MARKET_CAP_NUSD
                || deployment.pump.graduationThresholdNusd() != PUMP_GRADUATION_MARKET_CAP_NUSD
                || deployment.pump.graduationReserveThresholdNusd() != PUMP_GRADUATION_RESERVE_NUSD
                || deployment.pump.createFee() != 1 ether || deployment.pump.tradeFeeBps() != 10
                || deployment.pump.paused()
        ) revert UnexpectedPumpConfiguration();
        if (deployment.router.enabled() || deployment.router.enableAt() != 0) {
            revert UnsafeInitialGraduationState();
        }

        if (protocolAdmin != deployer) {
            deployment.router.transferAdmin(protocolAdmin);
        }

        vm.stopBroadcast();
        _writeManifest(deployment, protocolAdmin);
    }

    function _writeManifest(Deployment memory deployment, address protocolAdmin) private {
        string memory objectKey = "deployment";
        vm.serializeBool(objectKey, "broadcasted", false);
        vm.serializeUint(objectKey, "chainId", block.chainid);
        vm.serializeUint(objectKey, "scriptExecutionBlock", block.number);
        vm.serializeAddress(objectKey, "oracleNusd", address(deployment.oracleNusd));
        vm.serializeAddress(objectKey, "nusd", address(deployment.oracleNusd));
        vm.serializeAddress(objectKey, "vault", address(deployment.oracleNusd));
        vm.serializeAddress(objectKey, "oracle", address(deployment.oracle));
        vm.serializeUint(objectKey, "supplyCeilingNusd", deployment.oracleNusd.supplyCeilingNusd());
        vm.serializeBool(objectKey, "mintPaused", deployment.oracleNusd.mintPaused());
        vm.serializeBool(objectKey, "redeemPaused", deployment.oracleNusd.redeemPaused());
        vm.serializeString(objectKey, "riskModelVersion", "oracle-nusd-v1");
        vm.serializeString(objectKey, "riskModel", "oracle-priced-native-reserve");
        vm.serializeString(objectKey, "vaultCompatibility", "self");
        vm.serializeAddress(objectKey, "locker", address(deployment.locker));
        vm.serializeAddress(objectKey, "router", address(deployment.router));
        vm.serializeAddress(objectKey, "protocolAdmin", protocolAdmin);
        vm.serializeUint(objectKey, "initialMarketCapNusd", PUMP_INITIAL_MARKET_CAP_NUSD);
        vm.serializeUint(objectKey, "graduationMarketCapNusd", PUMP_GRADUATION_MARKET_CAP_NUSD);
        vm.serializeUint(objectKey, "graduationReserveNusd", PUMP_GRADUATION_RESERVE_NUSD);
        vm.serializeBool(objectKey, "graduationEnabled", false);
        string memory json = vm.serializeAddress(objectKey, "pump", address(deployment.pump));
        vm.writeJson(json, "./deployments/latest.json");

        emit DeploymentCompleted(
            block.chainid,
            address(deployment.pump),
            address(deployment.oracleNusd),
            address(deployment.oracle),
            address(deployment.router),
            address(deployment.locker),
            protocolAdmin,
            deployment.oracleNusd.supplyCeilingNusd()
        );
    }
}
