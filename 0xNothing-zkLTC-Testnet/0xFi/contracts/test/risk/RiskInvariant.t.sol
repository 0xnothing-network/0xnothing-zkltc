// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { PooledNUSDLendingPool } from "../../src/lending/PooledNUSDLendingPool.sol";
import { SynthSafetyReserve } from "../../src/synth/SynthSafetyReserve.sol";
import { SyntheticAsset } from "../../src/synth/SyntheticAsset.sol";
import { SyntheticVault } from "../../src/synth/SyntheticVault.sol";
import { TestBase } from "../TestBase.sol";
import { MockCollateralToken, MockMintFeeDistributor, MockNUSD, MockPriceOracle } from "./RiskMocks.sol";

contract SyntheticInvariantHandler {
    MockNUSD public immutable nusd;
    SyntheticAsset public immutable synthetic;
    SyntheticVault public immutable vault;

    constructor(MockNUSD nusd_, SyntheticAsset synthetic_, SyntheticVault vault_) {
        nusd = nusd_;
        synthetic = synthetic_;
        vault = vault_;
        nusd_.approve(address(vault_), type(uint256).max);
        synthetic_.approve(address(vault_), type(uint256).max);
    }

    function deposit(uint96 seed) external {
        uint256 balance = nusd.balanceOf(address(this));
        if (balance == 0) return;
        uint256 amount = 1 + (uint256(seed) % balance);
        try vault.depositCollateral(amount, address(this)) { } catch { }
    }

    function mint(uint96 seed) external {
        uint256 maximum = vault.maxMintableSynthetic(address(this));
        if (maximum == 0) return;
        uint256 amount = 1 + (uint256(seed) % maximum);
        try vault.mint(amount, type(uint256).max, address(this)) { } catch { }
    }

    function repay(uint96 seed) external {
        (,, uint256 debt) = vault.positions(address(this));
        uint256 balance = synthetic.balanceOf(address(this));
        uint256 maximum = debt < balance ? debt : balance;
        if (maximum == 0) return;
        uint256 amount = 1 + (uint256(seed) % maximum);
        try vault.repay(amount, address(this)) { } catch { }
    }

    function withdrawWhenDebtFree(uint96 seed) external {
        (uint256 userCollateral,, uint256 debt) = vault.positions(address(this));
        if (userCollateral == 0 || debt != 0) return;
        uint256 amount = 1 + (uint256(seed) % userCollateral);
        try vault.withdrawCollateral(amount, address(this)) { } catch { }
    }
}

contract LendingInvariantHandler {
    MockNUSD public immutable nusd;
    MockCollateralToken public immutable collateral;
    PooledNUSDLendingPool public immutable pool;

    constructor(MockNUSD nusd_, MockCollateralToken collateral_, PooledNUSDLendingPool pool_) {
        nusd = nusd_;
        collateral = collateral_;
        pool = pool_;
        nusd_.approve(address(pool_), type(uint256).max);
        collateral_.approve(address(pool_), type(uint256).max);
    }

    function supply(uint96 seed) external {
        uint256 balance = nusd.balanceOf(address(this));
        if (balance <= pool.MINIMUM_LOCKED_SHARES()) return;
        uint256 maximum = balance < 10_000 ether ? balance : 10_000 ether;
        uint256 amount = pool.MINIMUM_LOCKED_SHARES() + 1 + (uint256(seed) % (maximum - pool.MINIMUM_LOCKED_SHARES()));
        try pool.supply(amount, address(this)) { } catch { }
    }

    function depositCollateral(uint96 seed) external {
        uint256 balance = collateral.balanceOf(address(this));
        if (balance == 0) return;
        uint256 maximum = balance < 100 ether ? balance : 100 ether;
        uint256 amount = 1 + (uint256(seed) % maximum);
        try pool.depositCollateral(address(collateral), amount, address(this)) { } catch { }
    }

    function borrow(uint96 seed) external {
        (uint256 capacity,, uint256 debt) = pool.accountLiquidity(address(this));
        uint256 cash = nusd.balanceOf(address(pool));
        if (capacity <= debt || cash == 0) return;
        uint256 maximum = capacity - debt;
        if (maximum > cash) maximum = cash;
        uint256 amount = 1 + (uint256(seed) % maximum);
        try pool.borrow(amount, address(this)) { } catch { }
    }

    function repay(uint96 seed) external {
        uint256 debt = pool.debtBalance(address(this));
        uint256 balance = nusd.balanceOf(address(this));
        uint256 maximum = debt < balance ? debt : balance;
        if (maximum == 0) return;
        uint256 amount = 1 + (uint256(seed) % maximum);
        try pool.repay(amount, address(this)) { } catch { }
    }

    function withdrawCollateralWhenDebtFree(uint96 seed) external {
        if (pool.debtBalance(address(this)) != 0) return;
        uint256 balance = pool.collateralBalance(address(this), address(collateral));
        if (balance == 0) return;
        uint256 amount = 1 + (uint256(seed) % balance);
        try pool.withdrawCollateral(address(collateral), amount, address(this)) { } catch { }
    }
}

