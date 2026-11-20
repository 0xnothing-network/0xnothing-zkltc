// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MathX} from "../common/MathX.sol";
import {ReentrancyGuard} from "../common/ReentrancyGuard.sol";
import {IERC20Minimal, SafeTransferLib} from "../common/SafeTransferLib.sol";
import {TwoStepAdmin} from "../common/TwoStepAdmin.sol";

interface IFeeN is IERC20Minimal {
    function burn(uint256 amountN) external;
    function coverReserve() external payable;
    function releaseSurplus() external returns (uint256 amountN);
}

interface IFeeWrappedNative is IERC20Minimal {
    function withdraw(uint256 amount) external;
}

/// @title Fee splitter
/// @notice The one address every protocol fee is paid to, forever. What happens behind it is a
///         policy the admin (the owner wallet) can change, within bounds, without redeploying any
///         fee source:
///         - N: stakers / burn (raises N backing) / treasury, default 70 / 20 / 10.
///         - zkLTC (wrapped or native): N reserve / treasury, default 90 / 10.
///         `harvest()` pulls the accrued fees out of every registered source first. Anyone may call
///         it; the staking contract does on every stake and claim.
contract FeeSplitter is TwoStepAdmin, ReentrancyGuard {
    error InvalidConfiguration();
    error InvalidSplit();
    error InvalidSource();

    uint256 public constant BPS = 10_000;
    /// @notice The treasury share of either asset can never exceed 20%.
    uint256 public constant MAX_TREASURY_BPS = 2_000;
    uint256 public constant MAX_SOURCES = 8;
    /// @notice Gas forwarded to each source during a harvest, so one broken source cannot starve it.
    ///         A source's return data is never copied, so its size costs the harvest nothing.
    uint256 public constant SOURCE_GAS = 600_000;

    struct Source {
        address target;
        bytes data;
    }

    IFeeN public immutable n;
    IFeeWrappedNative public immutable wrappedNative;

    address public staking;
    address public treasury;
    uint256 public stakerBps = 7_000;
    uint256 public burnBps = 2_000;
    uint256 public treasuryBps = 1_000;
    uint256 public reserveBps = 9_000;
    uint256 public nativeTreasuryBps = 1_000;

    Source[] private _sources;
    bool private _harvesting;

    event Distributed(
        uint256 toStakersN, uint256 burnedN, uint256 toTreasuryN, uint256 toReserveWei, uint256 toTreasuryWei
    );
    event Harvested(address indexed caller, uint256 sourcesSucceeded);
    event FeeReceived(address indexed from, uint256 amountN);
    event RecipientsUpdated(address indexed staking, address indexed treasury);
    event NSplitUpdated(uint256 stakerBps, uint256 burnBps, uint256 treasuryBps);
    event NativeSplitUpdated(uint256 reserveBps, uint256 treasuryBps);
    event SourcesUpdated(uint256 count);

    constructor(address nAddress, address wrappedNativeAddress, address treasuryAddress, address initialAdmin)
        TwoStepAdmin(initialAdmin)
    {
        if (nAddress.code.length == 0 || wrappedNativeAddress.code.length == 0 || treasuryAddress == address(0)) {
            revert InvalidConfiguration();
        }
        n = IFeeN(nAddress);
        wrappedNative = IFeeWrappedNative(wrappedNativeAddress);
        treasury = treasuryAddress;
    }

    /// @notice Native zkLTC from unwrapping fees, or sent directly as a fee.
    receive() external payable {}

    // ---------------------------------------------------------------- flows

    /// @notice Pulls the accrued fees out of every registered source, releases any N surplus,
    ///         then splits what this contract holds. Sources that fail are skipped.
    function harvest() external returns (uint256 sourcesSucceeded) {
        // A source calls back into `distribute`; a source calling `harvest` again is a no-op.
        if (_harvesting) return 0;
        _harvesting = true;
        uint256 count = _sources.length;
        for (uint256 index; index < count; ++index) {
            Source storage source = _sources[index];
            address target = source.target;
            bytes memory data = source.data;
            uint256 gasCap = SOURCE_GAS;
            bool ok;
            // The answer is not read, so it is not copied either: a source's return data must
            // not be able to price the harvest out of the gas a staker's call forwards.
            assembly ("memory-safe") {
                ok := call(gasCap, target, 0, add(data, 0x20), mload(data), 0, 0)
            }
            if (ok) ++sourcesSucceeded;
        }
        // Mints straight to the staking pool and the treasury when the reserve allows it.
        try n.releaseSurplus{gas: SOURCE_GAS}() {} catch {}
        _harvesting = false;
        _distribute();
        emit Harvested(msg.sender, sourcesSucceeded);
    }

    /// @notice Splits the N and zkLTC this contract holds. Never reverts for an empty balance:
    ///         fee sources call it right after paying in.
    function distribute() external nonReentrant returns (uint256 amountN) {
        amountN = _distribute();
    }

    /// @notice Synth vault mint fees: pulled from the vault, then split like any other N fee.
    function routeMintFee(uint256 amountN) external nonReentrant returns (uint256 amountFlushedN) {
        if (amountN != 0) {
            SafeTransferLib.safeTransferFrom(address(n), msg.sender, address(this), amountN);
            emit FeeReceived(msg.sender, amountN);
        }
        amountFlushedN = _distribute();
    }

    /// @dev Synth vaults bind to a fee distributor through this pair of lookups.
    function mintFeePairForVault(address vault) external pure returns (address) {
        return vault;
    }

    function mintFeeVaultForPair(address pair) external pure returns (address) {
        return pair;
    }

    // ---------------------------------------------------------------- admin

    function setRecipients(address newStaking, address newTreasury) external onlyAdmin {
        if (newStaking.code.length == 0 || newTreasury == address(0) || newStaking == newTreasury) {
            revert InvalidConfiguration();
        }
        staking = newStaking;
        treasury = newTreasury;
        emit RecipientsUpdated(newStaking, newTreasury);
    }

    function setNSplit(uint256 newStakerBps, uint256 newBurnBps, uint256 newTreasuryBps) external onlyAdmin {
        if (newStakerBps + newBurnBps + newTreasuryBps != BPS || newTreasuryBps > MAX_TREASURY_BPS) revert InvalidSplit();
        stakerBps = newStakerBps;
        burnBps = newBurnBps;
        treasuryBps = newTreasuryBps;
        emit NSplitUpdated(newStakerBps, newBurnBps, newTreasuryBps);
    }

    function setNativeSplit(uint256 newReserveBps, uint256 newTreasuryBps) external onlyAdmin {
        if (newReserveBps + newTreasuryBps != BPS || newTreasuryBps > MAX_TREASURY_BPS) revert InvalidSplit();
        reserveBps = newReserveBps;
        nativeTreasuryBps = newTreasuryBps;
        emit NativeSplitUpdated(newReserveBps, newTreasuryBps);
    }

    /// @notice Replaces the harvest list. A source may never target an asset or a recipient of
    ///         this contract, so no source call can move the fees held here.
    function setSources(Source[] calldata newSources) external onlyAdmin {
        if (newSources.length > MAX_SOURCES) revert InvalidSource();
        delete _sources;
        for (uint256 index; index < newSources.length; ++index) {
            address target = newSources[index].target;
            if (
                target.code.length == 0 || target == address(n) || target == address(wrappedNative)
                    || target == staking || target == treasury || target == address(this)
                    || newSources[index].data.length < 4
            ) revert InvalidSource();
            _sources.push(newSources[index]);
        }
        emit SourcesUpdated(newSources.length);
    }

    // ---------------------------------------------------------------- views

    function sourceCount() external view returns (uint256) {
        return _sources.length;
    }

    function sourceAt(uint256 index) external view returns (address target, bytes memory data) {
        Source storage source = _sources[index];
        return (source.target, source.data);
    }

    // ---------------------------------------------------------------- internals

    /// @return amountN N sent to stakers and treasury or burned.
    function _distribute() private returns (uint256 amountN) {
        uint256 toStakers;
        uint256 toBurn;
        uint256 toTreasury;
        uint256 balance = n.balanceOf(address(this));
        // Until the staking pool is bound there is nowhere to send the staker share; it waits here.
        if (balance != 0 && staking != address(0)) {
            toStakers = MathX.mulDiv(balance, stakerBps, BPS);
            toTreasury = MathX.mulDiv(balance, treasuryBps, BPS);
            toBurn = balance - toStakers - toTreasury;
            if (toStakers != 0) SafeTransferLib.safeTransfer(address(n), staking, toStakers);
            if (toTreasury != 0) SafeTransferLib.safeTransfer(address(n), treasury, toTreasury);
            if (toBurn != 0) n.burn(toBurn);
        }

        uint256 wrapped = wrappedNative.balanceOf(address(this));
        if (wrapped != 0) wrappedNative.withdraw(wrapped);
        uint256 native = address(this).balance;
        uint256 toReserve;
        uint256 toTreasuryWei;
        if (native != 0) {
            toTreasuryWei = MathX.mulDiv(native, nativeTreasuryBps, BPS);
            toReserve = native - toTreasuryWei;
            if (toReserve != 0) n.coverReserve{value: toReserve}();
            if (toTreasuryWei != 0) SafeTransferLib.safeTransferNative(treasury, toTreasuryWei);
        }

        amountN = toStakers + toBurn + toTreasury;
        if (amountN != 0 || native != 0) {
            emit Distributed(toStakers, toBurn, toTreasury, toReserve, toTreasuryWei);
        }
    }
}
