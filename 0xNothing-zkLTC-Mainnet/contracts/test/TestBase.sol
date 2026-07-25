// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface Vm {
    function deal(address account, uint256 newBalance) external;
    function prank(address sender) external;
    function startPrank(address sender) external;
    function stopPrank() external;
    function warp(uint256 newTimestamp) external;
    function expectRevert() external;
    function expectRevert(bytes4 selector) external;
    function assume(bool condition) external;
    function createSelectFork(string calldata rpcUrl) external returns (uint256 forkId);
    function envOr(string calldata key, string calldata defaultValue) external returns (string memory value);
    function envOr(string calldata key, uint256 defaultValue) external returns (uint256 value);
    function envOr(string calldata key, address defaultValue) external returns (address value);
}

abstract contract TestBase {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function assertTrue(bool condition, string memory message) internal pure {
        require(condition, message);
    }

    function assertFalse(bool condition, string memory message) internal pure {
        require(!condition, message);
    }

    function assertEq(uint256 actual, uint256 expected, string memory message) internal pure {
        require(actual == expected, message);
    }

    function assertEq(address actual, address expected, string memory message) internal pure {
        require(actual == expected, message);
    }

    function assertEq(bytes32 actual, bytes32 expected, string memory message) internal pure {
        require(actual == expected, message);
    }

    function assertGt(uint256 actual, uint256 expected, string memory message) internal pure {
        require(actual > expected, message);
    }

    function assertGe(uint256 actual, uint256 expected, string memory message) internal pure {
        require(actual >= expected, message);
    }

    function assertLe(uint256 actual, uint256 expected, string memory message) internal pure {
        require(actual <= expected, message);
    }

    function bound(uint256 value, uint256 minimum, uint256 maximum) internal pure returns (uint256) {
        require(minimum <= maximum, "INVALID_BOUND");
        if (value >= minimum && value <= maximum) return value;
        return minimum + (value % (maximum - minimum + 1));
    }
}
