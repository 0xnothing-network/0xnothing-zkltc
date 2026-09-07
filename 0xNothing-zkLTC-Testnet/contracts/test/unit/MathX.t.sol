// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MathX} from "../../src/common/MathX.sol";
import {TestBase} from "../TestBase.sol";

contract MathXTest is TestBase {
    function testSqrtRoundsDownAtSmallBoundaries() public pure {
        assertEq(MathX.sqrt(0), 0, "sqrt zero");
        assertEq(MathX.sqrt(1), 1, "sqrt one");
        assertEq(MathX.sqrt(2), 1, "sqrt two rounds down");
        assertEq(MathX.sqrt(3), 1, "sqrt three rounds down");
        assertEq(MathX.sqrt(4), 2, "sqrt perfect square");
        assertEq(MathX.sqrt(8), 2, "sqrt below next square");
        assertEq(MathX.sqrt(9), 3, "sqrt next square");
    }

    function testSqrtHandlesMaximumUint256() public pure {
        assertEq(MathX.sqrt(type(uint256).max), type(uint128).max, "maximum floor root");
        assertEq(MathX.sqrtUp(type(uint256).max), uint256(type(uint128).max) + 1, "maximum ceiling root");
    }

    function testFuzzSqrtRoundingBounds(uint256 value) public pure {
        uint256 root = MathX.sqrt(value);
        if (value == 0) {
            assertEq(root, 0, "zero floor root");
            assertEq(MathX.sqrtUp(value), 0, "zero ceiling root");
            return;
        }
        assertGt(root, 0, "positive root");
        assertLe(root, value / root, "floor root does not exceed value");
        assertGt(root + 1, value / (root + 1), "next root exceeds value");
        uint256 expectedUp = root * root == value ? root : root + 1;
        assertEq(MathX.sqrtUp(value), expectedUp, "ceiling root rounding");
    }
}
