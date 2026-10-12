// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "../TestBase.sol";
import {TwoStepAdmin} from "../../src/common/TwoStepAdmin.sol";

contract TwoStepAdminHarness is TwoStepAdmin {
    uint256 public calls;

    constructor(address initialAdmin) TwoStepAdmin(initialAdmin) {}

    function guarded() external onlyAdmin {
        ++calls;
    }
}

contract TwoStepAdminTest is TestBase {
    address private constant NEXT = address(0x1E57);
    address private constant OUTSIDER = address(0xBAD);

    TwoStepAdminHarness private owned;

    function setUp() public {
        owned = new TwoStepAdminHarness(address(this));
    }

    function testConstructorRejectsZeroAdmin() public {
        assertEq(owned.admin(), address(this), "admin");
        vm.expectRevert(TwoStepAdmin.ZeroAddress.selector);
        new TwoStepAdminHarness(address(0));
    }

    function testTransferRequiresAcceptanceByPendingAdmin() public {
        vm.prank(OUTSIDER);
        vm.expectRevert(TwoStepAdmin.Unauthorized.selector);
        owned.transferAdmin(OUTSIDER);

        vm.expectRevert(TwoStepAdmin.ZeroAddress.selector);
        owned.transferAdmin(address(0));

        owned.transferAdmin(NEXT);
        assertEq(owned.pendingAdmin(), NEXT, "pending");
        assertEq(owned.admin(), address(this), "admin unchanged until accept");
        owned.guarded();

        vm.prank(OUTSIDER);
        vm.expectRevert(TwoStepAdmin.Unauthorized.selector);
        owned.acceptAdmin();

        vm.prank(NEXT);
        owned.acceptAdmin();
        assertEq(owned.admin(), NEXT, "accepted");
        assertEq(owned.pendingAdmin(), address(0), "pending cleared");

        vm.expectRevert(TwoStepAdmin.Unauthorized.selector);
        owned.guarded();
        vm.prank(NEXT);
        owned.guarded();
        assertEq(owned.calls(), 2, "guarded calls");
    }

    function testPendingTransferCanBeReplaced() public {
        owned.transferAdmin(OUTSIDER);
        owned.transferAdmin(NEXT);
        vm.prank(OUTSIDER);
        vm.expectRevert(TwoStepAdmin.Unauthorized.selector);
        owned.acceptAdmin();
        vm.prank(NEXT);
        owned.acceptAdmin();
        assertEq(owned.admin(), NEXT, "replacement accepted");

        vm.prank(NEXT);
        vm.expectRevert(TwoStepAdmin.Unauthorized.selector);
        owned.acceptAdmin();
    }
}
