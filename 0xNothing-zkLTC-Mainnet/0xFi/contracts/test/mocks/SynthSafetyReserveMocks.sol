// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { SynthSafetyReserve } from "../../src/synth/SynthSafetyReserve.sol";

contract MockReserveVault {
    IERC20 public immutable n;
    address public immutable safetyReserve;

    constructor(IERC20 n_, SynthSafetyReserve reserve_) {
        n = n_;
        safetyReserve = address(reserve_);
        n_.approve(address(reserve_), type(uint256).max);
    }

    function allocate(uint256 amountN) external {
        SynthSafetyReserve(safetyReserve).allocateToVault(amountN);
    }

    function release(uint256 amountN) external {
        SynthSafetyReserve(safetyReserve).releaseFromVault(amountN);
    }

    function realizeLoss(uint256 amountN, address recipient) external {
        require(n.transfer(recipient, amountN), "LOSS_TRANSFER_FAILED");
        SynthSafetyReserve(safetyReserve).recordVaultLoss(amountN);
    }
}
