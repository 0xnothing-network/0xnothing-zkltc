// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

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

    function lpTokenFor(address token, address nusd) external view returns (address lpToken);

    /// @notice Creates the destination pair when missing so `lpTokenFor` is a live ERC-20 before the router runs.
    function preparePool(address token) external returns (address pair);

    /// @notice Reserve-aware UniV2-style floor after the adapter's configured slippage.
    function quoteMinimumLp(address token, address nusd, uint256 tokenAmount, uint256 nusdAmount)
        external
        view
        returns (uint256 minimumLp);

    function graduate(GraduationParams calldata params) external returns (GraduationResult memory result);
}
