// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ZeroXFiFactoryV2 } from "../src/amm/ZeroXFiFactoryV2.sol";
import { ZeroXFiRouterV2 } from "../src/amm/ZeroXFiRouterV2.sol";
import { GaugeFactory } from "../src/farming/GaugeFactory.sol";
import { ZeroXFiGraduationAdapter } from "../src/graduation/ZeroXFiGraduationAdapter.sol";
import { PumpGraduationController } from "../src/graduation/PumpGraduationController.sol";
import { PooledNUSDLendingPoolV2 } from "../src/lending/PooledNUSDLendingPoolV2.sol";
import { CommunityLiquidityLocker } from "../src/locking/CommunityLiquidityLocker.sol";
import { TokenMetadataRegistry } from "../src/metadata/TokenMetadataRegistry.sol";
import { SyntheticAsset } from "../src/synth/SyntheticAsset.sol";
import { SynthSafetyReserve } from "../src/synth/SynthSafetyReserve.sol";
import { SyntheticVault } from "../src/synth/SyntheticVault.sol";

interface VmDeploy0xFiV3 {
    function addr(uint256 privateKey) external returns (address keyAddress);
    function envUint(string calldata key) external returns (uint256 value);
    function envAddress(string calldata key) external returns (address value);
    function envOr(string calldata key, string calldata defaultValue) external returns (string memory value);
    function serializeAddress(string calldata objectKey, string calldata valueKey, address value)
        external
        returns (string memory json);
    function serializeUint(string calldata objectKey, string calldata valueKey, uint256 value)
        external
        returns (string memory json);
    function writeJson(string calldata json, string calldata path) external;
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}

interface IV3Pump {
    function feeRecipient() external view returns (address);
    function NUSD() external view returns (address);
    function graduationRouter() external view returns (address);
}

/// @dev ABI mirror of `contracts/src/treasury/FeeSplitter.sol` (a separate Foundry root).
interface IV3FeeSplitter {
    struct Source {
        address target;
        bytes data;
    }

    function nusd() external view returns (address);
    function wrappedNative() external view returns (address);
    function treasury() external view returns (address);
    function admin() external view returns (address);
    function setSources(Source[] calldata newSources) external;
    function sourceCount() external view returns (uint256);
}

interface IV3OracleRouter {
    function admin() external view returns (address);
    function readPriceWad() external view returns (uint256 priceWad, uint256 updatedAt, uint80 roundId);
}

interface IPumpGraduationRouterV3 {
    function admin() external view returns (address);
    function pump() external view returns (address);
    function enabled() external view returns (bool);
    function enableAt() external view returns (uint256);
    function adapterActivationTime(address adapter) external view returns (uint256);
    function scheduleAdapter(address adapter) external;
    function scheduleEnable() external;
}

