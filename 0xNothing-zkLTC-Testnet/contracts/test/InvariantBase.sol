// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.24;

import {TestBase} from "./TestBase.sol";

abstract contract InvariantBase is TestBase {
    struct FuzzSelector {
        address addr;
        bytes4[] selectors;
    }

    struct FuzzArtifactSelector {
        string artifact;
        bytes4[] selectors;
    }

    struct FuzzInterface {
        address addr;
        string[] artifacts;
    }

    address[] private _targetedContracts;

    function targetContract(address target) internal {
        _targetedContracts.push(target);
    }

    function excludeArtifacts() public pure returns (string[] memory values) {
        values = new string[](0);
    }

    function excludeContracts() public pure returns (address[] memory values) {
        values = new address[](0);
    }

    function excludeSelectors() public pure returns (FuzzSelector[] memory values) {
        values = new FuzzSelector[](0);
    }

    function excludeSenders() public pure returns (address[] memory values) {
        values = new address[](0);
    }

    function targetArtifacts() public pure returns (string[] memory values) {
        values = new string[](0);
    }

    function targetArtifactSelectors() public pure returns (FuzzArtifactSelector[] memory values) {
        values = new FuzzArtifactSelector[](0);
    }

    function targetContracts() public view returns (address[] memory) {
        return _targetedContracts;
    }

    function targetSelectors() public pure returns (FuzzSelector[] memory values) {
        values = new FuzzSelector[](0);
    }

    function targetSenders() public pure returns (address[] memory values) {
        values = new address[](0);
    }

    function targetInterfaces() public pure returns (FuzzInterface[] memory values) {
        values = new FuzzInterface[](0);
    }
}
