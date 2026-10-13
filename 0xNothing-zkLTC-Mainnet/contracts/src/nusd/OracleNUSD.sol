// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MathX} from "../common/MathX.sol";
import {ReentrancyGuard} from "../common/ReentrancyGuard.sol";
import {RoleControl} from "../common/RoleControl.sol";
import {SafeTransferLib} from "../common/SafeTransferLib.sol";
import {DIAOracleAdapter} from "./DIAOracleAdapter.sol";

/// @notice 1:1 DIA-priced NUSD. Optional fees, caps, and same-block guards default off
///         so the accepted H-1 mint/redeem model is unchanged until an admin configures them.
contract OracleNUSD is RoleControl, ReentrancyGuard {
    error InvalidOracleAdapter();
    error InvalidSupplyCeiling();
    error InvalidAmount();
    error InvalidRecipient();
    error InvalidFee();
    error InvalidTreasury();
    error TreasuryNotSet();
    error MintPaused();
    error RedeemPaused();
    error SlippageExceeded(uint256 minimumAmount, uint256 actualAmount);
    error SupplyCeilingExceeded(uint256 requestedAmountNusd, uint256 availableAmountNusd);
    error InsufficientReserve(uint256 requiredCollateralWei, uint256 availableCollateralWei);
    error DailyMintCapExceeded(uint256 requestedAmountNusd, uint256 remainingAmountNusd);
    error DailyRedeemCapExceeded(uint256 requestedAmountNusd, uint256 remainingAmountNusd);
    error PerWalletDailyMintCapExceeded(uint256 requestedAmountNusd, uint256 remainingAmountNusd);
    error PerWalletDailyRedeemCapExceeded(uint256 requestedAmountNusd, uint256 remainingAmountNusd);
    error SameBlockMintRedeem();
    error ERC20InvalidAddress();
    error ERC20InsufficientBalance(address account, uint256 balance, uint256 requiredAmount);
    error ERC20InsufficientAllowance(address owner, address spender, uint256 allowance, uint256 requiredAmount);

    string public constant name = "Nothing USD";
    string public constant symbol = "NUSD";
    uint8 public constant decimals = 18;
    uint256 public constant WAD = 1e18;
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MAX_FEE_BPS = 100;
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    DIAOracleAdapter public immutable oracle;
    uint256 public immutable supplyCeilingNusd;

    uint256 public totalSupply;
    uint256 public totalCollateralWei;
    bool public mintPaused;
    bool public redeemPaused;

    /// @notice Mint fee in bps of the oracle NUSD amount. Default 0; hard-capped at `MAX_FEE_BPS`.
    uint256 public mintFeeBps;
    /// @notice Redeem fee in bps of the oracle native amount. Default 0; hard-capped at `MAX_FEE_BPS`.
    uint256 public redeemFeeBps;
    /// @notice Recipient of mint (NUSD) and redeem (native) protocol fees.
    address public treasury;

    /// @notice Optional admin issuance ceiling. Zero disables it; the immutable constructor ceiling still applies.
    uint256 public issuanceCeilingNusd;

    /// @notice Protocol-wide NUSD minted per UTC day. Zero means unlimited.
    uint256 public dailyMintCapNusd;
    /// @notice Protocol-wide NUSD redeemed per UTC day. Zero means unlimited.
    uint256 public dailyRedeemCapNusd;
    uint256 public dailyMintedNusd;
    uint256 public dailyRedeemedNusd;
    uint256 public mintDayId;
    uint256 public redeemDayId;

    /// @notice Per-wallet NUSD minted per UTC day. Zero means unlimited.
    uint256 public perWalletDailyMintCapNusd;
    /// @notice Per-wallet NUSD redeemed per UTC day. Zero means unlimited.
    uint256 public perWalletDailyRedeemCapNusd;

    /// @notice When true, the same account cannot mint and redeem inside one block.
    bool public sameBlockMintRedeemBlocked;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => uint256) public dailyMintedNusdByWallet;
    mapping(address => uint256) public dailyRedeemedNusdByWallet;
    mapping(address => uint256) public walletMintDayId;
    mapping(address => uint256) public walletRedeemDayId;
    mapping(address => uint256) public lastMintBlock;
    mapping(address => uint256) public lastRedeemBlock;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event MintedAtOracle(address indexed payer, address indexed recipient, uint256 collateralInWei, uint256 amountNusd);
    event RedeemedAtOracle(
        address indexed account, address indexed recipient, uint256 amountNusd, uint256 collateralOutWei
    );
    event ReserveCovered(address indexed payer, uint256 amountWei, uint256 totalCollateralWei);
    event MintPauseUpdated(bool paused);
    event RedeemPauseUpdated(bool paused);
    event MintFeeUpdated(uint256 mintFeeBps);
    event RedeemFeeUpdated(uint256 redeemFeeBps);
    event TreasuryUpdated(address indexed previousTreasury, address indexed treasury);
    event IssuanceCeilingUpdated(uint256 issuanceCeilingNusd);
    event DailyMintCapUpdated(uint256 dailyMintCapNusd);
    event DailyRedeemCapUpdated(uint256 dailyRedeemCapNusd);
    event PerWalletDailyMintCapUpdated(uint256 perWalletDailyMintCapNusd);
    event PerWalletDailyRedeemCapUpdated(uint256 perWalletDailyRedeemCapNusd);
    event SameBlockMintRedeemGuardUpdated(bool blocked);
    event ProtocolFeeCollected(address indexed treasury, uint256 amount, bool indexed mintedNusd);

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
        amountNusd = _netAfterFee(MathX.mulDiv(collateralWei, priceWad, WAD), mintFeeBps);
    }

    function quoteRedeem(uint256 amountNusd) public view returns (uint256 collateralOutWei) {
        (uint256 priceWad,,) = oracle.readPriceWad();
        collateralOutWei = _netAfterFee(MathX.mulDiv(amountNusd, WAD, priceWad), redeemFeeBps);
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
        _enforceSameBlockMint(msg.sender, recipient);

        (uint256 priceWad,,) = oracle.ensureAnchor();
        uint256 grossNusd = MathX.mulDiv(msg.value, priceWad, WAD);
        if (grossNusd == 0) revert InvalidAmount();

        uint256 feeNusd = _feeOn(grossNusd, mintFeeBps);
        amountNusd = grossNusd - feeNusd;
        if (amountNusd == 0) revert InvalidAmount();
        if (amountNusd < minNusdOut) revert SlippageExceeded(minNusdOut, amountNusd);
        if (feeNusd != 0 && treasury == address(0)) revert TreasuryNotSet();

        _checkSupplyCeiling(totalSupply + grossNusd);
        _accountDailyMint(msg.sender, recipient, grossNusd);

        totalCollateralWei += msg.value;
        _mint(recipient, amountNusd);
        if (feeNusd != 0) {
            _mint(treasury, feeNusd);
            emit ProtocolFeeCollected(treasury, feeNusd, true);
        }

        lastMintBlock[msg.sender] = block.number;
        lastMintBlock[recipient] = block.number;

        emit MintedAtOracle(msg.sender, recipient, msg.value, amountNusd);
    }

    function redeemAtOracle(uint256 amountNusd, uint256 minCollateralOutWei, address recipient)
        external
        nonReentrant
        returns (uint256 collateralOutWei)
    {
        if (redeemPaused) revert RedeemPaused();
        if (amountNusd == 0) revert InvalidAmount();
        if (recipient == address(0)) revert InvalidRecipient();
        _enforceSameBlockRedeem(msg.sender);

        (uint256 priceWad,,) = oracle.ensureAnchor();
        uint256 grossCollateralWei = MathX.mulDiv(amountNusd, WAD, priceWad);
        if (grossCollateralWei == 0) revert InvalidAmount();

        uint256 feeWei = _feeOn(grossCollateralWei, redeemFeeBps);
        collateralOutWei = grossCollateralWei - feeWei;
        if (collateralOutWei == 0) revert InvalidAmount();
        if (collateralOutWei < minCollateralOutWei) {
            revert SlippageExceeded(minCollateralOutWei, collateralOutWei);
        }
        if (feeWei != 0 && treasury == address(0)) revert TreasuryNotSet();
        if (grossCollateralWei > totalCollateralWei) {
            revert InsufficientReserve(grossCollateralWei, totalCollateralWei);
        }

        _accountDailyRedeem(msg.sender, amountNusd);

        _burn(msg.sender, amountNusd);
        totalCollateralWei -= grossCollateralWei;
        lastRedeemBlock[msg.sender] = block.number;

        if (feeWei != 0) {
            SafeTransferLib.safeTransferNative(treasury, feeWei);
            emit ProtocolFeeCollected(treasury, feeWei, false);
        }
        SafeTransferLib.safeTransferNative(recipient, collateralOutWei);

        emit RedeemedAtOracle(msg.sender, recipient, amountNusd, collateralOutWei);
    }

    function reserveValueNusd() external view returns (uint256 valueNusd) {
        (uint256 priceWad,,) = oracle.readPriceWad();
        valueNusd = MathX.mulDiv(totalCollateralWei, priceWad, WAD);
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

    function setTreasury(address newTreasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newTreasury == address(this)) revert InvalidTreasury();
        if (newTreasury == address(0) && (mintFeeBps != 0 || redeemFeeBps != 0)) revert InvalidTreasury();
        address previous = treasury;
        treasury = newTreasury;
        emit TreasuryUpdated(previous, newTreasury);
    }

    function setMintFeeBps(uint256 newMintFeeBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newMintFeeBps > MAX_FEE_BPS) revert InvalidFee();
        if (newMintFeeBps != 0 && treasury == address(0)) revert TreasuryNotSet();
        mintFeeBps = newMintFeeBps;
        emit MintFeeUpdated(newMintFeeBps);
    }

    function setRedeemFeeBps(uint256 newRedeemFeeBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newRedeemFeeBps > MAX_FEE_BPS) revert InvalidFee();
        if (newRedeemFeeBps != 0 && treasury == address(0)) revert TreasuryNotSet();
        redeemFeeBps = newRedeemFeeBps;
        emit RedeemFeeUpdated(newRedeemFeeBps);
    }

    function setIssuanceCeilingNusd(uint256 newIssuanceCeilingNusd) external onlyRole(DEFAULT_ADMIN_ROLE) {
        issuanceCeilingNusd = newIssuanceCeilingNusd;
        emit IssuanceCeilingUpdated(newIssuanceCeilingNusd);
    }

    function setDailyMintCapNusd(uint256 newDailyMintCapNusd) external onlyRole(DEFAULT_ADMIN_ROLE) {
        dailyMintCapNusd = newDailyMintCapNusd;
        emit DailyMintCapUpdated(newDailyMintCapNusd);
    }

    function setDailyRedeemCapNusd(uint256 newDailyRedeemCapNusd) external onlyRole(DEFAULT_ADMIN_ROLE) {
        dailyRedeemCapNusd = newDailyRedeemCapNusd;
        emit DailyRedeemCapUpdated(newDailyRedeemCapNusd);
    }

    function setPerWalletDailyMintCapNusd(uint256 newPerWalletDailyMintCapNusd) external onlyRole(DEFAULT_ADMIN_ROLE) {
        perWalletDailyMintCapNusd = newPerWalletDailyMintCapNusd;
        emit PerWalletDailyMintCapUpdated(newPerWalletDailyMintCapNusd);
    }

    function setPerWalletDailyRedeemCapNusd(uint256 newPerWalletDailyRedeemCapNusd)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        perWalletDailyRedeemCapNusd = newPerWalletDailyRedeemCapNusd;
        emit PerWalletDailyRedeemCapUpdated(newPerWalletDailyRedeemCapNusd);
    }

    function setSameBlockMintRedeemBlocked(bool blocked) external onlyRole(DEFAULT_ADMIN_ROLE) {
        sameBlockMintRedeemBlocked = blocked;
        emit SameBlockMintRedeemGuardUpdated(blocked);
    }

    function currentDayId() public view returns (uint256) {
        return block.timestamp / 1 days;
    }

    function remainingDailyMintCapNusd() external view returns (uint256 remaining) {
        remaining = _remainingCap(dailyMintCapNusd, _dayValue(mintDayId, dailyMintedNusd));
    }

    function remainingDailyRedeemCapNusd() external view returns (uint256 remaining) {
        remaining = _remainingCap(dailyRedeemCapNusd, _dayValue(redeemDayId, dailyRedeemedNusd));
    }

    function remainingWalletDailyMintCapNusd(address account) external view returns (uint256 remaining) {
        remaining = _remainingCap(perWalletDailyMintCapNusd, _walletDayValue(account, true));
    }

    function remainingWalletDailyRedeemCapNusd(address account) external view returns (uint256 remaining) {
        remaining = _remainingCap(perWalletDailyRedeemCapNusd, _walletDayValue(account, false));
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

    function _feeOn(uint256 amount, uint256 feeBps) private pure returns (uint256) {
        if (feeBps == 0 || amount == 0) return 0;
        return MathX.mulDiv(amount, feeBps, BPS_DENOMINATOR);
    }

    function _netAfterFee(uint256 amount, uint256 feeBps) private pure returns (uint256) {
        return amount - _feeOn(amount, feeBps);
    }

    function _checkSupplyCeiling(uint256 requestedSupply) private view {
        if (requestedSupply > supplyCeilingNusd) {
            revert SupplyCeilingExceeded(requestedSupply, supplyCeilingNusd - totalSupply);
        }
        if (issuanceCeilingNusd != 0 && requestedSupply > issuanceCeilingNusd) {
            uint256 available = issuanceCeilingNusd > totalSupply ? issuanceCeilingNusd - totalSupply : 0;
            revert SupplyCeilingExceeded(requestedSupply, available);
        }
    }

    function _accountDailyMint(address payer, address recipient, uint256 grossNusd) private {
        uint256 day = currentDayId();
        if (mintDayId != day) {
            mintDayId = day;
            dailyMintedNusd = 0;
        }
        dailyMintedNusd += grossNusd;
        if (dailyMintCapNusd != 0 && dailyMintedNusd > dailyMintCapNusd) {
            revert DailyMintCapExceeded(grossNusd, dailyMintCapNusd - (dailyMintedNusd - grossNusd));
        }

        _bumpWalletMint(payer, day, grossNusd);
        if (recipient != payer) _bumpWalletMint(recipient, day, grossNusd);
    }

    function _accountDailyRedeem(address account, uint256 amountNusd) private {
        uint256 day = currentDayId();
        if (redeemDayId != day) {
            redeemDayId = day;
            dailyRedeemedNusd = 0;
        }
        dailyRedeemedNusd += amountNusd;
        if (dailyRedeemCapNusd != 0 && dailyRedeemedNusd > dailyRedeemCapNusd) {
            revert DailyRedeemCapExceeded(amountNusd, dailyRedeemCapNusd - (dailyRedeemedNusd - amountNusd));
        }

        if (walletRedeemDayId[account] != day) {
            walletRedeemDayId[account] = day;
            dailyRedeemedNusdByWallet[account] = 0;
        }
        dailyRedeemedNusdByWallet[account] += amountNusd;
        uint256 walletCap = perWalletDailyRedeemCapNusd;
        if (walletCap != 0 && dailyRedeemedNusdByWallet[account] > walletCap) {
            revert PerWalletDailyRedeemCapExceeded(amountNusd, walletCap - (dailyRedeemedNusdByWallet[account] - amountNusd));
        }
    }

    function _bumpWalletMint(address account, uint256 day, uint256 grossNusd) private {
        if (walletMintDayId[account] != day) {
            walletMintDayId[account] = day;
            dailyMintedNusdByWallet[account] = 0;
        }
        dailyMintedNusdByWallet[account] += grossNusd;
        uint256 walletCap = perWalletDailyMintCapNusd;
        if (walletCap != 0 && dailyMintedNusdByWallet[account] > walletCap) {
            revert PerWalletDailyMintCapExceeded(grossNusd, walletCap - (dailyMintedNusdByWallet[account] - grossNusd));
        }
    }

    function _enforceSameBlockMint(address payer, address recipient) private view {
        if (!sameBlockMintRedeemBlocked) return;
        if (lastRedeemBlock[payer] == block.number || lastRedeemBlock[recipient] == block.number) {
            revert SameBlockMintRedeem();
        }
    }

    function _enforceSameBlockRedeem(address account) private view {
        if (!sameBlockMintRedeemBlocked) return;
        if (lastMintBlock[account] == block.number) revert SameBlockMintRedeem();
    }

    function _remainingCap(uint256 cap, uint256 used) private pure returns (uint256 remaining) {
        if (cap == 0) return type(uint256).max;
        return used >= cap ? 0 : cap - used;
    }

    function _dayValue(uint256 storedDayId, uint256 storedValue) private view returns (uint256) {
        return storedDayId == currentDayId() ? storedValue : 0;
    }

    function _walletDayValue(address account, bool mintSide) private view returns (uint256) {
        if (mintSide) {
            return walletMintDayId[account] == currentDayId() ? dailyMintedNusdByWallet[account] : 0;
        }
        return walletRedeemDayId[account] == currentDayId() ? dailyRedeemedNusdByWallet[account] : 0;
    }
}
