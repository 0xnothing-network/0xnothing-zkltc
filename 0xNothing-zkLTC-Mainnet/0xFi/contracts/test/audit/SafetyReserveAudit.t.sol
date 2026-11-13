// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { SynthSafetyReserve } from "../../src/synth/SynthSafetyReserve.sol";
import { TestBase } from "../helpers/TestBase.sol";
import { MockReserveVault } from "../mocks/SynthSafetyReserveMocks.sol";
import { AuditOracleGatedNUSD } from "./mocks/AuditMocks.sol";

/// Audit reproduction D-06. Same wiring as test/risk/SynthSafetyReserve.t.sol, with a NUSD whose
/// reserveValueNusd() can revert like the real one does on a stale LTC price.
contract SafetyReserveAuditTest is TestBase {
    address private constant FUNDER = address(0xF00D);
    address private constant STRANGER = address(0x57A6E);

    AuditOracleGatedNUSD private nusd;
    SynthSafetyReserve private reserve;
    MockReserveVault private firstVault;
    MockReserveVault private secondVault;

    function setUp() public {
        vm.warp(1_000_000);
        nusd = new AuditOracleGatedNUSD();
        reserve = new SynthSafetyReserve(address(nusd), address(this));
        firstVault = new MockReserveVault(IERC20(address(nusd)), reserve);
        secondVault = new MockReserveVault(IERC20(address(nusd)), reserve);
        reserve.bindVaults(address(firstVault), address(secondVault));

        nusd.mint(FUNDER, 500_000 ether);
        vm.prank(FUNDER);
        nusd.approve(address(reserve), type(uint256).max);
    }

    // D-06. While NUSD.reserveValueNusd() reverts (stale LTC price) nusdBackingHealthy() is false.
    // Any address that calls syncSponsorshipMode() in that window clears the stored activation
    // flag, and getting it back needs a sync, a full 24 hours and nothing resetting it meanwhile.
    // Checks: with 100,000 NUSD funded and sponsorship active, a failed read alone costs nothing
    // (active again as soon as the read works); the same failed read plus one sync by a stranger
    // leaves sponsorship off after the read is restored, allocateToVault reverts
    // SponsorshipInactive, and it is still off 24h - 1s after the next sync.
    function testAudit_D06_strangerSyncDuringStaleReadDisablesSponsorshipFor24h() public {
        vm.prank(FUNDER);
        reserve.fund(100_000 ether);
        vm.warp(block.timestamp + reserve.ACTIVATION_DELAY());
        assertTrue(reserve.syncSponsorshipMode(), "sponsorship active and persisted");
        firstVault.allocate(1000 ether);

        // A stale read that nobody syncs on is harmless: the view fails closed and recovers.
        nusd.setReserveReadReverts(true);
        assertFalse(reserve.nusdBackingHealthy(), "failed read counts as unhealthy");
        assertFalse(reserve.sponsorshipActive(), "fails closed while the read fails");
        nusd.setReserveReadReverts(false);
        assertTrue(reserve.sponsorshipActive(), "active again without any penalty");

        // Same stale block, but a stranger calls the permissionless sync.
        nusd.setReserveReadReverts(true);
        vm.prank(STRANGER);
        assertFalse(reserve.syncSponsorshipMode(), "stranger sync during the stale block");
        nusd.setReserveReadReverts(false);

        // The feed is healthy again and the reserve is still fully funded, yet sponsorship is off.
        assertTrue(reserve.nusdBackingHealthy(), "backing healthy again");
        assertEq(reserve.totalReserveNusd(), 100_000 ether, "reserve still at the entry level");
        assertFalse(reserve.sponsorshipActive(), "sponsorship stays off after the feed recovers");
        assertEq(reserve.eligibleSince(), 0, "entry timer was reset");
        vm.expectRevert(SynthSafetyReserve.SponsorshipInactive.selector);
        firstVault.allocate(1 ether);

        // Re-entry: one sync to start the timer, then the full activation delay.
        uint256 restartedAt = block.timestamp;
        assertFalse(reserve.syncSponsorshipMode(), "first healthy sync only starts the timer");
        assertEq(reserve.eligibleSince(), restartedAt, "timer restarted");
        vm.warp(restartedAt + reserve.ACTIVATION_DELAY() - 1);
        assertFalse(reserve.sponsorshipActive(), "still off 23h59m59s later");
        vm.expectRevert(SynthSafetyReserve.SponsorshipInactive.selector);
        firstVault.allocate(1 ether);

        // And a second stale block with one more sync resets the timer again.
        nusd.setReserveReadReverts(true);
        vm.prank(STRANGER);
        reserve.syncSponsorshipMode();
        nusd.setReserveReadReverts(false);
        assertEq(reserve.eligibleSince(), 0, "timer wiped by the second incident");
        vm.warp(restartedAt + reserve.ACTIVATION_DELAY());
        assertFalse(reserve.sponsorshipActive(), "24h after the first incident it is still off");

        // Clean recovery needs sync + 24h with no stale sync in between.
        reserve.syncSponsorshipMode();
        vm.warp(block.timestamp + reserve.ACTIVATION_DELAY());
        assertTrue(reserve.sponsorshipActive(), "back only after a clean 24h");
    }
}
