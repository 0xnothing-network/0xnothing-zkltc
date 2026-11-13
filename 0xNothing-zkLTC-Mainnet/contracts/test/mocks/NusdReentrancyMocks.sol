// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IReenterNusd {
    function mintAtOracle(uint256 minNusdOut, address recipient) external payable returns (uint256);
    function redeemAtOracle(uint256 amountNusd, uint256 minCollateralOutWei, address recipient)
        external
        returns (uint256);
    function emergencyRedeem(uint256 amountNusd, uint256 minCollateralOutWei, address recipient)
        external
        returns (uint256);
    function releaseSurplus() external returns (uint256);
    function balanceOf(address account) external view returns (uint256);
}

/// Receives a redemption payout and tries every guarded entry point from inside the callback.
contract ReenteringRecipient {
    IReenterNusd public immutable nusd;
    uint256 public attempts;
    uint256 public succeeded;

    constructor(address nusd_) {
        nusd = IReenterNusd(nusd_);
    }

    function redeem(uint256 amount) external returns (uint256) {
        return nusd.redeemAtOracle(amount, 0, address(this));
    }

    receive() external payable {
        attempts += 4;
        try nusd.releaseSurplus() {
            ++succeeded;
        } catch {}
        try nusd.mintAtOracle{value: msg.value}(0, address(this)) {
            ++succeeded;
        } catch {}
        uint256 balance = nusd.balanceOf(address(this));
        if (balance != 0) {
            try nusd.redeemAtOracle(balance, 0, address(this)) {
                ++succeeded;
            } catch {}
            try nusd.emergencyRedeem(balance, 0, address(this)) {
                ++succeeded;
            } catch {}
        }
    }
}
