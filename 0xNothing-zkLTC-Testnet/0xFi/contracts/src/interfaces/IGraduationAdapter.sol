// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev ABI-compatible with the live 0xPump IGraduationAdapter.
interface IGraduationAdapter {
    struct GraduationParams {
        address token;
        address nusd;
        uint256 tokenAmount;
        uint256 nusdAmount;
        uint256 minimumLp;
        uint256 deadline;
        address lpRecipient;
    }

    struct GraduationResult {
        address dex;
        bytes32 pairId;
        address pool;
        address lpToken;
        uint256 lpAmount;
    }

    function preparePool(address token) external returns (address pair);

    function lpTokenFor(address token, address nusd) external view returns (address lpToken);

    function graduate(GraduationParams calldata params) external returns (GraduationResult memory result);
}
