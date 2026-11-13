// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ZeroXFiFactoryV2 } from "../src/amm/ZeroXFiFactoryV2.sol";
import { ZeroXFiRouterV2 } from "../src/amm/ZeroXFiRouterV2.sol";
import { EmergencyGuardian } from "../src/access/EmergencyGuardian.sol";
import { GaugeFactory } from "../src/farming/GaugeFactory.sol";
import { ZeroXFiGraduationAdapter } from "../src/graduation/ZeroXFiGraduationAdapter.sol";
import { PumpGraduationController } from "../src/graduation/PumpGraduationController.sol";
import { PooledNUSDLendingPoolV2 } from "../src/lending/PooledNUSDLendingPoolV2.sol";
import { CommunityLiquidityLocker } from "../src/locking/CommunityLiquidityLocker.sol";
import { TokenMetadataRegistry } from "../src/metadata/TokenMetadataRegistry.sol";
import { SyntheticAsset } from "../src/synth/SyntheticAsset.sol";
import { SynthSafetyReserve } from "../src/synth/SynthSafetyReserve.sol";
import { SyntheticVault } from "../src/synth/SyntheticVault.sol";

interface VmDeploy0xFiMainnet {
    function addr(uint256 privateKey) external returns (address keyAddress);
    function envUint(string calldata key) external returns (uint256 value);
    function envAddress(string calldata key) external returns (address value);
    function envOr(string calldata key, string calldata defaultValue) external returns (string memory value);
    function envOr(string calldata key, bool defaultValue) external returns (bool value);
    function readFile(string calldata path) external view returns (string memory data);
    function parseJsonAddress(string calldata json, string calldata key) external pure returns (address value);
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
    function admin() external view returns (address);
    function transferAdmin(address newAdmin) external;
}

interface IV3Nusd {
    function oracle() external view returns (address);
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
    function sourceAt(uint256 index) external view returns (address target, bytes memory data);
}

interface IV3OracleRouter {
    function admin() external view returns (address);
    function description() external view returns (string memory);
    function readPriceWad() external view returns (uint256 priceWad, uint256 updatedAt, uint80 roundId);
}

interface IPumpGraduationRouterV3 {
    function admin() external view returns (address);
    function pump() external view returns (address);
    function enabled() external view returns (bool);
    function enableAt() external view returns (uint256);
    function adapterActivationTime(address adapter) external view returns (uint256);
    function isAdapterAllowed(address adapter) external view returns (bool);
    function scheduleAdapter(address adapter) external;
    function scheduleEnable() external;
    function transferAdmin(address newAdmin) external;
}

/// @dev Creating a pair or a gauge is open to anyone, so a stranger who creates one first would
///      make the deployment's own call revert and stop the run. This creates each only if it is
///      missing, in one transaction per pair. Pair addresses do not depend on who creates them;
///      gauge addresses do, which is why the manifest does not record them (read
///      `GaugeFactory.gaugeForPair` instead).
contract PairAndGaugeEnsurer {
    function ensure(ZeroXFiFactoryV2 dexFactory, GaugeFactory gaugeFactory, address tokenA, address tokenB)
        external
        returns (address pair, address gauge)
    {
        pair = dexFactory.getPair(tokenA, tokenB);
        if (pair == address(0)) pair = dexFactory.createPair(tokenA, tokenB);
        gauge = gaugeFactory.gaugeForPair(pair);
        if (gauge == address(0)) gauge = gaugeFactory.createGauge(pair);
    }
}

