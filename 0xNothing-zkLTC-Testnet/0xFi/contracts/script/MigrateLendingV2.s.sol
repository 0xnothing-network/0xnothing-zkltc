// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {PooledNUSDLendingPool} from "../src/lending/PooledNUSDLendingPool.sol";

interface VmMigrateLendingV2 {
    function addr(uint256 privateKey) external returns (address keyAddress);
    function envUint(string calldata key) external returns (uint256 value);
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

interface ILegacyPooledNUSDLendingPool is IERC20 {
    function owner() external view returns (address);
    function nusd() external view returns (address);
    function supplyCapNusd() external view returns (uint256);
    function borrowCapNusd() external view returns (uint256);
    function baseRatePerSecondWad() external view returns (uint256);
    function slopeRatePerSecondWad() external view returns (uint256);
    function supplyPaused() external view returns (bool);
    function borrowPaused() external view returns (bool);
    function collateralWithdrawalPaused() external view returns (bool);
    function totalSupplied() external view returns (uint256);
    function totalBorrowed() external view returns (uint256);
    function totalBadDebtNusd() external view returns (uint256);
    function totalCollateralByAsset(address asset) external view returns (uint256);
    function supplyBalance(address account) external view returns (uint256);
    function setPauses(bool pauseSupply, bool pauseBorrow, bool pauseCollateralWithdrawal) external;
    function redeem(uint256 shares, address recipient) external returns (uint256 amountNusd);
}

/// @notice Retires the empty legacy lending market and moves its deployer-owned NUSD into the fixed implementation.
/// @dev Run only after a receipt-aware finalizer is ready. This script never edits the canonical deployment files.
contract MigrateLendingV2 {
    using SafeERC20 for IERC20;

    error ActiveLegacyState();
    error AssetConservationFailed();
    error InsufficientMigrationAssets(uint256 assets);
    error UnexpectedConfiguration();
    error WrongChain(uint256 expectedChainId, uint256 actualChainId);
    error WrongDeployer(address expected, address actual);

    VmMigrateLendingV2 private constant vm =
        VmMigrateLendingV2(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 private constant CHAIN_ID = 4441;
    uint256 private constant MINIMUM_LOCKED_SHARES = 1000;
    uint256 private constant SUPPLY_CAP_NUSD = 5000 ether;
    uint256 private constant BORROW_CAP_NUSD = 2500 ether;
    uint256 private constant LEGACY_BASE_RATE_PER_SECOND_WAD = 634_195_839;
    uint256 private constant LEGACY_SLOPE_RATE_PER_SECOND_WAD = 5_707_762_557;
    uint256 private constant BORROW_APR_BPS = 450;
    uint256 private constant LENDER_APR_BPS = 400;
    uint256 private constant PROTOCOL_APR_BPS = 50;
    uint16 private constant LOAN_TO_VALUE_BPS = 8000;
    uint16 private constant MARGIN_CALL_THRESHOLD_BPS = 8500;
    uint16 private constant LIQUIDATION_THRESHOLD_BPS = 9000;
    uint16 private constant LIQUIDATION_BONUS_BPS = 500;
    bytes32 private constant EXPECTED_IMPLEMENTATION_ID = keccak256("0xfi.lending.fixed-4.5-4-0.5.80-85-90.v1");
    string private constant IMPLEMENTATION_STATUS = "fixed-rate-protocol-spread-80-85-90-v1";
    uint256 private constant WZKLTC_COLLATERAL_CAP = 50 ether;
    uint256 private constant NBTC_COLLATERAL_CAP = 0.01 ether;
    uint256 private constant NETH_COLLATERAL_CAP = 0.25 ether;

    address private constant DEPLOYER = 0x58633401dCc383F010688e950878000000000000;
    address private constant NUSD = 0x5317e21aba902c6c7087a84457bc02fFe99604d1;
    address private constant OLD_LENDING_POOL = 0x099Fe8b7611A294eD33e6D96a0b958E189143622;
    address private constant WZKLTC = 0xE93d4373CE1eDA3df6c3Ab7ed3ab07A07aA5939F;
    address private constant NBTC = 0xc44B6027eBc4859d2E7e2bCF17188C29b1BC1655;
    address private constant NETH = 0x60590B1f4F17969B8c52c2c0B533404Bbb62206b;
    address private constant LTC_ORACLE = 0x54361dB5F9DF455B448E882Ce65612D5e418f3Ee;
    address private constant BTC_ORACLE = 0x781178849cE1D131EFbedff1EF52323A6E117813;
    address private constant ETH_ORACLE = 0x8E9BD05a80542B171719ac0d749a7A609D69E324;
    address private constant LOCKED_SHARE_RECIPIENT = address(1);

    struct LegacySnapshot {
        uint256 totalSupplied;
        uint256 cash;
        uint256 totalShares;
        uint256 deployerShares;
        uint256 lockedShares;
        uint256 expectedMigratedNusd;
    }

    function run() external returns (PooledNUSDLendingPool newLendingPool) {
        if (block.chainid != CHAIN_ID) revert WrongChain(CHAIN_ID, block.chainid);

        uint256 privateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(privateKey);
        if (deployer != DEPLOYER) revert WrongDeployer(DEPLOYER, deployer);

        ILegacyPooledNUSDLendingPool oldPool = ILegacyPooledNUSDLendingPool(OLD_LENDING_POOL);
        LegacySnapshot memory snapshot = _snapshotAndRequireSafe(oldPool, deployer);
        if (snapshot.expectedMigratedNusd <= MINIMUM_LOCKED_SHARES) {
            revert InsufficientMigrationAssets(snapshot.expectedMigratedNusd);
        }

        IERC20 nusd = IERC20(NUSD);
        vm.startBroadcast(privateKey);

        // Retire risk-increasing operations first. Supplier redemption remains available while paused.
        oldPool.setPauses(true, true, true);
        if (!oldPool.supplyPaused() || !oldPool.borrowPaused() || !oldPool.collateralWithdrawalPaused()) {
            revert UnexpectedConfiguration();
        }

        // Make the replacement fully configured before moving any supplier assets out of the old market.
        newLendingPool = new PooledNUSDLendingPool(NUSD, deployer, SUPPLY_CAP_NUSD, BORROW_CAP_NUSD);
        newLendingPool.configureCollateral(
            WZKLTC,
            LTC_ORACLE,
            WZKLTC_COLLATERAL_CAP,
            LOAN_TO_VALUE_BPS,
            MARGIN_CALL_THRESHOLD_BPS,
            LIQUIDATION_THRESHOLD_BPS,
            LIQUIDATION_BONUS_BPS,
            true
        );
        newLendingPool.configureCollateral(
            NBTC,
            BTC_ORACLE,
            NBTC_COLLATERAL_CAP,
            LOAN_TO_VALUE_BPS,
            MARGIN_CALL_THRESHOLD_BPS,
            LIQUIDATION_THRESHOLD_BPS,
            LIQUIDATION_BONUS_BPS,
            true
        );
        newLendingPool.configureCollateral(
            NETH,
            ETH_ORACLE,
            NETH_COLLATERAL_CAP,
            LOAN_TO_VALUE_BPS,
            MARGIN_CALL_THRESHOLD_BPS,
            LIQUIDATION_THRESHOLD_BPS,
            LIQUIDATION_BONUS_BPS,
            true
        );
        _validateUnfundedReplacement(newLendingPool, deployer);

        // Abort if the legacy state changed while the replacement was being prepared.
        _requireSnapshotUnchanged(oldPool, deployer, snapshot);

        uint256 deployerBalanceBefore = nusd.balanceOf(deployer);
        uint256 migratedNusd = oldPool.redeem(snapshot.deployerShares, deployer);
        uint256 deployerBalanceAfterRedeem = nusd.balanceOf(deployer);
        if (
            migratedNusd != snapshot.expectedMigratedNusd
                || deployerBalanceAfterRedeem != deployerBalanceBefore + migratedNusd
        ) revert AssetConservationFailed();

        nusd.forceApprove(address(newLendingPool), migratedNusd);
        uint256 newShares = newLendingPool.supply(migratedNusd, deployer);
        nusd.forceApprove(address(newLendingPool), 0);

        _validateRetiredLegacy(oldPool, snapshot, migratedNusd);
        _validateFundedReplacement(newLendingPool, deployer, migratedNusd, newShares);
        if (nusd.balanceOf(deployer) != deployerBalanceBefore) revert AssetConservationFailed();

        vm.stopBroadcast();
        _writePrediction(newLendingPool, snapshot, migratedNusd, deployer);
    }

    function _snapshotAndRequireSafe(ILegacyPooledNUSDLendingPool oldPool, address deployer)
        private
        view
        returns (LegacySnapshot memory snapshot)
    {
        if (
            OLD_LENDING_POOL.code.length == 0 || oldPool.owner() != deployer || oldPool.nusd() != NUSD
                || oldPool.supplyCapNusd() != SUPPLY_CAP_NUSD || oldPool.borrowCapNusd() != BORROW_CAP_NUSD
                || oldPool.baseRatePerSecondWad() != LEGACY_BASE_RATE_PER_SECOND_WAD
                || oldPool.slopeRatePerSecondWad() != LEGACY_SLOPE_RATE_PER_SECOND_WAD
        ) revert UnexpectedConfiguration();

        if (
            oldPool.totalBorrowed() != 0 || oldPool.totalBadDebtNusd() != 0
                || oldPool.totalCollateralByAsset(WZKLTC) != 0 || oldPool.totalCollateralByAsset(NBTC) != 0
                || oldPool.totalCollateralByAsset(NETH) != 0
        ) revert ActiveLegacyState();

        snapshot.totalSupplied = oldPool.totalSupplied();
        snapshot.cash = IERC20(NUSD).balanceOf(OLD_LENDING_POOL);
        snapshot.totalShares = oldPool.totalSupply();
        snapshot.deployerShares = oldPool.balanceOf(deployer);
        snapshot.lockedShares = oldPool.balanceOf(LOCKED_SHARE_RECIPIENT);
        snapshot.expectedMigratedNusd = oldPool.supplyBalance(deployer);

        if (
            snapshot.totalSupplied == 0 || snapshot.totalSupplied != snapshot.cash || snapshot.totalShares == 0
                || snapshot.deployerShares == 0 || snapshot.lockedShares != MINIMUM_LOCKED_SHARES
                || snapshot.totalShares != snapshot.deployerShares + snapshot.lockedShares
                || snapshot.expectedMigratedNusd > snapshot.totalSupplied
                || snapshot.expectedMigratedNusd > SUPPLY_CAP_NUSD
        ) revert ActiveLegacyState();
    }

    function _requireSnapshotUnchanged(
        ILegacyPooledNUSDLendingPool oldPool,
        address deployer,
        LegacySnapshot memory snapshot
    ) private view {
        LegacySnapshot memory current = _snapshotAndRequireSafe(oldPool, deployer);
        if (
            current.totalSupplied != snapshot.totalSupplied || current.cash != snapshot.cash
                || current.totalShares != snapshot.totalShares || current.deployerShares != snapshot.deployerShares
                || current.lockedShares != snapshot.lockedShares
                || current.expectedMigratedNusd != snapshot.expectedMigratedNusd || !oldPool.supplyPaused()
                || !oldPool.borrowPaused() || !oldPool.collateralWithdrawalPaused()
        ) revert ActiveLegacyState();
    }

    function _validateUnfundedReplacement(PooledNUSDLendingPool pool, address deployer) private view {
        _validateFixedEconomics(pool);
        if (
            address(pool.nusd()) != NUSD || pool.owner() != deployer || pool.pendingOwner() != address(0)
                || pool.guardian() != deployer || pool.supplyCapNusd() != SUPPLY_CAP_NUSD
                || pool.borrowCapNusd() != BORROW_CAP_NUSD || pool.supplyPaused() || pool.borrowPaused()
                || pool.collateralWithdrawalPaused() || pool.totalSupply() != 0 || pool.totalBorrowed() != 0
                || pool.totalBadDebtNusd() != 0 || IERC20(NUSD).balanceOf(address(pool)) != 0
                || pool.collateralAssetCount() != 3
        ) revert UnexpectedConfiguration();

        if (
            pool.collateralAssetAt(0) != WZKLTC || pool.collateralAssetAt(1) != NBTC
                || pool.collateralAssetAt(2) != NETH
        ) revert UnexpectedConfiguration();

        _validateCollateral(pool, WZKLTC, LTC_ORACLE, WZKLTC_COLLATERAL_CAP);
        _validateCollateral(pool, NBTC, BTC_ORACLE, NBTC_COLLATERAL_CAP);
        _validateCollateral(pool, NETH, ETH_ORACLE, NETH_COLLATERAL_CAP);
    }

    function _validateFundedReplacement(
        PooledNUSDLendingPool pool,
        address deployer,
        uint256 migratedNusd,
        uint256 newShares
    ) private view {
        _validateFixedEconomics(pool);
        _validateCollateral(pool, WZKLTC, LTC_ORACLE, WZKLTC_COLLATERAL_CAP);
        _validateCollateral(pool, NBTC, BTC_ORACLE, NBTC_COLLATERAL_CAP);
        _validateCollateral(pool, NETH, ETH_ORACLE, NETH_COLLATERAL_CAP);

        if (
            pool.owner() != deployer || pool.guardian() != deployer || pool.totalSupply() != migratedNusd
                || pool.balanceOf(LOCKED_SHARE_RECIPIENT) != MINIMUM_LOCKED_SHARES
                || newShares != migratedNusd - MINIMUM_LOCKED_SHARES || pool.balanceOf(deployer) != newShares
                || pool.totalAssetsNusd() != migratedNusd || pool.totalBorrowed() != 0 || pool.totalBadDebtNusd() != 0
                || IERC20(NUSD).balanceOf(address(pool)) != migratedNusd || pool.totalCollateralByAsset(WZKLTC) != 0
                || pool.totalCollateralByAsset(NBTC) != 0 || pool.totalCollateralByAsset(NETH) != 0
                || IERC20(NUSD).allowance(deployer, address(pool)) != 0 || pool.supplyPaused() || pool.borrowPaused()
                || pool.collateralWithdrawalPaused()
        ) revert AssetConservationFailed();
    }

    function _validateRetiredLegacy(
        ILegacyPooledNUSDLendingPool oldPool,
        LegacySnapshot memory snapshot,
        uint256 migratedNusd
    ) private view {
        uint256 residualNusd = snapshot.totalSupplied - migratedNusd;
        if (
            oldPool.balanceOf(DEPLOYER) != 0 || oldPool.totalSupply() != snapshot.lockedShares
                || oldPool.balanceOf(LOCKED_SHARE_RECIPIENT) != snapshot.lockedShares
                || oldPool.totalSupplied() != residualNusd || IERC20(NUSD).balanceOf(OLD_LENDING_POOL) != residualNusd
                || oldPool.totalBorrowed() != 0 || oldPool.totalBadDebtNusd() != 0
                || oldPool.totalCollateralByAsset(WZKLTC) != 0 || oldPool.totalCollateralByAsset(NBTC) != 0
                || oldPool.totalCollateralByAsset(NETH) != 0 || !oldPool.supplyPaused() || !oldPool.borrowPaused()
                || !oldPool.collateralWithdrawalPaused()
        ) revert AssetConservationFailed();
    }

    function _validateCollateral(PooledNUSDLendingPool pool, address asset, address oracle, uint256 cap) private view {
        (
            address configuredOracle,
            uint256 configuredCap,
            uint16 loanToValueBps,
            uint16 liquidationThresholdBps,
            uint16 liquidationBonusBps,
            uint8 decimals,
            bool enabled,
            uint16 marginCallThresholdBps
        ) = pool.collateralConfigs(asset);
        if (
            configuredOracle != oracle || configuredCap != cap || loanToValueBps != LOAN_TO_VALUE_BPS
                || marginCallThresholdBps != MARGIN_CALL_THRESHOLD_BPS
                || liquidationThresholdBps != LIQUIDATION_THRESHOLD_BPS || liquidationBonusBps != LIQUIDATION_BONUS_BPS
                || decimals != 18 || !enabled
        ) revert UnexpectedConfiguration();
    }

    function _validateFixedEconomics(PooledNUSDLendingPool pool) private view {
        if (
            pool.IMPLEMENTATION_ID() != EXPECTED_IMPLEMENTATION_ID || pool.BORROW_APR_BPS() != BORROW_APR_BPS
                || pool.LENDER_APR_BPS() != LENDER_APR_BPS || pool.PROTOCOL_APR_BPS() != PROTOCOL_APR_BPS
                || pool.borrowRate() != 0.045 ether || pool.lenderRate() != 0.04 ether
                || pool.protocolRate() != 0.005 ether || pool.accruedProtocolInterestNusd() != 0
        ) revert UnexpectedConfiguration();
    }

    function _writePrediction(
        PooledNUSDLendingPool newLendingPool,
        LegacySnapshot memory snapshot,
        uint256 migratedNusd,
        address deployer
    ) private {
        string memory key = "migration";
        vm.serializeBool(key, "broadcasted", false);
        vm.serializeUint(key, "chainId", CHAIN_ID);
        vm.serializeUint(key, "scriptExecutionBlock", block.number);
        vm.serializeAddress(key, "deployer", deployer);
        vm.serializeAddress(key, "oldLendingPool", OLD_LENDING_POOL);
        vm.serializeAddress(key, "newLendingPool", address(newLendingPool));
        vm.serializeAddress(key, "lendingPool", address(newLendingPool));
        vm.serializeUint(key, "migratedNusd", migratedNusd);
        vm.serializeUint(key, "oldTotalSuppliedBefore", snapshot.totalSupplied);
        vm.serializeUint(key, "oldCashBefore", snapshot.cash);
        vm.serializeUint(key, "oldTotalSharesBefore", snapshot.totalShares);
        vm.serializeUint(key, "oldDeployerSharesBefore", snapshot.deployerShares);
        vm.serializeUint(key, "oldLockedShares", snapshot.lockedShares);
        vm.serializeUint(key, "oldResidualNusd", snapshot.totalSupplied - migratedNusd);
        vm.serializeUint(key, "newSupplyCapNusd", SUPPLY_CAP_NUSD);
        vm.serializeUint(key, "newBorrowCapNusd", BORROW_CAP_NUSD);
        vm.serializeBytes32(key, "implementationId", EXPECTED_IMPLEMENTATION_ID);
        vm.serializeUint(key, "borrowAprBps", BORROW_APR_BPS);
        vm.serializeUint(key, "lenderAprBps", LENDER_APR_BPS);
        vm.serializeUint(key, "protocolAprBps", PROTOCOL_APR_BPS);
        vm.serializeUint(key, "loanToValueBps", LOAN_TO_VALUE_BPS);
        vm.serializeUint(key, "marginCallThresholdBps", MARGIN_CALL_THRESHOLD_BPS);
        vm.serializeUint(key, "liquidationThresholdBps", LIQUIDATION_THRESHOLD_BPS);
        vm.serializeUint(key, "liquidationBonusBps", LIQUIDATION_BONUS_BPS);
        vm.serializeUint(key, "wzkLtcCollateralCap", WZKLTC_COLLATERAL_CAP);
        vm.serializeUint(key, "nBTCCollateralCap", NBTC_COLLATERAL_CAP);
        vm.serializeUint(key, "nETHCollateralCap", NETH_COLLATERAL_CAP);
        vm.serializeString(key, "implementationStatus", IMPLEMENTATION_STATUS);
        string memory json = vm.serializeString(key, "status", "lending-v2-migration-prediction");
        vm.writeJson(json, "./deployments/lending-v2.json");
    }
}
