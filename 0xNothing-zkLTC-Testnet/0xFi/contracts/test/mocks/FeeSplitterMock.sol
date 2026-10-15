// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Mirrors `contracts/src/treasury/FeeSplitter.sol` (a separate Foundry root): NUSD is split
///      70% stakers / 20% burned / 10% treasury and an empty split never reverts; synth vaults
///      activate through the identity fee-pair mapping and pay through `routeMintFee`. The real
///      splitter burns through NUSD; this mock parks the burn share at `BURN_SINK`.
contract FeeSplitterMock {
    address public constant BURN_SINK = address(0xdEaD);

    IERC20 public immutable nusd;
    address public immutable staking;
    address public immutable treasury;

    constructor(address nusd_, address staking_, address treasury_) {
        nusd = IERC20(nusd_);
        staking = staking_;
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
    }

    function _distribute() private returns (uint256 amountNusd) {
        amountNusd = nusd.balanceOf(address(this));
        if (amountNusd == 0) return 0;
        uint256 toStakers = amountNusd * 7_000 / 10_000;
        uint256 toTreasury = amountNusd * 1_000 / 10_000;
        if (toStakers != 0) require(nusd.transfer(staking, toStakers), "STAKERS");
        if (toTreasury != 0) require(nusd.transfer(treasury, toTreasury), "TREASURY");
        require(nusd.transfer(BURN_SINK, amountNusd - toStakers - toTreasury), "BURN");
    }
}
