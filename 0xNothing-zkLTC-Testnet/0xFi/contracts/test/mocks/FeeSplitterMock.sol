// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Mirrors `contracts/src/treasury/FeeSplitter.sol` (a separate Foundry root): NUSD is split
///      half to the pool and the rest to the treasury; synth vaults activate through the identity
///      fee-pair mapping and pay through `routeMintFee`.
contract FeeSplitterMock {
    IERC20 public immutable nusd;
    address public immutable rewardPool;
    address public immutable treasury;

    constructor(address nusd_, address rewardPool_, address treasury_) {
        nusd = IERC20(nusd_);
        rewardPool = rewardPool_;
        treasury = treasury_;
    }

    function mintFeePairForVault(address vault) external pure returns (address) {
        return vault;
    }

    function mintFeeVaultForPair(address pair) external pure returns (address) {
        return pair;
    }

    function routeMintFee(uint256 amountNusd) external returns (uint256) {
        if (amountNusd != 0) require(nusd.transferFrom(msg.sender, address(this), amountNusd), "PULL");
        return _distribute();
    }

    function distribute() external returns (uint256 amountNusd) {
        amountNusd = _distribute();
        require(amountNusd != 0, "NOTHING");
    }

    function _distribute() private returns (uint256 amountNusd) {
        amountNusd = nusd.balanceOf(address(this));
        if (amountNusd == 0) return 0;
        uint256 toPool = amountNusd / 2;
        if (toPool != 0) require(nusd.transfer(rewardPool, toPool), "POOL");
        require(nusd.transfer(treasury, amountNusd - toPool), "TREASURY");
    }
}