contract RiskInvariantTest is TestBase {
    MockNUSD private nusd;
    SyntheticAsset private synthetic;
    SyntheticVault private vault;
    SynthSafetyReserve private synthReserve;
    MockMintFeeDistributor private feeDistributor;
    MockCollateralToken private collateral;
    PooledNUSDLendingPool private pool;
    LendingInvariantHandler private lendingHandler;
    address[] private invariantTargets;

    // Foundry probes the optional StdInvariant configuration getters.
    fallback() external {
        bytes memory emptyArray = abi.encode(new address[](0));
        assembly ("memory-safe") {
            return(add(emptyArray, 32), mload(emptyArray))
        }
    }

    function setUp() public {
        vm.warp(1_000_000);
        nusd = new MockNUSD();

        MockPriceOracle btcOracle = new MockPriceOracle(100_000 ether);
        synthetic = new SyntheticAsset("Synthetic Bitcoin", "nBTC", address(this));
        SyntheticAsset secondSynthetic = new SyntheticAsset("Synthetic Ether", "nETH", address(this));
        MockPriceOracle ethOracle = new MockPriceOracle(2000 ether);
        synthReserve = new SynthSafetyReserve(address(nusd), address(this));
        feeDistributor = new MockMintFeeDistributor(address(nusd));
        vault = new SyntheticVault(
            address(nusd),
            address(synthetic),
            address(btcOracle),
            address(synthReserve),
            address(feeDistributor),
            address(this),
            1000 ether
        );
        SyntheticVault secondVault = new SyntheticVault(
            address(nusd),
            address(secondSynthetic),
            address(ethOracle),
            address(synthReserve),
            address(feeDistributor),
            address(this),
            1000 ether
        );
        synthReserve.bindVaults(address(vault), address(secondVault));
        synthetic.bindVault(address(vault));
        secondSynthetic.bindVault(address(secondVault));
        SyntheticInvariantHandler synthHandler = new SyntheticInvariantHandler(nusd, synthetic, vault);
        nusd.mint(address(synthHandler), 10_000_000 ether);

        collateral = new MockCollateralToken("Wrapped zkLTC", "WzkLTC", 18);
        MockPriceOracle ltcOracle = new MockPriceOracle(100 ether);
        pool = new PooledNUSDLendingPool(address(nusd), address(this), 20_000_000 ether, 10_000_000 ether);
        pool.configureCollateral(address(collateral), address(ltcOracle), 1_000_000 ether, 8000, 8500, 9000, 500, true);
        nusd.mint(address(this), 2_000_000 ether);
        nusd.approve(address(pool), type(uint256).max);
        pool.supply(1_000_000 ether, address(this));

        lendingHandler = new LendingInvariantHandler(nusd, collateral, pool);
        nusd.mint(address(lendingHandler), 1_000_000 ether);
        collateral.mint(address(lendingHandler), 100_000 ether);

        invariantTargets.push(address(synthHandler));
        invariantTargets.push(address(lendingHandler));
    }

    function targetContracts() external view returns (address[] memory) {
        return invariantTargets;
    }

    function invariantSyntheticDebtEqualsSyntheticSupply() public view {
        assertEq(
            vault.totalDebtSynthetic() + vault.totalBadDebtSynthetic(),
            synthetic.totalSupply(),
            "synthetic debt conservation"
        );
    }

    function invariantSyntheticCollateralIsFullyAccounted() public view {
        assertEq(nusd.balanceOf(address(vault)), vault.totalCollateralNusd(), "vault NUSD accounting");
    }

    function invariantSyntheticMintFeesAreFullyRouted() public view {
        assertEq(
            nusd.balanceOf(address(feeDistributor)), feeDistributor.totalRoutedNusd(), "mint fee distributor accounting"
        );
    }

    function invariantSyntheticReserveIsFullyAccounted() public view {
        assertEq(
            synthReserve.freeReserveNusd() + synthReserve.totalAllocatedNusd(),
            synthReserve.totalReserveNusd(),
            "reserve NUSD accounting"
        );
    }

    function invariantLendingCollateralIsFullyAccounted() public view {
        assertEq(
            collateral.balanceOf(address(pool)),
            pool.totalCollateralByAsset(address(collateral)),
            "lending collateral accounting"
        );
    }

    function invariantLendingDebtSharesAreFullyAccounted() public view {
        assertEq(pool.totalDebtShares(), pool.debtSharesOf(address(lendingHandler)), "debt share accounting");
    }

    function invariantLendingAssetIdentity() public view {
        assertEq(
            pool.totalAssetsNusd() + pool.protocolInterestNusd(),
            nusd.balanceOf(address(pool)) + pool.totalBorrowed(),
            "supplier assets plus protocol claim equal gross assets"
        );
    }
}
