// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IGraduationAdapter} from "./IGraduationAdapter.sol";

interface IGraduationRouter {
    function executeGraduation(
        address adapter,
        address token,
        address nusd,
        uint256 tokenAmount,
        uint256 nusdAmount,
        uint256 minimumLp,
        uint256 deadline
    ) external returns (IGraduationAdapter.GraduationResult memory result);

    function lpRecipient() external view returns (address);
    function enabled() external view returns (bool);
    function isAdapterAllowed(address adapter) external view returns (bool);
}
