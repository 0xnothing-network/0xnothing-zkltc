// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MathX} from "../common/MathX.sol";
import {ReentrancyGuard} from "../common/ReentrancyGuard.sol";
import {RoleControl} from "../common/RoleControl.sol";
import {SafeTransferLib} from "../common/SafeTransferLib.sol";
import {DIAOracleAdapter} from "./DIAOracleAdapter.sol";

/// @title NUSD v2
/// @notice Oracle-priced NUSD backed by native zkLTC, with three additions over v1:
///         a price-free emergency exit when the oracle dies, a public burn, and a
///         governance-only surplus mint that can never push the reserve below 2x supply.
contract OracleNUSDv2 is RoleControl, ReentrancyGuard {
    error InvalidOracleAdapter();
    error InvalidSupplyCeiling();
    error InvalidAmount();
    error InvalidRecipient();
    error MintPaused();
    error RedeemPaused();
    error SlippageExceeded(uint256 minimumAmount, uint256 actualAmount);
    error SupplyCeilingExceeded(uint256 requestedAmountNusd, uint256 availableAmountNusd);
    error InsufficientReserve(uint256 requiredCollateralWei, uint256 availableCollateralWei);
    error OracleHealthy();
    error OracleFailureNotReported();
    error OracleUnavailable();
    error OracleFailureGracePending(uint256 availableAt);
    error SurplusMinterAlreadyBound();
    error InvalidSurplusMinter();
    error OnlySurplusMinter();
    error SurplusBelowTrigger(uint256 reserveValueNusd, uint256 supplyNusd);
    error SurplusMintTooLarge(uint256 reserveValueNusd, uint256 supplyAfterNusd);
    error ERC20InvalidAddress();
    error ERC20InsufficientBalance(address account, uint256 balance, uint256 requiredAmount);
    error ERC20InsufficientAllowance(address owner, address spender, uint256 allowance, uint256 requiredAmount);

    string public constant name = "Nothing USD";
    string public constant symbol = "NUSD";
    uint8 public constant decimals = 18;
    uint256 public constant WAD = 1e18;
    /// @notice How long the oracle must stay unusable before the price-free exit opens.
    uint256 public constant ORACLE_FAILURE_GRACE = 7 days;
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    /// @notice A surplus mint may only start when the reserve is worth at least 3x supply ...
    uint256 public constant SURPLUS_TRIGGER_RATIO = 3;
    /// @notice ... and must leave the reserve worth at least 2x the new supply.
    uint256 public constant SURPLUS_FLOOR_RATIO = 2;

    DIAOracleAdapter public immutable oracle;
    uint256 public immutable supplyCeilingNusd;

    uint256 public totalSupply;
    uint256 public totalCollateralWei;
    bool public mintPaused;
    bool public redeemPaused;
    /// @notice First time anyone observed the oracle failing; zero while it is healthy.
    uint256 public oracleFailureReportedAt;
    /// @notice The only account allowed to call `mintSurplus` (the surplus-mint governor); bound once.
    address public surplusMinter;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event MintedAtOracle(address indexed payer, address indexed recipient, uint256 collateralInWei, uint256 amountNusd);
    event RedeemedAtOracle(
        address indexed account, address indexed recipient, uint256 amountNusd, uint256 collateralOutWei
    );
    event ReserveCovered(address indexed payer, uint256 amountWei, uint256 totalCollateralWei);
    event OracleFailureReported(address indexed reporter, uint256 reportedAt);
    event OracleFailureCleared(address indexed caller);
    event EmergencyRedeemed(
        address indexed account, address indexed recipient, uint256 amountNusd, uint256 collateralOutWei
    );
    event SurplusMinterBound(address indexed minter);
    event SurplusMinted(
        address indexed firstRecipient,
        address indexed secondRecipient,
        uint256 amountNusd,
        uint256 reserveValueNusd,
        uint256 supplyAfterNusd
    );
    event Burned(address indexed account, uint256 amountNusd);
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

    /// @notice Starts the failure clock. Permissionless; only succeeds while the oracle cannot price.
    function reportOracleFailure() external {
        if (_oracleUsable()) revert OracleHealthy();
        if (oracleFailureReportedAt != 0) return;
        // The grace period is measured in wall-clock time by design.
        // forge-lint: disable-next-line(block-timestamp)
        oracleFailureReportedAt = block.timestamp;
        emit OracleFailureReported(msg.sender, block.timestamp);
    }

    /// @notice Stops the failure clock once the oracle prices again. Permissionless.
    function clearOracleFailure() external {
        if (!_oracleUsable()) revert OracleUnavailable();
        if (oracleFailureReportedAt == 0) return;
        oracleFailureReportedAt = 0;
        emit OracleFailureCleared(msg.sender);
    }

    /// @notice Price-free exit for when the oracle has been unusable for ORACLE_FAILURE_GRACE.
    /// @dev Pays each holder their proportional share of the reserve, so the order of
    ///      exits does not matter and no stale price is ever used. It deliberately ignores
    ///      `redeemPaused`: an absent or compromised pauser must not be able to lock holders
    ///      out of collateral once the normal oracle path is gone.
    function emergencyRedeem(uint256 amountNusd, uint256 minCollateralOutWei, address recipient)
        external
        nonReentrant
        returns (uint256 collateralOutWei)
    {
        uint256 reportedAt = oracleFailureReportedAt;
        if (reportedAt == 0) revert OracleFailureNotReported();
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < reportedAt + ORACLE_FAILURE_GRACE) {
            revert OracleFailureGracePending(reportedAt + ORACLE_FAILURE_GRACE);
        }
        if (_oracleUsable()) revert OracleHealthy();
        if (amountNusd == 0) revert InvalidAmount();
        if (recipient == address(0)) revert InvalidRecipient();
        collateralOutWei = MathX.mulDiv(amountNusd, totalCollateralWei, totalSupply);
        if (collateralOutWei == 0) revert InvalidAmount();
        if (collateralOutWei < minCollateralOutWei) {
            revert SlippageExceeded(minCollateralOutWei, collateralOutWei);
        }
        _burn(msg.sender, amountNusd);
        totalCollateralWei -= collateralOutWei;
        SafeTransferLib.safeTransferNative(recipient, collateralOutWei);
        emit EmergencyRedeemed(msg.sender, recipient, amountNusd, collateralOutWei);
    }

    function _oracleUsable() private view returns (bool) {
        try oracle.readPriceWad() returns (uint256 priceWad, uint256, uint80) {
            return priceWad != 0;
        } catch {
            return false;
        }
    }

    function reserveValueNusd() external view returns (uint256 valueNusd) {
        valueNusd = quoteMint(totalCollateralWei);
    }

    /// @notice Burns the caller's NUSD. The collateral stays, so every burn raises the reserve ratio.
    function burn(uint256 amountNusd) external {
        if (amountNusd == 0) revert InvalidAmount();
        _burn(msg.sender, amountNusd);
        emit Burned(msg.sender, amountNusd);
    }

    /// @notice Binds the surplus-mint governor once; it can never be changed afterwards.
    function bindSurplusMinter(address minter) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (surplusMinter != address(0)) revert SurplusMinterAlreadyBound();
        if (minter == address(0) || minter.code.length == 0) revert InvalidSurplusMinter();
        surplusMinter = minter;
        emit SurplusMinterBound(minter);
    }

    /// @notice Largest surplus mint allowed right now and whether the 3x trigger is met.
    /// @dev Reverts while the oracle cannot price, like every other price-dependent path.
    function surplusMintCapacity() public view returns (uint256 amountNusd, bool triggerReached) {
        uint256 reserveValue = quoteMint(totalCollateralWei);
        uint256 supply = totalSupply;
        triggerReached = reserveValue >= supply * SURPLUS_TRIGGER_RATIO;
        uint256 target = reserveValue / SURPLUS_FLOOR_RATIO;
        amountNusd = target > supply ? target - supply : 0;
        uint256 headroom = supplyCeilingNusd - supply;
        if (amountNusd > headroom) amountNusd = headroom;
    }

    /// @notice Mints uncollateralised NUSD against surplus reserve, split between two recipients.
    /// @dev Only the bound governor may call. Both bounds are enforced here with a fresh price,
    ///      independently of the governor: >= 3x before, >= 2x after. One call mints both halves
    ///      so the second recipient is not re-checked against the already enlarged supply.
    function mintSurplus(address firstRecipient, address secondRecipient, uint256 amountNusd)
        external
        nonReentrant
    {
        if (msg.sender != surplusMinter || surplusMinter == address(0)) revert OnlySurplusMinter();
        if (firstRecipient == address(0) || secondRecipient == address(0)) revert InvalidRecipient();
        if (amountNusd == 0) revert InvalidAmount();
        uint256 reserveValue = quoteMint(totalCollateralWei);
        uint256 supply = totalSupply;
        if (reserveValue < supply * SURPLUS_TRIGGER_RATIO) revert SurplusBelowTrigger(reserveValue, supply);
        uint256 supplyAfter = supply + amountNusd;
        if (reserveValue < supplyAfter * SURPLUS_FLOOR_RATIO) revert SurplusMintTooLarge(reserveValue, supplyAfter);
        if (amountNusd > supplyCeilingNusd - supply) {
            revert SupplyCeilingExceeded(amountNusd, supplyCeilingNusd - supply);
        }
        uint256 firstShare = amountNusd / 2;
        _mint(firstRecipient, firstShare);
        _mint(secondRecipient, amountNusd - firstShare);
        emit SurplusMinted(firstRecipient, secondRecipient, amountNusd, reserveValue, supplyAfter);
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
