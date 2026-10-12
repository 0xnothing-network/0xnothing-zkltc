// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "../TestBase.sol";
import {Clones} from "../../src/common/Clones.sol";
import {PumpToken} from "../../src/pump/PumpToken.sol";

contract PumpTokenTest is TestBase {
    uint256 private constant SUPPLY = 1_000_000 ether;
    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);

    PumpToken private implementation;
    PumpToken private token;

    function setUp() public {
        implementation = new PumpToken();
        token = PumpToken(Clones.clone(address(implementation)));
        token.initialize("Pump", "PMP", "ipfs://meta", "ipfs://img", SUPPLY, address(this));
    }

    function testInitializeMintsFixedSupplyToPump() public view {
        assertEq(token.totalSupply(), SUPPLY, "supply");
        assertEq(token.balanceOf(address(this)), SUPPLY, "pump balance");
        assertEq(token.pump(), address(this), "pump");
        assertEq(uint256(token.decimals()), 18, "decimals");
        assertEq(keccak256(bytes(token.name())), keccak256("Pump"), "name");
        assertEq(keccak256(bytes(token.symbol())), keccak256("PMP"), "symbol");
        assertEq(keccak256(bytes(token.metadataURI())), keccak256("ipfs://meta"), "metadata");
        assertEq(keccak256(bytes(token.imageURI())), keccak256("ipfs://img"), "image");
    }

    function testImplementationAndClonesCannotBeReinitialized() public {
        vm.expectRevert(PumpToken.AlreadyInitialized.selector);
        implementation.initialize("X", "X", "", "", 1, address(this));

        vm.expectRevert(PumpToken.AlreadyInitialized.selector);
        token.initialize("X", "X", "", "", 1, ALICE);
    }

    function testInitializeRejectsInvalidConfiguration() public {
        PumpToken clone = PumpToken(Clones.clone(address(implementation)));
        vm.expectRevert(PumpToken.InvalidTokenConfiguration.selector);
        clone.initialize("", "X", "", "", 1, address(this));
        vm.expectRevert(PumpToken.InvalidTokenConfiguration.selector);
        clone.initialize("X", "", "", "", 1, address(this));
        vm.expectRevert(PumpToken.InvalidTokenConfiguration.selector);
        clone.initialize("X", "X", "", "", 0, address(this));
        vm.expectRevert(PumpToken.InvalidTokenConfiguration.selector);
        clone.initialize("X", "X", "", "", 1, address(0));
    }

    function testTransferAndAllowanceFlows() public {
        assertTrue(token.transfer(ALICE, 100 ether), "transfer");
        assertEq(token.balanceOf(ALICE), 100 ether, "alice balance");

        vm.prank(ALICE);
        token.approve(BOB, 40 ether);
        vm.prank(BOB);
        token.transferFrom(ALICE, BOB, 25 ether);
        assertEq(token.allowance(ALICE, BOB), 15 ether, "allowance spent");
        assertEq(token.balanceOf(BOB), 25 ether, "bob balance");

        vm.prank(BOB);
        vm.expectRevert(PumpToken.ERC20InsufficientAllowance.selector);
        token.transferFrom(ALICE, BOB, 16 ether);

        vm.prank(ALICE);
        token.approve(BOB, type(uint256).max);
        vm.prank(BOB);
        token.transferFrom(ALICE, BOB, 75 ether);
        assertEq(token.allowance(ALICE, BOB), type(uint256).max, "infinite allowance kept");
        assertEq(token.totalSupply(), SUPPLY, "transfers keep supply");
    }

    function testTransferRejectsZeroRecipientAndOverdraft() public {
        vm.expectRevert(PumpToken.ERC20InvalidAddress.selector);
        token.transfer(address(0), 1);

        vm.prank(ALICE);
        vm.expectRevert(PumpToken.ERC20InsufficientBalance.selector);
        token.transfer(BOB, 1);

        vm.expectRevert(PumpToken.ERC20InvalidAddress.selector);
        token.approve(address(0), 1);
    }

    function testOnlyPumpCanBurnItsOwnBalance() public {
        token.transfer(ALICE, 10 ether);
        vm.prank(ALICE);
        vm.expectRevert(PumpToken.UnauthorizedPump.selector);
        token.burn(1);

        vm.expectRevert(PumpToken.ERC20InsufficientBalance.selector);
        token.burn(SUPPLY);

        token.burn(5 ether);
        assertEq(token.totalSupply(), SUPPLY - 5 ether, "supply burned");
        assertEq(token.balanceOf(address(this)), SUPPLY - 15 ether, "pump balance burned");
        assertEq(token.balanceOf(ALICE), 10 ether, "holder untouched");
    }

    function testFuzzTransfersConserveSupply(uint256 rawAmount, uint256 rawSecond) public {
        uint256 amount = bound(rawAmount, 0, SUPPLY);
        token.transfer(ALICE, amount);
        uint256 second = bound(rawSecond, 0, amount);
        vm.prank(ALICE);
        token.transfer(BOB, second);
        assertEq(
            token.balanceOf(address(this)) + token.balanceOf(ALICE) + token.balanceOf(BOB), SUPPLY, "conserved"
        );
        assertEq(token.totalSupply(), SUPPLY, "supply fixed");
    }
}
