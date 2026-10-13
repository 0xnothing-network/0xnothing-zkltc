// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MathX} from "../src/common/MathX.sol";
import {DIAOracleAdapter} from "../src/nusd/DIAOracleAdapter.sol";
import {OracleNUSD} from "../src/nusd/OracleNUSD.sol";
import {ZeroXPump} from "../src/pump/ZeroXPump.sol";
import {GraduationRouter} from "../src/graduation/GraduationRouter.sol";
import {PermanentLiquidityLocker} from "../src/graduation/PermanentLiquidityLocker.sol";

interface VmDeploy {
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
    function serializeString(string calldata objectKey, string calldata valueKey, string calldata value)
        external
        returns (string memory json);
    function writeJson(string calldata json, string calldata path) external;
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}

contract DeployTestnet {
    error WrongChain(uint256 expectedChainId, uint256 actualChainId);
    error UnexpectedOracleNusdConfiguration();
    error UnexpectedPumpConfiguration();
    error UnsafeInitialGraduationState();
    error InvalidOracleParameters();
    error InvalidLaunchProtection();
    error InvalidGraduationThresholds();

    VmDeploy private constant vm = VmDeploy(address(uint160(uint256(keccak256("hevm cheat code")))));

    address public constant DEFAULT_DIA_LTC_USD_FEED = 0x45dDa5d881BD2C917976CCfde74fFd6f6412da29;
    uint256 public constant DEFAULT_INITIAL_VIRTUAL_NUSD_RESERVE = 1_500 ether;
    uint256 public constant DEFAULT_GRADUATION_MARKET_CAP_TARGET_NUSD = 6_000 ether;
    uint256 private constant CREATE_FEE_NUSD = 1 ether;
    uint256 private constant TRADE_FEE_BPS = 10;

    struct Deployment {
        DIAOracleAdapter diaOracleAdapter;
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
        if (block.chainid != 4441) revert WrongChain(4441, block.chainid);

        uint256 privateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(privateKey);
        address protocolAdmin = vm.envOr("PROTOCOL_ADMIN", deployer);
        address diaFeed = vm.envOr("DIA_LTC_USD_FEED", DEFAULT_DIA_LTC_USD_FEED);
        // The LiteForge DIA feed publishes roughly every 50 minutes; a shorter window halts mint and redeem.
        uint256 maxPriceAge = vm.envOr("DIA_MAX_PRICE_AGE", uint256(60 minutes));
        uint256 minPriceWad = vm.envOr("DIA_MIN_PRICE_WAD", uint256(1 ether));
        uint256 maxPriceWad = vm.envOr("DIA_MAX_PRICE_WAD", uint256(10_000 ether));
        uint256 maxDeviationBps = vm.envOr("DIA_MAX_DEVIATION_BPS", uint256(2_000));
        uint256 routerDelay = vm.envOr("GRADUATION_TIMELOCK", uint256(2 days));
        uint256 totalSupply = vm.envOr("PUMP_TOKEN_TOTAL_SUPPLY", uint256(1_000_000_000 ether));
        uint256 supplyCeilingNusd = vm.envOr("NUSD_DEBT_CEILING", uint256(1_000_000 ether));
        uint256 launchWindow = vm.envOr("LAUNCH_PROTECTION_WINDOW", uint256(15 minutes));
        uint256 launchMaxBuyNusd = vm.envOr("LAUNCH_MAX_BUY_NUSD", uint256(50 ether));
        uint256 virtualNusdReserve = vm.envOr("PUMP_INITIAL_VIRTUAL_NUSD", DEFAULT_INITIAL_VIRTUAL_NUSD_RESERVE);
        uint256 graduationMarketCapNusd =
            vm.envOr("PUMP_GRADUATION_MARKET_CAP_NUSD", DEFAULT_GRADUATION_MARKET_CAP_TARGET_NUSD);

        validateOracleParameters(maxPriceAge, minPriceWad, maxPriceWad, maxDeviationBps);
        validateLaunchProtection(launchWindow, launchMaxBuyNusd);
        uint256 reserveThresholdNusd = validateGraduationThresholds(virtualNusdReserve, graduationMarketCapNusd);
        uint256 expectedReserveThresholdNusd = vm.envOr("PUMP_GRADUATION_RESERVE_NUSD", reserveThresholdNusd);
        if (expectedReserveThresholdNusd != reserveThresholdNusd) revert InvalidGraduationThresholds();

        vm.startBroadcast(privateKey);

        deployment.diaOracleAdapter =
            new DIAOracleAdapter(diaFeed, maxPriceAge, deployer, minPriceWad, maxPriceWad, maxDeviationBps);
        // Do not call syncPrice() here. The constructor try-arms the deviation
        // breaker when the feed is readable; paris Foundry simulation of shanghai
        // PUSH0 aggregators is swallowed so this script can still run. Mint/redeem
        // call ensureAnchor() on the first consume. `cast send <adapter> "syncPrice()"`
        // remains a fallback. Preflight with `scripts/preflight-testnet-oracle.sh`.
        deployment.oracleNusd = new OracleNUSD(deployment.diaOracleAdapter, protocolAdmin, supplyCeilingNusd);

        deployment.locker = new PermanentLiquidityLocker(deployer);
        deployment.router = new GraduationRouter(deployer, routerDelay, address(deployment.locker));
        deployment.pump = new ZeroXPump(
            address(deployment.oracleNusd),
            address(deployment.oracleNusd),
            address(deployment.router),
            deployer,
            totalSupply,
            virtualNusdReserve,
            graduationMarketCapNusd
        );
        if (launchWindow != 0) {
            deployment.pump.setLaunchProtection(launchWindow, launchMaxBuyNusd);
        }
        deployment.router.bindPump(address(deployment.pump));
        deployment.locker.bindRouter(address(deployment.router));

        if (
            address(deployment.oracleNusd.oracle()) != address(deployment.diaOracleAdapter)
                || deployment.oracleNusd.vault() != address(deployment.oracleNusd)
                || deployment.oracleNusd.supplyCeilingNusd() != supplyCeilingNusd || deployment.oracleNusd.mintPaused()
                || deployment.oracleNusd.redeemPaused()
        ) revert UnexpectedOracleNusdConfiguration();
        if (
            deployment.pump.initialVirtualNusdReserve() != virtualNusdReserve
                || deployment.pump.graduationThresholdNusd() != graduationMarketCapNusd
                || deployment.pump.graduationReserveThresholdNusd() != reserveThresholdNusd
                || deployment.pump.createFee() != CREATE_FEE_NUSD || deployment.pump.tradeFeeBps() != TRADE_FEE_BPS
                || deployment.pump.paused() || deployment.pump.readyExitDelay() != 1 days
                || deployment.pump.permissionlessGraduationDelay() != 1 hours
                || deployment.pump.launchProtectionWindow() != launchWindow
                || deployment.pump.launchMaxBuyNusd() != (launchWindow == 0 ? 0 : launchMaxBuyNusd)
                || deployment.pump.graduationAdapter() != address(0)
        ) revert UnexpectedPumpConfiguration();
        if (deployment.router.enabled() || deployment.router.enableAt() != 0) {
            revert UnsafeInitialGraduationState();
        }

        if (protocolAdmin != deployer) {
            deployment.pump.transferAdmin(protocolAdmin);
            deployment.router.transferAdmin(protocolAdmin);
            deployment.diaOracleAdapter.transferAdmin(protocolAdmin);
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
        vm.serializeAddress(objectKey, "nusdVault", address(deployment.oracleNusd));
        vm.serializeAddress(objectKey, "diaOracleAdapter", address(deployment.diaOracleAdapter));
        vm.serializeUint(objectKey, "supplyCeilingNusd", deployment.oracleNusd.supplyCeilingNusd());
        vm.serializeBool(objectKey, "mintPaused", deployment.oracleNusd.mintPaused());
        vm.serializeBool(objectKey, "redeemPaused", deployment.oracleNusd.redeemPaused());
        vm.serializeString(objectKey, "riskModelVersion", "oracle-nusd-v1");
        vm.serializeString(objectKey, "riskModel", "oracle-priced-native-reserve");
        vm.serializeString(objectKey, "vaultCompatibility", "self");
        vm.serializeBool(objectKey, "legacyPositionsMigrated", false);
        vm.serializeAddress(objectKey, "locker", address(deployment.locker));
        vm.serializeAddress(objectKey, "router", address(deployment.router));
        vm.serializeAddress(objectKey, "protocolAdmin", protocolAdmin);
        vm.serializeUint(objectKey, "initialVirtualNusdReserve", deployment.pump.initialVirtualNusdReserve());
        vm.serializeUint(objectKey, "graduationThresholdNusd", deployment.pump.graduationThresholdNusd());
        vm.serializeUint(objectKey, "graduationReserveThresholdNusd", deployment.pump.graduationReserveThresholdNusd());
        vm.serializeUint(objectKey, "createFeeNusd", deployment.pump.createFee());
        vm.serializeUint(objectKey, "tradeFeeBps", deployment.pump.tradeFeeBps());
        vm.serializeUint(objectKey, "maxPriceAge", deployment.diaOracleAdapter.maxPriceAge());
        vm.serializeUint(objectKey, "minPriceWad", deployment.diaOracleAdapter.minPriceWad());
        vm.serializeUint(objectKey, "maxPriceWad", deployment.diaOracleAdapter.maxPriceWad());
        vm.serializeUint(objectKey, "maxDeviationBps", deployment.diaOracleAdapter.maxDeviationBps());
        vm.serializeUint(objectKey, "permissionlessGraduationDelay", deployment.pump.permissionlessGraduationDelay());
        vm.serializeUint(objectKey, "readyExitDelay", deployment.pump.readyExitDelay());
        vm.serializeUint(objectKey, "launchProtectionWindow", deployment.pump.launchProtectionWindow());
        vm.serializeUint(objectKey, "launchMaxBuyNusd", deployment.pump.launchMaxBuyNusd());
        vm.serializeAddress(objectKey, "graduationAdapter", deployment.pump.graduationAdapter());
        vm.serializeBool(objectKey, "graduationRouterEnabled", deployment.router.enabled());
        vm.serializeUint(objectKey, "graduationRouterEnableAt", deployment.router.enableAt());
        string memory json = vm.serializeAddress(objectKey, "pump", address(deployment.pump));
        vm.writeJson(json, "./deployments/latest.json");

        emit DeploymentCompleted(
            block.chainid,
            address(deployment.pump),
            address(deployment.oracleNusd),
            address(deployment.diaOracleAdapter),
            address(deployment.router),
            address(deployment.locker),
            protocolAdmin,
            deployment.oracleNusd.supplyCeilingNusd()
        );
    }

    function validateOracleParameters(
        uint256 maxPriceAge,
        uint256 minPriceWad,
        uint256 maxPriceWad,
        uint256 maxDeviationBps
    ) public pure {
        if (
            maxPriceAge < 5 minutes || maxPriceAge > 2 hours || minPriceWad < 0.01 ether || minPriceWad > 1_000 ether
                || maxPriceWad < 1 ether || maxPriceWad > 1_000_000 ether || minPriceWad >= maxPriceWad
                || maxDeviationBps == 0 || maxDeviationBps > 10_000
        ) revert InvalidOracleParameters();
    }

    function validateLaunchProtection(uint256 window, uint256 maxBuyNusd) public pure {
        if (window > 1 hours || (window != 0 && maxBuyNusd == 0)) {
            revert InvalidLaunchProtection();
        }
    }

    /// @notice Testnet-only override. Mainnet keeps its 1,500 / 6,000 constants.
    ///         Reserve is derived as `sqrtUp(virtual * marketCap) - virtual`.
    function validateGraduationThresholds(uint256 virtualNusdReserve, uint256 graduationMarketCapNusd)
        public
        pure
        returns (uint256 reserveThresholdNusd)
    {
        if (
            virtualNusdReserve < 1 ether || virtualNusdReserve > 100_000 ether
                || graduationMarketCapNusd <= virtualNusdReserve || graduationMarketCapNusd > 1_000_000 ether
                || virtualNusdReserve > type(uint256).max / graduationMarketCapNusd
        ) revert InvalidGraduationThresholds();

        reserveThresholdNusd = MathX.sqrtUp(virtualNusdReserve * graduationMarketCapNusd) - virtualNusdReserve;
        if (reserveThresholdNusd == 0) revert InvalidGraduationThresholds();
    }
}
