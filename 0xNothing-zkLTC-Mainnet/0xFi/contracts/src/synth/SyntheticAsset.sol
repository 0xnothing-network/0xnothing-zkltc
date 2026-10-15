// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice An 18-decimal synthetic asset whose mint and burn authority can be bound once.
contract SyntheticAsset is ERC20, Ownable2Step {
    error InvalidVault();
    error VaultAlreadyBound();
    error UnauthorizedVault();

    address public vault;

    event VaultBound(address indexed vault);

    constructor(string memory name_, string memory symbol_, address initialOwner)
        ERC20(name_, symbol_)
        Ownable(initialOwner)
    { }

    modifier onlyVault() {
        if (msg.sender != vault) revert UnauthorizedVault();
        _;
    }

    function bindVault(address vaultAddress) external onlyOwner {
        if (vault != address(0)) revert VaultAlreadyBound();
        if (vaultAddress == address(0) || vaultAddress == address(this) || vaultAddress.code.length == 0) {
            revert InvalidVault();
        }
        vault = vaultAddress;
        emit VaultBound(vaultAddress);
    }

    function mint(address recipient, uint256 amount) external onlyVault {
        _mint(recipient, amount);
    }

    /// @dev The vault first pulls tokens to itself, then burns only its own balance.
    function burn(uint256 amount) external onlyVault {
        _burn(msg.sender, amount);
    }
}
