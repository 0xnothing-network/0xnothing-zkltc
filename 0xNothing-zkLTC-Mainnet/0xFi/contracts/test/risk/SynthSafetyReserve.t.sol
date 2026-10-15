// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { SynthSafetyReserve } from "../../src/synth/SynthSafetyReserve.sol";
import { TestBase } from "../helpers/TestBase.sol";
import { MockNUSD } from "../mocks/RiskMocks.sol";
import { MockReserveVault } from "../mocks/SynthSafetyReserveMocks.sol";
import { MockFeeOnTransferToken } from "../mocks/TokenMocks.sol";

contract SynthSafetyReserveTest is TestBase {
    address private constant FUNDER = address(0xF00D);
    address private constant GUARDIAN = address(0xBEEF);
    address private constant LOSS_RECIPIENT = address(0x1055);

    MockNUSD private nusd;
    SynthSafetyReserve private reserve;
    MockReserveVault private firstVault;
    MockReserveVault private secondVault;

    function setUp() public {
        vm.warp(1_000_000);
        nusd = new MockNUSD();
        reserve = new SynthSafetyReserve(address(nusd), address(this));
        firstVault = new MockReserveVault(nusd, reserve);
        secondVault = new MockReserveVault(nusd, reserve);
        reserve.bindVaults(address(firstVault), address(secondVault));

        nusd.mint(FUNDER, 500_000 ether);
        vm.prank(FUNDER);
        nusd.approve(address(reserve), type(uint256).max);
    }

    function testConstantsAndExactlyTwoVaultBinding() public {
        assertEq(reserve.ENTRY_TVL_NUSD(), 100_000 ether, "entry threshold");
        assertEq(reserve.EXIT_TVL_NUSD(), 90_000 ether, "exit threshold");
        assertEq(reserve.ACTIVATION_DELAY(), 24 hours, "activation delay");
        assertTrue(reserve.vaultsBound(), "vault set bound");
        assertTrue(reserve.authorizedVault(address(firstVault)), "first vault authorized");
        assertTrue(reserve.authorizedVault(address(secondVault)), "second vault authorized");

        vm.expectRevert(SynthSafetyReserve.VaultsAlreadyBound.selector);
        reserve.bindVaults(address(firstVault), address(secondVault));
    }

    function testBindingRejectsWrongReserveAndDuplicateVaults() public {
        SynthSafetyReserve otherReserve = new SynthSafetyReserve(address(nusd), address(this));
        MockReserveVault wrongTarget = new MockReserveVault(nusd, otherReserve);

        vm.expectRevert(SynthSafetyReserve.InvalidConfiguration.selector);
        otherReserve.bindVaults(address(wrongTarget), address(wrongTarget));

        MockReserveVault anotherWrongTarget = new MockReserveVault(nusd, reserve);
        vm.expectRevert(SynthSafetyReserve.InvalidConfiguration.selector);
        otherReserve.bindVaults(address(wrongTarget), address(anotherWrongTarget));
    }

    function testEntryThresholdAndDelayBecomeActiveWithoutKeeper() public {
        _fund(99_999 ether);
        assertEq(reserve.eligibleSince(), 0, "below entry threshold");
        assertFalse(reserve.sponsorshipActive(), "not active below threshold");

        _fund(1 ether);
        uint256 eligibleAt = reserve.eligibleSince();
        assertEq(eligibleAt, block.timestamp, "eligibility begins at threshold");
        vm.warp(eligibleAt + reserve.ACTIVATION_DELAY() - 1);
        assertFalse(reserve.sponsorshipActive(), "full delay required");
        vm.warp(eligibleAt + reserve.ACTIVATION_DELAY());
        assertTrue(reserve.sponsorshipActive(), "view activates without keeper transaction");

        firstVault.allocate(1 ether);
        assertTrue(reserve.sponsorshipActive(), "allocation persists matured mode");
        assertEq(reserve.eligibleSince(), 0, "timer cleared after persistence");
    }

    function testAllocationReleaseAndManagedBalanceIdentity() public {
        _activate();
        firstVault.allocate(30_000 ether);
        secondVault.allocate(20_000 ether);

        assertEq(reserve.freeReserveNusd(), 50_000 ether, "free funds");
        assertEq(reserve.totalAllocatedNusd(), 50_000 ether, "allocated funds");
        assertEq(reserve.allocatedNusdByVault(address(firstVault)), 30_000 ether, "first allocation");
        assertEq(reserve.allocatedNusdByVault(address(secondVault)), 20_000 ether, "second allocation");
        assertEq(reserve.totalReserveNusd(), 100_000 ether, "free plus allocated identity");

        firstVault.release(10_000 ether);
        assertEq(reserve.freeReserveNusd(), 60_000 ether, "released funds free");
        assertEq(reserve.totalAllocatedNusd(), 40_000 ether, "released allocation deducted");
        assertEq(reserve.totalReserveNusd(), 100_000 ether, "release preserves managed total");
    }

    function testExitThresholdAfterRealizedLossAndFreshReentryDelay() public {
        _activate();
        firstVault.allocate(20_000 ether);
        firstVault.realizeLoss(10_000 ether, LOSS_RECIPIENT);
        assertEq(reserve.totalReserveNusd(), 90_000 ether, "exit boundary remains eligible");
        assertTrue(reserve.sponsorshipActive(), "inclusive exit boundary");

        firstVault.realizeLoss(1, LOSS_RECIPIENT);
        assertEq(reserve.totalReserveNusd(), 90_000 ether - 1, "loss reflected");
        assertFalse(reserve.sponsorshipActive(), "below exit threshold stops allocations");

        vm.expectRevert(SynthSafetyReserve.SponsorshipInactive.selector);
        secondVault.allocate(1);

        _fund(10_000 ether + 1);
        assertFalse(reserve.sponsorshipActive(), "reentry is delayed");
        uint256 eligibleAt = reserve.eligibleSince();
        vm.warp(eligibleAt + reserve.ACTIVATION_DELAY());
        assertTrue(reserve.sponsorshipActive(), "reentry after full delay");
    }

    function testUnderlyingNusdUnderbackingFailsClosedImmediately() public {
        _activate();
        assertTrue(reserve.nusdBackingHealthy(), "healthy backing");
        nusd.setReserveValueNusd(nusd.totalSupply() - 1);

        assertFalse(reserve.nusdBackingHealthy(), "underbacking detected");
        assertFalse(reserve.sponsorshipActive(), "effective mode fails closed");
        reserve.syncSponsorshipMode();
        vm.expectRevert(SynthSafetyReserve.SponsorshipInactive.selector);
        firstVault.allocate(1 ether);

        nusd.setReserveValueNusd(type(uint256).max);
        reserve.syncSponsorshipMode();
        assertFalse(reserve.sponsorshipActive(), "restored backing starts a new delay");
        assertEq(reserve.eligibleSince(), block.timestamp, "new eligibility timer");
    }

    function testGuardianPauseBlocksAllocationButNeverRelease() public {
        _activate();
        firstVault.allocate(10_000 ether);
        reserve.setGuardian(GUARDIAN);
        vm.prank(GUARDIAN);
        reserve.pauseAllocations();

        vm.expectRevert(SynthSafetyReserve.AllocationsPaused.selector);
        secondVault.allocate(1 ether);
        firstVault.release(10_000 ether);
        assertEq(reserve.totalAllocatedNusd(), 0, "release remains open");

        vm.expectRevert();
        vm.prank(GUARDIAN);
        reserve.setAllocationsPaused(false);
        reserve.setAllocationsPaused(false);
        assertFalse(reserve.allocationsPaused(), "owner can restore operation");
    }

    function testUnauthorizedCallerCannotAllocateReleaseOrRecordLoss() public {
        vm.expectRevert(SynthSafetyReserve.UnauthorizedVault.selector);
        reserve.allocateToVault(1);
        vm.expectRevert(SynthSafetyReserve.UnauthorizedVault.selector);
        reserve.releaseFromVault(1);
        vm.expectRevert(SynthSafetyReserve.UnauthorizedVault.selector);
        reserve.recordVaultLoss(1);
    }

    function testRejectsFeeOnTransferFunding() public {
        MockFeeOnTransferToken feeToken = new MockFeeOnTransferToken();
        SynthSafetyReserve feeReserve = new SynthSafetyReserve(address(feeToken), address(this));
        feeToken.mint(FUNDER, 100 ether);
        vm.prank(FUNDER);
        feeToken.approve(address(feeReserve), type(uint256).max);

        vm.expectRevert(SynthSafetyReserve.ExactTransferRequired.selector);
        vm.prank(FUNDER);
        feeReserve.fund(100 ether);
    }

    function testDirectDonationIsProtocolOwnedFreeReserve() public {
        vm.prank(FUNDER);
        assertTrue(nusd.transfer(address(reserve), 100_000 ether), "donation transfer");
        assertEq(reserve.freeReserveNusd(), 100_000 ether, "direct donation recognized");
        assertEq(reserve.totalReserveNusd(), 100_000 ether, "managed TVL includes donation");

        reserve.syncSponsorshipMode();
        assertEq(reserve.eligibleSince(), block.timestamp, "anyone can start synchronization");
    }

    function _fund(uint256 amountNusd) private {
        vm.prank(FUNDER);
        reserve.fund(amountNusd);
    }

    function _activate() private {
        _fund(100_000 ether);
        vm.warp(block.timestamp + reserve.ACTIVATION_DELAY());
        assertTrue(reserve.sponsorshipActive(), "active after delay");
    }
}
