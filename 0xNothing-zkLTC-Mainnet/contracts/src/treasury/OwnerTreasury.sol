// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title 0xNothing treasury
/// @notice Receives the protocol's treasury share (NUSD, WzkLTC, native zkLTC and any other token).
///         Spending is controlled by the owner alone, by design; ownership moves in two steps.
contract OwnerTreasury is Ownable2Step {
    using SafeERC20 for IERC20;

    error InvalidRecipient();
    error NativeTransferFailed();

    event NativeReceived(address indexed from, uint256 amount);
    event TokenWithdrawn(address indexed token, address indexed recipient, uint256 amount);
    event NativeWithdrawn(address indexed recipient, uint256 amount);

    constructor(address initialOwner) Ownable(initialOwner) {}

    receive() external payable {
        emit NativeReceived(msg.sender, msg.value);
    }

    function withdrawToken(IERC20 token, address recipient, uint256 amount) external onlyOwner {
        if (recipient == address(0)) revert InvalidRecipient();
        token.safeTransfer(recipient, amount);
        emit TokenWithdrawn(address(token), recipient, amount);
    }

    function withdrawNative(address payable recipient, uint256 amount) external onlyOwner {
        if (recipient == address(0)) revert InvalidRecipient();
        (bool ok,) = recipient.call{ value: amount }("");
        if (!ok) revert NativeTransferFailed();
        emit NativeWithdrawn(recipient, amount);
    }
}
