// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SafeTransferLib} from "../../src/common/SafeTransferLib.sol";
import {TestBase} from "../TestBase.sol";

contract SafeTransferHarness {
    function transfer(address token) external {
        SafeTransferLib.safeTransfer(token, address(0xBEEF), 1);
    }

    function transferFrom(address token) external {
        SafeTransferLib.safeTransferFrom(token, address(this), address(0xBEEF), 1);
    }

    function approve(address token) external {
        SafeTransferLib.forceApprove(token, address(0xBEEF), 1);
    }
}

contract NoReturnToken {
    fallback() external {}
}

contract ShortReturnToken {
    fallback() external {
        assembly ("memory-safe") {
            mstore(0, 1)
            return(31, 1)
        }
    }
}

contract InvalidBoolReturnToken {
    fallback() external {
        assembly ("memory-safe") {
            mstore(0, 2)
            return(0, 32)
        }
    }
}

contract SafeTransferLibTest is TestBase {
    SafeTransferHarness internal harness;

    function setUp() public {
        harness = new SafeTransferHarness();
    }

    function testRejectsEoaTargets() public {
        _expectAllOperationsToRevert(address(0xCAFE));
    }

    function testRejectsShortReturnDataWithLibraryError() public {
        _expectAllOperationsToRevert(address(new ShortReturnToken()));
    }

    function testRejectsInvalidBooleanReturnDataWithLibraryError() public {
        _expectAllOperationsToRevert(address(new InvalidBoolReturnToken()));
    }

    function testAcceptsNoReturnTokenContracts() public {
        address token = address(new NoReturnToken());
        harness.transfer(token);
        harness.transferFrom(token);
        harness.approve(token);
    }

    function _expectAllOperationsToRevert(address token) internal {
        bytes memory expectedError = abi.encodeWithSelector(SafeTransferLib.ERC20CallFailed.selector, token);

        vm.expectRevert(expectedError);
        harness.transfer(token);

        vm.expectRevert(expectedError);
        harness.transferFrom(token);

        vm.expectRevert(expectedError);
        harness.approve(token);
    }
}
