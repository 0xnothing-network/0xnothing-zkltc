// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "../TestBase.sol";
import {DeployMainnet} from "../../script/DeployMainnet.s.sol";

contract DeployParametersTest is TestBase {
    DeployMainnet private script;

    function setUp() public {
        script = new DeployMainnet();
    }

    function testOracleDefaultsAreAccepted() public view {
        script.validateOracleParameters(3600, 1 ether, 10_000 ether, 2_000);
    }

    function testOracleParametersRejectOutOfRangeValues() public {
        vm.expectRevert(DeployMainnet.InvalidOracleParameters.selector);
        script.validateOracleParameters(5 minutes - 1, 1 ether, 10_000 ether, 2_000);
        vm.expectRevert(DeployMainnet.InvalidOracleParameters.selector);
        script.validateOracleParameters(2 hours + 1, 1 ether, 10_000 ether, 2_000);
        vm.expectRevert(DeployMainnet.InvalidOracleParameters.selector);
        script.validateOracleParameters(3600, 0.009 ether, 10_000 ether, 2_000);
        vm.expectRevert(DeployMainnet.InvalidOracleParameters.selector);
        script.validateOracleParameters(3600, 1 ether, 1_000_000 ether + 1, 2_000);
        vm.expectRevert(DeployMainnet.InvalidOracleParameters.selector);
        script.validateOracleParameters(3600, 10_000 ether, 10_000 ether, 2_000);
        vm.expectRevert(DeployMainnet.InvalidOracleParameters.selector);
        script.validateOracleParameters(3600, 1 ether, 10_000 ether, 10_001);
        vm.expectRevert(DeployMainnet.InvalidOracleParameters.selector);
        script.validateOracleParameters(3600, 1 ether, 10_000 ether, 0);
        vm.expectRevert(DeployMainnet.InvalidOracleParameters.selector);
        script.validateOracleParameters(3600, 1_000 ether + 1, 10_000 ether, 2_000);
        vm.expectRevert(DeployMainnet.InvalidOracleParameters.selector);
        script.validateOracleParameters(3600, 0.01 ether, 1 ether - 1, 2_000);
    }

    function testLaunchProtectionDefaultIsAccepted() public view {
        script.validateLaunchProtection(15 minutes, 50 ether);
        script.validateLaunchProtection(0, 0);
    }

    function testLaunchProtectionRejectsInvalidWindowOrZeroCap() public {
        vm.expectRevert(DeployMainnet.InvalidLaunchProtection.selector);
        script.validateLaunchProtection(1 hours + 1, 50 ether);
        vm.expectRevert(DeployMainnet.InvalidLaunchProtection.selector);
        script.validateLaunchProtection(15 minutes, 0);
    }
}
