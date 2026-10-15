// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @notice Adds a replaceable pause-only guardian to two-step ownership.
abstract contract EmergencyGuardian is Ownable2Step {
    error InvalidGuardian();
    error UnauthorizedGuardian();

    address public guardian;

    event GuardianUpdated(address indexed previousGuardian, address indexed newGuardian);

    constructor(address initialOwner) Ownable(initialOwner) {
        guardian = initialOwner;
        emit GuardianUpdated(address(0), initialOwner);
    }

    modifier onlyOwnerOrGuardian() {
        if (msg.sender != owner() && msg.sender != guardian) revert UnauthorizedGuardian();
        _;
    }

    function setGuardian(address newGuardian) external onlyOwner {
        if (newGuardian == address(0)) revert InvalidGuardian();
        address previousGuardian = guardian;
        guardian = newGuardian;
        emit GuardianUpdated(previousGuardian, newGuardian);
    }
}
