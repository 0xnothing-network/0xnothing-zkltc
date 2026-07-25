// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract PumpToken {
    error AlreadyInitialized();
    error InvalidTokenConfiguration();
    error UnauthorizedPump();
    error ERC20InvalidAddress();
    error ERC20InsufficientBalance();
    error ERC20InsufficientAllowance();

    uint8 public constant decimals = 18;

    string public name;
    string public symbol;
    string public metadataURI;
    string public imageURI;
    address public pump;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool private _initialized;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor() {
        _initialized = true;
    }

    function initialize(
        string calldata tokenName,
        string calldata tokenSymbol,
        string calldata tokenMetadataURI,
        string calldata tokenImageURI,
        uint256 supply,
        address pumpAddress
    ) external {
        if (_initialized) revert AlreadyInitialized();
        if (bytes(tokenName).length == 0 || bytes(tokenSymbol).length == 0 || supply == 0 || pumpAddress == address(0)) revert InvalidTokenConfiguration();

        _initialized = true;
        name = tokenName;
        symbol = tokenSymbol;
        metadataURI = tokenMetadataURI;
        imageURI = tokenImageURI;
        pump = pumpAddress;
        totalSupply = supply;
        balanceOf[pumpAddress] = supply;
        emit Transfer(address(0), pumpAddress, supply);
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
        uint256 currentAllowance = allowance[from][msg.sender];
        if (currentAllowance != type(uint256).max) {
            if (currentAllowance < amount) revert ERC20InsufficientAllowance();
            unchecked {
                allowance[from][msg.sender] = currentAllowance - amount;
            }
            emit Approval(from, msg.sender, allowance[from][msg.sender]);
        }
        _transfer(from, to, amount);
        return true;
    }

    function burn(uint256 amount) external {
        if (msg.sender != pump) revert UnauthorizedPump();
        uint256 balance = balanceOf[msg.sender];
        if (balance < amount) revert ERC20InsufficientBalance();
        unchecked {
            balanceOf[msg.sender] = balance - amount;
            totalSupply -= amount;
        }
        emit Transfer(msg.sender, address(0), amount);
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
}
