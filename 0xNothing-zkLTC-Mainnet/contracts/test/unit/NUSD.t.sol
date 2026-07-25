// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "../TestBase.sol";
import {NUSD} from "../../src/nusd/NUSD.sol";

contract NUSDTest is TestBase {
    NUSD private token;
    address private constant USER = address(0xA11CE);

    function setUp() public {
        token = new NUSD(address(this));
    }

    function testVaultBindingRequiresBinderContractAndCanOnlyHappenOnce() public {
        vm.expectRevert(NUSD.InvalidVault.selector);
        token.bindVault(USER);

        vm.expectRevert(NUSD.UnauthorizedBinder.selector);
        vm.prank(USER);
        token.bindVault(address(this));

        token.bindVault(address(this));
        assertEq(token.vault(), address(this), "bound vault");

        vm.expectRevert(NUSD.VaultAlreadyBound.selector);
        token.bindVault(address(this));
    }

    function testMintIsBoundVaultRestricted() public {
        vm.expectRevert(NUSD.UnauthorizedVault.selector);
        token.mint(USER, 1 ether);

        token.bindVault(address(this));
        token.mint(USER, 10 ether);
        assertEq(token.balanceOf(USER), 10 ether, "minted balance");

        vm.expectRevert(NUSD.UnauthorizedVault.selector);
        vm.prank(USER);
        token.mint(USER, 1 ether);
    }

    function testBoundVaultBurnStillRequiresUserAllowance() public {
        token.bindVault(address(this));
        token.mint(USER, 5 ether);

        vm.expectRevert(NUSD.ERC20InsufficientAllowance.selector);
        token.burnFrom(USER, 1 ether);

        vm.prank(USER);
        token.approve(address(this), 2 ether);
        token.burnFrom(USER, 2 ether);
        assertEq(token.balanceOf(USER), 3 ether, "allowance burn");
    }
}
