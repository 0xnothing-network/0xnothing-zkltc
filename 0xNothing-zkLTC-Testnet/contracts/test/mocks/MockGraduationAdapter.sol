// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IGraduationAdapter} from "../../src/graduation/interfaces/IGraduationAdapter.sol";
import {SafeTransferLib} from "../../src/common/SafeTransferLib.sol";

contract MockLPToken {
    string public constant name = "Mock LP";
    string public constant symbol = "MLP";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

contract MockGraduationAdapter is IGraduationAdapter {
    MockLPToken public immutable lpToken;
    bool public shouldRevert;
    bool public skipLpMint;

    constructor() {
        lpToken = new MockLPToken();
    }

    function setShouldRevert(bool value) external {
        shouldRevert = value;
    }

    function setSkipLpMint(bool value) external {
        skipLpMint = value;
    }

    function lpTokenFor(address, address) external view returns (address) {
        return address(lpToken);
    }

    function graduate(GraduationParams calldata params) external returns (GraduationResult memory result) {
        require(!shouldRevert, "MOCK_REVERT");
        require(block.timestamp <= params.deadline, "EXPIRED");
        SafeTransferLib.safeTransferFrom(params.token, msg.sender, address(this), params.tokenAmount);
        SafeTransferLib.safeTransferFrom(params.nusd, msg.sender, address(this), params.nusdAmount);

        uint256 lpAmount = params.tokenAmount < params.nusdAmount ? params.tokenAmount : params.nusdAmount;
        require(lpAmount >= params.minimumLp, "MIN_LP");
        if (!skipLpMint) lpToken.mint(params.lpRecipient, lpAmount);

        bytes32 pairId = params.token < params.nusd
            ? keccak256(abi.encodePacked(params.token, params.nusd))
            : keccak256(abi.encodePacked(params.nusd, params.token));
        result = GraduationResult({
            dex: address(this), pairId: pairId, pool: address(this), lpToken: address(lpToken), lpAmount: lpAmount
        });
    }
}
