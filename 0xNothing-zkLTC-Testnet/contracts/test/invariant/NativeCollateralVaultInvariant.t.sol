// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {InvariantBase} from "../InvariantBase.sol";
import {MockDIAFeed} from "../mocks/MockDIAFeed.sol";
import {NUSD} from "../../src/nusd/NUSD.sol";
import {DIAOracleAdapter} from "../../src/nusd/DIAOracleAdapter.sol";
import {NativeCollateralVault} from "../../src/nusd/NativeCollateralVault.sol";

contract VaultHandler {
    NUSD public immutable nusd;
    NativeCollateralVault public immutable vault;

    constructor(NUSD nusd_, NativeCollateralVault vault_) {
        nusd = nusd_;
        vault = vault_;
        nusd_.approve(address(vault_), type(uint256).max);
    }

    receive() external payable {}

    function depositAndMint(uint256 seed) external {
        uint256 amount = 1e12 + (seed % 1 ether);
        if (amount > address(this).balance) amount = address(this).balance;
        if (amount == 0) return;
        uint256 mintAmount = vault.quoteMintForCollateral(amount) / 2;
        if (mintAmount == 0) {
            vault.deposit{value: amount}();
        } else {
            vault.depositAndMint{value: amount}(mintAmount, address(this));
        }
    }

    function repay(uint256 seed) external {
        (, uint256 debt) = vault.positions(address(this));
        uint256 balance = nusd.balanceOf(address(this));
        uint256 maximum = debt < balance ? debt : balance;
        if (maximum == 0) return;
        uint256 amount = 1 + (seed % maximum);
        vault.repay(amount, address(this));
    }

    function withdrawWhenDebtFree(uint256 seed) external {
        (uint256 collateral, uint256 debt) = vault.positions(address(this));
        if (collateral == 0 || debt != 0) return;
        uint256 amount = 1 + (seed % collateral);
        vault.withdrawCollateral(amount, address(this));
    }
}

contract NativeCollateralVaultInvariantTest is InvariantBase {
    NUSD private nusd;
    NativeCollateralVault private vault;

    function setUp() public {
        vm.warp(1_000_000);
        MockDIAFeed feed = new MockDIAFeed(18);
        feed.setRound(1, 100 ether, block.timestamp, 1);
        DIAOracleAdapter oracle = new DIAOracleAdapter(address(feed), 2 hours);
        nusd = new NUSD(address(this));
        vault = new NativeCollateralVault(
            address(nusd), address(oracle), address(this), 17_500, 15_000, 800, 5_000, 1_000_000 ether
        );
        nusd.bindVault(address(vault));

        VaultHandler handler = new VaultHandler(nusd, vault);
        vm.deal(address(handler), 10_000 ether);
        targetContract(address(handler));
    }

    function invariantDebtEqualsNusdSupply() public view {
        assertEq(vault.totalDebtNusd() + vault.totalBadDebtNusd(), nusd.totalSupply(), "debt supply conservation");
    }

    function invariantNativeCollateralIsFullyAccounted() public view {
        assertEq(address(vault).balance, vault.totalCollateralWei(), "native accounting");
    }
}
