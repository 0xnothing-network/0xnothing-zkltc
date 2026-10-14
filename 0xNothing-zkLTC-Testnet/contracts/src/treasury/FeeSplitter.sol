// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title Protocol revenue splitter
/// @notice Every protocol fee lands here. NUSD is split 50/50 between the staker reward pool
///         and the owner treasury; any other asset (WzkLTC, native zkLTC, anything sent by
///         mistake) goes entirely to the treasury, because the reward pool only pays NUSD.
///         Distribution is permissionless and the destinations are immutable: no admin.
contract FeeSplitter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    error InvalidConfiguration();
    error NothingToDistribute();
    error NativeTransferFailed();

    IERC20 public immutable nusd;
    address public immutable rewardPool;
    address public immutable treasury;

    event FeeReceived(address indexed from, uint256 amountNusd);
    event NusdDistributed(address indexed caller, uint256 toRewardPool, uint256 toTreasury);
    event TokenSwept(address indexed caller, address indexed token, uint256 amount);
    event NativeSwept(address indexed caller, uint256 amount);

    constructor(IERC20 nusdToken, address rewardPoolAddress, address treasuryAddress) {
        if (
            address(nusdToken).code.length == 0 || rewardPoolAddress == address(0) || treasuryAddress == address(0)
                || rewardPoolAddress == treasuryAddress
        ) revert InvalidConfiguration();
        nusd = nusdToken;
        rewardPool = rewardPoolAddress;
        treasury = treasuryAddress;
    }

    receive() external payable {}

    /// @notice Synth mint-fee hook: pulls the fee from the calling vault, then splits it.
    /// @dev Matches the `ISynthMintFeeDistributor.routeMintFee` call the synth vaults make after approving.
    function routeMintFee(uint256 amountNusd) external nonReentrant returns (uint256 amountFlushedNusd) {
        if (amountNusd != 0) {
            nusd.safeTransferFrom(msg.sender, address(this), amountNusd);
            emit FeeReceived(msg.sender, amountNusd);
        }
        amountFlushedNusd = _distribute();
    }

    /// @notice Synth-vault activation check. v2 has no fee gauges: each vault routes its own mint fee
    ///         here, so the "fee pair" of a vault is the vault itself (identity mapping).
    function mintFeePairForVault(address vault) external pure returns (address) {
        return vault;
    }

    /// @notice Inverse of `mintFeePairForVault`.
    function mintFeeVaultForPair(address pair) external pure returns (address) {
        return pair;
    }

    /// @notice Splits the whole NUSD balance: half (rounded down) to the pool, the rest to the treasury.
    function distribute() external nonReentrant returns (uint256 amountNusd) {
        amountNusd = _distribute();
        if (amountNusd == 0) revert NothingToDistribute();
    }

    /// @notice Sends any non-NUSD token balance to the treasury.
    function sweep(IERC20 token) external nonReentrant returns (uint256 amount) {
        if (address(token) == address(nusd)) revert InvalidConfiguration();
        amount = token.balanceOf(address(this));
        if (amount == 0) revert NothingToDistribute();
        token.safeTransfer(treasury, amount);
        emit TokenSwept(msg.sender, address(token), amount);
    }

    /// @notice Sends the native zkLTC balance to the treasury.
    function sweepNative() external nonReentrant returns (uint256 amount) {
        amount = address(this).balance;
        if (amount == 0) revert NothingToDistribute();
        (bool ok,) = treasury.call{ value: amount }("");
        if (!ok) revert NativeTransferFailed();
        emit NativeSwept(msg.sender, amount);
    }

    function _distribute() private returns (uint256 amountNusd) {
        amountNusd = nusd.balanceOf(address(this));
        if (amountNusd == 0) return 0;
        uint256 toPool = amountNusd / 2;
        uint256 toTreasury = amountNusd - toPool;
        if (toPool != 0) nusd.safeTransfer(rewardPool, toPool);
        nusd.safeTransfer(treasury, toTreasury);
        emit NusdDistributed(msg.sender, toPool, toTreasury);
    }
}
