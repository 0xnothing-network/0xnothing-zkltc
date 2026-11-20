// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IReenterN {
    function mintAtOracle(uint256 minNOut, address recipient) external payable returns (uint256);
    function redeemAtOracle(uint256 amountN, uint256 minCollateralOutWei, address recipient)
        external
        returns (uint256);
    function emergencyRedeem(uint256 amountN, uint256 minCollateralOutWei, address recipient)
        external
        returns (uint256);
    function releaseSurplus() external returns (uint256);
    function balanceOf(address account) external view returns (uint256);
}

/// Receives a redemption payout and tries every guarded entry point from inside the callback.
contract ReenteringRecipient {
    IReenterN public immutable n;
    uint256 public attempts;
    uint256 public succeeded;

    constructor(address n_) {
        n = IReenterN(n_);
    }

    function redeem(uint256 amount) external returns (uint256) {
        return n.redeemAtOracle(amount, 0, address(this));
    }

    receive() external payable {
        attempts += 4;
        try n.releaseSurplus() {
            ++succeeded;
        } catch {}
        try n.mintAtOracle{value: msg.value}(0, address(this)) {
            ++succeeded;
        } catch {}
        uint256 balance = n.balanceOf(address(this));
        if (balance != 0) {
            try n.redeemAtOracle(balance, 0, address(this)) {
                ++succeeded;
            } catch {}
            try n.emergencyRedeem(balance, 0, address(this)) {
                ++succeeded;
            } catch {}
        }
    }
}
