// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "../TestBase.sol";
import {DeployTestnet} from "../../script/DeployTestnet.s.sol";

contract DeployParametersTest is TestBase {
    DeployTestnet private script;

    function setUp() public {
        script = new DeployTestnet();
    }

    function testOracleDefaultsAreAccepted() public view {
        script.validateOracleParameters(3600, 1 ether, 10_000 ether, 2_000);
    }

    function testOracleParametersRejectOutOfRangeValues() public {
        vm.expectRevert(DeployTestnet.InvalidOracleParameters.selector);
        script.validateOracleParameters(5 minutes - 1, 1 ether, 10_000 ether, 2_000);
        vm.expectRevert(DeployTestnet.InvalidOracleParameters.selector);
        script.validateOracleParameters(2 hours + 1, 1 ether, 10_000 ether, 2_000);
        vm.expectRevert(DeployTestnet.InvalidOracleParameters.selector);
        script.validateOracleParameters(3600, 0.009 ether, 10_000 ether, 2_000);
        vm.expectRevert(DeployTestnet.InvalidOracleParameters.selector);
        script.validateOracleParameters(3600, 1 ether, 1_000_000 ether + 1, 2_000);
        vm.expectRevert(DeployTestnet.InvalidOracleParameters.selector);
        script.validateOracleParameters(3600, 10_000 ether, 10_000 ether, 2_000);
        vm.expectRevert(DeployTestnet.InvalidOracleParameters.selector);
        script.validateOracleParameters(3600, 1 ether, 10_000 ether, 10_001);
        vm.expectRevert(DeployTestnet.InvalidOracleParameters.selector);
        script.validateOracleParameters(3600, 1 ether, 10_000 ether, 0);
        vm.expectRevert(DeployTestnet.InvalidOracleParameters.selector);
        script.validateOracleParameters(3600, 1_000 ether + 1, 10_000 ether, 2_000);
        vm.expectRevert(DeployTestnet.InvalidOracleParameters.selector);
        script.validateOracleParameters(3600, 0.01 ether, 1 ether - 1, 2_000);
    }

    function testLaunchProtectionDefaultIsAccepted() public view {
        script.validateLaunchProtection(15 minutes, 50 ether);
        script.validateLaunchProtection(0, 0);
    }

    function testLaunchProtectionRejectsInvalidWindowOrZeroCap() public {
        vm.expectRevert(DeployTestnet.InvalidLaunchProtection.selector);
        script.validateLaunchProtection(1 hours + 1, 50 ether);
        vm.expectRevert(DeployTestnet.InvalidLaunchProtection.selector);
        script.validateLaunchProtection(15 minutes, 0);
    }

    function testGraduationDefaultsDeriveTheReviewedReserveTarget() public view {
        uint256 reserve = script.validateGraduationThresholds(1_500 ether, 6_000 ether);
        assertEq(reserve, 1_500 ether, "default derived reserve");
        assertEq(
            script.validateGraduationThresholds(50 ether, 200 ether),
            50 ether,
            "testnet 50/200 reserve"
        );
    }

    function testGraduationThresholdsRejectOutOfRangeValues() public {
        vm.expectRevert(DeployTestnet.InvalidGraduationThresholds.selector);
        script.validateGraduationThresholds(1 ether - 1, 6_000 ether);
        vm.expectRevert(DeployTestnet.InvalidGraduationThresholds.selector);
        script.validateGraduationThresholds(100_000 ether + 1, 200_000 ether);
        vm.expectRevert(DeployTestnet.InvalidGraduationThresholds.selector);
        script.validateGraduationThresholds(1_500 ether, 1_500 ether);
        vm.expectRevert(DeployTestnet.InvalidGraduationThresholds.selector);
        script.validateGraduationThresholds(1_500 ether, 1_000_000 ether + 1);
    }
}
