// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { ZeroXFiRouterV2 } from "../../../src/amm/ZeroXFiRouterV2.sol";

/// @dev Cheatcodes the audit tests need on top of the hand-written `Vm` in test/helpers/TestBase.sol.
interface AuditVm {
    function snapshotState() external returns (uint256 snapshotId);
    function revertToState(uint256 snapshotId) external returns (bool success);
}

/// @dev NUSD stand-in whose `reserveValueNusd()` can revert, the way the real NUSD does when the
///      LTC oracle it reads is stale or out of bounds.
contract AuditOracleGatedNUSD is ERC20 {
    bool public reserveReadReverts;

    constructor() ERC20("Nothing USD", "NUSD") { }

    function mint(address recipient, uint256 amount) external {
        _mint(recipient, amount);
    }

    function setReserveReadReverts(bool shouldRevert) external {
        reserveReadReverts = shouldRevert;
    }

    /// @dev Fully backed whenever the oracle read works.
    function reserveValueNusd() external view returns (uint256) {
        require(!reserveReadReverts, "STALE_LTC_PRICE");
        return type(uint256).max;
    }
}

/// @dev Any integrator can do this: TOKEN -> base and base -> TOKEN as two direct router swaps in
///      one transaction, instead of one three-token path.
contract AuditSplitRouteWrapper {
    function splitSwap(
        ZeroXFiRouterV2 router,
        address tokenIn,
        address base,
        address tokenOut,
        uint256 amountIn,
        address to
    ) external returns (uint256 amountOut) {
        require(IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn), "PULL");
        IERC20(tokenIn).approve(address(router), amountIn);
        address[] memory path = new address[](2);
        (path[0], path[1]) = (tokenIn, base);
        uint256[] memory amounts = router.swapExactTokensForTokens(amountIn, 0, path, address(this), block.timestamp);

        uint256 baseAmount = amounts[1];
        IERC20(base).approve(address(router), baseAmount);
        (path[0], path[1]) = (base, tokenOut);
        amounts = router.swapExactTokensForTokens(baseAmount, 0, path, to, block.timestamp);
        amountOut = amounts[1];
    }
}
