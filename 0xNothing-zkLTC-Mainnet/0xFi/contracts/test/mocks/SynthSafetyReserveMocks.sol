// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { SynthSafetyReserve } from "../../src/synth/SynthSafetyReserve.sol";

contract MockReserveVault {
    IERC20 public immutable nusd;
    address public immutable safetyReserve;

    constructor(IERC20 nusd_, SynthSafetyReserve reserve_) {
        nusd = nusd_;
        safetyReserve = address(reserve_);
        nusd_.approve(address(reserve_), type(uint256).max);
    }

    function allocate(uint256 amountNusd) external {
        SynthSafetyReserve(safetyReserve).allocateToVault(amountNusd);
    }

    function release(uint256 amountNusd) external {
        SynthSafetyReserve(safetyReserve).releaseFromVault(amountNusd);
    }

    function realizeLoss(uint256 amountNusd, address recipient) external {
        require(nusd.transfer(recipient, amountNusd), "LOSS_TRANSFER_FAILED");
        SynthSafetyReserve(safetyReserve).recordVaultLoss(amountNusd);
    }
}