/// @notice zkLTC mainnet 0xFi suite against the mainnet core (run
///         `contracts/script/DeployMainnetCore.s.sol` first). Same code and wiring as testnet v3;
///         chain-specific addresses come from the environment. Every price comes through the
///         core's oracle routers, every fee ends in the core fee splitter (router WzkLTC fees
///         included, which back NUSD), and the splitter learns where to harvest from.
///
///         Following the 2026-11 audit (docs/AUDIT_2026-11.md) this differs from testnet: the
///         graduation controller takes the Pump and router admin in this run; governance and the
///         guardian come from the environment; every contract that keeps an owner is offered to
///         governance (two-step, governance accepts); Safety Reserve sponsorship is paused and the
///         reserve is left without an owner, so it stays paused; and only WzkLTC is listed in the
///         lending pool, which takes one collateral asset.
///
///         Entry points: `run()` deploys; `verify()` is a read-only check of the chain against the
///         manifest. The checks inside `run()` only ever see the local simulation, so run
///         `verify()` after the broadcast, and again with MAINNET_VERIFY_HANDOVER=true once
///         governance has accepted everything and graduation is active.
contract Deploy0xFiMainnet {
    error UnexpectedConfiguration(string what);
    error WrongChain(uint256 expectedChainId, uint256 actualChainId);

    VmDeploy0xFiMainnet private constant vm = VmDeploy0xFiMainnet(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 private constant TESTNET_CHAIN_ID = 4441;
    address private immutable WZKLTC = vm.envAddress("MAINNET_WZKLTC");
    uint256 private constant NBTC_DEBT_CEILING = 0.01 ether;
    uint256 private constant NETH_DEBT_CEILING = 0.25 ether;
    uint256 private constant LENDING_SUPPLY_CAP = 5000 ether;
    uint256 private constant LENDING_BORROW_CAP = 2500 ether;
    uint256 private constant WZKLTC_COLLATERAL_CAP = 50 ether;

    struct Roles {
        address deployer;
        /// @dev Long-term owner (a multisig): the controller's governance, which can never change,
        ///      and the pending owner of every 0xFi contract that has one.
        address governance;
        /// @dev Pause-only key of the controller and of every 0xFi contract with a guardian.
        address guardian;
    }

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
    }

    // ---------------------------------------------------------------- entry points

    function run() external returns (Deployment memory d) {
        _requireChain();
        uint256 privateKey = vm.envUint("PRIVATE_KEY");
        Roles memory roles = _roles(vm.addr(privateKey));
        Core memory core = _core();
        _checkCore(core);
        _checkCoreUntouched(core, roles.deployer);

        vm.startBroadcast(privateKey);
        _deployDex(d, core, roles);
        _deploySynths(d, core, roles.deployer);
        _deployLending(d, core, roles.deployer);
        _deployPairsAndPeriphery(d, core);

        // Everything that accrues fees, so one `harvest()` (run by every stake and claim) collects it.
        IV3FeeSplitter(core.feeSplitter).setSources(_feeSources(d, core));

        // Roles before the Pump handover, so that whatever stops the last transactions of this run
        // leaves no contract with the deployer as its only guardian.
        if (roles.guardian != roles.deployer) {
            d.dexFactory.setGuardian(roles.guardian);
            d.gaugeFactory.setGuardian(roles.guardian);
            d.synthSafetyReserve.setGuardian(roles.guardian);
            d.nbtcVault.setGuardian(roles.guardian);
            d.nethVault.setGuardian(roles.guardian);
            d.lendingPool.setGuardian(roles.guardian);
        }
        // The Safety Reserve gets no owner at all. Its owner's only remaining power would be to
        // switch sponsorship on again (and to change the guardian, who can only pause).
        d.synthSafetyReserve.renounceOwnership();
        // Two-step: the deployer stays the owner until governance accepts each one.
        if (roles.governance != roles.deployer) {
            d.dexFactory.transferOwnership(roles.governance);
            d.gaugeFactory.transferOwnership(roles.governance);
            d.nbtcVault.transferOwnership(roles.governance);
            d.nethVault.transferOwnership(roles.governance);
            d.lendingPool.transferOwnership(roles.governance);
        }

        // Graduation opens after the router delay: once it has passed, anyone can call
        // activateAdapter and enableRouter on the pump graduation router
        // (script/ActivateGraduationMainnet.s.sol does both).
        IPumpGraduationRouterV3(core.pumpRouter).scheduleAdapter(address(d.graduationAdapter));
        IPumpGraduationRouterV3(core.pumpRouter).scheduleEnable();
        // The controller becomes the Pump and router admin here, so graduating a READY market never
        // needs a key. Governance keeps the remaining admin powers through the controller. Anyone
        // may accept one of the two for the controller first; acceptProtocolAdmin allows for that.
        IV3Pump(core.pump).transferAdmin(address(d.graduationController));
        IPumpGraduationRouterV3(core.pumpRouter).transferAdmin(address(d.graduationController));
        d.graduationController.acceptProtocolAdmin();
        vm.stopBroadcast();

        _validateWiring(d, core);
        _validateRoles(d, core, roles, false);
        _writeManifest(d, core, roles);
    }

    /// @notice Read-only check of the deployed state against the manifest and the environment the
    ///         deployment used. With MAINNET_VERIFY_HANDOVER=true it expects governance to own
    ///         every contract, nothing pending, and graduation active.
    function verify() external {
        _requireChain();
        Roles memory roles = _roles(vm.envAddress("MAINNET_DEPLOYER"));
        Core memory core = _core();
        Deployment memory d = _load();
        _checkCore(core);
        _validateWiring(d, core);
        _validateRoles(d, core, roles, vm.envOr("MAINNET_VERIFY_HANDOVER", false));
    }

    // ---------------------------------------------------------------- deployment

    function _deployDex(Deployment memory d, Core memory core, Roles memory roles) private {
        d.dexFactory = new ZeroXFiFactoryV2(roles.deployer, core.nusd, WZKLTC, core.pump);
        // WzkLTC router fees go to the splitter too, which unwraps them into the NUSD reserve.
        d.dexRouter = new ZeroXFiRouterV2(address(d.dexFactory), WZKLTC, core.feeSplitter, core.feeSplitter);
        d.dexFactory.bindRouter(address(d.dexRouter));
        d.graduationAdapter =
            new ZeroXFiGraduationAdapter(address(d.dexFactory), core.pumpRouter, core.nusd, core.pump);
        d.dexFactory.bindGraduationAdapter(address(d.graduationAdapter));
        d.graduationController =
            new PumpGraduationController(core.pump, address(d.graduationAdapter), roles.governance, roles.guardian);
        d.gaugeFactory = new GaugeFactory(roles.deployer, core.nusd, address(d.dexFactory));
    }

    function _deploySynths(Deployment memory d, Core memory core, address deployer) private {
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
        // Sponsored minting is closed for good in this deployment: the reserve's share of a
        // sponsored position can be taken by self-liquidation after a price jump (audit D-01,
        // D-02, D-06), and pausing again does not protect a share once it is allocated. The pause
        // is set here and run() gives up the reserve's ownership below, so nobody can lift it;
        // every position is backed by its minter alone. A redesign needs new vaults in any case,
        // because the vault, the reserve and the synthetic token are bound to each other once.
        d.synthSafetyReserve.setAllocationsPaused(true);
        d.nbtc.bindVault(address(d.nbtcVault));
        d.neth.bindVault(address(d.nethVault));
        d.nbtc.renounceOwnership();
        d.neth.renounceOwnership();
    }

    function _deployLending(Deployment memory d, Core memory core, address deployer) private {
        d.lendingPool = new PooledNUSDLendingPoolV2(
            core.nusd, core.feeSplitter, deployer, LENDING_SUPPLY_CAP, LENDING_BORROW_CAP, true
        );
        d.lendingPool.configureCollateral(WZKLTC, core.ltcOracle, WZKLTC_COLLATERAL_CAP, 8000, 8500, 9000, 500, true);
        // nBTC and nETH are not listed as collateral: lending would value them at the feed price
        // even when a vault's bad debt has left part of their supply unbacked (audit D-03). The pool
        // takes one collateral asset, so none can be listed later; another asset needs another pool.
    }

    function _deployPairsAndPeriphery(Deployment memory d, Core memory core) private {
        PairAndGaugeEnsurer ensurer = new PairAndGaugeEnsurer();
        (d.wzkLtcNusdPair,) = ensurer.ensure(d.dexFactory, d.gaugeFactory, WZKLTC, core.nusd);
        (d.nbtcNusdPair,) = ensurer.ensure(d.dexFactory, d.gaugeFactory, address(d.nbtc), core.nusd);
        (d.nethNusdPair,) = ensurer.ensure(d.dexFactory, d.gaugeFactory, address(d.neth), core.nusd);

        d.lpLocker = new CommunityLiquidityLocker(address(d.dexFactory));
        d.tokenMetadataRegistry = new TokenMetadataRegistry(_protectedTokens(d, core));
    }

    function _protectedTokens(Deployment memory d, Core memory core) private view returns (address[] memory tokens) {
        tokens = new address[](4);
        tokens[0] = core.nusd;
        tokens[1] = WZKLTC;
        tokens[2] = address(d.nbtc);
        tokens[3] = address(d.neth);
    }

    function _feeSources(Deployment memory d, Core memory core)
        private
        view
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

    // ---------------------------------------------------------------- environment

    function _requireChain() private {
        uint256 expectedChainId = vm.envUint("MAINNET_CHAIN_ID");
        if (expectedChainId == TESTNET_CHAIN_ID || block.chainid != expectedChainId) {
            revert WrongChain(expectedChainId, block.chainid);
        }
    }

    function _roles(address deployer) private returns (Roles memory roles) {
        roles = Roles({
            deployer: deployer,
            governance: vm.envAddress("MAINNET_GOVERNANCE"),
            guardian: vm.envAddress("MAINNET_GUARDIAN")
        });
        if (roles.governance == address(0) || roles.guardian == address(0)) {
            revert UnexpectedConfiguration("governance and guardian must be set");
        }
        // The controller's governance can never be changed, so an address that does not exist on
        // this chain (a multisig deployed on another one, a typo) would lock the Pump's admin
        // powers for good. A contract here, or an account that has been funded here, is neither.
        if (roles.governance.code.length == 0 && roles.governance.balance == 0) {
            revert UnexpectedConfiguration("governance has neither code nor a balance on this chain");
        }
    }

    function _core() private returns (Core memory core) {
        core = Core({
            nusd: vm.envAddress("MAINNET_NUSD"),
            pump: vm.envAddress("MAINNET_PUMP"),
            pumpRouter: vm.envAddress("MAINNET_PUMP_GRADUATION_ROUTER"),
            feeSplitter: vm.envAddress("MAINNET_FEE_SPLITTER"),
            treasury: vm.envAddress("MAINNET_TREASURY"),
            ltcOracle: vm.envAddress("MAINNET_LTC_ORACLE"),
            btcOracle: vm.envAddress("MAINNET_BTC_ORACLE"),
            ethOracle: vm.envAddress("MAINNET_ETH_ORACLE")
        });
    }

    // ---------------------------------------------------------------- checks of the core

    /// @dev The core addresses fit together and each oracle router is the one its name says. Two
    ///      routers swapped in the environment would price nBTC with the ETH feed, and nothing
    ///      else would notice until someone traded against it.
    function _checkCore(Core memory core) private view {
        if (
            IV3Pump(core.pump).feeRecipient() != core.feeSplitter || IV3Pump(core.pump).NUSD() != core.nusd
                || IV3Pump(core.pump).graduationRouter() != core.pumpRouter
                || IPumpGraduationRouterV3(core.pumpRouter).pump() != core.pump
        ) revert UnexpectedConfiguration("pump core");
        IV3FeeSplitter splitter = IV3FeeSplitter(core.feeSplitter);
        if (splitter.nusd() != core.nusd || splitter.wrappedNative() != WZKLTC || splitter.treasury() != core.treasury) {
            revert UnexpectedConfiguration("fee splitter");
        }
        if (IV3Nusd(core.nusd).oracle() != core.ltcOracle) {
            revert UnexpectedConfiguration("NUSD does not price with the LTC router");
        }
        _checkOracle(core.ltcOracle, "LTC/USD");
        _checkOracle(core.btcOracle, "BTC/USD");
        _checkOracle(core.ethOracle, "ETH/USD");
    }

    function _checkOracle(address router, string memory expectedDescription) private view {
        if (keccak256(bytes(IV3OracleRouter(router).description())) != keccak256(bytes(expectedDescription))) {
            revert UnexpectedConfiguration("an oracle router is not the one its variable names");
        }
        (uint256 priceWad,,) = IV3OracleRouter(router).readPriceWad();
        if (priceWad == 0) revert UnexpectedConfiguration("an oracle router does not price right now");
    }

    /// @dev Before deploying: the core is as its own script left it and nothing here has run yet.
    function _checkCoreUntouched(Core memory core, address deployer) private view {
        IPumpGraduationRouterV3 pumpRouter = IPumpGraduationRouterV3(core.pumpRouter);
        if (
            pumpRouter.admin() != deployer || pumpRouter.enabled() || pumpRouter.enableAt() != 0
                || IV3Pump(core.pump).admin() != deployer
        ) revert UnexpectedConfiguration("pump core is not with the deployer or is already scheduled");
        IV3FeeSplitter splitter = IV3FeeSplitter(core.feeSplitter);
        if (splitter.admin() != deployer || splitter.sourceCount() != 0) {
            revert UnexpectedConfiguration("fee splitter is not with the deployer or already has sources");
        }
        if (
            IV3OracleRouter(core.ltcOracle).admin() != deployer || IV3OracleRouter(core.btcOracle).admin() != deployer
                || IV3OracleRouter(core.ethOracle).admin() != deployer
        ) revert UnexpectedConfiguration("oracle routers are not with the deployer");
    }

    // ---------------------------------------------------------------- checks of this deployment

    /// @dev Everything that does not depend on who holds a role.
    function _validateWiring(Deployment memory d, Core memory core) private view {
        _validateDex(d, core);
        _validateSynths(d, core);
        _validateLending(d, core);
        _validatePairsAndPeriphery(d, core);
        _validateFeeSources(d, core);
    }

    function _validateDex(Deployment memory d, Core memory core) private view {
        if (
            d.dexFactory.nusd() != core.nusd || d.dexFactory.wzkLTC() != WZKLTC || d.dexFactory.pump() != core.pump
                || d.dexFactory.router() != address(d.dexRouter)
                || d.dexFactory.graduationAdapter() != address(d.graduationAdapter)
        ) revert UnexpectedConfiguration("factory");
        if (
            address(d.dexRouter.factory()) != address(d.dexFactory) || d.dexRouter.nusd() != core.nusd
                || d.dexRouter.feeSplitter() != core.feeSplitter || d.dexRouter.treasury() != core.feeSplitter
                || d.dexRouter.DIRECT_FEE_BPS() != 10 || d.dexRouter.CROSS_FEE_BPS() != 30
                || d.dexRouter.LP_FEE_BPS() != 50
        ) revert UnexpectedConfiguration("router");
        if (
            address(d.graduationAdapter.factory()) != address(d.dexFactory)
                || d.graduationAdapter.pumpRouter() != core.pumpRouter || d.graduationAdapter.nusd() != core.nusd
                || d.graduationAdapter.pump() != core.pump
        ) revert UnexpectedConfiguration("graduation adapter");
        if (
            address(d.graduationController.pump()) != core.pump
                || address(d.graduationController.adapter()) != address(d.graduationAdapter)
                || address(d.graduationController.router()) != core.pumpRouter
        ) revert UnexpectedConfiguration("graduation controller wiring");
        if (address(d.gaugeFactory.nusd()) != core.nusd || address(d.gaugeFactory.dexFactory()) != address(d.dexFactory)) {
            revert UnexpectedConfiguration("gauge factory");
        }
    }

    function _validateSynths(Deployment memory d, Core memory core) private view {
        if (
            address(d.nbtcVault.mintFeeDistributor()) != core.feeSplitter
                || address(d.nethVault.mintFeeDistributor()) != core.feeSplitter || d.nbtc.vault() != address(d.nbtcVault)
                || d.neth.vault() != address(d.nethVault) || d.nbtc.owner() != address(0) || d.neth.owner() != address(0)
                || d.nbtcVault.debtCeilingSynthetic() != NBTC_DEBT_CEILING
                || d.nethVault.debtCeilingSynthetic() != NETH_DEBT_CEILING
        ) revert UnexpectedConfiguration("synths");
        if (
            address(d.nbtcVault.oracle()) != core.btcOracle || address(d.nethVault.oracle()) != core.ethOracle
                || address(d.nbtcVault.syntheticAsset()) != address(d.nbtc)
                || address(d.nethVault.syntheticAsset()) != address(d.neth)
                || address(d.nbtcVault.safetyReserve()) != address(d.synthSafetyReserve)
                || address(d.nethVault.safetyReserve()) != address(d.synthSafetyReserve)
        ) revert UnexpectedConfiguration("synth vaults");
        if (
            !d.synthSafetyReserve.vaultsBound() || !d.synthSafetyReserve.allocationsPaused()
                || !d.synthSafetyReserve.isVault(address(d.nbtcVault))
                || !d.synthSafetyReserve.isVault(address(d.nethVault))
                || address(d.synthSafetyReserve.nusd()) != core.nusd
        ) revert UnexpectedConfiguration("safety reserve");
    }

    function _validateLending(Deployment memory d, Core memory core) private view {
        if (
            d.lendingPool.feeSplitter() != core.feeSplitter || d.lendingPool.supplyCapNusd() != LENDING_SUPPLY_CAP
                || d.lendingPool.borrowCapNusd() != LENDING_BORROW_CAP || !d.lendingPool.activated()
                || d.lendingPool.collateralAssetCount() != 1 || d.lendingPool.MAX_COLLATERAL_ASSETS() != 1
        ) revert UnexpectedConfiguration("lending");
        (
            address oracle,
            uint256 supplyCap,
            uint16 loanToValueBps,
            uint16 liquidationThresholdBps,
            uint16 liquidationBonusBps,
            ,
            bool enabled,
            uint16 marginCallThresholdBps
        ) = d.lendingPool.collateralConfigs(WZKLTC);
        if (
            oracle != core.ltcOracle || supplyCap != WZKLTC_COLLATERAL_CAP || loanToValueBps != 8000
                || marginCallThresholdBps != 8500 || liquidationThresholdBps != 9000 || liquidationBonusBps != 500
                || !enabled
        ) revert UnexpectedConfiguration("WzkLTC collateral");
    }

    function _validatePairsAndPeriphery(Deployment memory d, Core memory core) private view {
        if (
            d.wzkLtcNusdPair == address(0) || d.nbtcNusdPair == address(0) || d.nethNusdPair == address(0)
                || d.dexFactory.getPair(WZKLTC, core.nusd) != d.wzkLtcNusdPair
                || d.dexFactory.getPair(address(d.nbtc), core.nusd) != d.nbtcNusdPair
                || d.dexFactory.getPair(address(d.neth), core.nusd) != d.nethNusdPair
        ) revert UnexpectedConfiguration("pairs");
        if (
            d.gaugeFactory.gaugeForPair(d.wzkLtcNusdPair) == address(0)
                || d.gaugeFactory.gaugeForPair(d.nbtcNusdPair) == address(0)
                || d.gaugeFactory.gaugeForPair(d.nethNusdPair) == address(0)
        ) revert UnexpectedConfiguration("gauges");
        if (address(d.lpLocker.factory()) != address(d.dexFactory)) revert UnexpectedConfiguration("LP locker");
        address[] memory tokens = _protectedTokens(d, core);
        for (uint256 index; index < tokens.length; ++index) {
            if (!d.tokenMetadataRegistry.isProtectedToken(tokens[index])) {
                revert UnexpectedConfiguration("token metadata registry");
            }
        }
    }

    function _validateFeeSources(Deployment memory d, Core memory core) private view {
        IV3FeeSplitter splitter = IV3FeeSplitter(core.feeSplitter);
        IV3FeeSplitter.Source[] memory expected = _feeSources(d, core);
        if (splitter.sourceCount() != expected.length) revert UnexpectedConfiguration("fee sources");
        for (uint256 index; index < expected.length; ++index) {
            (address target, bytes memory data) = splitter.sourceAt(index);
            if (target != expected[index].target || keccak256(data) != keccak256(expected[index].data)) {
                revert UnexpectedConfiguration("fee sources");
            }
        }
    }

    /// @dev Who holds what. Right after `run()`: the deployer owns five contracts with governance
    ///      pending on each, and graduation is at least scheduled. After the handover: governance
    ///      owns them, nothing is pending, and graduation is active. The Safety Reserve has no
    ///      owner in either state.
    function _validateRoles(Deployment memory d, Core memory core, Roles memory roles, bool handedOver) private view {
        IPumpGraduationRouterV3 pumpRouter = IPumpGraduationRouterV3(core.pumpRouter);
        if (
            IV3Pump(core.pump).admin() != address(d.graduationController)
                || pumpRouter.admin() != address(d.graduationController)
                || d.graduationController.governance() != roles.governance
                || d.graduationController.guardian() != roles.guardian
        ) revert UnexpectedConfiguration("graduation controller");
        bool adapterActive = pumpRouter.isAdapterAllowed(address(d.graduationAdapter));
        bool routerActive = pumpRouter.enabled();
        if (handedOver) {
            if (!adapterActive || !routerActive) revert UnexpectedConfiguration("graduation is not active");
        } else if (
            (!adapterActive && pumpRouter.adapterActivationTime(address(d.graduationAdapter)) == 0)
                || (!routerActive && pumpRouter.enableAt() == 0)
        ) {
            revert UnexpectedConfiguration("graduation schedule");
        }
        _validateOwned(d.dexFactory, roles, handedOver);
        _validateOwned(d.gaugeFactory, roles, handedOver);
        if (
            d.synthSafetyReserve.owner() != address(0) || d.synthSafetyReserve.pendingOwner() != address(0)
                || d.synthSafetyReserve.guardian() != roles.guardian
        ) revert UnexpectedConfiguration("the Safety Reserve must have no owner and the configured guardian");
        _validateOwned(d.nbtcVault, roles, handedOver);
        _validateOwned(d.nethVault, roles, handedOver);
        _validateOwned(d.lendingPool, roles, handedOver);
    }

    function _validateOwned(EmergencyGuardian target, Roles memory roles, bool handedOver) private view {
        if (target.guardian() != roles.guardian) revert UnexpectedConfiguration("a guardian is not the configured one");
        address expectedOwner = handedOver ? roles.governance : roles.deployer;
        address expectedPending = handedOver || roles.governance == roles.deployer ? address(0) : roles.governance;
        if (target.owner() != expectedOwner || target.pendingOwner() != expectedPending) {
            revert UnexpectedConfiguration(
                handedOver ? "governance does not own every 0xFi contract yet" : "a 0xFi owner or pending owner"
            );
        }
    }

    // ---------------------------------------------------------------- manifest

    function _manifestPath() private returns (string memory) {
        return string.concat("./deployments/mainnet-fi", vm.envOr("MAINNET_MANIFEST_SUFFIX", string("")), ".json");
    }

    function _writeManifest(Deployment memory d, Core memory core, Roles memory roles) private {
        string memory key = "fi";
        vm.serializeUint(key, "chainId", block.chainid);
        vm.serializeUint(key, "scriptBlock", block.number);
        vm.serializeAddress(key, "deployer", roles.deployer);
        vm.serializeAddress(key, "governance", roles.governance);
        vm.serializeAddress(key, "guardian", roles.guardian);
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
        // Gauge addresses depend on who created them and in which order, so they are not recorded:
        // read `GaugeFactory.gaugeForPair(pair)`.
        vm.serializeAddress(key, "wzkLtcNusdPair", d.wzkLtcNusdPair);
        vm.serializeAddress(key, "nBTCNusdPair", d.nbtcNusdPair);
        string memory json = vm.serializeAddress(key, "nETHNusdPair", d.nethNusdPair);
        vm.writeJson(json, _manifestPath());
    }

    function _load() private returns (Deployment memory d) {
        string memory json = vm.readFile(_manifestPath());
        d.dexFactory = ZeroXFiFactoryV2(vm.parseJsonAddress(json, ".dexFactory"));
        d.dexRouter = ZeroXFiRouterV2(payable(vm.parseJsonAddress(json, ".dexRouter")));
        d.graduationAdapter = ZeroXFiGraduationAdapter(vm.parseJsonAddress(json, ".pumpGraduationAdapter"));
        d.graduationController = PumpGraduationController(vm.parseJsonAddress(json, ".pumpGraduationController"));
        d.gaugeFactory = GaugeFactory(vm.parseJsonAddress(json, ".gaugeFactory"));
        d.synthSafetyReserve = SynthSafetyReserve(vm.parseJsonAddress(json, ".synthSafetyReserve"));
        d.nbtc = SyntheticAsset(vm.parseJsonAddress(json, ".nBTC"));
        d.neth = SyntheticAsset(vm.parseJsonAddress(json, ".nETH"));
        d.nbtcVault = SyntheticVault(vm.parseJsonAddress(json, ".nBTCVault"));
        d.nethVault = SyntheticVault(vm.parseJsonAddress(json, ".nETHVault"));
        d.lendingPool = PooledNUSDLendingPoolV2(vm.parseJsonAddress(json, ".lendingPool"));
        d.lpLocker = CommunityLiquidityLocker(vm.parseJsonAddress(json, ".lpLocker"));
        d.tokenMetadataRegistry = TokenMetadataRegistry(vm.parseJsonAddress(json, ".tokenMetadataRegistry"));
        d.wzkLtcNusdPair = vm.parseJsonAddress(json, ".wzkLtcNusdPair");
        d.nbtcNusdPair = vm.parseJsonAddress(json, ".nBTCNusdPair");
        d.nethNusdPair = vm.parseJsonAddress(json, ".nETHNusdPair");
        if (address(d.dexFactory).code.length == 0 || address(d.lendingPool).code.length == 0) {
            revert UnexpectedConfiguration("the manifest does not describe this chain");
        }
    }
}
