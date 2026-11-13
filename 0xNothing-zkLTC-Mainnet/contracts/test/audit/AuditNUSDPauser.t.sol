// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "../TestBase.sol";
import {OracleNUSDv2} from "../../src/nusd/OracleNUSDv2.sol";
import {RoleControl} from "../../src/common/RoleControl.sol";
import {IPriceOracle} from "../../src/oracle/IPriceOracle.sol";
import {MockPriceOracle} from "../mocks/TokenomicsMocks.sol";

/// Tests for finding R2-N-02 of the second review of the 2026-11 audit (docs/AUDIT_2026-11.md).
///
/// setMintPaused(bool) asked for PAUSER_ROLE whatever the value, so the pause-only guardian key
/// could also lift a pause: for instance the one governance sets while it distrusts the price
/// (finding A-07), which reopens minting and the surplus release at that price. Pausing still
/// takes PAUSER_ROLE; lifting a pause now takes DEFAULT_ADMIN_ROLE.
contract AuditNUSDPauserTest is TestBase {
    address private constant GUARDIAN = address(0x6A2D1A);
    address private constant STRANGER = address(0xBAD);
    address private constant ALICE = address(0xA11CE);

    MockPriceOracle private oracle;
    OracleNUSDv2 private nusd;
    bytes32 private adminRole;
    bytes32 private pauserRole;

    function setUp() public {
        vm.warp(1_000_000);
        oracle = new MockPriceOracle(100 ether);
        nusd = new OracleNUSDv2(IPriceOracle(address(oracle)), address(this), 1_000_000 ether);
        adminRole = nusd.DEFAULT_ADMIN_ROLE();
        pauserRole = nusd.PAUSER_ROLE();
        nusd.grantRole(pauserRole, GUARDIAN); // as DeployMainnetCore.handover() does
        vm.deal(ALICE, 10 ether);
    }

    function _missing(bytes32 role, address account) private pure returns (bytes memory) {
        return abi.encodeWithSelector(RoleControl.MissingRole.selector, role, account);
    }

    function testAudit_R2N02_aPauseOnlyKeyCannotLiftAPause() public {
        nusd.setMintPaused(true); // governance distrusts the price
        vm.prank(GUARDIAN);
        vm.expectRevert(_missing(adminRole, GUARDIAN));
        nusd.setMintPaused(false);
        assertTrue(nusd.mintPaused(), "still paused");
        vm.prank(ALICE);
        vm.expectRevert(OracleNUSDv2.MintPaused.selector);
        nusd.mintAtOracle{value: 1 ether}(0, ALICE);

        nusd.setMintPaused(false);
        assertFalse(nusd.mintPaused(), "reopened by the admin");

        // Stopping is the guardian's job, and repeating it is harmless.
        vm.startPrank(GUARDIAN);
        nusd.setMintPaused(true);
        nusd.setMintPaused(true);
        vm.stopPrank();
        assertTrue(nusd.mintPaused(), "paused by the guardian");

        vm.startPrank(STRANGER);
        vm.expectRevert(_missing(pauserRole, STRANGER));
        nusd.setMintPaused(true);
        vm.expectRevert(_missing(adminRole, STRANGER));
        nusd.setMintPaused(false);
        vm.stopPrank();
        assertTrue(nusd.mintPaused(), "a stranger changes nothing");
    }

    /// The two roles are separate: an admin that has given up the pauser role can lift a pause but
    /// cannot set one until it grants itself the role again.
    function testAudit_R2N02_pausingStillTakesThePauserRole() public {
        nusd.renounceRole(pauserRole);
        vm.expectRevert(_missing(pauserRole, address(this)));
        nusd.setMintPaused(true);

        vm.prank(GUARDIAN);
        nusd.setMintPaused(true);
        nusd.setMintPaused(false);
        assertFalse(nusd.mintPaused(), "lifted by the admin without the pauser role");

        nusd.grantRole(pauserRole, address(this));
        nusd.setMintPaused(true);
        assertTrue(nusd.mintPaused(), "paused");
    }
}
