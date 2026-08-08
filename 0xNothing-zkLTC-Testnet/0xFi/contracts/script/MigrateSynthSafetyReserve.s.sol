// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { ZeroXFiRouter } from "../src/amm/ZeroXFiRouter.sol";
import { GaugeFactory } from "../src/farming/GaugeFactory.sol";
import { PooledNUSDLendingPool } from "../src/lending/PooledNUSDLendingPool.sol";
import { IZeroXFiFactory } from "../src/interfaces/IZeroXFiFactory.sol";
import { SyntheticAsset } from "../src/synth/SyntheticAsset.sol";
import { SynthSafetyReserve } from "../src/synth/SynthSafetyReserve.sol";
import { SyntheticVault } from "../src/synth/SyntheticVault.sol";

interface VmMigrateSynthSafetyReserve {
    function addr(uint256 privateKey) external returns (address keyAddress);
    function envAddress(string calldata key) external returns (address value);
    function envUint(string calldata key) external returns (uint256 value);
    function serializeAddress(string calldata objectKey, string calldata valueKey, address value)
        external
        returns (string memory json);
    function serializeBool(string calldata objectKey, string calldata valueKey, bool value)
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

interface ILegacySyntheticVault {
    function owner() external view returns (address);
    function pendingOwner() external view returns (address);
    function guardian() external view returns (address);
    function nusd() external view returns (address);
    function syntheticAsset() external view returns (address);
    function oracle() external view returns (address);
    function debtCeilingSynthetic() external view returns (uint256);
    function totalCollateralNusd() external view returns (uint256);
    function totalDebtSynthetic() external view returns (uint256);
    function totalBadDebtSynthetic() external view returns (uint256);
    function mintPaused() external view returns (bool);
    function withdrawPaused() external view returns (bool);
    function setMintPaused(bool paused) external;
    function setWithdrawPaused(bool paused) external;
}

interface ILegacyGauge {
    function stakingToken() external view returns (address);
    function rewardToken() external view returns (address);
    function distributor() external view returns (address);
    function totalSupply() external view returns (uint256);
    function periodFinish() external view returns (uint256);
    function rewardRate() external view returns (uint256);
    function lastUpdateTime() external view returns (uint256);
    function rewardPerTokenStored() external view returns (uint256);
    function totalFunded() external view returns (uint256);
    function totalPaid() external view returns (uint256);
    function depositsPaused() external view returns (bool);
}

interface ILegacyPair is IERC20 {
    function factory() external view returns (address);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
}

/// @notice Replaces debt-free synth markets with reserve-aware vaults without moving user or lending NUSD.
/// @dev The script writes only a prediction. A receipt-aware finalizer must verify the broadcast before publication.
contract MigrateSynthSafetyReserve {
    error ActiveLegacyState();
    error UnexpectedConfiguration();
    error WrongChain(uint256 expectedChainId, uint256 actualChainId);
    error WrongDeployer(address expected, address actual);

    VmMigrateSynthSafetyReserve private constant vm =
        VmMigrateSynthSafetyReserve(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 private constant CHAIN_ID = 4441;
    uint256 private constant NBTC_DEBT_CEILING = 0.01 ether;
    uint256 private constant NETH_DEBT_CEILING = 0.25 ether;
    uint256 private constant NBTC_COLLATERAL_CAP = 0.01 ether;
    uint256 private constant NETH_COLLATERAL_CAP = 0.25 ether;
    uint256 private constant ENTRY_TVL_NUSD = 100_000 ether;
    uint256 private constant EXIT_TVL_NUSD = 90_000 ether;
    uint256 private constant ACTIVATION_DELAY = 24 hours;
    bytes32 private constant LENDING_IMPLEMENTATION_ID =
        keccak256("0xfi.lending.fixed-4.5-4-0.5.80-85-90.paused-bootstrap.v2");

    address private constant DEPLOYER = 0x58633401dCc383F010688e950878000000000000;
    address private constant NUSD = 0x5317e21aba902c6c7087a84457bc02fFe99604d1;
    address private constant DEX_FACTORY = 0xe33fE815c2e12DC83b69397CeD12b09849Fa9C0D;
    address private constant LEGACY_GAUGE_FACTORY = 0x36F425fddc59d281c6ddEaDAc34B32E6f039EB13;
    address private constant WZKLTC = 0xE93d4373CE1eDA3df6c3Ab7ed3ab07A07aA5939F;
    address private constant BTC_ORACLE = 0x781178849cE1D131EFbedff1EF52323A6E117813;
    address private constant ETH_ORACLE = 0x8E9BD05a80542B171719ac0d749a7A609D69E324;

    address private constant OLD_NBTC = 0xc44B6027eBc4859d2E7e2bCF17188C29b1BC1655;
    address private constant OLD_NETH = 0x60590B1f4F17969B8c52c2c0B533404Bbb62206b;
    address private constant OLD_NBTC_VAULT = 0x620fB32a1e113aA3D1121baC0c65f919569dF1d3;
    address private constant OLD_NETH_VAULT = 0xA7dA20a8a0d833eFcc0B2ca8189011FCFeab7465;
    address private constant OLD_NBTC_PAIR = 0xF791643Bb8c86516e9e8a1c4F25cDDc438ced80C;
    address private constant OLD_NETH_PAIR = 0x5cB49442b1684C39FC9348022114FEef6FdB3617;
    address private constant OLD_NBTC_GAUGE = 0x622eAf97dfe1f284850a462039568aCF52c2B0B4;
    address private constant OLD_NETH_GAUGE = 0xa28656a5277Db9Bcf0Bd8fe0312A52Dd3e7a55c8;

    struct Migration {
        GaugeFactory synthFeeGaugeFactory;
        ZeroXFiRouter dexRouter;
        SynthSafetyReserve reserve;
        SyntheticAsset nbtc;
        SyntheticAsset neth;
        SyntheticVault nbtcVault;
        SyntheticVault nethVault;
        address nbtcNusdPair;
        address nethNusdPair;
        address nbtcNusdGauge;
        address nethNusdGauge;
    }

    function run() external returns (Migration memory migration) {
        if (block.chainid != CHAIN_ID) revert WrongChain(CHAIN_ID, block.chainid);

        uint256 privateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(privateKey);
        if (deployer != DEPLOYER) revert WrongDeployer(DEPLOYER, deployer);
        PooledNUSDLendingPool lendingPool = PooledNUSDLendingPool(vm.envAddress("LENDING_POOL"));

        _requireLegacyConfiguration(lendingPool);
        _requireLegacyStateSafe(lendingPool);

        vm.startBroadcast(privateKey);

        ILegacySyntheticVault(OLD_NBTC_VAULT).setMintPaused(true);
        // Deposits cannot be paused in the legacy implementation. Keep debt-free exits open
        // so a direct post-retirement deposit can never become trapped.
        ILegacySyntheticVault(OLD_NBTC_VAULT).setWithdrawPaused(false);
        ILegacySyntheticVault(OLD_NETH_VAULT).setMintPaused(true);
        ILegacySyntheticVault(OLD_NETH_VAULT).setWithdrawPaused(false);

        GaugeFactory legacyGaugeFactory = GaugeFactory(LEGACY_GAUGE_FACTORY);
        legacyGaugeFactory.setGaugeDepositsPaused(OLD_NBTC_PAIR, true);
        legacyGaugeFactory.setGaugeDepositsPaused(OLD_NETH_PAIR, true);

        lendingPool.configureCollateral(OLD_NBTC, BTC_ORACLE, NBTC_COLLATERAL_CAP, 8000, 8500, 9000, 500, false);
        lendingPool.configureCollateral(OLD_NETH, ETH_ORACLE, NETH_COLLATERAL_CAP, 8000, 8500, 9000, 500, false);

        // Deposits cannot be paused on the legacy vaults. Existing debt-free collateral remains
        // fully backed and withdrawable while all debt/mint/LP/lending paths must stay empty.
        _requireLegacyStateSafe(lendingPool);
        _validateRetiredMarkets(lendingPool);

        migration.synthFeeGaugeFactory = new GaugeFactory(deployer, NUSD, DEX_FACTORY);
        migration.dexRouter = new ZeroXFiRouter(DEX_FACTORY, WZKLTC);
        migration.reserve = new SynthSafetyReserve(NUSD, deployer);
        migration.nbtc = new SyntheticAsset("0xFi Synthetic Bitcoin", "nBTC", deployer);
        migration.neth = new SyntheticAsset("0xFi Synthetic Ether", "nETH", deployer);
        migration.nbtcVault = new SyntheticVault(
            NUSD,
            address(migration.nbtc),
            BTC_ORACLE,
            address(migration.reserve),
            address(migration.synthFeeGaugeFactory),
            deployer,
            NBTC_DEBT_CEILING,
            false
        );
        migration.nethVault = new SyntheticVault(
            NUSD,
            address(migration.neth),
            ETH_ORACLE,
            address(migration.reserve),
            address(migration.synthFeeGaugeFactory),
            deployer,
            NETH_DEBT_CEILING,
            false
        );

        migration.reserve.bindVaults(address(migration.nbtcVault), address(migration.nethVault));
        migration.nbtc.bindVault(address(migration.nbtcVault));
        migration.neth.bindVault(address(migration.nethVault));
        migration.nbtc.renounceOwnership();
        migration.neth.renounceOwnership();

        IZeroXFiFactory dexFactory = IZeroXFiFactory(DEX_FACTORY);
        migration.nbtcNusdPair = dexFactory.createPair(address(migration.nbtc), NUSD);
        migration.nethNusdPair = dexFactory.createPair(address(migration.neth), NUSD);
        migration.nbtcNusdGauge = migration.synthFeeGaugeFactory.createGauge(migration.nbtcNusdPair);
        migration.nethNusdGauge = migration.synthFeeGaugeFactory.createGauge(migration.nethNusdPair);
        migration.synthFeeGaugeFactory.setGaugeDepositsPaused(migration.nbtcNusdPair, true);
        migration.synthFeeGaugeFactory.setGaugeDepositsPaused(migration.nethNusdPair, true);
        migration.synthFeeGaugeFactory.bindMintFeeVault(address(migration.nbtcVault), migration.nbtcNusdPair);
        migration.synthFeeGaugeFactory.bindMintFeeVault(address(migration.nethVault), migration.nethNusdPair);

        lendingPool.configureCollateral(
            address(migration.nbtc), BTC_ORACLE, NBTC_COLLATERAL_CAP, 8000, 8500, 9000, 500, true
        );
        lendingPool.configureCollateral(
            address(migration.neth), ETH_ORACLE, NETH_COLLATERAL_CAP, 8000, 8500, 9000, 500, true
        );

        _validateMigration(migration, lendingPool);

        vm.stopBroadcast();
        _writePrediction(migration, lendingPool);
    }

    function _requireLegacyConfiguration(PooledNUSDLendingPool lendingPool) private view {
        ILegacySyntheticVault nbtcVault = ILegacySyntheticVault(OLD_NBTC_VAULT);
        ILegacySyntheticVault nethVault = ILegacySyntheticVault(OLD_NETH_VAULT);
        GaugeFactory legacyGaugeFactory = GaugeFactory(LEGACY_GAUGE_FACTORY);
        IZeroXFiFactory dexFactory = IZeroXFiFactory(DEX_FACTORY);

        if (
            OLD_NBTC.code.length == 0 || OLD_NETH.code.length == 0 || OLD_NBTC_VAULT.code.length == 0
                || OLD_NETH_VAULT.code.length == 0 || OLD_NBTC_PAIR.code.length == 0 || OLD_NETH_PAIR.code.length == 0
                || OLD_NBTC_GAUGE.code.length == 0 || OLD_NETH_GAUGE.code.length == 0
                || LEGACY_GAUGE_FACTORY.code.length == 0 || address(lendingPool).code.length == 0
        ) revert UnexpectedConfiguration();

        if (
            nbtcVault.owner() != DEPLOYER || nbtcVault.pendingOwner() != address(0) || nbtcVault.guardian() != DEPLOYER
                || nbtcVault.nusd() != NUSD || nbtcVault.syntheticAsset() != OLD_NBTC
                || nbtcVault.oracle() != BTC_ORACLE || nbtcVault.debtCeilingSynthetic() != NBTC_DEBT_CEILING
                || nethVault.owner() != DEPLOYER || nethVault.pendingOwner() != address(0)
                || nethVault.guardian() != DEPLOYER || nethVault.nusd() != NUSD
                || nethVault.syntheticAsset() != OLD_NETH || nethVault.oracle() != ETH_ORACLE
                || nethVault.debtCeilingSynthetic() != NETH_DEBT_CEILING
                || SyntheticAsset(OLD_NBTC).vault() != OLD_NBTC_VAULT
                || SyntheticAsset(OLD_NETH).vault() != OLD_NETH_VAULT || SyntheticAsset(OLD_NBTC).owner() != address(0)
                || SyntheticAsset(OLD_NETH).owner() != address(0)
        ) revert UnexpectedConfiguration();

        if (
            address(legacyGaugeFactory.nusd()) != NUSD || address(legacyGaugeFactory.dexFactory()) != DEX_FACTORY
                || legacyGaugeFactory.owner() != DEPLOYER || legacyGaugeFactory.pendingOwner() != address(0)
                || legacyGaugeFactory.guardian() != DEPLOYER
                || legacyGaugeFactory.gaugeForPair(OLD_NBTC_PAIR) != OLD_NBTC_GAUGE
                || legacyGaugeFactory.gaugeForPair(OLD_NETH_PAIR) != OLD_NETH_GAUGE
                || dexFactory.getPair(OLD_NBTC, NUSD) != OLD_NBTC_PAIR
                || dexFactory.getPair(OLD_NETH, NUSD) != OLD_NETH_PAIR
        ) revert UnexpectedConfiguration();

        _validateStagedLending(lendingPool);
        _validateCollateral(lendingPool, OLD_NBTC, BTC_ORACLE, NBTC_COLLATERAL_CAP, true);
        _validateCollateral(lendingPool, OLD_NETH, ETH_ORACLE, NETH_COLLATERAL_CAP, true);
        _validatePairBinding(OLD_NBTC_PAIR, OLD_NBTC);
        _validatePairBinding(OLD_NETH_PAIR, OLD_NETH);
        _validateGaugeBinding(OLD_NBTC_GAUGE, OLD_NBTC_PAIR, LEGACY_GAUGE_FACTORY);
        _validateGaugeBinding(OLD_NETH_GAUGE, OLD_NETH_PAIR, LEGACY_GAUGE_FACTORY);
    }

    function _requireLegacyStateSafe(PooledNUSDLendingPool lendingPool) private view {
        uint256 nbtcCollateral = ILegacySyntheticVault(OLD_NBTC_VAULT).totalCollateralNusd();
        uint256 nethCollateral = ILegacySyntheticVault(OLD_NETH_VAULT).totalCollateralNusd();
        if (
            ILegacySyntheticVault(OLD_NBTC_VAULT).totalDebtSynthetic() != 0
                || ILegacySyntheticVault(OLD_NBTC_VAULT).totalBadDebtSynthetic() != 0
                || ILegacySyntheticVault(OLD_NETH_VAULT).totalDebtSynthetic() != 0
                || ILegacySyntheticVault(OLD_NETH_VAULT).totalBadDebtSynthetic() != 0
                || IERC20(OLD_NBTC).totalSupply() != 0 || IERC20(OLD_NETH).totalSupply() != 0
                || IERC20(OLD_NBTC).balanceOf(OLD_NBTC_VAULT) != 0 || IERC20(OLD_NETH).balanceOf(OLD_NETH_VAULT) != 0
                || IERC20(NUSD).balanceOf(OLD_NBTC_VAULT) < nbtcCollateral
                || IERC20(NUSD).balanceOf(OLD_NETH_VAULT) < nethCollateral
                || lendingPool.totalCollateralByAsset(OLD_NBTC) != 0
                || lendingPool.totalCollateralByAsset(OLD_NETH) != 0
                || IERC20(OLD_NBTC).balanceOf(address(lendingPool)) != 0
                || IERC20(OLD_NETH).balanceOf(address(lendingPool)) != 0
        ) revert ActiveLegacyState();
        _requirePairEmpty(OLD_NBTC_PAIR);
        _requirePairEmpty(OLD_NETH_PAIR);
        _requireGaugeEmpty(OLD_NBTC_GAUGE);
        _requireGaugeEmpty(OLD_NETH_GAUGE);
    }

    function _validateRetiredMarkets(PooledNUSDLendingPool lendingPool) private view {
        if (
            !ILegacySyntheticVault(OLD_NBTC_VAULT).mintPaused()
                || ILegacySyntheticVault(OLD_NBTC_VAULT).withdrawPaused()
                || !ILegacySyntheticVault(OLD_NETH_VAULT).mintPaused()
                || ILegacySyntheticVault(OLD_NETH_VAULT).withdrawPaused()
                || !ILegacyGauge(OLD_NBTC_GAUGE).depositsPaused() || !ILegacyGauge(OLD_NETH_GAUGE).depositsPaused()
        ) revert UnexpectedConfiguration();

        _validateCollateral(lendingPool, OLD_NBTC, BTC_ORACLE, NBTC_COLLATERAL_CAP, false);
        _validateCollateral(lendingPool, OLD_NETH, ETH_ORACLE, NETH_COLLATERAL_CAP, false);
    }

    function _validateMigration(Migration memory migration, PooledNUSDLendingPool lendingPool) private view {
        _validateStagedLending(lendingPool);
        if (
            address(migration.reserve.nusd()) != NUSD || migration.reserve.owner() != DEPLOYER
                || migration.reserve.pendingOwner() != address(0) || migration.reserve.guardian() != DEPLOYER
                || migration.reserve.ENTRY_TVL_NUSD() != ENTRY_TVL_NUSD
                || migration.reserve.EXIT_TVL_NUSD() != EXIT_TVL_NUSD
                || migration.reserve.ACTIVATION_DELAY() != ACTIVATION_DELAY
                || !migration.reserve.authorizedVault(address(migration.nbtcVault))
                || !migration.reserve.authorizedVault(address(migration.nethVault)) || !migration.reserve.vaultsBound()
                || migration.reserve.vault0() != address(migration.nbtcVault)
                || migration.reserve.vault1() != address(migration.nethVault)
                || migration.reserve.totalReserveNusd() != migration.reserve.freeReserveNusd()
                || migration.reserve.freeReserveNusd() != IERC20(NUSD).balanceOf(address(migration.reserve))
                || migration.reserve.totalAllocatedNusd() != 0 || migration.reserve.sponsorshipActive()
                || migration.reserve.eligibleSince() != 0 || migration.reserve.allocationsPaused()
        ) revert UnexpectedConfiguration();

        _validateVault(
            migration.nbtcVault,
            migration.nbtc,
            BTC_ORACLE,
            migration.reserve,
            migration.synthFeeGaugeFactory,
            NBTC_DEBT_CEILING
        );
        _validateVault(
            migration.nethVault,
            migration.neth,
            ETH_ORACLE,
            migration.reserve,
            migration.synthFeeGaugeFactory,
            NETH_DEBT_CEILING
        );

        if (
            migration.nbtc.vault() != address(migration.nbtcVault)
                || migration.neth.vault() != address(migration.nethVault) || migration.nbtc.owner() != address(0)
                || migration.neth.owner() != address(0) || migration.nbtc.totalSupply() != 0
                || migration.neth.totalSupply() != 0
        ) revert UnexpectedConfiguration();

        IZeroXFiFactory dexFactory = IZeroXFiFactory(DEX_FACTORY);
        if (
            address(migration.synthFeeGaugeFactory.nusd()) != NUSD
                || address(migration.synthFeeGaugeFactory.dexFactory()) != DEX_FACTORY
                || migration.synthFeeGaugeFactory.owner() != DEPLOYER
                || migration.synthFeeGaugeFactory.pendingOwner() != address(0)
                || migration.synthFeeGaugeFactory.guardian() != DEPLOYER
                || migration.synthFeeGaugeFactory.allGaugesLength() != 2
                || migration.synthFeeGaugeFactory.totalPendingMintFeesNusd() != 0
                || address(migration.dexRouter.factory()) != DEX_FACTORY
                || address(migration.dexRouter.wzkLTC()) != WZKLTC || migration.dexRouter.FEE_DENOMINATOR() != 10_000
                || migration.dexRouter.LP_FEE_BPS() != 50 || migration.dexRouter.PROTOCOL_FEE_BPS() != 10
                || migration.dexRouter.ROUTE_SURCHARGE_BPS() != 10
                || dexFactory.getPair(address(migration.nbtc), NUSD) != migration.nbtcNusdPair
                || dexFactory.getPair(address(migration.neth), NUSD) != migration.nethNusdPair
                || migration.synthFeeGaugeFactory.gaugeForPair(migration.nbtcNusdPair) != migration.nbtcNusdGauge
                || migration.synthFeeGaugeFactory.gaugeForPair(migration.nethNusdPair) != migration.nethNusdGauge
                || migration.synthFeeGaugeFactory.mintFeePairForVault(address(migration.nbtcVault))
                    != migration.nbtcNusdPair
                || migration.synthFeeGaugeFactory.mintFeePairForVault(address(migration.nethVault))
                    != migration.nethNusdPair
                || migration.synthFeeGaugeFactory.mintFeeVaultForPair(migration.nbtcNusdPair)
                    != address(migration.nbtcVault)
                || migration.synthFeeGaugeFactory.mintFeeVaultForPair(migration.nethNusdPair)
                    != address(migration.nethVault) || !ILegacyGauge(migration.nbtcNusdGauge).depositsPaused()
                || !ILegacyGauge(migration.nethNusdGauge).depositsPaused()
        ) revert UnexpectedConfiguration();
        _validatePairBinding(migration.nbtcNusdPair, address(migration.nbtc));
        _validatePairBinding(migration.nethNusdPair, address(migration.neth));
        _validateGaugeBinding(migration.nbtcNusdGauge, migration.nbtcNusdPair, address(migration.synthFeeGaugeFactory));
        _validateGaugeBinding(migration.nethNusdGauge, migration.nethNusdPair, address(migration.synthFeeGaugeFactory));
        _requirePairEmpty(migration.nbtcNusdPair);
        _requirePairEmpty(migration.nethNusdPair);
        _requireGaugeEmpty(migration.nbtcNusdGauge);
        _requireGaugeEmpty(migration.nethNusdGauge);

        _validateCollateral(lendingPool, OLD_NBTC, BTC_ORACLE, NBTC_COLLATERAL_CAP, false);
        _validateCollateral(lendingPool, OLD_NETH, ETH_ORACLE, NETH_COLLATERAL_CAP, false);
        _validateCollateral(lendingPool, address(migration.nbtc), BTC_ORACLE, NBTC_COLLATERAL_CAP, true);
        _validateCollateral(lendingPool, address(migration.neth), ETH_ORACLE, NETH_COLLATERAL_CAP, true);
        if (
            lendingPool.totalCollateralByAsset(OLD_NBTC) != 0 || lendingPool.totalCollateralByAsset(OLD_NETH) != 0
                || lendingPool.totalCollateralByAsset(address(migration.nbtc)) != 0
                || lendingPool.totalCollateralByAsset(address(migration.neth)) != 0
        ) revert ActiveLegacyState();
        _requireLegacyStateSafe(lendingPool);
    }

    function _validateStagedLending(PooledNUSDLendingPool lendingPool) private view {
        if (
            address(lendingPool.nusd()) != NUSD || lendingPool.owner() != DEPLOYER
                || lendingPool.pendingOwner() != address(0) || lendingPool.guardian() != DEPLOYER
                || lendingPool.IMPLEMENTATION_ID() != LENDING_IMPLEMENTATION_ID || lendingPool.activated()
                || lendingPool.bootstrapOpen() || !lendingPool.supplyPaused() || !lendingPool.borrowPaused()
                || !lendingPool.collateralWithdrawalPaused() || lendingPool.totalBorrowed() != 0
                || lendingPool.totalBadDebtNusd() != 0 || lendingPool.totalCollateralByAsset(WZKLTC) != 0
        ) revert UnexpectedConfiguration();
    }

    function _validateVault(
        SyntheticVault vault,
        SyntheticAsset asset,
        address oracle,
        SynthSafetyReserve reserve,
        GaugeFactory gaugeFactory,
        uint256 debtCeiling
    ) private view {
        if (
            address(vault.nusd()) != NUSD || address(vault.syntheticAsset()) != address(asset)
                || address(vault.oracle()) != oracle || address(vault.safetyReserve()) != address(reserve)
                || address(vault.mintFeeDistributor()) != address(gaugeFactory) || vault.owner() != DEPLOYER
                || vault.pendingOwner() != address(0) || vault.guardian() != DEPLOYER
                || vault.debtCeilingSynthetic() != debtCeiling || vault.totalCollateralNusd() != 0
                || vault.totalDebtSynthetic() != 0 || vault.totalBadDebtSynthetic() != 0 || vault.activated()
                || !vault.mintPaused() || !vault.withdrawPaused()
                || IERC20(NUSD).allowance(address(vault), address(reserve)) != type(uint256).max
                || IERC20(NUSD).allowance(address(vault), address(gaugeFactory)) != 0
                || asset.balanceOf(address(vault)) != 0
        ) revert UnexpectedConfiguration();
    }

    function _validateCollateral(
        PooledNUSDLendingPool lendingPool,
        address asset,
        address oracle,
        uint256 cap,
        bool enabled
    ) private view {
        (
            address configuredOracle,
            uint256 configuredCap,
            uint16 loanToValueBps,
            uint16 liquidationThresholdBps,
            uint16 liquidationBonusBps,
            uint8 decimals,
            bool configuredEnabled,
            uint16 marginCallThresholdBps
        ) = lendingPool.collateralConfigs(asset);
        if (
            configuredOracle != oracle || configuredCap != cap || loanToValueBps != 8000
                || marginCallThresholdBps != 8500 || liquidationThresholdBps != 9000 || liquidationBonusBps != 500
                || decimals != 18 || configuredEnabled != enabled
        ) revert UnexpectedConfiguration();
    }

    function _validatePairBinding(address pair, address asset) private view {
        ILegacyPair market = ILegacyPair(pair);
        address token0 = market.token0();
        address token1 = market.token1();
        if (
            market.factory() != DEX_FACTORY
                || !((token0 == asset && token1 == NUSD) || (token0 == NUSD && token1 == asset))
        ) revert UnexpectedConfiguration();
    }

    function _validateGaugeBinding(address gauge, address pair, address distributor) private view {
        ILegacyGauge marketGauge = ILegacyGauge(gauge);
        if (
            marketGauge.stakingToken() != pair || marketGauge.rewardToken() != NUSD
                || marketGauge.distributor() != distributor
        ) revert UnexpectedConfiguration();
    }

    function _requirePairEmpty(address pair) private view {
        (uint112 reserve0, uint112 reserve1,) = ILegacyPair(pair).getReserves();
        if (IERC20(pair).totalSupply() != 0 || reserve0 != 0 || reserve1 != 0) revert ActiveLegacyState();
    }

    function _requireGaugeEmpty(address gauge) private view {
        ILegacyGauge marketGauge = ILegacyGauge(gauge);
        if (
            marketGauge.totalSupply() != 0 || marketGauge.totalFunded() != 0 || marketGauge.totalPaid() != 0
                || marketGauge.periodFinish() != 0 || marketGauge.rewardRate() != 0 || marketGauge.lastUpdateTime() != 0
                || marketGauge.rewardPerTokenStored() != 0
        ) revert ActiveLegacyState();
    }

    function _writePrediction(Migration memory migration, PooledNUSDLendingPool lendingPool) private {
        string memory key = "migration";
        vm.serializeBool(key, "broadcasted", false);
        vm.serializeUint(key, "chainId", CHAIN_ID);
        vm.serializeUint(key, "scriptExecutionBlock", block.number);
        vm.serializeAddress(key, "deployer", DEPLOYER);
        vm.serializeAddress(key, "lendingPool", address(lendingPool));
        vm.serializeAddress(key, "gaugeFactory", LEGACY_GAUGE_FACTORY);
        vm.serializeAddress(key, "synthFeeGaugeFactory", address(migration.synthFeeGaugeFactory));
        vm.serializeAddress(key, "dexRouter", address(migration.dexRouter));
        vm.serializeAddress(key, "synthSafetyReserve", address(migration.reserve));
        vm.serializeAddress(key, "nBTC", address(migration.nbtc));
        vm.serializeAddress(key, "nETH", address(migration.neth));
        vm.serializeAddress(key, "nBTCVault", address(migration.nbtcVault));
        vm.serializeAddress(key, "nETHVault", address(migration.nethVault));
        vm.serializeAddress(key, "nBTCNusdPair", migration.nbtcNusdPair);
        vm.serializeAddress(key, "nETHNusdPair", migration.nethNusdPair);
        vm.serializeAddress(key, "nBTCNusdGauge", migration.nbtcNusdGauge);
        vm.serializeAddress(key, "nETHNusdGauge", migration.nethNusdGauge);
        vm.serializeAddress(key, "oldNBTC", OLD_NBTC);
        vm.serializeAddress(key, "oldNETH", OLD_NETH);
        vm.serializeAddress(key, "oldNBTCVault", OLD_NBTC_VAULT);
        vm.serializeAddress(key, "oldNETHVault", OLD_NETH_VAULT);
        vm.serializeAddress(key, "oldNBTCNusdPair", OLD_NBTC_PAIR);
        vm.serializeAddress(key, "oldNETHNusdPair", OLD_NETH_PAIR);
        vm.serializeAddress(key, "oldNBTCNusdGauge", OLD_NBTC_GAUGE);
        vm.serializeAddress(key, "oldNETHNusdGauge", OLD_NETH_GAUGE);
        vm.serializeUint(key, "nBTCDebtCeiling", NBTC_DEBT_CEILING);
        vm.serializeUint(key, "nETHDebtCeiling", NETH_DEBT_CEILING);
        vm.serializeUint(key, "nBTCLendingCollateralCap", NBTC_COLLATERAL_CAP);
        vm.serializeUint(key, "nETHLendingCollateralCap", NETH_COLLATERAL_CAP);
        vm.serializeUint(key, "sponsorshipEntryTvlNusd", ENTRY_TVL_NUSD);
        vm.serializeUint(key, "sponsorshipExitTvlNusd", EXIT_TVL_NUSD);
        vm.serializeUint(key, "sponsorshipActivationDelay", ACTIVATION_DELAY);
        vm.serializeBool(key, "vaultActivationRequired", true);
        string memory json = vm.serializeString(key, "status", "synth-safety-reserve-migration-prediction");
        vm.writeJson(json, "./deployments/synth-safety-reserve.json");
    }
}
