// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "../TestBase.sol";
import {OracleNv2} from "../../src/n/OracleNv2.sol";
import {IPriceOracle} from "../../src/oracle/IPriceOracle.sol";
import {MockPriceOracle} from "../mocks/TokenomicsMocks.sol";
import {ReenteringRecipient} from "../mocks/NReentrancyMocks.sol";

/// Properties of the mechanisms the 2026-11 audit added to N: the supply a surplus release is
/// measured against, the refilling mint budget, the redeem fee against an old price, and the order
/// of state changes around the redemption payout. Written during the adversarial review of the
/// fixes; each test failed on a deliberately broken copy of the contract.
contract OracleNv2GuardsTest is TestBase {
    uint256 private constant PRICE = 100 ether; // $100 per zkLTC
    uint256 private constant WEEK = 7 days;

    address private constant HOLDER = address(0xA11CE);
    address private constant ATTACKER = address(0xBAD);
    address private constant STAKING = address(0x57A6);
    address private constant TREASURY = address(0x7EA5);

    MockPriceOracle private oracle;
    OracleNv2 private n;

    function setUp() public {
        vm.warp(1_000_000);
        vm.deal(HOLDER, 1_000_000 ether);
        vm.deal(ATTACKER, 1_000_000 ether);
        vm.deal(address(this), 1_000_000 ether);
        oracle = new MockPriceOracle(PRICE);
        n = new OracleNv2(IPriceOracle(address(oracle)), address(this), 10_000_000 ether);
        n.setSurplusRecipients(STAKING, TREASURY, 2_000);
    }

    function _mint(address account, uint256 collateralWei) private returns (uint256 amount) {
        vm.prank(account);
        amount = n.mintAtOracle{value: collateralWei}(0, account);
    }

    function _redeem(address account, uint256 amountN) private returns (uint256 out) {
        vm.prank(account);
        out = n.redeemAtOracle(amountN, 0, account);
    }

    function _ready() private view returns (bool ready) {
        (, ready) = n.surplusMintCapacity();
    }

    /// Later redemptions (dust or not) cannot erase a remembered peak early.
    function testDustRedemptionsCannotEraseARememberedPeak() public {
        _mint(HOLDER, 9_000 ether);
        uint256 whaleN = _mint(ATTACKER, 1_000 ether); // 1,000,000 N in total
        n.coverReserve{value: 22_000 ether}(); // 3.2x
        uint256 epochStart = (vm.getBlockTimestamp() / WEEK + 1) * WEEK;
        vm.warp(epochStart + 3 days);
        _redeem(ATTACKER, whaleN - 1 ether); // 100,000 of 1,000,000 minus 1 N kept for dust
        uint256 basis = n.surplusSupplyBasis();
        assertEq(basis, 1_000_000 ether, "remembered");

        // Dust in the same epoch, at the boundary and all through the next epoch.
        _redeem(ATTACKER, 0.001 ether);
        assertEq(n.surplusSupplyBasis(), basis, "same epoch");
        vm.warp(epochStart + WEEK - 1);
        _redeem(ATTACKER, 0.001 ether);
        assertEq(n.surplusSupplyBasis(), basis, "last second of the epoch");
        vm.warp(epochStart + WEEK);
        assertEq(n.surplusSupplyBasis(), basis, "first second of the next, before any redemption");
        _redeem(ATTACKER, 0.001 ether);
        assertEq(n.surplusSupplyBasis(), basis, "and after one");
        vm.warp(epochStart + 2 * WEEK - 1);
        _redeem(ATTACKER, 0.001 ether);
        assertEq(n.surplusSupplyBasis(), basis, "last second of the next epoch");
        assertFalse(_ready(), "no release in the whole window");
        vm.warp(epochStart + 2 * WEEK);
        assertApproxEq(n.surplusSupplyBasis(), n.totalSupply(), 0.01 ether, "gone only when the second epoch ends");
    }

    /// The peak is raised inside an epoch. A first, small redemption at a low supply
    /// does not stop a later redemption from a higher supply being remembered.
    function testSupplyPeakIsRaisedInsideAnEpoch() public {
        _mint(HOLDER, 9_000 ether); // 900,000 N
        n.coverReserve{value: 22_000 ether}(); // 31,000 zkLTC
        _redeem(HOLDER, 1 ether); // the first redemption of the epoch, from 900,000
        assertEq(n.surplusSupplyBasis(), 900_000 ether, "first redemption remembered");

        uint256 whaleN = _mint(ATTACKER, 1_000 ether); // supply grows to 999,999 N: 3.2x
        assertFalse(_ready(), "32,000 zkLTC behind 999,999 N is under the trigger");
        _redeem(ATTACKER, whaleN); // and she leaves again in the same epoch
        assertEq(n.surplusSupplyBasis(), 999_999 ether, "the higher supply is remembered, not the first one");
        assertGe(n.backingRatioWad(), 3.4 ether, "the raw ratio is far above the trigger");
        assertFalse(_ready(), "but no release is due");
    }

    /// A release that does fire while a redemption is remembered is triggered against the
    /// remembered supply and sized on the supply that exists, so it stops well above the floor.
    function testReleaseDuringTheWindowIsTriggeredOnTheRememberedSupplyAndSizedOnTheRealOne() public {
        _mint(HOLDER, 1 ether); // 100 N
        n.coverReserve{value: 2.2 ether}(); // $320: 3.2x
        _redeem(HOLDER, 10 ether); // $310 behind 90 N, remembered as 100
        oracle.setPrice(106 ether); // zkLTC +6%: $328.60 is 3.65x of the 90 left, 3.286x of the remembered 100
        assertFalse(_ready(), "below the trigger on the remembered supply");
        oracle.setPrice(110 ether); // +10%: $341, 3.41x of the remembered 100
        (uint256 capacity, bool ready) = n.surplusMintCapacity();
        assertTrue(ready, "a real price rise still triggers");
        assertEq(capacity, 9 ether, "one step of the 90 that exist, not of the remembered 100");
        assertEq(n.releaseSurplus(), 9 ether, "and that is what the release mints");
        assertApproxEq(n.backingRatioWad(), 3.4444 ether, 0.0001 ether, "$341 behind 99 N: well above 3.0x");
    }

    /// "A plain burn counts at once" holds only while no redemption started from a higher
    /// supply in this epoch or the last. After any redemption, however small, burned fees lift the
    /// ratio a release sees only when that memory lapses (7 to 14 days later).
    function testBurnCountsOnlyAfterTheWindowOnceAnyoneRedeemed() public {
        _mint(HOLDER, 10_000 ether); // 1,000,000 N
        n.coverReserve{value: 22_900 ether}(); // 32,900 zkLTC: 3.29x
        _redeem(HOLDER, 1 ether); // an ordinary small redemption
        vm.prank(HOLDER);
        n.burn(5_000 ether); // the fee splitter burning 5,000 N of fees
        assertGe(n.backingRatioWad(), 3.3 ether, "the burn lifted the real ratio over the trigger");
        assertEq(n.surplusSupplyBasis(), 1_000_000 ether, "but the release still counts the old supply");
        assertFalse(_ready(), "no release");

        vm.warp((vm.getBlockTimestamp() / WEEK + 2) * WEEK - 1);
        assertFalse(_ready(), "nor for the rest of this epoch and all of the next");
        vm.warp(vm.getBlockTimestamp() + 1);
        assertTrue(_ready(), "it counts when the second epoch ends");
    }

    /// Across random mints, redemptions, burns, donations, price moves and waits, the
    /// basis is never below the supply, a release never fires below the trigger on the real
    /// supply, and it never leaves the real backing below the 3.0x floor.
    function testFuzzSurplusBasisIsConservative(uint256 seed) public {
        _mint(HOLDER, 5_000 ether);
        _mint(ATTACKER, 5_000 ether);
        n.coverReserve{value: 21_000 ether}(); // 3.1x
        for (uint256 step; step < 24; ++step) {
            seed = uint256(keccak256(abi.encode(seed, step)));
            uint256 action = seed % 7;
            uint256 size = (seed >> 8) % 2_000 ether + 1 ether;
            if (action == 0) {
                _mint(ATTACKER, size / 100);
            } else if (action == 1) {
                uint256 balance = n.balanceOf(ATTACKER);
                if (balance != 0) _redeem(ATTACKER, size % balance + 1);
            } else if (action == 2) {
                uint256 balance = n.balanceOf(ATTACKER);
                if (balance > 1 ether) {
                    vm.prank(ATTACKER);
                    n.burn(size % (balance / 50) + 1);
                }
            } else if (action == 3) {
                n.coverReserve{value: size / 100}();
            } else if (action == 4) {
                oracle.setPrice(bound(seed >> 16, 80 ether, 140 ether));
            } else {
                vm.warp(vm.getBlockTimestamp() + (seed >> 24) % (9 days));
            }
            assertGe(n.surplusSupplyBasis(), n.totalSupply(), "basis below supply");

            (uint256 capacity, bool ready) = n.surplusMintCapacity();
            if (ready) {
                uint256 reserveValue = n.reserveValueN();
                assertGe(reserveValue * 10_000, n.totalSupply() * 33_000, "ready below the trigger");
                assertEq(n.releaseSurplus(), capacity, "capacity");
                assertGe(n.backingRatioWad(), 3 ether, "release left the backing below the floor");
            }
        }
    }

    /// Random mints at random gaps (same block, seconds, minutes, over an hour). At every step no
    /// more than the limit is available, one wei of zkLTC beyond it is refused, and for every pair
    /// of mints the total minted between them obeys the token-bucket bound
    /// limit + limit * elapsed / 1 hour, which gives "never more than twice the limit in an hour".
    function testFuzzMintBudgetIsATokenBucket(uint256 seed) public {
        uint256 limit = 50_000 ether;
        n.setMintGuards(90 minutes, limit);
        uint256 steps = 40;
        uint256[] memory times = new uint256[](steps);
        uint256[] memory amounts = new uint256[](steps);

        for (uint256 index; index < steps; ++index) {
            seed = uint256(keccak256(abi.encode(seed, index)));
            uint256 kind = seed % 4;
            uint256 gap = kind == 0
                ? 0
                : kind == 1 ? (seed >> 8) % 60 : kind == 2 ? (seed >> 8) % 1_800 : (seed >> 8) % 5_000;
            vm.warp(vm.getBlockTimestamp() + gap);

            uint256 available = n.mintAvailableInWindow();
            assertLe(available, limit, "more than the limit available at once");
            vm.prank(ATTACKER);
            vm.expectRevert();
            n.mintAtOracle{value: available / 100 + 1}(0, ATTACKER);

            uint256 want = (seed >> 40) % 3 == 0 ? available : (seed >> 48) % (available + 1);
            uint256 minted;
            if (want / 100 != 0) minted = _mint(ATTACKER, want / 100);
            times[index] = vm.getBlockTimestamp();
            amounts[index] = minted;

            uint256 sum;
            for (uint256 from = index + 1; from != 0; --from) {
                sum += amounts[from - 1];
                uint256 elapsed = times[index] - times[from - 1];
                assertLe(sum, limit + limit * elapsed / 1 hours + 1, "more than the bucket can hold and refill");
                if (elapsed <= 1 hours) assertLe(sum, 2 * limit, "more than twice the limit within an hour");
            }
        }
    }

    /// Changing the limit between mints never lets more than the limit in force out at once.
    function testLimitChangesBetweenMintsNeverReleaseMoreThanTheLimit() public {
        n.setMintGuards(90 minutes, 50_000 ether);
        _mint(ATTACKER, 500 ether); // the whole 50,000
        assertEq(n.mintAvailableInWindow(), 0, "spent");

        // Raised in the same block: only the difference is free, not a fresh 80,000.
        n.setMintGuards(90 minutes, 80_000 ether);
        assertEq(n.mintAvailableInWindow(), 30_000 ether, "the difference");
        _mint(ATTACKER, 300 ether);
        assertEq(n.mintAvailableInWindow(), 0, "80,000 out in this block, not 130,000");

        // Lowered far below what is counted: nothing for an hour, then one new limit, never more.
        n.setMintGuards(90 minutes, 10_000 ether);
        uint256 lastMint = vm.getBlockTimestamp();
        vm.warp(lastMint + 3_599);
        assertEq(n.mintAvailableInWindow(), 0, "80,000 counted against 10,000 an hour");
        vm.warp(lastMint + 3_600);
        assertEq(n.mintAvailableInWindow(), 10_000 ether, "open again after one window, at the new limit");
        _mint(ATTACKER, 100 ether);
        vm.prank(ATTACKER);
        vm.expectRevert(abi.encodeWithSelector(OracleNv2.MintRateLimited.selector, 100 ether, 0));
        n.mintAtOracle{value: 1 ether}(0, ATTACKER);

        // The default "unlimited" limit does not overflow anything.
        n.setMintGuards(90 minutes, type(uint96).max);
        vm.warp(vm.getBlockTimestamp() + 1);
        assertEq(n.mintAvailableInWindow(), type(uint96).max, "refilled at once");
        _mint(ATTACKER, 1_000 ether);
        assertEq(n.mintAvailableInWindow(), type(uint96).max - 100_000 ether, "counted");
    }

    /// The fee tier depends on the age of the price and on nothing a third party controls: the
    /// quote equals the oracle value minus redeemFeeBps up to mintMaxPriceAge and minus 2% after
    /// it, a stranger topping up the reserve or moving N in between changes nothing, and the
    /// redemption pays exactly the quote.
    function testFuzzRedeemFeeTierFollowsOnlyThePriceAge(
        uint256 rawAge,
        uint256 rawAmount,
        uint256 rawFee
    ) public {
        uint256 fee = bound(rawFee, 0, 200);
        n.setFees(0, fee);
        _mint(HOLDER, 1_000 ether); // 100,000 N
        _mint(ATTACKER, 1 ether);
        n.coverReserve{value: 2_000 ether}(); // about 3x: the oracle leg decides
        uint256 age = bound(rawAge, 0, 1 days);
        uint256 amount = bound(rawAmount, 1 ether, 100_000 ether);
        oracle.setUpdatedAt(vm.getBlockTimestamp() - age);

        uint256 gross = amount * 1e18 / PRICE;
        uint256 expected = gross - gross * (age <= 90 minutes ? fee : 200) / 10_000;
        assertEq(n.quoteRedeem(amount), expected, "quote");

        vm.startPrank(ATTACKER);
        n.coverReserve{value: 1 ether}();
        n.transfer(HOLDER, 1 ether);
        n.burn(1 ether);
        vm.stopPrank();
        assertEq(n.quoteRedeem(amount), expected, "a stranger cannot move the fee tier");

        vm.prank(HOLDER);
        assertEq(n.redeemAtOracle(amount, expected, HOLDER), expected, "the redemption pays the quote");
    }

    /// The payout of a redemption hands control to the recipient after every state write. From
    /// there none of the guarded paths can be entered, although a surplus release was due.
    function testPayoutCallbackCannotReenterGuardedPaths() public {
        n.setSurplusRecipients(STAKING, TREASURY, 2_000);
        ReenteringRecipient recipient = new ReenteringRecipient(address(n));
        vm.prank(HOLDER);
        n.mintAtOracle{value: 100 ether}(0, address(recipient)); // 10,000 N
        _mint(HOLDER, 100 ether);
        n.coverReserve{value: 600 ether}(); // 800 zkLTC behind 20,000 N: 4.0x
        (, bool ready) = n.surplusMintCapacity();
        assertTrue(ready, "a release is due");

        assertEq(recipient.redeem(5_000 ether), 50 ether, "paid");
        assertEq(recipient.attempts(), 4, "release, mint, redeem and emergency exit were tried");
        assertEq(recipient.succeeded(), 0, "none went through");
        assertEq(n.totalSupply(), 15_000 ether, "supply");
        assertEq(n.totalCollateralWei(), 750 ether, "reserve");
        assertEq(address(n).balance, 750 ether, "and the balance agrees with it");
        assertEq(n.surplusSupplyBasis(), 20_000 ether, "the redemption was recorded before the payout");
    }
}
