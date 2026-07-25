// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {NUSD} from "../src/nusd/NUSD.sol";
import {DIAOracleAdapter} from "../src/nusd/DIAOracleAdapter.sol";
import {NativeCollateralVault} from "../src/nusd/NativeCollateralVault.sol";
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
    function writeJson(string calldata json, string calldata path) external;
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}

contract DeployMainnet {
    error MainnetReleaseNotApproved();
    error InvalidExpectedChainId(uint256 chainId);
    error WrongChain(uint256 expectedChainId, uint256 actualChainId);

    VmDeploy private constant vm = VmDeploy(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 public constant PUMP_INITIAL_MARKET_CAP_NUSD = 1_500 ether;
    uint256 public constant PUMP_GRADUATION_MARKET_CAP_NUSD = 6_000 ether;
    uint256 public constant PUMP_GRADUATION_RESERVE_NUSD = 1_500 ether;

    struct Deployment {
        NUSD nusd;
        DIAOracleAdapter oracle;
        NativeCollateralVault vault;
        PermanentLiquidityLocker locker;
        GraduationRouter router;
        ZeroXPump pump;
    }

    event DeploymentCompleted(
        uint256 indexed chainId,
        address indexed pump,
        address indexed nusd,
        address vault,
        address oracle,
        address router,
        address locker,
        address protocolAdmin
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
        uint256 debtCeilingNusd = vm.envUint("NUSD_DEBT_CEILING");
        uint256 totalSupply = vm.envOr("PUMP_TOKEN_TOTAL_SUPPLY", uint256(1_000_000_000 ether));

        vm.startBroadcast(privateKey);

        deployment.nusd = new NUSD(deployer);
        deployment.oracle = new DIAOracleAdapter(diaFeed, maxPriceAge);
        deployment.vault = new NativeCollateralVault(
            address(deployment.nusd),
            address(deployment.oracle),
            protocolAdmin,
            17_500,
            15_000,
            800,
            5_000,
            debtCeilingNusd
        );
        deployment.nusd.bindVault(address(deployment.vault));

        deployment.locker = new PermanentLiquidityLocker(deployer);
        deployment.router = new GraduationRouter(deployer, routerDelay, address(deployment.locker));
        deployment.pump = new ZeroXPump(
            address(deployment.nusd),
            address(deployment.vault),
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
        vm.serializeAddress(objectKey, "nusd", address(deployment.nusd));
        vm.serializeAddress(objectKey, "oracle", address(deployment.oracle));
        vm.serializeAddress(objectKey, "vault", address(deployment.vault));
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
            address(deployment.nusd),
            address(deployment.vault),
            address(deployment.oracle),
            address(deployment.router),
            address(deployment.locker),
            protocolAdmin
        );
    }
}
