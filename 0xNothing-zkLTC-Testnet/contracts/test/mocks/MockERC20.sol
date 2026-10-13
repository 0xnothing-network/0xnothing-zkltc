// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MockERC20 {
    string public name = "Mock NUSD";
    string public symbol = "NUSD";
    uint8 public constant decimals = 18;

    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        uint256 balance = balanceOf[msg.sender];
        require(balance >= amount, "BALANCE");
        balanceOf[msg.sender] = balance - amount;
        balanceOf[to] += amount;
        return true;
    }
}
