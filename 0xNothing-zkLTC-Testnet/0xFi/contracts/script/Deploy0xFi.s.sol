// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { WzkLTC } from "../src/amm/WzkLTC.sol";
import { ZeroXFiFactory } from "../src/amm/ZeroXFiFactory.sol";
import { ZeroXFiRouter } from "../src/amm/ZeroXFiRouter.sol";
import { GaugeFactory } from "../src/farming/GaugeFactory.sol";
import { ZeroXFiGraduationAdapter } from "../src/graduation/ZeroXFiGraduationAdapter.sol";
import { PooledNUSDLendingPool } from "../src/lending/PooledNUSDLendingPool.sol";
import { DIAOracleV2Adapter } from "../src/oracle/DIAOracleV2Adapter.sol";
import { SyntheticAsset } from "../src/synth/SyntheticAsset.sol";
import { SynthSafetyReserve } from "../src/synth/SynthSafetyReserve.sol";
import { SyntheticVault } from "../src/synth/SyntheticVault.sol";

interface VmDeploy0xFi {
    function addr(uint256 privateKey) external returns (address keyAddress);
    function envUint(string calldata key) external returns (uint256 value);
    function envOr(string calldata key, uint256 defaultValue) external returns (uint256 value);
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

interface IPumpGraduationRouterAdmin {
    function admin() external view returns (address);
    function adapterActivationTime(address adapter) external view returns (uint256);
    function enabled() external view returns (bool);
    function enableAt() external view returns (uint256);
    function isAdapterAllowed(address adapter) external view returns (bool);
    function minimumDelay() external view returns (uint256);
    function scheduleAdapter(address adapter) external;
    function scheduleEnable() external;
}

contract Deploy0xFi {
    error UnexpectedConfiguration();
    error WrongChain(uint256 expectedChainId, uint256 actualChainId);

    VmDeploy0xFi private constant vm = VmDeploy0xFi(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 private constant CHAIN_ID = 4441;
    uint256 private constant PUMP_ROUTER_DELAY = 2 days;
    uint256 private constant ORACLE_MAX_AGE = 90 minutes;

    address private constant NUSD = 0x5317e21aba902c6c7087a84457bc02fFe99604d1;
    address private constant PUMP = 0x4a0Eaf310e3659aA9B360fD44e90208c31Dbe0e2;
    address private constant PUMP_GRADUATION_ROUTER = 0xDCf571C4b03A86c5e15B48864C1aCbB6A8085904;
    address private constant DIA_LTC_USD = 0x45dDa5d881BD2C917976CCfde74fFd6f6412da29;
    address private constant DIA_BTC_USD = 0x7d0445782E383223c7B4B660bb96b87213e9b605;
    address private constant DIA_ETH_USD = 0xc760B46beF9eD3F9A3d2b825164324D6703F0185;

    struct Deployment {
        DIAOracleV2Adapter ltcOracle;
        DIAOracleV2Adapter btcOracle;
        DIAOracleV2Adapter ethOracle;
        WzkLTC wzkLTC;
        ZeroXFiFactory dexFactory;
        ZeroXFiRouter dexRouter;
        ZeroXFiGraduationAdapter graduationAdapter;
        GaugeFactory gaugeFactory;
        SynthSafetyReserve synthSafetyReserve;
        SyntheticAsset nbtc;
        SyntheticAsset neth;
        SyntheticVault nbtcVault;
        SyntheticVault nethVault;
        PooledNUSDLendingPool lendingPool;
        address wzkLtcNusdPair;
        address nbtcNusdPair;
        address nethNusdPair;
        address wzkLtcNusdGauge;
        address nbtcNusdGauge;
        address nethNusdGauge;
    }

    function run() external returns (Deployment memory deployment) {
        if (block.chainid != CHAIN_ID) revert WrongChain(CHAIN_ID, block.chainid);

        uint256 privateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(privateKey);
        uint256 nbtcDebtCeiling = vm.envOr("NBTC_DEBT_CEILING", uint256(0.01 ether));
        uint256 nethDebtCeiling = vm.envOr("NETH_DEBT_CEILING", uint256(0.25 ether));
        uint256 lendingSupplyCap = vm.envOr("LENDING_SUPPLY_CAP_NUSD", uint256(5000 ether));
        uint256 lendingBorrowCap = vm.envOr("LENDING_BORROW_CAP_NUSD", uint256(2500 ether));
        uint256 wzkLtcCollateralCap = vm.envOr("WZKLTC_COLLATERAL_CAP", uint256(50 ether));
        uint256 nbtcCollateralCap = vm.envOr("NBTC_LENDING_COLLATERAL_CAP", nbtcDebtCeiling);
        uint256 nethCollateralCap = vm.envOr("NETH_LENDING_COLLATERAL_CAP", nethDebtCeiling);
        IPumpGraduationRouterAdmin pumpRouter = IPumpGraduationRouterAdmin(PUMP_GRADUATION_ROUTER);
        if (pumpRouter.admin() != deployer || pumpRouter.minimumDelay() != PUMP_ROUTER_DELAY) {
            revert UnexpectedConfiguration();
        }

        vm.startBroadcast(privateKey);

        deployment.ltcOracle =
            new DIAOracleV2Adapter(DIA_LTC_USD, "LTC/USD Oracle", ORACLE_MAX_AGE, 10 ether, 1000 ether);
        deployment.btcOracle =
            new DIAOracleV2Adapter(DIA_BTC_USD, "BTC/USD Oracle", ORACLE_MAX_AGE, 5000 ether, 500_000 ether);
        deployment.ethOracle =
            new DIAOracleV2Adapter(DIA_ETH_USD, "ETH/USD Oracle", ORACLE_MAX_AGE, 250 ether, 50_000 ether);

        deployment.wzkLTC = new WzkLTC();
        deployment.dexFactory = new ZeroXFiFactory(deployer, NUSD, PUMP);
        deployment.dexRouter = new ZeroXFiRouter(address(deployment.dexFactory), address(deployment.wzkLTC));
        deployment.dexFactory.bindRouter(address(deployment.dexRouter));
        deployment.graduationAdapter =
            new ZeroXFiGraduationAdapter(address(deployment.dexFactory), PUMP_GRADUATION_ROUTER, NUSD, PUMP);
        deployment.dexFactory.bindGraduationAdapter(address(deployment.graduationAdapter));

        deployment.gaugeFactory = new GaugeFactory(deployer, NUSD, address(deployment.dexFactory));

        deployment.synthSafetyReserve = new SynthSafetyReserve(NUSD, deployer);
        deployment.nbtc = new SyntheticAsset("0xFi Synthetic Bitcoin", "nBTC", deployer);
        deployment.neth = new SyntheticAsset("0xFi Synthetic Ether", "nETH", deployer);
        deployment.nbtcVault = new SyntheticVault(
            NUSD,
            address(deployment.nbtc),
            address(deployment.btcOracle),
            address(deployment.synthSafetyReserve),
            address(deployment.gaugeFactory),
            deployer,
            nbtcDebtCeiling
        );
        deployment.nethVault = new SyntheticVault(
            NUSD,
            address(deployment.neth),
            address(deployment.ethOracle),
            address(deployment.synthSafetyReserve),
            address(deployment.gaugeFactory),
            deployer,
            nethDebtCeiling
        );
        deployment.synthSafetyReserve.bindVaults(address(deployment.nbtcVault), address(deployment.nethVault));
        deployment.nbtc.bindVault(address(deployment.nbtcVault));
        deployment.neth.bindVault(address(deployment.nethVault));

        deployment.lendingPool = new PooledNUSDLendingPool(NUSD, deployer, lendingSupplyCap, lendingBorrowCap);
        deployment.lendingPool
            .configureCollateral(
                address(deployment.wzkLTC),
                address(deployment.ltcOracle),
                wzkLtcCollateralCap,
                8000,
                8500,
                9000,
                500,
                true
            );
        // Synthetic collateral is enabled only behind small, isolated caps and per-asset debt
        // ceilings, so this cannot create unbounded recursive leverage.
        deployment.lendingPool
            .configureCollateral(
                address(deployment.nbtc),
                address(deployment.btcOracle),
                nbtcCollateralCap,
                8000,
                8500,
                9000,
                500,
                true
            );
        deployment.lendingPool
            .configureCollateral(
                address(deployment.neth),
                address(deployment.ethOracle),
                nethCollateralCap,
                8000,
                8500,
                9000,
                500,
                true
            );

        deployment.wzkLtcNusdPair = deployment.dexFactory.createPair(address(deployment.wzkLTC), NUSD);
        deployment.nbtcNusdPair = deployment.dexFactory.createPair(address(deployment.nbtc), NUSD);
        deployment.nethNusdPair = deployment.dexFactory.createPair(address(deployment.neth), NUSD);
        deployment.wzkLtcNusdGauge = deployment.gaugeFactory.createGauge(deployment.wzkLtcNusdPair);
        deployment.nbtcNusdGauge = deployment.gaugeFactory.createGauge(deployment.nbtcNusdPair);
        deployment.nethNusdGauge = deployment.gaugeFactory.createGauge(deployment.nethNusdPair);
        deployment.gaugeFactory.bindMintFeeVault(address(deployment.nbtcVault), deployment.nbtcNusdPair);
        deployment.gaugeFactory.bindMintFeeVault(address(deployment.nethVault), deployment.nethNusdPair);

        if (
            !pumpRouter.isAdapterAllowed(address(deployment.graduationAdapter))
                && pumpRouter.adapterActivationTime(address(deployment.graduationAdapter)) == 0
        ) {
            pumpRouter.scheduleAdapter(address(deployment.graduationAdapter));
        }
        if (!pumpRouter.enabled() && pumpRouter.enableAt() == 0) pumpRouter.scheduleEnable();

        deployment.nbtc.renounceOwnership();
        deployment.neth.renounceOwnership();

        _validate(
            deployment,
            deployer,
            nbtcDebtCeiling,
            nethDebtCeiling,
            lendingSupplyCap,
            lendingBorrowCap,
            wzkLtcCollateralCap,
            nbtcCollateralCap,
            nethCollateralCap
        );

        vm.stopBroadcast();
        _writePrediction(
            deployment,
            deployer,
            nbtcDebtCeiling,
            nethDebtCeiling,
            lendingSupplyCap,
            lendingBorrowCap,
            wzkLtcCollateralCap,
            nbtcCollateralCap,
            nethCollateralCap
        );
    }

    function _validate(
        Deployment memory deployment,
        address deployer,
        uint256 nbtcDebtCeiling,
        uint256 nethDebtCeiling,
        uint256 lendingSupplyCap,
        uint256 lendingBorrowCap,
        uint256 wzkLtcCollateralCap,
        uint256 nbtcCollateralCap,
        uint256 nethCollateralCap
    ) private view {
        if (
            deployment.dexFactory.nusd() != NUSD || deployment.dexFactory.pump() != PUMP
                || deployment.dexFactory.router() != address(deployment.dexRouter)
                || deployment.dexFactory.graduationAdapter() != address(deployment.graduationAdapter)
                || address(deployment.dexRouter.factory()) != address(deployment.dexFactory)
                || address(deployment.dexRouter.wzkLTC()) != address(deployment.wzkLTC)
                || deployment.dexRouter.LP_FEE_BPS() != 50 || deployment.dexRouter.PROTOCOL_FEE_BPS() != 10
                || deployment.dexRouter.ROUTE_SURCHARGE_BPS() != 10 || address(deployment.gaugeFactory.nusd()) != NUSD
                || address(deployment.synthSafetyReserve.nusd()) != NUSD
                || !deployment.synthSafetyReserve.authorizedVault(address(deployment.nbtcVault))
                || !deployment.synthSafetyReserve.authorizedVault(address(deployment.nethVault))
                || !deployment.synthSafetyReserve.vaultsBound()
                || deployment.synthSafetyReserve.vault0() != address(deployment.nbtcVault)
                || deployment.synthSafetyReserve.vault1() != address(deployment.nethVault)
                || deployment.synthSafetyReserve.allocationsPaused()
                || deployment.synthSafetyReserve.sponsorshipActive()
                || deployment.nbtc.vault() != address(deployment.nbtcVault)
                || deployment.neth.vault() != address(deployment.nethVault) || deployment.nbtc.owner() != address(0)
                || deployment.neth.owner() != address(0)
                || deployment.nbtcVault.debtCeilingSynthetic() != nbtcDebtCeiling
                || deployment.nethVault.debtCeilingSynthetic() != nethDebtCeiling
                || address(deployment.nbtcVault.mintFeeDistributor()) != address(deployment.gaugeFactory)
                || address(deployment.nethVault.mintFeeDistributor()) != address(deployment.gaugeFactory)
                || deployment.lendingPool.supplyCapNusd() != lendingSupplyCap
                || deployment.lendingPool.borrowCapNusd() != lendingBorrowCap
                || deployment.lendingPool.IMPLEMENTATION_ID()
                    != keccak256("0xfi.lending.fixed-4.5-4-0.5.80-85-90.v1")
                || deployment.lendingPool.borrowRate() != 0.045 ether
                || deployment.lendingPool.lenderRate() != 0.04 ether
                || deployment.lendingPool.protocolRate() != 0.005 ether
                || deployment.dexFactory.owner() != deployer || deployment.dexFactory.guardian() != deployer
                || deployment.gaugeFactory.owner() != deployer || deployment.gaugeFactory.guardian() != deployer
                || deployment.synthSafetyReserve.owner() != deployer
                || deployment.synthSafetyReserve.guardian() != deployer || deployment.nbtcVault.owner() != deployer
                || deployment.nbtcVault.guardian() != deployer || deployment.nethVault.owner() != deployer
                || deployment.nethVault.guardian() != deployer || deployment.lendingPool.owner() != deployer
                || deployment.lendingPool.guardian() != deployer
        ) revert UnexpectedConfiguration();

        _validateCollateral(deployment, address(deployment.wzkLTC), address(deployment.ltcOracle), wzkLtcCollateralCap);
        _validateCollateral(deployment, address(deployment.nbtc), address(deployment.btcOracle), nbtcCollateralCap);
        _validateCollateral(deployment, address(deployment.neth), address(deployment.ethOracle), nethCollateralCap);

        if (
            deployment.dexFactory.getPair(address(deployment.wzkLTC), NUSD) != deployment.wzkLtcNusdPair
                || deployment.dexFactory.getPair(address(deployment.nbtc), NUSD) != deployment.nbtcNusdPair
                || deployment.dexFactory.getPair(address(deployment.neth), NUSD) != deployment.nethNusdPair
                || deployment.gaugeFactory.gaugeForPair(deployment.wzkLtcNusdPair) != deployment.wzkLtcNusdGauge
                || deployment.gaugeFactory.gaugeForPair(deployment.nbtcNusdPair) != deployment.nbtcNusdGauge
                || deployment.gaugeFactory.gaugeForPair(deployment.nethNusdPair) != deployment.nethNusdGauge
                || deployment.gaugeFactory.mintFeePairForVault(address(deployment.nbtcVault)) != deployment.nbtcNusdPair
                || deployment.gaugeFactory.mintFeePairForVault(address(deployment.nethVault)) != deployment.nethNusdPair
                || deployment.gaugeFactory.mintFeeVaultForPair(deployment.nbtcNusdPair) != address(deployment.nbtcVault)
                || deployment.gaugeFactory.mintFeeVaultForPair(deployment.nethNusdPair) != address(deployment.nethVault)
        ) revert UnexpectedConfiguration();

        IPumpGraduationRouterAdmin pumpRouter = IPumpGraduationRouterAdmin(PUMP_GRADUATION_ROUTER);
        bool adapterReadyOrScheduled = pumpRouter.isAdapterAllowed(address(deployment.graduationAdapter))
            || pumpRouter.adapterActivationTime(address(deployment.graduationAdapter)) != 0;
        bool routerReadyOrScheduled = pumpRouter.enabled() || pumpRouter.enableAt() != 0;
        if (
            pumpRouter.admin() != deployer || pumpRouter.minimumDelay() != PUMP_ROUTER_DELAY || !adapterReadyOrScheduled
                || !routerReadyOrScheduled
        ) revert UnexpectedConfiguration();
    }

    function _validateCollateral(Deployment memory deployment, address asset, address oracle, uint256 supplyCap)
        private
        view
    {
        (
            address configuredOracle,
            uint256 configuredCap,
            uint16 loanToValueBps,
            uint16 liquidationThresholdBps,
            uint16 liquidationBonusBps,
            uint8 decimals,
            bool enabled,
            uint16 marginCallThresholdBps
        ) = deployment.lendingPool.collateralConfigs(asset);
        if (
            configuredOracle != oracle || configuredCap != supplyCap || loanToValueBps != 8000
                || marginCallThresholdBps != 8500 || liquidationThresholdBps != 9000 || liquidationBonusBps != 500
                || decimals != 18 || !enabled
        ) revert UnexpectedConfiguration();
    }

    function _writePrediction(
        Deployment memory deployment,
        address deployer,
        uint256 nbtcDebtCeiling,
        uint256 nethDebtCeiling,
        uint256 lendingSupplyCap,
        uint256 lendingBorrowCap,
        uint256 wzkLtcCollateralCap,
        uint256 nbtcCollateralCap,
        uint256 nethCollateralCap
    ) private {
        string memory key = "deployment";
        vm.serializeBool(key, "broadcasted", false);
        vm.serializeUint(key, "chainId", CHAIN_ID);
        vm.serializeUint(key, "scriptExecutionBlock", block.number);
        vm.serializeAddress(key, "deployer", deployer);
        vm.serializeAddress(key, "nusd", NUSD);
        vm.serializeAddress(key, "pump", PUMP);
        vm.serializeAddress(key, "pumpGraduationRouter", PUMP_GRADUATION_ROUTER);
        vm.serializeAddress(key, "ltcOracle", address(deployment.ltcOracle));
        vm.serializeAddress(key, "btcOracle", address(deployment.btcOracle));
        vm.serializeAddress(key, "ethOracle", address(deployment.ethOracle));
        vm.serializeAddress(key, "wzkLTC", address(deployment.wzkLTC));
        vm.serializeAddress(key, "dexFactory", address(deployment.dexFactory));
        vm.serializeAddress(key, "dexRouter", address(deployment.dexRouter));
        vm.serializeAddress(key, "pumpGraduationAdapter", address(deployment.graduationAdapter));
        vm.serializeUint(
            key,
            "pumpAdapterActivationTime",
            IPumpGraduationRouterAdmin(PUMP_GRADUATION_ROUTER)
                .adapterActivationTime(address(deployment.graduationAdapter))
        );
        vm.serializeUint(key, "pumpRouterEnableAt", IPumpGraduationRouterAdmin(PUMP_GRADUATION_ROUTER).enableAt());
        vm.serializeAddress(key, "gaugeFactory", address(deployment.gaugeFactory));
        vm.serializeAddress(key, "synthSafetyReserve", address(deployment.synthSafetyReserve));
        vm.serializeUint(key, "sponsorshipEntryTvlNusd", deployment.synthSafetyReserve.ENTRY_TVL_NUSD());
        vm.serializeUint(key, "sponsorshipExitTvlNusd", deployment.synthSafetyReserve.EXIT_TVL_NUSD());
        vm.serializeUint(key, "sponsorshipActivationDelay", deployment.synthSafetyReserve.ACTIVATION_DELAY());
        vm.serializeAddress(key, "nBTC", address(deployment.nbtc));
        vm.serializeAddress(key, "nETH", address(deployment.neth));
        vm.serializeAddress(key, "nBTCVault", address(deployment.nbtcVault));
        vm.serializeAddress(key, "nETHVault", address(deployment.nethVault));
        vm.serializeAddress(key, "lendingPool", address(deployment.lendingPool));
        vm.serializeUint(key, "nBTCDebtCeiling", nbtcDebtCeiling);
        vm.serializeUint(key, "nETHDebtCeiling", nethDebtCeiling);
        vm.serializeUint(key, "lendingSupplyCapNusd", lendingSupplyCap);
        vm.serializeUint(key, "lendingBorrowCapNusd", lendingBorrowCap);
        vm.serializeUint(key, "wzkLtcCollateralCap", wzkLtcCollateralCap);
        vm.serializeUint(key, "nBTCLendingCollateralCap", nbtcCollateralCap);
        vm.serializeUint(key, "nETHLendingCollateralCap", nethCollateralCap);
        vm.serializeAddress(key, "wzkLtcNusdPair", deployment.wzkLtcNusdPair);
        vm.serializeAddress(key, "nBTCNusdPair", deployment.nbtcNusdPair);
        vm.serializeAddress(key, "nETHNusdPair", deployment.nethNusdPair);
        vm.serializeAddress(key, "wzkLtcNusdGauge", deployment.wzkLtcNusdGauge);
        vm.serializeAddress(key, "nBTCNusdGauge", deployment.nbtcNusdGauge);
        vm.serializeAddress(key, "nETHNusdGauge", deployment.nethNusdGauge);
        vm.serializeString(key, "status", "direct-governance-prediction");
        string memory json = vm.serializeString(key, "riskMode", "direct-deployer-no-timelock");
        vm.writeJson(json, "./deployments/fresh-deployment.json");
    }
}
