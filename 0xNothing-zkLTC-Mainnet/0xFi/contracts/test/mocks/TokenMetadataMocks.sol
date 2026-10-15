// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract OwnableTokenMock {
    address public owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function transferOwnership(address newOwner) external {
        require(msg.sender == owner, "NOT_OWNER");
        owner = newOwner;
    }
}

contract NonOwnableTokenMock { }

contract RevertingOwnerTokenMock {
    function owner() external pure returns (address) {
        revert("NO_OWNER");
    }
}

contract ShortOwnerReturnTokenMock {
    fallback() external {
        assembly ("memory-safe") {
            mstore(0, caller())
            return(1, 31)
        }
    }
}

contract LongOwnerReturnTokenMock {
    fallback() external {
        assembly ("memory-safe") {
            mstore(0, caller())
            mstore(0x20, 1)
            return(0, 64)
        }
    }
}

contract NonCanonicalOwnerReturnTokenMock {
    fallback() external {
        assembly ("memory-safe") {
            mstore(0, shl(160, 1))
            return(0, 32)
        }
    }
}
