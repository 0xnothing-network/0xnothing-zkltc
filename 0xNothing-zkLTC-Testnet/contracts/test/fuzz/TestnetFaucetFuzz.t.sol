// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "../TestBase.sol";
import {TestnetFaucet} from "../../src/nusd/TestnetFaucet.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

contract TestnetFaucetFuzzTest is TestBase {
    address private constant USER = address(0xA11CE);

    MockERC20 private token;
    TestnetFaucet private faucet;

    function setUp() public {
        vm.chainId(4441);
        vm.warp((1_700_000_000 / 1 days) * 1 days + 1 hours);
        token = new MockERC20();
        faucet = new TestnetFaucet(address(token), address(this), 0.05 ether, 25 ether, 8 hours, 2 ether, 1_000 ether);
        token.mint(address(faucet), 1_000_000 ether);
        vm.deal(address(faucet), 1_000 ether);
    }

    function testFuzzCooldownIsHonored(uint256 wait) public {
        vm.startPrank(USER, USER);
        faucet.claim();
        uint256 readyAt = faucet.lastClaimAt(USER) + 8 hours;
        uint256 elapsed = bound(wait, 0, 8 hours - 1);
        vm.warp(block.timestamp + elapsed);
        vm.expectRevert(abi.encodeWithSelector(TestnetFaucet.CooldownActive.selector, readyAt));
        faucet.claim();
        vm.stopPrank();
    }

    function testFuzzDailyNativeCapNeverExceeded(uint8 claims) public {
        uint256 count = bound(claims, 1, 80);
        uint256 successful;
        for (uint256 i; i < count; ++i) {
            address claimer = address(uint160(0x1000 + i));
            (bool allowed,,,) = faucet.previewClaim(claimer);
            if (!allowed) {
                vm.prank(claimer, claimer);
                vm.expectRevert(TestnetFaucet.DailyCapExceeded.selector);
                faucet.claim();
                break;
            }
            vm.prank(claimer, claimer);
            faucet.claim();
            successful += 1;
        }
        assertLe(faucet.dailyNativeDispensed(), faucet.dailyNativeCap(), "native cap");
        assertLe(faucet.dailyNusdDispensed(), faucet.dailyNusdCap(), "nusd cap");
        assertEq(successful, 2 ether / 0.05 ether > count ? count : 2 ether / 0.05 ether, "exact fill");
    }

    function testFuzzClaimPaysConfiguredDrip(uint256 nativeDrip, uint256 nusdDrip) public {
        nativeDrip = bound(nativeDrip, 1, 0.2 ether);
        nusdDrip = bound(nusdDrip, 1, 50 ether);
        faucet.setDrip(nativeDrip, nusdDrip);
        faucet.setDailyCaps(nativeDrip * 4, nusdDrip * 4);

        uint256 nativeBefore = USER.balance;
        uint256 nusdBefore = token.balanceOf(USER);
        vm.prank(USER, USER);
        faucet.claim();
        assertEq(USER.balance, nativeBefore + nativeDrip, "native drip");
        assertEq(token.balanceOf(USER), nusdBefore + nusdDrip, "nusd drip");
    }
}
