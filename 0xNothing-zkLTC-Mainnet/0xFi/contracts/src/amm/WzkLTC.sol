// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract WzkLTC is ERC20, ReentrancyGuard {
    error NativeTransferFailed();
    error ZeroAmount();

    event Deposit(address indexed account, uint256 amount);
    event Withdrawal(address indexed account, uint256 amount);

    constructor() ERC20("Wrapped zkLTC", "WzkLTC") { }

    receive() external payable {
        _deposit(msg.sender, msg.value);
    }

    function deposit() external payable {
        _deposit(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _burn(msg.sender, amount);
        (bool success,) = payable(msg.sender).call{ value: amount }("");
        if (!success) revert NativeTransferFailed();
        emit Withdrawal(msg.sender, amount);
    }

    function _deposit(address recipient, uint256 amount) private {
        if (amount == 0) revert ZeroAmount();
        _mint(recipient, amount);
        emit Deposit(recipient, amount);
    }
}

