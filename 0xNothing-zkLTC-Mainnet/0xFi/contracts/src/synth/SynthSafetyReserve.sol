// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { EmergencyGuardian } from "../access/EmergencyGuardian.sol";

interface ISyntheticVaultReserveTarget {
    function n() external view returns (address);
    function safetyReserve() external view returns (address);
}

/// @notice Irrevocable protocol-owned N backstop shared by exactly two synthetic vaults.
/// @dev Funds have no depositor claims and there is deliberately no sweep or withdrawal function.
contract SynthSafetyReserve is EmergencyGuardian, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error InvalidConfiguration();
    error InvalidAmount();
    error ExactTransferRequired();
    error VaultsAlreadyBound();
    error UnauthorizedVault();
    error AllocationsPaused();
    error SponsorshipInactive();
    error InsufficientFreeReserve();
    error AllocationExceeded();

    uint256 public constant ENTRY_TVL_N = 100_000 ether;
    uint256 public constant EXIT_TVL_N = 90_000 ether;
    uint256 public constant ACTIVATION_DELAY = 24 hours;

    IERC20 public immutable n;

    address public vault0;
    address public vault1;
    bool public vaultsBound;
    bool public allocationsPaused;
    uint256 public eligibleSince;
    uint256 public totalAllocatedN;

    bool private _sponsorshipActivated;
    mapping(address => bool) public isVault;
    mapping(address => uint256) public allocatedNByVault;

    event ReserveFunded(address indexed payer, uint256 amountN, uint256 totalReserveN);
    event VaultsBound(address indexed vault0, address indexed vault1);
    event ReserveAllocated(address indexed vault, uint256 amountN, uint256 vaultAllocationN);
    event ReserveReleased(address indexed vault, uint256 amountN, uint256 vaultAllocationN);
    event ReserveLossRecorded(address indexed vault, uint256 amountN, uint256 vaultAllocationN);
    event SponsorshipModeUpdated(bool active, uint256 totalReserveN);
    event SponsorshipEligibilityStarted(uint256 eligibleSince);
    event AllocationsPauseUpdated(bool paused);

    constructor(address nAddress, address initialOwner) EmergencyGuardian(initialOwner) {
        if (nAddress == address(0) || nAddress.code.length == 0) revert InvalidConfiguration();
        n = IERC20(nAddress);
    }

    /// @notice Permanently binds the only two vaults that may use this reserve.
    function bindVaults(address firstVault, address secondVault) external onlyOwner {
        if (vaultsBound) revert VaultsAlreadyBound();
        if (
            firstVault == address(0) || secondVault == address(0) || firstVault == secondVault
                || firstVault.code.length == 0 || secondVault.code.length == 0 || !_validVault(firstVault)
                || !_validVault(secondVault)
        ) revert InvalidConfiguration();

        vaultsBound = true;
        vault0 = firstVault;
        vault1 = secondVault;
        isVault[firstVault] = true;
        isVault[secondVault] = true;
        emit VaultsBound(firstVault, secondVault);
    }

    /// @notice Adds irreversible protocol reserve capital. The payer receives no shares or withdrawal claim.
    function fund(uint256 amountN) external nonReentrant {
        if (amountN == 0) revert InvalidAmount();
        _pullExact(n, msg.sender, amountN);
        _syncSponsorshipMode();
        emit ReserveFunded(msg.sender, amountN, totalReserveN());
    }

    /// @notice Advances entry-delay and hysteresis state using current onchain backing.
    function syncSponsorshipMode() external returns (bool active) {
        _syncSponsorshipMode();
        return sponsorshipActive();
    }

    function setAllocationsPaused(bool paused) external onlyOwner {
        allocationsPaused = paused;
        emit AllocationsPauseUpdated(paused);
    }

    function pauseAllocations() external onlyOwnerOrGuardian {
        allocationsPaused = true;
        emit AllocationsPauseUpdated(true);
    }

    /// @dev Called only by a bound vault. Transfers newly assigned reserve collateral to that vault.
    function allocateToVault(uint256 amountN) external nonReentrant {
        _requireVault();
        if (amountN == 0) revert InvalidAmount();
        _syncSponsorshipMode();
        if (allocationsPaused) revert AllocationsPaused();
        if (!sponsorshipActive()) revert SponsorshipInactive();
        if (amountN > freeReserveN()) revert InsufficientFreeReserve();

        allocatedNByVault[msg.sender] += amountN;
        totalAllocatedN += amountN;
        _pushExact(n, msg.sender, amountN);
        emit ReserveAllocated(msg.sender, amountN, allocatedNByVault[msg.sender]);
    }

    /// @dev Pulls reserve-owned collateral back from a bound vault. Releases remain available while paused.
    function releaseFromVault(uint256 amountN) external nonReentrant {
        _requireVault();
        if (amountN == 0) revert InvalidAmount();
        uint256 allocated = allocatedNByVault[msg.sender];
        if (amountN > allocated) revert AllocationExceeded();

        allocatedNByVault[msg.sender] = allocated - amountN;
        totalAllocatedN -= amountN;
        _pullExact(n, msg.sender, amountN);
        _syncSponsorshipMode();
        emit ReserveReleased(msg.sender, amountN, allocatedNByVault[msg.sender]);
    }

    /// @dev Accounts reserve collateral transferred to a liquidator rather than returned to this contract.
    function recordVaultLoss(uint256 amountN) external nonReentrant {
        _requireVault();
        if (amountN == 0) revert InvalidAmount();
        uint256 allocated = allocatedNByVault[msg.sender];
        if (amountN > allocated) revert AllocationExceeded();

        allocatedNByVault[msg.sender] = allocated - amountN;
        totalAllocatedN -= amountN;
        _syncSponsorshipMode();
        emit ReserveLossRecorded(msg.sender, amountN, allocatedNByVault[msg.sender]);
    }

    function totalReserveN() public view returns (uint256) {
        return freeReserveN() + totalAllocatedN;
    }

    function freeReserveN() public view returns (uint256) {
        return n.balanceOf(address(this));
    }

    function authorizedVault(address vault) external view returns (bool) {
        return isVault[vault];
    }

    /// @notice Effective mode fails closed immediately if N loses full reserve backing.
    function sponsorshipActive() public view returns (bool) {
        uint256 reserveN = totalReserveN();
        bool backingHealthy = nBackingHealthy();
        if (_sponsorshipActivated) return reserveN >= EXIT_TVL_N && backingHealthy;
        return eligibleSince != 0 && block.timestamp >= eligibleSince + ACTIVATION_DELAY
            && reserveN >= ENTRY_TVL_N && backingHealthy;
    }

    function nBackingHealthy() public view returns (bool) {
        (bool supplyOk, bytes memory supplyData) = address(n).staticcall(abi.encodeWithSignature("totalSupply()"));
        (bool reserveOk, bytes memory reserveData) =
            address(n).staticcall(abi.encodeWithSignature("reserveValueN()"));
        if (!supplyOk || !reserveOk || supplyData.length < 32 || reserveData.length < 32) return false;
        return abi.decode(reserveData, (uint256)) >= abi.decode(supplyData, (uint256));
    }

    function _syncSponsorshipMode() internal {
        uint256 reserveN = totalReserveN();
        bool backingHealthy = nBackingHealthy();

        if (_sponsorshipActivated) {
            if (reserveN < EXIT_TVL_N || !backingHealthy) {
                _sponsorshipActivated = false;
                eligibleSince = 0;
                emit SponsorshipModeUpdated(false, reserveN);
            }
            return;
        }

        if (reserveN < ENTRY_TVL_N || !backingHealthy) {
            eligibleSince = 0;
            return;
        }

        if (eligibleSince == 0) {
            eligibleSince = block.timestamp;
            emit SponsorshipEligibilityStarted(block.timestamp);
            return;
        }

        if (block.timestamp >= eligibleSince + ACTIVATION_DELAY) {
            _sponsorshipActivated = true;
            eligibleSince = 0;
            emit SponsorshipModeUpdated(true, reserveN);
        }
    }

    function _validVault(address vault) internal view returns (bool) {
        try ISyntheticVaultReserveTarget(vault).n() returns (address vaultN) {
            if (vaultN != address(n)) return false;
        } catch {
            return false;
        }
        try ISyntheticVaultReserveTarget(vault).safetyReserve() returns (address vaultReserve) {
            return vaultReserve == address(this);
        } catch {
            return false;
        }
    }

    function _requireVault() internal view {
        if (!isVault[msg.sender]) revert UnauthorizedVault();
    }

    function _pullExact(IERC20 token, address payer, uint256 amount) internal {
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(payer, address(this), amount);
        uint256 afterBalance = token.balanceOf(address(this));
        if (afterBalance < beforeBalance || afterBalance - beforeBalance != amount) revert ExactTransferRequired();
    }

    function _pushExact(IERC20 token, address recipient, uint256 amount) internal {
        uint256 senderBefore = token.balanceOf(address(this));
        uint256 recipientBefore = token.balanceOf(recipient);
        token.safeTransfer(recipient, amount);
        uint256 senderAfter = token.balanceOf(address(this));
        uint256 recipientAfter = token.balanceOf(recipient);
        if (
            senderBefore < senderAfter || senderBefore - senderAfter != amount || recipientAfter < recipientBefore
                || recipientAfter - recipientBefore != amount
        ) revert ExactTransferRequired();
    }
}
