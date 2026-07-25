// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MathX} from "../common/MathX.sol";
import {ReentrancyGuard} from "../common/ReentrancyGuard.sol";
import {RoleControl} from "../common/RoleControl.sol";
import {SafeTransferLib} from "../common/SafeTransferLib.sol";
import {DIAOracleAdapter} from "./DIAOracleAdapter.sol";

contract OracleNUSD is RoleControl, ReentrancyGuard {
    error InvalidOracleAdapter();
    error InvalidSupplyCeiling();
    error InvalidAmount();
    error InvalidRecipient();
    error MintPaused();
    error RedeemPaused();
    error SlippageExceeded(uint256 minimumAmount, uint256 actualAmount);
    error SupplyCeilingExceeded(uint256 requestedAmountNusd, uint256 availableAmountNusd);
    error InsufficientReserve(uint256 requiredCollateralWei, uint256 availableCollateralWei);
    error ERC20InvalidAddress();
    error ERC20InsufficientBalance(address account, uint256 balance, uint256 requiredAmount);
    error ERC20InsufficientAllowance(address owner, address spender, uint256 allowance, uint256 requiredAmount);

    string public constant name = "Nothing USD";
    string public constant symbol = "NUSD";
    uint8 public constant decimals = 18;
    uint256 public constant WAD = 1e18;
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    DIAOracleAdapter public immutable oracle;
    uint256 public immutable supplyCeilingNusd;

    uint256 public totalSupply;
    uint256 public totalCollateralWei;
    bool public mintPaused;
    bool public redeemPaused;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event MintedAtOracle(address indexed payer, address indexed recipient, uint256 collateralInWei, uint256 amountNusd);
    event RedeemedAtOracle(
        address indexed account, address indexed recipient, uint256 amountNusd, uint256 collateralOutWei
    );
    event ReserveCovered(address indexed payer, uint256 amountWei, uint256 totalCollateralWei);
    event MintPauseUpdated(bool paused);
    event RedeemPauseUpdated(bool paused);

    constructor(DIAOracleAdapter oracleAdapter, address initialAdmin, uint256 supplyCeilingNusd_)
        RoleControl(initialAdmin)
    {
        if (address(oracleAdapter) == address(0) || address(oracleAdapter).code.length == 0) {
            revert InvalidOracleAdapter();
        }
        if (supplyCeilingNusd_ == 0) revert InvalidSupplyCeiling();

        oracle = oracleAdapter;
        supplyCeilingNusd = supplyCeilingNusd_;
        _grantRole(PAUSER_ROLE, initialAdmin);
    }

    receive() external payable {
        _coverReserve(msg.sender, msg.value);
    }

    function vault() external view returns (address) {
        return address(this);
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
        if (from == address(0)) revert ERC20InvalidAddress();
        _spendAllowance(from, msg.sender, amount);
        _transfer(from, to, amount);
        return true;
    }

    function quoteMint(uint256 collateralWei) public view returns (uint256 amountNusd) {
        (uint256 priceWad,,) = oracle.readPriceWad();
        amountNusd = MathX.mulDiv(collateralWei, priceWad, WAD);
    }

    function mintAtOracle(uint256 minNusdOut, address recipient)
        external
        payable
        nonReentrant
        returns (uint256 amountNusd)
    {
        if (mintPaused) revert MintPaused();
        if (msg.value == 0) revert InvalidAmount();
        if (recipient == address(0)) revert InvalidRecipient();

        amountNusd = quoteMint(msg.value);
        if (amountNusd == 0) revert InvalidAmount();
        if (amountNusd < minNusdOut) revert SlippageExceeded(minNusdOut, amountNusd);

        uint256 availableAmountNusd = supplyCeilingNusd - totalSupply;
        if (amountNusd > availableAmountNusd) {
            revert SupplyCeilingExceeded(amountNusd, availableAmountNusd);
        }

        totalCollateralWei += msg.value;
        _mint(recipient, amountNusd);

        emit MintedAtOracle(msg.sender, recipient, msg.value, amountNusd);
    }

    function quoteRedeem(uint256 amountNusd) public view returns (uint256 collateralOutWei) {
        (uint256 priceWad,,) = oracle.readPriceWad();
        collateralOutWei = MathX.mulDiv(amountNusd, WAD, priceWad);
    }

    function redeemAtOracle(uint256 amountNusd, uint256 minCollateralOutWei, address recipient)
        external
        nonReentrant
        returns (uint256 collateralOutWei)
    {
        if (redeemPaused) revert RedeemPaused();
        if (amountNusd == 0) revert InvalidAmount();
        if (recipient == address(0)) revert InvalidRecipient();

        collateralOutWei = quoteRedeem(amountNusd);
        if (collateralOutWei == 0) revert InvalidAmount();
        if (collateralOutWei < minCollateralOutWei) {
            revert SlippageExceeded(minCollateralOutWei, collateralOutWei);
        }
        if (collateralOutWei > totalCollateralWei) {
            revert InsufficientReserve(collateralOutWei, totalCollateralWei);
        }

        _burn(msg.sender, amountNusd);
        totalCollateralWei -= collateralOutWei;
        SafeTransferLib.safeTransferNative(recipient, collateralOutWei);

        emit RedeemedAtOracle(msg.sender, recipient, amountNusd, collateralOutWei);
    }

    function reserveValueNusd() external view returns (uint256 valueNusd) {
        valueNusd = quoteMint(totalCollateralWei);
    }

    function coverReserve() external payable {
        _coverReserve(msg.sender, msg.value);
    }

    function setMintPaused(bool paused) external onlyRole(PAUSER_ROLE) {
        mintPaused = paused;
        emit MintPauseUpdated(paused);
    }

    function setRedeemPaused(bool paused) external onlyRole(PAUSER_ROLE) {
        redeemPaused = paused;
        emit RedeemPauseUpdated(paused);
    }

    function _coverReserve(address payer, uint256 amountWei) private {
        if (amountWei == 0) revert InvalidAmount();
        totalCollateralWei += amountWei;
        emit ReserveCovered(payer, amountWei, totalCollateralWei);
    }

    function _transfer(address from, address to, uint256 amount) private {
        if (to == address(0)) revert ERC20InvalidAddress();
        uint256 balance = balanceOf[from];
        if (balance < amount) revert ERC20InsufficientBalance(from, balance, amount);

        unchecked {
            balanceOf[from] = balance - amount;
            balanceOf[to] += amount;
        }
        emit Transfer(from, to, amount);
    }

    function _mint(address recipient, uint256 amount) private {
        totalSupply += amount;
        balanceOf[recipient] += amount;
        emit Transfer(address(0), recipient, amount);
    }

    function _burn(address account, uint256 amount) private {
        uint256 balance = balanceOf[account];
        if (balance < amount) revert ERC20InsufficientBalance(account, balance, amount);

        unchecked {
            balanceOf[account] = balance - amount;
            totalSupply -= amount;
        }
        emit Transfer(account, address(0), amount);
    }

    function _spendAllowance(address owner, address spender, uint256 amount) private {
        uint256 currentAllowance = allowance[owner][spender];
        if (currentAllowance == type(uint256).max) return;
        if (currentAllowance < amount) {
            revert ERC20InsufficientAllowance(owner, spender, currentAllowance, amount);
        }

        unchecked {
            allowance[owner][spender] = currentAllowance - amount;
        }
        emit Approval(owner, spender, allowance[owner][spender]);
    }
}
