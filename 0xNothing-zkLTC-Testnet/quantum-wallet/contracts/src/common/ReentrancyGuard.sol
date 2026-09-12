// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Self-contained copy of the repo guard convention so quantum-wallet/contracts
/// compiles standalone. Semantics identical to contracts/src/common/ReentrancyGuard.sol.
abstract contract ReentrancyGuard {
    error ReentrantCall();

    uint256 private _reentrancyStatus = 1;

    modifier nonReentrant() {
        if (_reentrancyStatus != 1) revert ReentrantCall();
        _reentrancyStatus = 2;
        _;
        _reentrancyStatus = 1;
    }
}
