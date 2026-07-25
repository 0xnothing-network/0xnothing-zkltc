// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract NUSD {
    error ERC20InvalidAddress();
    error ERC20InsufficientBalance();
    error ERC20InsufficientAllowance();
    error UnauthorizedBinder();
    error UnauthorizedVault();
    error InvalidVault();
    error VaultAlreadyBound();

    string public constant name = "Nothing USD";
    string public constant symbol = "NUSD";
    uint8 public constant decimals = 18;

    address public immutable binder;
    address public vault;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event VaultBound(address indexed vault);

    constructor(address initialBinder) {
        if (initialBinder == address(0)) revert ERC20InvalidAddress();
        binder = initialBinder;
    }

    modifier onlyVault() {
        if (msg.sender != vault) revert UnauthorizedVault();
        _;
    }

    function bindVault(address vaultAddress) external {
        if (msg.sender != binder) revert UnauthorizedBinder();
        if (vault != address(0)) revert VaultAlreadyBound();
        if (vaultAddress == address(0) || vaultAddress == address(this) || vaultAddress.code.length == 0) {
            revert InvalidVault();
        }
        vault = vaultAddress;
        emit VaultBound(vaultAddress);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        if (spender == address(0)) revert ERC20InvalidAddress();
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        _spendAllowance(from, msg.sender, amount);
        _transfer(from, to, amount);
        return true;
    }

    function mint(address to, uint256 amount) external onlyVault {
        if (to == address(0)) revert ERC20InvalidAddress();
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function burnFrom(address account, uint256 amount) external onlyVault {
        _spendAllowance(account, msg.sender, amount);
        _burn(account, amount);
    }

    function _transfer(address from, address to, uint256 amount) internal {
        if (to == address(0)) revert ERC20InvalidAddress();
        uint256 balance = balanceOf[from];
        if (balance < amount) revert ERC20InsufficientBalance();
        unchecked {
            balanceOf[from] = balance - amount;
            balanceOf[to] += amount;
        }
        emit Transfer(from, to, amount);
    }

    function _burn(address account, uint256 amount) internal {
        uint256 balance = balanceOf[account];
        if (balance < amount) revert ERC20InsufficientBalance();
        unchecked {
            balanceOf[account] = balance - amount;
            totalSupply -= amount;
        }
        emit Transfer(account, address(0), amount);
    }

    function _spendAllowance(address owner, address spender, uint256 amount) internal {
        uint256 currentAllowance = allowance[owner][spender];
        if (currentAllowance != type(uint256).max) {
            if (currentAllowance < amount) revert ERC20InsufficientAllowance();
            unchecked {
                allowance[owner][spender] = currentAllowance - amount;
            }
            emit Approval(owner, spender, allowance[owner][spender]);
        }
    }
}
