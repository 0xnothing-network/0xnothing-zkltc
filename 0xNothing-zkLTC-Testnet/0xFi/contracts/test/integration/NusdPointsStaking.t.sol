// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { NusdPointsStaking } from "../../src/rewards/NusdPointsStaking.sol";
import { TestBase } from "../helpers/TestBase.sol";
import { MockERC20, MockFeeOnTransferToken } from "../mocks/TokenMocks.sol";

contract NusdPointsStakingTest is TestBase {
    uint256 private constant SIGNER_KEY = 0xB0B;
    uint256 private constant OTHER_SIGNER_KEY = 0xBAD;
    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B0);
    address private constant GUARDIAN = address(0xBEEF);

    MockERC20 private nusd;
    NusdPointsStaking private staking;
    address private signer;

    function setUp() public {
        vm.warp(1_000_000);
        signer = vm.addr(SIGNER_KEY);
        nusd = new MockERC20("Nothing USD", "NUSD");
        staking = new NusdPointsStaking(address(nusd), address(this), GUARDIAN, signer);

        nusd.mint(ALICE, 10_000 ether);
        nusd.mint(address(this), 10_000 ether);
        vm.prank(ALICE);
        nusd.approve(address(staking), type(uint256).max);
        nusd.approve(address(staking), type(uint256).max);
    }

    function testLockMultipliersAndXPointDisplayUnits() public {
        uint256[4] memory durations = [uint256(30 days), 90 days, 180 days, 365 days];
        uint256[4] memory expectedCredits = [uint256(1 ether), 1.2 ether, 1.5 ether, 3 ether];

        for (uint256 i; i < durations.length; ++i) {
            vm.prank(ALICE);
            staking.stake(1 ether, uint32(durations[i]));
        }

        assertEq(staking.earnedPointCredits(ALICE), 6.7 ether, "all fixed multipliers are exact");
        assertEq(staking.xPointsWad(ALICE), 0.067 ether, "100 credits display as one xPoint");
        for (uint256 i; i < durations.length; ++i) {
            NusdPointsStaking.Position memory position = staking.getPosition(i);
            assertEq(position.pointCredits, expectedCredits[i], "position credits match duration multiplier");
        }
    }

    function testFractionalNusdRetainsWadPrecision() public {
        uint256 amount = 0.123_456_789 ether;
        vm.prank(ALICE);
        staking.stake(amount, uint32(90 days));

        assertEq(
            staking.earnedPointCredits(ALICE), amount * 12_000 / 10_000, "fractional amount is not rounded to NUSD"
        );
    }

    function testMultiplePositionsAreEnumerableAndAggregateLockedPrincipal() public {
        vm.startPrank(ALICE);
        uint256 firstId = staking.stake(4 ether, uint32(30 days));
        uint256 secondId = staking.stake(6 ether, uint32(180 days));
        vm.stopPrank();

        assertEq(firstId, 0, "first position id");
        assertEq(secondId, 1, "second position id");
        assertEq(staking.userPositionCount(ALICE), 2, "position count");
        assertEq(staking.userPositionIdAt(ALICE, 0), firstId, "first enumerable id");
        assertEq(staking.userPositionIdAt(ALICE, 1), secondId, "second enumerable id");
        assertEq(staking.totalLockedByUser(ALICE), 10 ether, "user principal aggregate");
        assertEq(staking.totalLocked(), 10 ether, "global principal aggregate");

        uint256[] memory page = staking.userPositionIds(ALICE, 1, 50);
        assertEq(page.length, 1, "bounded page length");
        assertEq(page[0], secondId, "bounded page starts at offset");
    }

    function testWithdrawOnlyAtBoundaryAndNeverBurnsPoints() public {
        uint256 startingBalance = nusd.balanceOf(ALICE);
        vm.prank(ALICE);
        uint256 positionId = staking.stake(20 ether, uint32(30 days));

        vm.warp(block.timestamp + 30 days - 1);
        vm.prank(ALICE);
        vm.expectRevert(NusdPointsStaking.PositionStillLocked.selector);
        staking.withdraw(positionId);

        vm.warp(block.timestamp + 1);
        vm.prank(ALICE);
        staking.withdraw(positionId);

        assertEq(nusd.balanceOf(ALICE), startingBalance, "all principal returns at unlock");
        assertEq(staking.totalLockedByUser(ALICE), 0, "principal aggregate clears");
        assertEq(staking.availablePointCredits(ALICE), 20 ether, "earned credits remain after honoring lock");

        vm.prank(ALICE);
        vm.expectRevert(NusdPointsStaking.PositionAlreadyWithdrawn.selector);
        staking.withdraw(positionId);
    }

    function testGuardianPauseBlocksNewStakesButNeverMaturedWithdrawal() public {
        vm.prank(ALICE);
        uint256 positionId = staking.stake(10 ether, uint32(30 days));

        vm.prank(GUARDIAN);
        staking.pauseStaking();
        vm.prank(ALICE);
        vm.expectRevert(NusdPointsStaking.StakingPaused.selector);
        staking.stake(1 ether, uint32(30 days));

        vm.warp(block.timestamp + 30 days);
        vm.prank(ALICE);
        staking.withdraw(positionId);
        assertEq(staking.totalLocked(), 0, "pause cannot trap matured principal");

        vm.expectRevert();
        vm.prank(GUARDIAN);
        staking.unpauseStaking();
        staking.unpauseStaking();
    }

    function testFeeOnTransferNusdIsRejectedAtomically() public {
        MockFeeOnTransferToken feeToken = new MockFeeOnTransferToken();
        NusdPointsStaking feeStaking = new NusdPointsStaking(address(feeToken), address(this), GUARDIAN, signer);
        feeToken.mint(ALICE, 1 ether);
        vm.startPrank(ALICE);
        feeToken.approve(address(feeStaking), type(uint256).max);
        vm.expectRevert(NusdPointsStaking.FeeOnTransferUnsupported.selector);
        feeStaking.stake(1 ether, uint32(30 days));
        vm.stopPrank();

        assertEq(feeStaking.nextPositionId(), 0, "failed transfer creates no position");
        assertEq(feeStaking.earnedPointCredits(ALICE), 0, "failed transfer creates no credits");
    }

    function testDirectRedeemConsumesAvailableCreditsAndPaysFromReserve() public {
        _stakeAlice(100 ether, uint32(30 days));
        staking.configureRedemption(10 ether, true);
        staking.fundRedemptionReserve(20 ether);

        uint256 aliceBefore = nusd.balanceOf(ALICE);
        vm.prank(ALICE);
        uint256 output = staking.redeemPoints(50 ether);

        assertEq(output, 5 ether, "50 credits are 0.5 xPoint at configured rate");
        assertEq(nusd.balanceOf(ALICE) - aliceBefore, output, "caller receives NUSD directly");
        assertEq(staking.earnedPointCredits(ALICE), 100 ether, "earned credits remain historical");
        assertEq(staking.spentPointCredits(ALICE), 50 ether, "redeemed credits are marked spent");
        assertEq(staking.availablePointCredits(ALICE), 50 ether, "available credits decrease immediately");
        assertEq(staking.totalSpentPointCredits(), 50 ether, "global spent accounting increases");
        assertEq(staking.redemptionReserve(), 15 ether, "reserve decreases by the exact payout");
        assertEq(staking.redemptionNonces(ALICE), 0, "direct redemption does not consume voucher nonce");
        assertTrue(staking.isSolvent(), "redemption preserves solvency");
    }

    function testDirectRedeemFailsClosedUntilPublicPoolIsUsable() public {
        _stakeAlice(10 ether, uint32(30 days));

        vm.prank(ALICE);
        vm.expectRevert(NusdPointsStaking.RedemptionDisabled.selector);
        staking.redeemPoints(1 ether);

        staking.configureRedemption(1 ether, true);
        vm.prank(ALICE);
        vm.expectRevert(NusdPointsStaking.InsufficientRedemptionReserve.selector);
        staking.redeemPoints(1 ether);

        staking.fundRedemptionReserve(1 ether);
        vm.prank(GUARDIAN);
        staking.pauseRedemptions();
        vm.prank(ALICE);
        vm.expectRevert(NusdPointsStaking.RedemptionPaused.selector);
        staking.redeemPoints(1 ether);

        staking.unpauseRedemptions();
        vm.prank(ALICE);
        vm.expectRevert(NusdPointsStaking.InsufficientPointCredits.selector);
        staking.redeemPoints(11 ether);

        vm.prank(ALICE);
        vm.expectRevert(NusdPointsStaking.InvalidAmount.selector);
        staking.redeemPoints(0);

        staking.configureRedemption(1, true);
        vm.prank(ALICE);
        vm.expectRevert(NusdPointsStaking.RedemptionTooSmall.selector);
        staking.redeemPoints(1);

        assertEq(staking.spentPointCredits(ALICE), 0, "failed redemptions consume no credits");
        assertEq(staking.redemptionReserve(), 1 ether, "failed redemptions consume no reserve");
    }

    function testVoucherRedeemIsAccountBoundRelayerSafeAndReplayProtected() public {
        _stakeAlice(100 ether, uint32(30 days));
        staking.configureRedemption(10 ether, true);
        staking.fundRedemptionReserve(20 ether);

        NusdPointsStaking.RedeemVoucher memory voucher = _voucher(ALICE, BOB, 50 ether, block.timestamp + 1 hours);
        bytes memory signature = _sign(voucher, SIGNER_KEY);
        uint256 bobBefore = nusd.balanceOf(BOB);

        vm.prank(address(0xCAFE));
        uint256 output = staking.redeem(voucher, signature);

        assertEq(output, 5 ether, "50 credits are 0.5 xPoint at configured rate");
        assertEq(nusd.balanceOf(BOB) - bobBefore, output, "signed recipient receives redemption");
        assertEq(staking.spentPointCredits(ALICE), 50 ether, "credits are consumed once");
        assertEq(staking.redemptionNonces(ALICE), 1, "nonce increments");

        vm.expectRevert(NusdPointsStaking.InvalidVoucherNonce.selector);
        staking.redeem(voucher, signature);
    }

    function testVoucherExpirySignerRateAndCreditChecksFailClosed() public {
        _stakeAlice(10 ether, uint32(30 days));
        staking.configureRedemption(1 ether, true);
        staking.fundRedemptionReserve(10 ether);

        NusdPointsStaking.RedeemVoucher memory expired = _voucher(ALICE, ALICE, 1 ether, block.timestamp - 1);
        bytes memory expiredSignature = _sign(expired, SIGNER_KEY);
        vm.expectRevert(NusdPointsStaking.VoucherExpired.selector);
        staking.redeem(expired, expiredSignature);

        NusdPointsStaking.RedeemVoucher memory wrongSigner = _voucher(ALICE, ALICE, 1 ether, block.timestamp + 1 hours);
        bytes memory wrongSignerSignature = _sign(wrongSigner, OTHER_SIGNER_KEY);
        vm.expectRevert(NusdPointsStaking.InvalidSignature.selector);
        staking.redeem(wrongSigner, wrongSignerSignature);

        NusdPointsStaking.RedeemVoucher memory oldRate = _voucher(ALICE, ALICE, 1 ether, block.timestamp + 1 hours);
        bytes memory oldRateSignature = _sign(oldRate, SIGNER_KEY);
        staking.configureRedemption(2 ether, true);
        vm.expectRevert(NusdPointsStaking.InvalidRateVersion.selector);
        staking.redeem(oldRate, oldRateSignature);

        NusdPointsStaking.RedeemVoucher memory tooMany = _voucher(ALICE, ALICE, 11 ether, block.timestamp + 1 hours);
        bytes memory tooManySignature = _sign(tooMany, SIGNER_KEY);
        vm.expectRevert(NusdPointsStaking.InsufficientPointCredits.selector);
        staking.redeem(tooMany, tooManySignature);

        NusdPointsStaking.RedeemVoucher memory recipientBound =
            _voucher(ALICE, ALICE, 1 ether, block.timestamp + 1 hours);
        bytes memory recipientSignature = _sign(recipientBound, SIGNER_KEY);
        recipientBound.recipient = BOB;
        vm.expectRevert(NusdPointsStaking.InvalidSignature.selector);
        staking.redeem(recipientBound, recipientSignature);
    }

    function testReserveAccountingCanNeverConsumeLockedPrincipal() public {
        uint256 aliceBefore = nusd.balanceOf(ALICE);
        _stakeAlice(100 ether, uint32(30 days));
        staking.configureRedemption(100 ether, true);
        staking.fundRedemptionReserve(1 ether);

        NusdPointsStaking.RedeemVoucher memory voucher = _voucher(ALICE, ALICE, 2 ether, block.timestamp + 1 hours);
        bytes memory signature = _sign(voucher, SIGNER_KEY);
        vm.expectRevert(NusdPointsStaking.InsufficientRedemptionReserve.selector);
        staking.redeem(voucher, signature);

        vm.expectRevert(NusdPointsStaking.InsufficientRedemptionReserve.selector);
        staking.withdrawRedemptionReserve(address(this), 1 ether + 1);
        staking.withdrawRedemptionReserve(address(this), 1 ether);

        assertEq(nusd.balanceOf(address(staking)), 100 ether, "only locked principal remains");
        assertTrue(staking.isSolvent(), "principal remains solvent");
        vm.warp(block.timestamp + 30 days);
        vm.prank(ALICE);
        staking.withdraw(0);
        assertEq(nusd.balanceOf(ALICE), aliceBefore, "principal remains fully withdrawable");
    }

    function testRedemptionPauseAndSignerRotationAreSeparated() public {
        _stakeAlice(10 ether, uint32(30 days));
        staking.configureRedemption(1 ether, true);
        staking.fundRedemptionReserve(1 ether);
        NusdPointsStaking.RedeemVoucher memory voucher = _voucher(ALICE, ALICE, 1 ether, block.timestamp + 1 hours);
        bytes memory originalSignature = _sign(voucher, SIGNER_KEY);

        vm.prank(GUARDIAN);
        staking.pauseRedemptions();
        vm.expectRevert(NusdPointsStaking.RedemptionPaused.selector);
        staking.redeem(voucher, originalSignature);

        vm.expectRevert();
        vm.prank(GUARDIAN);
        staking.unpauseRedemptions();
        staking.unpauseRedemptions();

        address nextSigner = vm.addr(OTHER_SIGNER_KEY);
        staking.setRedemptionSigner(nextSigner);
        vm.expectRevert(NusdPointsStaking.InvalidSignature.selector);
        staking.redeem(voucher, originalSignature);
        bytes memory rotatedSignature = _sign(voucher, OTHER_SIGNER_KEY);
        staking.redeem(voucher, rotatedSignature);
    }

    function testFuzzPointQuoteMatchesSupportedMultiplier(uint96 rawAmount, uint8 choice) public view {
        uint256 amount = bound(uint256(rawAmount), 1, type(uint96).max);
        uint32[4] memory durations = [uint32(30 days), uint32(90 days), uint32(180 days), uint32(365 days)];
        uint256[4] memory multipliers = [uint256(10_000), 12_000, 15_000, 30_000];
        uint256 index = uint256(choice) % durations.length;
        assertEq(
            staking.quotePointCredits(amount, durations[index]),
            amount * multipliers[index] / 10_000,
            "quote is exact fixed-point multiplier"
        );
    }

    function _stakeAlice(uint256 amount, uint32 duration) private returns (uint256 positionId) {
        vm.prank(ALICE);
        return staking.stake(amount, duration);
    }

    function _voucher(address account, address recipient, uint256 credits, uint256 deadline)
        private
        view
        returns (NusdPointsStaking.RedeemVoucher memory)
    {
        return NusdPointsStaking.RedeemVoucher({
            account: account,
            recipient: recipient,
            pointCredits: credits,
            nonce: staking.redemptionNonces(account),
            deadline: deadline,
            rateVersion: staking.rateVersion()
        });
    }

    function _sign(NusdPointsStaking.RedeemVoucher memory voucher, uint256 privateKey) private returns (bytes memory) {
        bytes32 digest = staking.voucherDigest(voucher);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }
}