/// @notice Testnet v3 0xFi suite against the v3 core (run `contracts/script/DeployV3Core.s.sol`
///         first). Every price comes through the core's oracle routers, every fee ends in the core
///         fee splitter (router WzkLTC fees included, which back NUSD), and the splitter learns
///         where to harvest from.
contract Deploy0xFiV3 {
    error UnexpectedConfiguration(string what);
    error WrongChain(uint256 expectedChainId, uint256 actualChainId);

    VmDeploy0xFiV3 private constant vm = VmDeploy0xFiV3(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 private constant CHAIN_ID = 4441;
    address private constant WZKLTC = 0xE93d4373CE1eDA3df6c3Ab7ed3ab07A07aA5939F;
    uint256 private constant NBTC_DEBT_CEILING = 0.01 ether;
    uint256 private constant NETH_DEBT_CEILING = 0.25 ether;
    uint256 private constant LENDING_SUPPLY_CAP = 5000 ether;
    uint256 private constant LENDING_BORROW_CAP = 2500 ether;
    uint256 private constant WZKLTC_COLLATERAL_CAP = 50 ether;

    struct Core {
        address nusd;
        address pump;
        address pumpRouter;
        address feeSplitter;
        address treasury;
        address ltcOracle;
        address btcOracle;
        address ethOracle;
    }

    struct Deployment {
        ZeroXFiFactoryV2 dexFactory;
        ZeroXFiRouterV2 dexRouter;
        ZeroXFiGraduationAdapter graduationAdapter;
        PumpGraduationController graduationController;
        GaugeFactory gaugeFactory;
        SynthSafetyReserve synthSafetyReserve;
        SyntheticAsset nbtc;
        SyntheticAsset neth;
        SyntheticVault nbtcVault;
        SyntheticVault nethVault;
        PooledNUSDLendingPoolV2 lendingPool;
        CommunityLiquidityLocker lpLocker;
        TokenMetadataRegistry tokenMetadataRegistry;
        address wzkLtcNusdPair;
        address nbtcNusdPair;
        address nethNusdPair;
        address wzkLtcNusdGauge;
        address nbtcNusdGauge;
        address nethNusdGauge;
    }

    function run() external returns (Deployment memory d) {
        if (block.chainid != CHAIN_ID) revert WrongChain(CHAIN_ID, block.chainid);
        uint256 privateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(privateKey);
        Core memory core = Core({
            nusd: vm.envAddress("V3_NUSD"),
            pump: vm.envAddress("V3_PUMP"),
            pumpRouter: vm.envAddress("V3_PUMP_GRADUATION_ROUTER"),
            feeSplitter: vm.envAddress("V3_FEE_SPLITTER"),
            treasury: vm.envAddress("V3_TREASURY"),
            ltcOracle: vm.envAddress("V3_LTC_ORACLE"),
            btcOracle: vm.envAddress("V3_BTC_ORACLE"),
            ethOracle: vm.envAddress("V3_ETH_ORACLE")
        });
        _checkCore(core, deployer);

        vm.startBroadcast(privateKey);

        d.dexFactory = new ZeroXFiFactoryV2(deployer, core.nusd, WZKLTC, core.pump);
        // WzkLTC router fees go to the splitter too, which unwraps them into the NUSD reserve.
        d.dexRouter = new ZeroXFiRouterV2(address(d.dexFactory), WZKLTC, core.feeSplitter, core.feeSplitter);
        d.dexFactory.bindRouter(address(d.dexRouter));
        d.graduationAdapter =
            new ZeroXFiGraduationAdapter(address(d.dexFactory), core.pumpRouter, core.nusd, core.pump);
        d.dexFactory.bindGraduationAdapter(address(d.graduationAdapter));
        d.graduationController =
            new PumpGraduationController(core.pump, address(d.graduationAdapter), deployer, deployer);

        d.gaugeFactory = new GaugeFactory(deployer, core.nusd, address(d.dexFactory));
        d.synthSafetyReserve = new SynthSafetyReserve(core.nusd, deployer);
        d.nbtc = new SyntheticAsset("0xFi Synthetic Bitcoin", "nBTC", deployer);
        d.neth = new SyntheticAsset("0xFi Synthetic Ether", "nETH", deployer);
        d.nbtcVault = new SyntheticVault(
            core.nusd,
            address(d.nbtc),
            core.btcOracle,
            address(d.synthSafetyReserve),
            core.feeSplitter,
            deployer,
            NBTC_DEBT_CEILING,
            true
        );
        d.nethVault = new SyntheticVault(
            core.nusd,
            address(d.neth),
            core.ethOracle,
            address(d.synthSafetyReserve),
            core.feeSplitter,
            deployer,
            NETH_DEBT_CEILING,
            true
        );
        d.synthSafetyReserve.bindVaults(address(d.nbtcVault), address(d.nethVault));
        d.nbtc.bindVault(address(d.nbtcVault));
        d.neth.bindVault(address(d.nethVault));
        d.nbtc.renounceOwnership();
        d.neth.renounceOwnership();

        d.lendingPool = new PooledNUSDLendingPoolV2(
            core.nusd, core.feeSplitter, deployer, LENDING_SUPPLY_CAP, LENDING_BORROW_CAP, true
        );
        d.lendingPool.configureCollateral(WZKLTC, core.ltcOracle, WZKLTC_COLLATERAL_CAP, 8000, 8500, 9000, 500, true);
        // Synthetic collateral sits behind small caps equal to the synth debt ceilings.
        d.lendingPool.configureCollateral(
            address(d.nbtc), core.btcOracle, NBTC_DEBT_CEILING, 8000, 8500, 9000, 500, true
        );
        d.lendingPool.configureCollateral(
            address(d.neth), core.ethOracle, NETH_DEBT_CEILING, 8000, 8500, 9000, 500, true
        );

        d.wzkLtcNusdPair = d.dexFactory.createPair(WZKLTC, core.nusd);
        d.nbtcNusdPair = d.dexFactory.createPair(address(d.nbtc), core.nusd);
        d.nethNusdPair = d.dexFactory.createPair(address(d.neth), core.nusd);
        d.wzkLtcNusdGauge = d.gaugeFactory.createGauge(d.wzkLtcNusdPair);
        d.nbtcNusdGauge = d.gaugeFactory.createGauge(d.nbtcNusdPair);
        d.nethNusdGauge = d.gaugeFactory.createGauge(d.nethNusdPair);

        d.lpLocker = new CommunityLiquidityLocker(address(d.dexFactory));
        address[] memory protectedTokens = new address[](4);
        protectedTokens[0] = core.nusd;
        protectedTokens[1] = WZKLTC;
        protectedTokens[2] = address(d.nbtc);
        protectedTokens[3] = address(d.neth);
        d.tokenMetadataRegistry = new TokenMetadataRegistry(protectedTokens);

        // Everything that accrues fees, so one `harvest()` (run by every stake and claim) collects it.
        IV3FeeSplitter(core.feeSplitter).setSources(_feeSources(d, core));

        // Graduation opens after the router delay; `deploy-v3.mjs --activate` finishes it.
        IPumpGraduationRouterV3(core.pumpRouter).scheduleAdapter(address(d.graduationAdapter));
        IPumpGraduationRouterV3(core.pumpRouter).scheduleEnable();

        vm.stopBroadcast();
        _validate(d, core, deployer);
        _writeManifest(d, core);
    }

    function _feeSources(Deployment memory d, Core memory core)
        private
        pure
        returns (IV3FeeSplitter.Source[] memory sources)
    {
        sources = new IV3FeeSplitter.Source[](4);
        sources[0] = IV3FeeSplitter.Source(core.pump, abi.encodeWithSignature("distributeFees()"));
        sources[1] = IV3FeeSplitter.Source(
            address(d.dexRouter), abi.encodeWithSignature("distributeFees(address)", core.nusd)
        );
        sources[2] =
            IV3FeeSplitter.Source(address(d.dexRouter), abi.encodeWithSignature("distributeFees(address)", WZKLTC));
        sources[3] =
            IV3FeeSplitter.Source(address(d.lendingPool), abi.encodeWithSignature("sweepProtocolInterest()"));
    }

    function _checkCore(Core memory core, address deployer) private view {
        IPumpGraduationRouterV3 pumpRouter = IPumpGraduationRouterV3(core.pumpRouter);
        if (
            IV3Pump(core.pump).feeRecipient() != core.feeSplitter || IV3Pump(core.pump).NUSD() != core.nusd
                || IV3Pump(core.pump).graduationRouter() != core.pumpRouter || pumpRouter.pump() != core.pump
                || pumpRouter.admin() != deployer || pumpRouter.enabled() || pumpRouter.enableAt() != 0
        ) revert UnexpectedConfiguration("pump core");
        IV3FeeSplitter splitter = IV3FeeSplitter(core.feeSplitter);
        if (
            splitter.nusd() != core.nusd || splitter.wrappedNative() != WZKLTC || splitter.treasury() != core.treasury
                || splitter.admin() != deployer || splitter.sourceCount() != 0
        ) revert UnexpectedConfiguration("fee splitter");
        if (
            IV3OracleRouter(core.ltcOracle).admin() != deployer || IV3OracleRouter(core.btcOracle).admin() != deployer
                || IV3OracleRouter(core.ethOracle).admin() != deployer
        ) revert UnexpectedConfiguration("oracle routers");
    }

    function _validate(Deployment memory d, Core memory core, address deployer) private view {
        if (
            d.dexFactory.nusd() != core.nusd || d.dexFactory.wzkLTC() != WZKLTC || d.dexFactory.pump() != core.pump
                || d.dexFactory.router() != address(d.dexRouter)
                || d.dexFactory.graduationAdapter() != address(d.graduationAdapter) || d.dexFactory.owner() != deployer
        ) revert UnexpectedConfiguration("factory");
        if (
            address(d.dexRouter.factory()) != address(d.dexFactory) || d.dexRouter.nusd() != core.nusd
                || d.dexRouter.feeSplitter() != core.feeSplitter || d.dexRouter.treasury() != core.feeSplitter
                || d.dexRouter.DIRECT_FEE_BPS() != 10 || d.dexRouter.CROSS_FEE_BPS() != 30
                || d.dexRouter.LP_FEE_BPS() != 50
        ) revert UnexpectedConfiguration("router");
        if (
            address(d.nbtcVault.mintFeeDistributor()) != core.feeSplitter
                || address(d.nethVault.mintFeeDistributor()) != core.feeSplitter || d.nbtc.vault() != address(d.nbtcVault)
                || d.neth.vault() != address(d.nethVault) || d.nbtc.owner() != address(0) || d.neth.owner() != address(0)
                || !d.synthSafetyReserve.vaultsBound()
        ) revert UnexpectedConfiguration("synths");
        if (
            d.lendingPool.feeSplitter() != core.feeSplitter || d.lendingPool.supplyCapNusd() != LENDING_SUPPLY_CAP
                || d.lendingPool.borrowCapNusd() != LENDING_BORROW_CAP || !d.lendingPool.activated()
        ) revert UnexpectedConfiguration("lending");
        if (
            d.dexFactory.getPair(WZKLTC, core.nusd) != d.wzkLtcNusdPair
                || d.gaugeFactory.gaugeForPair(d.wzkLtcNusdPair) != d.wzkLtcNusdGauge
                || d.gaugeFactory.gaugeForPair(d.nbtcNusdPair) != d.nbtcNusdGauge
                || d.gaugeFactory.gaugeForPair(d.nethNusdPair) != d.nethNusdGauge
        ) revert UnexpectedConfiguration("pairs");
        if (IV3FeeSplitter(core.feeSplitter).sourceCount() != 4) revert UnexpectedConfiguration("fee sources");
        IPumpGraduationRouterV3 pumpRouter = IPumpGraduationRouterV3(core.pumpRouter);
        if (pumpRouter.adapterActivationTime(address(d.graduationAdapter)) == 0 || pumpRouter.enableAt() == 0) {
            revert UnexpectedConfiguration("graduation schedule");
        }
    }

    function _writeManifest(Deployment memory d, Core memory core) private {
        string memory key = "fi";
        vm.serializeUint(key, "chainId", block.chainid);
        vm.serializeUint(key, "scriptBlock", block.number);
        vm.serializeAddress(key, "nusd", core.nusd);
        vm.serializeAddress(key, "pump", core.pump);
        vm.serializeAddress(key, "wzkLTC", WZKLTC);
        vm.serializeAddress(key, "ltcOracle", core.ltcOracle);
        vm.serializeAddress(key, "btcOracle", core.btcOracle);
        vm.serializeAddress(key, "ethOracle", core.ethOracle);
        vm.serializeAddress(key, "dexFactory", address(d.dexFactory));
        vm.serializeAddress(key, "dexRouter", address(d.dexRouter));
        vm.serializeAddress(key, "pumpGraduationAdapter", address(d.graduationAdapter));
        vm.serializeAddress(key, "pumpGraduationController", address(d.graduationController));
        vm.serializeAddress(key, "gaugeFactory", address(d.gaugeFactory));
        vm.serializeAddress(key, "synthSafetyReserve", address(d.synthSafetyReserve));
        vm.serializeAddress(key, "nBTC", address(d.nbtc));
        vm.serializeAddress(key, "nETH", address(d.neth));
        vm.serializeAddress(key, "nBTCVault", address(d.nbtcVault));
        vm.serializeAddress(key, "nETHVault", address(d.nethVault));
        vm.serializeAddress(key, "lendingPool", address(d.lendingPool));
        vm.serializeAddress(key, "lpLocker", address(d.lpLocker));
        vm.serializeAddress(key, "tokenMetadataRegistry", address(d.tokenMetadataRegistry));
        vm.serializeAddress(key, "wzkLtcNusdPair", d.wzkLtcNusdPair);
        vm.serializeAddress(key, "nBTCNusdPair", d.nbtcNusdPair);
        vm.serializeAddress(key, "nETHNusdPair", d.nethNusdPair);
        vm.serializeAddress(key, "wzkLtcNusdGauge", d.wzkLtcNusdGauge);
        vm.serializeAddress(key, "nBTCNusdGauge", d.nbtcNusdGauge);
        string memory json = vm.serializeAddress(key, "nETHNusdGauge", d.nethNusdGauge);
        vm.writeJson(json, string.concat("./deployments/v3-fi", vm.envOr("V3_MANIFEST_SUFFIX", string("")), ".json"));
    }
}
