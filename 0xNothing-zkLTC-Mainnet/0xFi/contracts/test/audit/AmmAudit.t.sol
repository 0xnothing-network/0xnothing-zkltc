// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ZeroXFiFactoryV2 } from "../../src/amm/ZeroXFiFactoryV2.sol";
import { ZeroXFiPair } from "../../src/amm/ZeroXFiPair.sol";
import { ZeroXFiRouterV2 } from "../../src/amm/ZeroXFiRouterV2.sol";
import { WzkLTC } from "../../src/amm/WzkLTC.sol";
import { TestBase } from "../helpers/TestBase.sol";
import { FeeSplitterMock } from "../mocks/FeeSplitterMock.sol";
import { MockPump } from "../mocks/GraduationMocks.sol";
import { MockERC20 } from "../mocks/TokenMocks.sol";
import { AuditSplitRouteWrapper, AuditVm } from "./mocks/AuditMocks.sol";

/// Tests for findings C-1 and C-2 of the 2026-11 audit (docs/AUDIT_2026-11.md). C-1 was fixed for
/// its sync() vector: these tests replay the two attacks as found and assert that they now fail;
/// what remains of it is in AmmPairAudit.t.sol. C-2 is accepted and documented: its test still
/// passes on the outcome the report describes. Same wiring as test/integration/AmmRouterV2.t.sol.
contract AmmAuditTest is TestBase {
    AuditVm private constant avm = AuditVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    address private constant POOL = address(0xB001);
    address private constant TREASURY = address(0x7EA5);

    MockERC20 private nusd;
    MockERC20 private tokenA;
    MockERC20 private tokenB;
    MockERC20 private tokenC;
    MockERC20 private pumpToken;
    MockPump private pump;
    WzkLTC private wrapped;
    ZeroXFiFactoryV2 private factory;
    FeeSplitterMock private splitter;
    ZeroXFiRouterV2 private router;

    function setUp() public {
        vm.warp(1_000_000);
        nusd = new MockERC20("Nothing USD", "NUSD");
        tokenA = new MockERC20("Token A", "TKA");
        tokenB = new MockERC20("Token B", "TKB");
        tokenC = new MockERC20("Token C", "TKC");
        pumpToken = new MockERC20("Pump token", "PUMP");
        pump = new MockPump(address(nusd));
        pump.setStatus(address(pumpToken), 2);
        wrapped = new WzkLTC();
        factory = new ZeroXFiFactoryV2(address(this), address(nusd), address(wrapped), address(pump));
        splitter = new FeeSplitterMock(address(nusd), POOL, TREASURY);
        router = new ZeroXFiRouterV2(address(factory), address(wrapped), address(splitter), TREASURY);
        factory.bindRouter(address(router));

        MockERC20[4] memory tokens = [nusd, tokenA, tokenB, tokenC];
        for (uint256 i; i < tokens.length; ++i) {
            _fundAndApprove(ALICE, tokens[i], 10_000_000 ether);
            _fundAndApprove(BOB, tokens[i], 10_000_000 ether);
        }
        vm.deal(ALICE, 100_000 ether);
        vm.deal(BOB, 100_000 ether);

        vm.startPrank(ALICE);
        router.addLiquidity(_addParams(address(tokenA), address(nusd), 100_000 ether, 200_000 ether, 1, 1));
        router.addLiquidity(_addParams(address(tokenB), address(nusd), 100_000 ether, 100_000 ether, 1, 1));
        vm.stopPrank();
    }

    // C-1 (a) (fixed). A pair created empty with a bare factory.createPair (what
    // Deploy0xFiMainnet.s.sol does for WzkLTC/NUSD, nBTC/NUSD, nETH/NUSD) has no bootstrapper, and
    // anyone could sync() it before the first mint. Donating 1 wei of one token and syncing set the
    // reserves to (1, 0), after which router.addLiquidity and addLiquidityNative reverted
    // InsufficientLiquidity. A pair without liquidity can no longer be synced, so its reserves
    // stay (0, 0) until the first mint.
    function testAudit_C1_emptyPairCannotBeSynced() public {
        ZeroXFiPair pair = ZeroXFiPair(factory.createPair(address(tokenC), address(nusd)));
        ZeroXFiPair nativePair = ZeroXFiPair(factory.createPair(address(tokenC), address(wrapped)));
        assertEq(pair.bootstrapper(), address(0), "bare createPair leaves no bootstrapper");

        vm.startPrank(BOB);
        nusd.transfer(address(pair), 1);
        vm.expectRevert(ZeroXFiPair.Forbidden.selector);
        pair.sync();
        tokenC.transfer(address(nativePair), 1);
        vm.expectRevert(ZeroXFiPair.Forbidden.selector);
        nativePair.sync();
        vm.stopPrank();
        (uint256 reserveC, uint256 reserveNusd) = router.getReserves(address(tokenC), address(nusd));
        assertEq(reserveC + reserveNusd, 0, "reserves stay empty");

        // The router's first deposit goes through in both pairs; the donated wei joins it.
        vm.startPrank(ALICE);
        (uint256 amountC, uint256 amountNusd,) =
            router.addLiquidity(_addParams(address(tokenC), address(nusd), 1 ether, 100 ether, 1 ether, 100 ether));
        assertEq(amountC, 1 ether, "tokenC in");
        assertEq(amountNusd, 100 ether, "NUSD in");
        router.addLiquidityNative{ value: 1 ether }(
            ZeroXFiRouterV2.AddLiquidityNativeParams({
                token: address(tokenC),
                amountTokenDesired: 100 ether,
                amountTokenMin: 100 ether,
                amountNativeMin: 1 ether,
                minimumLiquidity: 1,
                to: ALICE,
                deadline: block.timestamp
            })
        );
        vm.stopPrank();
        assertGt(pair.balanceOf(ALICE), 0, "liquidity minted");
        assertGt(nativePair.balanceOf(ALICE), 0, "liquidity minted in the native pair");
        (reserveC, reserveNusd) = router.getReserves(address(tokenC), address(nusd));
        assertEq(reserveC, 1 ether, "tokenC reserve");
        assertEq(reserveNusd, 100 ether + 1, "NUSD reserve: the deposit and the donated wei");

        // With liquidity in place, skim and sync are open to everyone again.
        vm.startPrank(BOB);
        tokenC.transfer(address(pair), 5);
        pair.skim(BOB);
        pair.sync();
        vm.stopPrank();
    }

    // C-1 (b) (fixed). Donating 1 wei of each token and syncing set the reserves to (1, 1) while
    // supply was 0. The router then treated 1:1 raw units as the pool price, so a first deposit
    // meant to be 1 tokenC : 100 NUSD with loose minimums went in as 1 : 1 and the attacker bought
    // 0.9 tokenC for 9 NUSD. The sync now reverts and the deposit goes in at the ratio asked for.
    // A dust first mint can still set a starting price: see AmmPairAudit.t.sol.
    function testAudit_C1_syncCannotPresetTheStartingPrice() public {
        ZeroXFiPair pair = ZeroXFiPair(factory.createPair(address(tokenC), address(nusd)));
        vm.startPrank(BOB);
        tokenC.transfer(address(pair), 1);
        nusd.transfer(address(pair), 1);
        vm.expectRevert(ZeroXFiPair.Forbidden.selector);
        pair.sync();
        vm.stopPrank();

        uint256 aliceNusdBefore = nusd.balanceOf(ALICE);
        vm.prank(ALICE);
        (uint256 amountC, uint256 amountNusd,) =
            router.addLiquidity(_addParams(address(tokenC), address(nusd), 1 ether, 100 ether, 0, 0));
        assertEq(amountC, 1 ether, "all of the tokenC went in");
        assertEq(amountNusd, 100 ether, "and all 100 NUSD, even with zero minimums");
        assertEq(aliceNusdBefore - nusd.balanceOf(ALICE), 100 ether, "pool priced at 100 NUSD per tokenC");

        address[] memory path = new address[](2);
        (path[0], path[1]) = (address(nusd), address(tokenC));
        uint256 bobBefore = tokenC.balanceOf(BOB);
        vm.prank(BOB);
        router.swapExactTokensForTokens(9 ether, 0, path, BOB, block.timestamp);
        assertLe(tokenC.balanceOf(BOB) - bobBefore, 0.09 ether, "9 NUSD now buys under 0.09 tokenC, not 0.9");
    }

    // C-2 (accepted). A token -> token route through NUSD is charged 30 bps of the NUSD leg, but the same
    // trade done as two direct swaps (token -> NUSD, NUSD -> token) is charged 10 bps twice, and a
    // wrapper contract can do both in one transaction.
    // Numbers: 1,000 tokenA through [tokenA, NUSD, tokenB]. Cross route: fee = 30 bps of the gross
    // NUSD leg (5.911 NUSD). Split route: 10 bps of the gross NUSD out + 10 bps of the NUSD back in
    // (3.939 NUSD, 19.99 bps, 66.6% of the cross fee), and the trader receives more tokenB.
    function testAudit_C2_splitRoutePaysTwentyBpsInsteadOfThirty() public {
        AuditSplitRouteWrapper wrapper = new AuditSplitRouteWrapper();
        vm.prank(BOB);
        tokenA.approve(address(wrapper), type(uint256).max);

        address[] memory path = new address[](3);
        (path[0], path[1], path[2]) = (address(tokenA), address(nusd), address(tokenB));
        (uint256 reserveIn, uint256 reserveOut) = router.getReserves(address(tokenA), address(nusd));
        uint256 grossNusd = router.getAmountOut(1000 ether, reserveIn, reserveOut);
        uint256 bobBefore = tokenB.balanceOf(BOB);
        uint256 snapshotId = avm.snapshotState();

        // Route A: one cross swap.
        vm.prank(BOB);
        router.swapExactTokensForTokens(1000 ether, 0, path, BOB, block.timestamp);
        uint256 crossOut = tokenB.balanceOf(BOB) - bobBefore;
        uint256 crossFee = router.accruedRouterFees(address(nusd));

        // Route B: identical starting state, two direct swaps in one transaction.
        assertTrue(avm.revertToState(snapshotId), "state restored");
        assertEq(router.accruedRouterFees(address(nusd)), 0, "fees back to zero");
        vm.prank(BOB);
        uint256 splitOut = wrapper.splitSwap(router, address(tokenA), address(nusd), address(tokenB), 1000 ether, BOB);
        uint256 splitFee = router.accruedRouterFees(address(nusd));
        assertEq(tokenB.balanceOf(BOB) - bobBefore, splitOut, "bob received the split output");

        uint256 firstLegFee = grossNusd * 10 / 10_000;
        assertEq(crossFee, grossNusd * 30 / 10_000, "cross route pays 30 bps of the NUSD leg");
        assertEq(splitFee, firstLegFee + (grossNusd - firstLegFee) * 10 / 10_000, "split route pays 10 bps twice");
        assertApproxEqAbs(crossFee, 5.911 ether, 0.001 ether, "5.911 NUSD");
        assertApproxEqAbs(splitFee, 3.939 ether, 0.001 ether, "3.939 NUSD");
        assertEq(splitFee * 10_000 / crossFee, 6663, "split fee is 66.6% of the cross fee");
        assertEq(splitFee * 100_000 / grossNusd, 199, "19.99 bps instead of 30");
        assertGt(splitOut, crossOut, "and the trader gets more tokenB");
    }

    function _addParams(address a, address b, uint256 amountA, uint256 amountB, uint256 minA, uint256 minB)
        private
        view
        returns (ZeroXFiRouterV2.AddLiquidityParams memory)
    {
        return ZeroXFiRouterV2.AddLiquidityParams({
            tokenA: a,
            tokenB: b,
            amountADesired: amountA,
            amountBDesired: amountB,
            amountAMin: minA,
            amountBMin: minB,
            minimumLiquidity: 1,
            to: ALICE,
            deadline: block.timestamp
        });
    }

    function _fundAndApprove(address account, MockERC20 token, uint256 amount) private {
        token.mint(account, amount);
        vm.prank(account);
        token.approve(address(router), type(uint256).max);
    }
}
