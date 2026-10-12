// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "../TestBase.sol";
import {RoleControl} from "../../src/common/RoleControl.sol";

contract RoleControlHarness is RoleControl {
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    uint256 public calls;

    constructor(address initialAdmin) RoleControl(initialAdmin) {}

    function operate() external onlyRole(OPERATOR_ROLE) {
        ++calls;
    }
}

contract RoleControlTest is TestBase {
    address private constant OPERATOR = address(0x0FE);
    address private constant OUTSIDER = address(0xBAD);

    RoleControlHarness private roles;
    bytes32 private operatorRole;

    function setUp() public {
        roles = new RoleControlHarness(address(this));
        operatorRole = roles.OPERATOR_ROLE();
    }

    function testConstructorGrantsAdminAndRejectsZero() public {
        assertTrue(roles.hasRole(roles.DEFAULT_ADMIN_ROLE(), address(this)), "initial admin");
        vm.expectRevert(RoleControl.ZeroRoleAccount.selector);
        new RoleControlHarness(address(0));
    }

    function testOnlyAdminGrantsAndRevokes() public {
        vm.prank(OUTSIDER);
        vm.expectRevert(abi.encodeWithSelector(RoleControl.MissingRole.selector, bytes32(0), OUTSIDER));
        roles.grantRole(operatorRole, OUTSIDER);

        vm.expectRevert(RoleControl.ZeroRoleAccount.selector);
        roles.grantRole(operatorRole, address(0));

        roles.grantRole(operatorRole, OPERATOR);
        roles.grantRole(operatorRole, OPERATOR);
        assertTrue(roles.hasRole(operatorRole, OPERATOR), "granted");
        vm.prank(OPERATOR);
        roles.operate();
        assertEq(roles.calls(), 1, "role call");

        vm.prank(OUTSIDER);
        vm.expectRevert(abi.encodeWithSelector(RoleControl.MissingRole.selector, bytes32(0), OUTSIDER));
        roles.revokeRole(operatorRole, OPERATOR);

        roles.revokeRole(operatorRole, OPERATOR);
        roles.revokeRole(operatorRole, OPERATOR);
        assertFalse(roles.hasRole(operatorRole, OPERATOR), "revoked");
        vm.prank(OPERATOR);
        vm.expectRevert(abi.encodeWithSelector(RoleControl.MissingRole.selector, operatorRole, OPERATOR));
        roles.operate();
    }

    function testRenounceOnlyAffectsCaller() public {
        roles.grantRole(operatorRole, OPERATOR);
        vm.prank(OUTSIDER);
        roles.renounceRole(operatorRole);
        assertTrue(roles.hasRole(operatorRole, OPERATOR), "other holder unaffected");

        vm.prank(OPERATOR);
        roles.renounceRole(operatorRole);
        assertFalse(roles.hasRole(operatorRole, OPERATOR), "renounced");

        roles.renounceRole(bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(RoleControl.MissingRole.selector, bytes32(0), address(this)));
        roles.grantRole(operatorRole, OPERATOR);
    }
}
