// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ZeroXFiRouter } from "../../src/amm/ZeroXFiRouter.sol";
import { TestBase } from "../TestBase.sol";

interface ILegacyLivePair {
    function sync() external;
}

contract LegacyAmmRouterLiveForkTest is TestBase {
    address private constant FACTORY = 0xe33fE815c2e12DC83b69397CeD12b09849Fa9C0D;
    address private constant WZKLTC = 0xE93d4373CE1eDA3df6c3Ab7ed3ab07A07aA5939F;
    address private constant NUSD = 0x5317e21aba902c6c7087a84457bc02fFe99604d1;
    address private constant LIQUID_PUMP_PAIR = 0x0a573E077466cdA9211063442714b67b0E2D74C7;
    address private constant LIQUID_PUMP_TOKEN = 0xE84C99B45a71038578c9806236e88FB7302DC00c;
    address private constant SECOND_PUMP_TOKEN = 0x30C81Ab870E42FB3492D05DF12cd04872eE06d50;
    address private constant ALICE = address(0xA11CE);

    function testNewFeeRouterSwapsThroughLegacyLivePairWithoutMovingLp() public {
        string memory rpcUrl = vm.envOr("LITVM_FORK_RPC_URL", string(""));
        if (bytes(rpcUrl).length == 0) return;
        vm.createSelectFork(rpcUrl);

        ZeroXFiRouter router = new ZeroXFiRouter(FACTORY, WZKLTC);
        address[] memory path = new address[](2);
        path[0] = LIQUID_PUMP_TOKEN;
        path[1] = NUSD;

        uint256 amountIn = 1000 ether;
        _fundAndApprove(router, amountIn);

        uint256[] memory quote = router.getAmountsOut(amountIn, path);
        uint256 routerFee = router.routerFeeFor(amountIn, path.length);
        uint256 nusdBefore = IERC20(NUSD).balanceOf(ALICE);

        vm.prank(ALICE);
        uint256[] memory actual = router.swapExactTokensForTokens(amountIn, quote[1], path, ALICE, block.timestamp + 1);

        assertEq(actual[1], quote[1], "legacy pair output must match the V2 quote");
        assertEq(IERC20(NUSD).balanceOf(ALICE) - nusdBefore, quote[1], "recipient output");
        assertEq(router.accruedRouterFees(LIQUID_PUMP_TOKEN), routerFee, "protocol fee ledger");
        assertEq(IERC20(LIQUID_PUMP_TOKEN).balanceOf(address(router)), routerFee, "protocol fee backing");
    }

    function testNewFeeRouterExecutesLegacyTwoPoolRouteAtomically() public {
        string memory rpcUrl = vm.envOr("LITVM_FORK_RPC_URL", string(""));
        if (bytes(rpcUrl).length == 0) return;
        vm.createSelectFork(rpcUrl);

        ZeroXFiRouter router = new ZeroXFiRouter(FACTORY, WZKLTC);
        address[] memory path = new address[](3);
        path[0] = LIQUID_PUMP_TOKEN;
        path[1] = NUSD;
        path[2] = SECOND_PUMP_TOKEN;

        uint256 amountIn = 1000 ether;
        _fundAndApprove(router, amountIn);
        uint256[] memory quote = router.getAmountsOut(amountIn, path);
        uint256 routerFee = router.routerFeeFor(amountIn, path.length);
        uint256 outputBefore = IERC20(SECOND_PUMP_TOKEN).balanceOf(ALICE);

        vm.prank(ALICE);
        uint256[] memory actual = router.swapExactTokensForTokens(amountIn, quote[2], path, ALICE, block.timestamp + 1);

        assertEq(actual[2], quote[2], "multihop output must match the V2 quote");
        assertEq(IERC20(SECOND_PUMP_TOKEN).balanceOf(ALICE) - outputBefore, quote[2], "multihop recipient output");
        assertEq(routerFee, amountIn * 20 / 10_000, "protocol plus route surcharge");
        assertEq(router.accruedRouterFees(LIQUID_PUMP_TOKEN), routerFee, "multihop router fee ledger");
        assertEq(IERC20(LIQUID_PUMP_TOKEN).balanceOf(address(router)), routerFee, "multihop router fee backing");
        assertEq(IERC20(NUSD).balanceOf(address(router)), 0, "intermediary cannot remain in the router");
    }

    function _fundAndApprove(ZeroXFiRouter router, uint256 amountIn) private {
        vm.prank(LIQUID_PUMP_PAIR);
        assertTrue(IERC20(LIQUID_PUMP_TOKEN).transfer(ALICE, amountIn), "fork token funding");
        ILegacyLivePair(LIQUID_PUMP_PAIR).sync();
        vm.prank(ALICE);
        IERC20(LIQUID_PUMP_TOKEN).approve(address(router), amountIn);
    }
}
