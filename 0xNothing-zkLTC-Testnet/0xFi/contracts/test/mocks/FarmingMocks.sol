// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { GaugeFactory } from "../../src/farming/GaugeFactory.sol";
import { SyntheticAsset } from "../../src/synth/SyntheticAsset.sol";

contract MockSynthMintFeeVault {
    using SafeERC20 for IERC20;

    IERC20 public immutable nusd;
    SyntheticAsset public immutable syntheticAsset;
    GaugeFactory public immutable mintFeeDistributor;

    constructor(address nusdAddress, SyntheticAsset syntheticAsset_, GaugeFactory mintFeeDistributor_) {
        nusd = IERC20(nusdAddress);
        syntheticAsset = syntheticAsset_;
        mintFeeDistributor = mintFeeDistributor_;
    }

    function mintSynthetic(address recipient, uint256 amount) external {
        syntheticAsset.mint(recipient, amount);
    }

    function routeMintFee(uint256 amountNusd) external returns (uint256 amountFlushedNusd) {
        nusd.forceApprove(address(mintFeeDistributor), amountNusd);
        amountFlushedNusd = mintFeeDistributor.routeMintFee(amountNusd);
        nusd.forceApprove(address(mintFeeDistributor), 0);
    }
}
