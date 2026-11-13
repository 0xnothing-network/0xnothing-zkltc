// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ZeroXFiFactoryV2 } from "../../src/amm/ZeroXFiFactoryV2.sol";
import { ZeroXFiPair } from "../../src/amm/ZeroXFiPair.sol";
import { ZeroXFiRouterV2 } from "../../src/amm/ZeroXFiRouterV2.sol";
import { WzkLTC } from "../../src/amm/WzkLTC.sol";
import { ZeroXFiGraduationAdapter } from "../../src/graduation/ZeroXFiGraduationAdapter.sol";
import { IGraduationAdapter } from "../../src/interfaces/IGraduationAdapter.sol";
import { TestBase } from "../helpers/TestBase.sol";
import { FeeSplitterMock } from "../mocks/FeeSplitterMock.sol";
import { MockPump, MockPumpRouter } from "../mocks/GraduationMocks.sol";
import { MockERC20 } from "../mocks/TokenMocks.sol";

/// Tests from the adversarial review of the C-1 fix of the 2026-11 audit (ZeroXFiPair.sync on a
/// pair without liquidity). Same wiring as test/audit/AmmAudit.t.sol, plus the graduation adapter
/// with the mocks of this repo.
contract AmmPairAuditTest is TestBase {
    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    address private constant MALLORY = address(0xBAD);
    address private constant POOL = address(0xB001);
    address private constant TREASURY = address(0x7EA5);
    uint256 private constant UINT112_MAX = type(uint112).max;

    MockERC20 private nusd;
    MockERC20 private tokenC;
    MockERC20 private big;
    MockERC20 private pumpToken;
    MockPump private pump;
    MockPumpRouter private pumpRouter;
    WzkLTC private wrapped;
    ZeroXFiFactoryV2 private factory;
    FeeSplitterMock private splitter;
    ZeroXFiRouterV2 private router;
    ZeroXFiGraduationAdapter private adapter;

    function setUp() public {
        vm.warp(1_000_000);
        nusd = new MockERC20("Nothing USD", "NUSD");
        tokenC = new MockERC20("Token C", "TKC");
        big = new MockERC20("Huge supply", "BIG");
        pumpToken = new MockERC20("Pump token", "PUMP");
        pump = new MockPump(address(nusd));
        pumpRouter = new MockPumpRouter(address(pump));
        pump.setGraduationRouter(address(pumpRouter));
        pump.setStatus(address(pumpToken), 2);
        wrapped = new WzkLTC();
        factory = new ZeroXFiFactoryV2(address(this), address(nusd), address(wrapped), address(pump));
        splitter = new FeeSplitterMock(address(nusd), POOL, TREASURY);
        router = new ZeroXFiRouterV2(address(factory), address(wrapped), address(splitter), TREASURY);
        factory.bindRouter(address(router));
        adapter = new ZeroXFiGraduationAdapter(address(factory), address(pumpRouter), address(nusd), address(pump));
        factory.bindGraduationAdapter(address(adapter));

        address[3] memory users = [ALICE, BOB, MALLORY];
        MockERC20[3] memory tokens = [nusd, tokenC, big];
        for (uint256 u; u < users.length; ++u) {
            for (uint256 t; t < tokens.length; ++t) {
                tokens[t].mint(users[u], 10_000_000 ether);
                vm.prank(users[u]);
                tokens[t].approve(address(router), type(uint256).max);
            }
        }
    }

    // Every state-changing entry point of an empty pair without a bootstrapper, called by a
    // stranger who has donated both tokens: none of them moves the reserves off (0, 0). Skimming
    // is open, and all it does is hand the donation back.
    function testAudit_C1_emptyPairKeepsZeroReservesUnderEveryStrangerCall() public {
        ZeroXFiPair pair = ZeroXFiPair(factory.createPair(address(tokenC), address(nusd)));
        vm.startPrank(MALLORY);
        tokenC.transfer(address(pair), 1);
        nusd.transfer(address(pair), 1);

        vm.expectRevert(ZeroXFiPair.Forbidden.selector);
        pair.sync();
        vm.expectRevert(ZeroXFiPair.Forbidden.selector);
        pair.sweepBootstrapDonations(MALLORY);
        vm.expectRevert(ZeroXFiPair.InsufficientLiquidityBurned.selector);
        pair.burn(MALLORY);
        vm.expectRevert(ZeroXFiPair.Forbidden.selector);
        pair.swap(1, 0, MALLORY);
        // A direct mint of two donated wei is too small to create liquidity.
        vm.expectRevert(ZeroXFiPair.InsufficientLiquidityMinted.selector);
        pair.mint(MALLORY);
        address[] memory path = new address[](2);
        (path[0], path[1]) = (address(nusd), address(tokenC));
        vm.expectRevert(ZeroXFiRouterV2.InsufficientLiquidity.selector);
        router.swapExactTokensForTokens(1 ether, 0, path, MALLORY, block.timestamp);
        vm.stopPrank();

        (uint112 reserve0, uint112 reserve1,) = pair.getReserves();
        assertEq(uint256(reserve0) + uint256(reserve1), 0, "reserves still (0, 0)");
        assertEq(pair.totalSupply(), 0, "no liquidity");

        uint256 before = tokenC.balanceOf(MALLORY);
        vm.prank(MALLORY);
        pair.skim(MALLORY);
        assertEq(tokenC.balanceOf(MALLORY) - before, 1, "skim returns the donated wei");
        (reserve0, reserve1,) = pair.getReserves();
        assertEq(uint256(reserve0) + uint256(reserve1), 0, "and leaves the reserves at (0, 0)");
    }

    // A donation without sync cannot hurt the first depositor: the whole donation is minted to
    // them. Mallory gives 100 NUSD; Alice deposits 1 tokenC + 100 NUSD with zero minimums and can
    // take out 1 tokenC + 200 NUSD straight away (less the locked 1000 units of liquidity).
    function testAudit_C1_donationWithoutSyncIsAGiftToTheFirstDepositor() public {
        ZeroXFiPair pair = ZeroXFiPair(factory.createPair(address(tokenC), address(nusd)));
        vm.prank(MALLORY);
        nusd.transfer(address(pair), 100 ether);

        uint256 aliceC = tokenC.balanceOf(ALICE);
        uint256 aliceNusd = nusd.balanceOf(ALICE);
        vm.startPrank(ALICE);
        (uint256 amountC, uint256 amountNusd, uint256 liquidity) =
            router.addLiquidity(_addParams(address(tokenC), address(nusd), 1 ether, 100 ether, 0, 0));
        assertEq(amountC, 1 ether, "tokenC in");
        assertEq(amountNusd, 100 ether, "NUSD in");
        pair.approve(address(router), type(uint256).max);
        router.removeLiquidity(
            ZeroXFiRouterV2.RemoveLiquidityParams({
                tokenA: address(tokenC),
                tokenB: address(nusd),
                liquidity: liquidity,
                amountAMin: 0,
                amountBMin: 0,
                to: ALICE,
                deadline: block.timestamp
            })
        );
        vm.stopPrank();
        assertApproxEqAbs(tokenC.balanceOf(ALICE), aliceC, 1e6, "all tokenC back (less dust)");
        assertApproxEqAbs(nusd.balanceOf(ALICE), aliceNusd + 100 ether, 1e9, "plus the 100 NUSD Mallory gave");
    }

    // A donation can only raise sqrt(amount0 * amount1), so it cannot push a first deposit under
    // the MINIMUM_LIQUIDITY check. It can lift a dust deposit over it; the donor pays for that.
    function testAudit_C1_donationCannotPushAFirstDepositUnderMinimumLiquidity() public {
        ZeroXFiPair pair = ZeroXFiPair(factory.createPair(address(tokenC), address(nusd)));
        vm.prank(ALICE);
        vm.expectRevert(ZeroXFiPair.InsufficientLiquidityMinted.selector);
        router.addLiquidity(_addParams(address(tokenC), address(nusd), 1000, 1000, 0, 0));

        vm.startPrank(MALLORY);
        tokenC.transfer(address(pair), 1);
        nusd.transfer(address(pair), 3);
        vm.stopPrank();
        // (1000 + 1) * (1000 + 3) = 1,004,003 -> sqrt 1001 -> 1 unit of liquidity for Alice.
        vm.prank(ALICE);
        (,, uint256 liquidity) = router.addLiquidity(_addParams(address(tokenC), address(nusd), 1000, 1000, 0, 0));
        assertEq(liquidity, 1, "the donation only helped the deposit through");
        (uint256 reserveC, uint256 reserveNusd) = router.getReserves(address(tokenC), address(nusd));
        assertEq(reserveC, 1001, "tokenC reserve");
        assertEq(reserveNusd, 1003, "NUSD reserve");
    }

    // The protected pump-pair path with the mocks of this repo: a stranger prepares the pool
    // early, donates both tokens, cannot sync / skim / mint / sweep, and graduation still seeds
    // the exact amounts. Nothing on this path calls sync or skim.
    function testAudit_C1_protectedPumpPairGraduatesAfterDonations() public {
        vm.expectRevert(ZeroXFiFactoryV2.ProtectedPumpPair.selector);
        factory.createPair(address(pumpToken), address(nusd));

        vm.prank(MALLORY);
        ZeroXFiPair pair = ZeroXFiPair(adapter.preparePool(address(pumpToken)));
        assertEq(pair.bootstrapper(), address(adapter), "the adapter is the bootstrapper");

        pumpToken.mint(MALLORY, 7);
        vm.startPrank(MALLORY);
        pumpToken.transfer(address(pair), 7);
        nusd.transfer(address(pair), 3 ether);
        vm.expectRevert(ZeroXFiPair.Forbidden.selector);
        pair.sync();
        vm.expectRevert(ZeroXFiPair.Forbidden.selector);
        pair.skim(MALLORY);
        vm.expectRevert(ZeroXFiPair.Forbidden.selector);
        pair.mint(MALLORY);
        vm.expectRevert(ZeroXFiPair.Forbidden.selector);
        pair.sweepBootstrapDonations(MALLORY);
        vm.stopPrank();

        uint256 tokenAmount = 250_000_000 ether;
        uint256 nusdAmount = 1500 ether;
        pumpToken.mint(address(pumpRouter), tokenAmount);
        nusd.mint(address(pumpRouter), nusdAmount);
        // sqrt(250,000,000e18 * 1,500e18) = 612,372.435695794524549321e18
        uint256 expectedLp = 612_372_435_695_794_524_549_321 - 1000;
        IGraduationAdapter.GraduationResult memory result = pumpRouter.execute(
            adapter, address(pumpToken), address(nusd), tokenAmount, nusdAmount, expectedLp, block.timestamp
        );
        assertEq(result.lpAmount, expectedLp, "exact initial liquidity, donations excluded");
        assertEq(result.pool, address(pair), "pool");
        assertEq(pair.balanceOf(address(pumpRouter)), expectedLp, "LP with the pump router");
        assertEq(pair.bootstrapper(), address(0), "bootstrap finished");
        assertEq(pumpToken.balanceOf(address(1)), 7, "token donation swept to the sink");
        assertEq(nusd.balanceOf(address(1)), 3 ether, "NUSD donation swept to the sink");
        (uint256 reserveToken, uint256 reserveNusd) = router.getReserves(address(pumpToken), address(nusd));
        assertEq(reserveToken, tokenAmount, "token reserve is the seeded amount");
        assertEq(reserveNusd, nusdAmount, "NUSD reserve is the seeded amount");

        // Once liquidity exists skim and sync are open again, and a second bootstrap is refused.
        vm.startPrank(MALLORY);
        nusd.transfer(address(pair), 1 ether);
        pair.skim(MALLORY);
        pair.sync();
        vm.stopPrank();
        pumpToken.mint(address(pumpRouter), 1 ether);
        nusd.mint(address(pumpRouter), 1 ether);
        vm.expectRevert(ZeroXFiGraduationAdapter.InvalidPoolState.selector);
        pumpRouter.execute(adapter, address(pumpToken), address(nusd), 1 ether, 1 ether, 1, block.timestamp);
    }

    // A balance above 2^112 - 1 makes every mint revert Overflow. The first version of the C-1 fix
    // closed skim() as well as sync() on a pair without liquidity, which left no way to take such
    // a balance out again: the pair of that token was lost for good (review finding R-F-01).
    // Skimming is open again, because it never changes the reserves.
    function testAudit_C1_oversizedDonationCanBeSkimmedOutOfAnEmptyPair() public {
        ZeroXFiPair pair = ZeroXFiPair(factory.createPair(address(big), address(nusd)));
        big.mint(MALLORY, UINT112_MAX + 1);
        vm.prank(MALLORY);
        big.transfer(address(pair), UINT112_MAX + 1);

        vm.prank(ALICE);
        vm.expectRevert(ZeroXFiPair.Overflow.selector);
        router.addLiquidity(_addParams(address(big), address(nusd), 1 ether, 100 ether, 0, 0));

        // Anyone takes the excess out; the reserves were never touched.
        vm.prank(ALICE);
        pair.skim(MALLORY);
        assertEq(big.balanceOf(address(pair)), 0, "empty again");
        vm.prank(ALICE);
        (uint256 amountBig, uint256 amountNusd,) =
            router.addLiquidity(_addParams(address(big), address(nusd), 1 ether, 100 ether, 1 ether, 100 ether));
        assertEq(amountBig, 1 ether, "the first deposit goes in");
        assertEq(amountNusd, 100 ether, "at its own ratio");
        assertGt(pair.balanceOf(ALICE), 0, "liquidity minted");
    }

    // At exactly 2^112 - 1 the pair is not stuck: the next minter simply takes the donation.
    function testAudit_C1_atUint112MaxTheDonationIsSimplyTaken() public {
        ZeroXFiPair pair = ZeroXFiPair(factory.createPair(address(big), address(nusd)));
        big.mint(MALLORY, UINT112_MAX);
        vm.prank(MALLORY);
        big.transfer(address(pair), UINT112_MAX);

        vm.startPrank(ALICE);
        nusd.transfer(address(pair), 1);
        uint256 liquidity = pair.mint(ALICE);
        vm.stopPrank();
        assertGt(liquidity, 0, "minted against the donation");
        assertEq(pair.balanceOf(ALICE), liquidity, "Alice owns all liquidity but the locked minimum");
    }

    // The guard on sync() must not pass for a caller whose address is zero, which is what the
    // bootstrapper of an ordinary pair is (review finding R-F-02). No signed transaction has that
    // sender; it only matters on a chain with system calls from it.
    function testAudit_C1_callerZeroAddressCannotSyncAnEmptyPair() public {
        ZeroXFiPair pair = ZeroXFiPair(factory.createPair(address(tokenC), address(nusd)));
        vm.startPrank(MALLORY);
        tokenC.transfer(address(pair), 1);
        nusd.transfer(address(pair), 1);
        vm.stopPrank();

        vm.prank(address(0));
        vm.expectRevert(ZeroXFiPair.Forbidden.selector);
        pair.sync();
        (uint112 reserve0, uint112 reserve1,) = pair.getReserves();
        assertEq(uint256(reserve0) + uint256(reserve1), 0, "reserves still (0, 0)");
    }

    // C-1 (b), accepted: the starting price of a pair is whatever its first liquidity says, and the
    // first mint is open on every pair without a bootstrapper. The audit's attacker set a 1:1
    // price with 1 wei of each token and sync(); sync is closed now, but 1001 wei of each token
    // and a direct mint() set the same price (review finding R-F-05). A first deposit meant to be
    // 1 tokenC : 100 NUSD with zero minimums still goes in as 1 : 1 and the attacker buys about
    // 0.9 tokenC for 9 NUSD. Only the depositor's minimums protect the deposit.
    function testAudit_C1_accepted_dustFirstMintSetsTheStartingPrice() public {
        ZeroXFiPair pair = ZeroXFiPair(factory.createPair(address(tokenC), address(nusd)));
        vm.startPrank(BOB);
        tokenC.transfer(address(pair), 1001);
        nusd.transfer(address(pair), 1001);
        assertEq(pair.mint(BOB), 1, "one unit of liquidity is enough");
        vm.stopPrank();

        uint256 aliceNusdBefore = nusd.balanceOf(ALICE);
        vm.prank(ALICE);
        (uint256 amountC, uint256 amountNusd,) =
            router.addLiquidity(_addParams(address(tokenC), address(nusd), 1 ether, 100 ether, 0, 0));
        assertEq(amountC, 1 ether, "all of the tokenC went in");
        assertEq(amountNusd, 1 ether, "but only 1 NUSD of the 100 offered");
        assertEq(aliceNusdBefore - nusd.balanceOf(ALICE), 1 ether, "pool priced at 1 NUSD per tokenC, not 100");

        address[] memory path = new address[](2);
        (path[0], path[1]) = (address(nusd), address(tokenC));
        uint256 bobBefore = tokenC.balanceOf(BOB);
        vm.prank(BOB);
        router.swapExactTokensForTokens(9 ether, 0, path, BOB, block.timestamp);
        uint256 bought = tokenC.balanceOf(BOB) - bobBefore;
        assertGt(bought, 0.89 ether, "9 NUSD buys ~0.9 tokenC");
        assertLe(bought, 0.9 ether, "upper bound");
    }

    // R-F-05 control: with the minimums the audit test used in its first case, the same deposit
    // reverts instead of going in at the wrong price.
    function testAudit_C1_minimumsAreWhatProtectsAFirstDeposit() public {
        ZeroXFiPair pair = ZeroXFiPair(factory.createPair(address(tokenC), address(nusd)));
        vm.startPrank(BOB);
        tokenC.transfer(address(pair), 1001);
        nusd.transfer(address(pair), 1001);
        pair.mint(BOB);
        vm.stopPrank();

        vm.prank(ALICE);
        vm.expectRevert(ZeroXFiRouterV2.InsufficientAmount.selector);
        router.addLiquidity(_addParams(address(tokenC), address(nusd), 1 ether, 100 ether, 1 ether, 100 ether));
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
}
