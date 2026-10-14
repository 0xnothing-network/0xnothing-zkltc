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

interface VmDeploy0xFiV2 {
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

interface IV2Core {
    function feeRecipient() external view returns (address);
    function NUSD() external view returns (address);
    function graduationRouter() external view returns (address);
    function nusd() external view returns (address);
    function rewardPool() external view returns (address);
    function treasury() external view returns (address);
}

interface IPumpGraduationRouterV2 {
    function admin() external view returns (address);
    function pump() external view returns (address);
    function minimumDelay() external view returns (uint256);
    function enabled() external view returns (bool);
    function enableAt() external view returns (uint256);
    function adapterActivationTime(address adapter) external view returns (uint256);
    function scheduleAdapter(address adapter) external;
    function scheduleEnable() external;
}

/// @notice Testnet v2 0xFi suite against the v2 core (run `contracts/script/DeployV2Core.s.sol` first).
///         Reuses the stateless v1 DIA adapters and the permissionless WzkLTC wrapper.
contract Deploy0xFiV2 {
    error UnexpectedConfiguration(string what);
    error WrongChain(uint256 expectedChainId, uint256 actualChainId);

    VmDeploy0xFiV2 private constant vm = VmDeploy0xFiV2(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 private constant CHAIN_ID = 4441;
    address private constant WZKLTC = 0xE93d4373CE1eDA3df6c3Ab7ed3ab07A07aA5939F;
    address private constant LTC_ORACLE = 0x54361dB5F9DF455B448E882Ce65612D5e418f3Ee;
    address private constant BTC_ORACLE = 0x781178849cE1D131EFbedff1EF52323A6E117813;
    address private constant ETH_ORACLE = 0x8E9BD05a80542B171719ac0d749a7A609D69E324;
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
            nusd: vm.envAddress("V2_NUSD"),
            pump: vm.envAddress("V2_PUMP"),
            pumpRouter: vm.envAddress("V2_PUMP_GRADUATION_ROUTER"),
            feeSplitter: vm.envAddress("V2_FEE_SPLITTER"),
            treasury: vm.envAddress("V2_TREASURY")
        });
        _checkCore(core, deployer);

        vm.startBroadcast(privateKey);

        d.dexFactory = new ZeroXFiFactoryV2(deployer, core.nusd, WZKLTC, core.pump);
        d.dexRouter = new ZeroXFiRouterV2(address(d.dexFactory), WZKLTC, core.feeSplitter, core.treasury);
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
        // The fee splitter is the mint-fee distributor: synth mint fees go 50/50 to pool and treasury.
        d.nbtcVault = new SyntheticVault(
            core.nusd,
            address(d.nbtc),
            BTC_ORACLE,
            address(d.synthSafetyReserve),
            core.feeSplitter,
            deployer,
            NBTC_DEBT_CEILING,
            true
        );
        d.nethVault = new SyntheticVault(
            core.nusd,
            address(d.neth),
            ETH_ORACLE,
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
        d.lendingPool.configureCollateral(WZKLTC, LTC_ORACLE, WZKLTC_COLLATERAL_CAP, 8000, 8500, 9000, 500, true);
        // Synthetic collateral sits behind small caps equal to the synth debt ceilings.
        d.lendingPool.configureCollateral(address(d.nbtc), BTC_ORACLE, NBTC_DEBT_CEILING, 8000, 8500, 9000, 500, true);
        d.lendingPool.configureCollateral(address(d.neth), ETH_ORACLE, NETH_DEBT_CEILING, 8000, 8500, 9000, 500, true);

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

        // Graduation opens after the router delay; `deploy-v2.mjs --activate` finishes it.
        IPumpGraduationRouterV2(core.pumpRouter).scheduleAdapter(address(d.graduationAdapter));
        IPumpGraduationRouterV2(core.pumpRouter).scheduleEnable();

        vm.stopBroadcast();
        _validate(d, core, deployer);
        _writeManifest(d, core);
    }

    function _checkCore(Core memory core, address deployer) private view {
        IPumpGraduationRouterV2 pumpRouter = IPumpGraduationRouterV2(core.pumpRouter);
        if (
            IV2Core(core.pump).feeRecipient() != core.feeSplitter || IV2Core(core.pump).NUSD() != core.nusd
                || IV2Core(core.pump).graduationRouter() != core.pumpRouter || pumpRouter.pump() != core.pump
                || pumpRouter.admin() != deployer || pumpRouter.enabled() || pumpRouter.enableAt() != 0
        ) revert UnexpectedConfiguration("pump core");
        if (IV2Core(core.feeSplitter).nusd() != core.nusd || IV2Core(core.feeSplitter).treasury() != core.treasury) {
            revert UnexpectedConfiguration("fee splitter");
        }
    }

    function _validate(Deployment memory d, Core memory core, address deployer) private view {
        if (
            d.dexFactory.nusd() != core.nusd || d.dexFactory.wzkLTC() != WZKLTC || d.dexFactory.pump() != core.pump
                || d.dexFactory.router() != address(d.dexRouter)
                || d.dexFactory.graduationAdapter() != address(d.graduationAdapter) || d.dexFactory.owner() != deployer
        ) revert UnexpectedConfiguration("factory");
        if (
            address(d.dexRouter.factory()) != address(d.dexFactory) || d.dexRouter.nusd() != core.nusd
                || d.dexRouter.feeSplitter() != core.feeSplitter || d.dexRouter.treasury() != core.treasury
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
        IPumpGraduationRouterV2 pumpRouter = IPumpGraduationRouterV2(core.pumpRouter);
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
        vm.serializeAddress(key, "ltcOracle", LTC_ORACLE);
        vm.serializeAddress(key, "btcOracle", BTC_ORACLE);
        vm.serializeAddress(key, "ethOracle", ETH_ORACLE);
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
        vm.writeJson(json, string.concat("./deployments/v2-fi", vm.envOr("V2_MANIFEST_SUFFIX", string("")), ".json"));
    }
}
