// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "../TestBase.sol";
import {DeployFaucet} from "../../script/DeployFaucet.s.sol";
import {TestnetFaucet} from "../../src/nusd/TestnetFaucet.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

contract FaucetClaimProxy {
    function claim(TestnetFaucet faucet) external {
        faucet.claim();
    }
}

contract TestnetFaucetTest is TestBase {
    address private constant USER = address(0xA11CE);
    address private constant OTHER = address(0xB0B);

    MockERC20 private token;
    TestnetFaucet private faucet;
    DeployFaucet private script;

    receive() external payable {}

    function setUp() public {
        vm.chainId(4441);
        vm.warp((1_700_000_000 / 1 days) * 1 days + 1 hours);
        token = new MockERC20();
        faucet = new TestnetFaucet(address(token), address(this), 0.05 ether, 25 ether, 8 hours, 2 ether, 1_000 ether);
        token.mint(address(faucet), 10_000 ether);
        vm.deal(address(faucet), 10 ether);
        vm.deal(USER, 0);
        script = new DeployFaucet();
    }

    function testDefaultsMatchReviewedTestnetDrip() public view {
        assertEq(faucet.nativeDrip(), 0.05 ether, "native drip");
        assertEq(faucet.nusdDrip(), 25 ether, "nusd drip");
        assertEq(faucet.cooldownSeconds(), 8 hours, "cooldown");
        assertEq(faucet.dailyNativeCap(), 2 ether, "native cap");
        assertEq(faucet.dailyNusdCap(), 1_000 ether, "nusd cap");
        assertEq(faucet.nusd(), address(token), "nusd");
        assertEq(faucet.admin(), address(this), "admin");
    }

    function testClaimSendsExactDripToCaller() public {
        vm.prank(USER, USER);
        faucet.claim();

        assertEq(USER.balance, 0.05 ether, "native received");
        assertEq(token.balanceOf(USER), 25 ether, "nusd received");
        assertEq(faucet.lastClaimAt(USER), block.timestamp, "cooldown stamped");
        assertEq(faucet.dailyNativeDispensed(), 0.05 ether, "native day usage");
        assertEq(faucet.dailyNusdDispensed(), 25 ether, "nusd day usage");
    }

    function testClaimRevertsDuringCooldown() public {
        vm.prank(USER, USER);
        faucet.claim();

        vm.prank(USER, USER);
        vm.expectRevert(abi.encodeWithSelector(TestnetFaucet.CooldownActive.selector, block.timestamp + 8 hours));
        faucet.claim();

        vm.warp(block.timestamp + 8 hours);
        vm.prank(USER, USER);
        faucet.claim();
        assertEq(USER.balance, 0.1 ether, "second claim after cooldown");
    }

    function testContractsCannotClaim() public {
        FaucetClaimProxy proxy = new FaucetClaimProxy();
        vm.prank(USER, USER);
        vm.expectRevert(TestnetFaucet.ContractsNotAllowed.selector);
        proxy.claim(faucet);
    }

    function testDailyCapBlocksFurtherClaimsUntilUtcReset() public {
        faucet.setDailyCaps(0.05 ether, 25 ether);
        vm.prank(USER, USER);
        faucet.claim();
        (uint256 nativeRemaining,) = faucet.dailyRemaining();
        assertEq(nativeRemaining, 0, "cap filled");

        (bool allowed,,,) = faucet.previewClaim(OTHER);
        assertFalse(allowed, "second wallet blocked");
        vm.prank(OTHER, OTHER);
        vm.expectRevert(TestnetFaucet.DailyCapExceeded.selector);
        faucet.claim();

        vm.warp((block.timestamp / 1 days + 1) * 1 days);
        vm.prank(OTHER, OTHER);
        faucet.claim();
        assertEq(OTHER.balance, 0.05 ether, "next utc day");
        assertEq(faucet.dailyNativeDispensed(), 0.05 ether, "day usage reset");
    }

    function testPausedAndEmptyReserveRevert() public {
        faucet.setPaused(true);
        vm.prank(USER, USER);
        vm.expectRevert(TestnetFaucet.FaucetPaused.selector);
        faucet.claim();
        faucet.setPaused(false);

        faucet.withdrawNative(address(this), address(faucet).balance);
        vm.prank(USER, USER);
        vm.expectRevert(abi.encodeWithSelector(TestnetFaucet.InsufficientNativeReserve.selector, 0.05 ether, 0));
        faucet.claim();
    }

    function testAdminCanRetuneAndWithdraw() public {
        faucet.setDrip(0.01 ether, 10 ether);
        faucet.setCooldown(1 hours);
        faucet.setDailyCaps(1 ether, 100 ether);
        faucet.withdrawNusd(OTHER, 5 ether);
        assertEq(token.balanceOf(OTHER), 5 ether, "admin nusd withdraw");
        assertEq(faucet.nativeDrip(), 0.01 ether, "updated native drip");
    }

    function testNonAdminCannotRetune() public {
        vm.prank(USER);
        vm.expectRevert();
        faucet.setDrip(1, 1);
    }

    function testConstructorRejectsWrongChain() public {
        vm.chainId(1);
        vm.expectRevert(abi.encodeWithSelector(TestnetFaucet.WrongChain.selector, 4441, 1));
        new TestnetFaucet(address(token), address(this), 1, 1, 1 hours, 1, 1);
        vm.chainId(4441);
    }

    function testDeployScriptAcceptsReviewedDefaultsAndTestnetExample() public view {
        script.validateFaucetParameters(
            DeployFaucet(address(script)).DEFAULT_NUSD(),
            0.05 ether,
            25 ether,
            8 hours,
            2 ether,
            1_000 ether
        );
    }

    function testDeployScriptRejectsInvalidParameters() public {
        vm.expectRevert(DeployFaucet.InvalidNusd.selector);
        script.validateFaucetParameters(address(0), 1, 1, 1 hours, 1, 1);
        vm.expectRevert(DeployFaucet.InvalidFaucetParameters.selector);
        script.validateFaucetParameters(address(token), 0, 1, 1 hours, 1, 1);
        vm.expectRevert(DeployFaucet.InvalidFaucetParameters.selector);
        script.validateFaucetParameters(address(token), 1, 1, 30, 1, 1);
        vm.expectRevert(DeployFaucet.InvalidFaucetParameters.selector);
        script.validateFaucetParameters(address(token), 2 ether, 1, 1 hours, 1 ether, 1);
    }
}
