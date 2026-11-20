// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Mirrors `contracts/src/treasury/FeeSplitter.sol` (a separate Foundry root): N is split
///      70% stakers / 20% burned / 10% treasury and an empty split never reverts; synth vaults
///      activate through the identity fee-pair mapping and pay through `routeMintFee`. The real
///      splitter burns through N; this mock parks the burn share at `BURN_SINK`.
contract FeeSplitterMock {
    address public constant BURN_SINK = address(0xdEaD);

    IERC20 public immutable n;
    address public immutable staking;
    address public immutable treasury;

    constructor(address n_, address staking_, address treasury_) {
        n = IERC20(n_);
        staking = staking_;
        treasury = treasury_;
    }

    function mintFeePairForVault(address vault) external pure returns (address) {
        return vault;
    }

    function mintFeeVaultForPair(address pair) external pure returns (address) {
        return pair;
    }

    function routeMintFee(uint256 amountN) external returns (uint256) {
        if (amountN != 0) require(n.transferFrom(msg.sender, address(this), amountN), "PULL");
        return _distribute();
    }

    function distribute() external returns (uint256 amountN) {
        amountN = _distribute();
    }

    function _distribute() private returns (uint256 amountN) {
        amountN = n.balanceOf(address(this));
        if (amountN == 0) return 0;
        uint256 toStakers = amountN * 7_000 / 10_000;
        uint256 toTreasury = amountN * 1_000 / 10_000;
        if (toStakers != 0) require(n.transfer(staking, toStakers), "STAKERS");
        if (toTreasury != 0) require(n.transfer(treasury, toTreasury), "TREASURY");
        require(n.transfer(BURN_SINK, amountN - toStakers - toTreasury), "BURN");
    }
}
