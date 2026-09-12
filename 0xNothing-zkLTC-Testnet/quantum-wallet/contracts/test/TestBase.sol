// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Self-contained copy of the repo's hand-rolled test harness so
/// quantum-wallet/contracts runs `forge test` with zero external deps.
interface Vm {
    function deal(address account, uint256 newBalance) external;
    function prank(address sender) external;
    function startPrank(address sender) external;
    function stopPrank() external;
    function warp(uint256 newTimestamp) external;
    /// Sets `tx.gasprice` for subsequent calls — needed to prove the relay hub
    /// caps what a relayer can bill the vault.
    function txGasPrice(uint256 newGasPrice) external;
    /// Sets `block.basefee`.
    function fee(uint256 newBasefee) external;
    function expectRevert() external;
    function expectRevert(bytes4 selector) external;
    function expectRevert(bytes calldata revertData) external;
    function assume(bool condition) external;
    function createSelectFork(string calldata rpcUrl) external returns (uint256 forkId);
    function envOr(string calldata key, string calldata defaultValue) external returns (string memory value);
    function envOr(string calldata key, uint256 defaultValue) external returns (uint256 value);
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

    function assertEq(bytes4 a, bytes4 b, string memory message) internal pure {
        require(a == b, message);
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

    function assertNotEq(address a, address b, string memory message) internal pure {
        require(a != b, message);
    }

    function bound(uint256 value, uint256 minimum, uint256 maximum) internal pure returns (uint256) {
        require(minimum <= maximum, "INVALID_BOUND");
        if (value >= minimum && value <= maximum) return value;
        return minimum + (value % (maximum - minimum + 1));
    }
}
