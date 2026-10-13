// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "../TestBase.sol";
import {MathX} from "../../src/common/MathX.sol";
import {GraduationRouter} from "../../src/graduation/GraduationRouter.sol";
import {PermanentLiquidityLocker} from "../../src/graduation/PermanentLiquidityLocker.sol";
import {IGraduationAdapter} from "../../src/graduation/interfaces/IGraduationAdapter.sol";
import {UniswapV2GraduationAdapter} from "../../src/graduation/UniswapV2GraduationAdapter.sol";
import {IUniswapV2Pair} from "../../src/graduation/interfaces/IUniswapV2Pair.sol";
import {NUSD} from "../../src/nusd/NUSD.sol";
import {ZeroXPump} from "../../src/pump/ZeroXPump.sol";
import {PumpToken} from "../../src/pump/PumpToken.sol";
import {MockLPToken} from "../mocks/MockGraduationAdapter.sol";
import {MockUniswapV2Factory, MockUniswapV2Pair} from "../mocks/MockUniswapV2.sol";

contract UniswapV2GraduationAdapterTest is TestBase {
    uint256 private constant SUPPLY = 1_000_000_000 ether;
    uint256 private constant VIRTUAL_NUSD = 1_500 ether;
    uint256 private constant MARKET_CAP_TARGET = 6_000 ether;
    uint256 private constant RESERVE_THRESHOLD = 1_500 ether;
    uint256 private constant DELAY = 1 hours;
    uint256 private constant SLIPPAGE_BPS = 100;
    uint256 private constant MAX_DEV_BPS = 1_000;

    NUSD private nusd;
    PermanentLiquidityLocker private locker;
    GraduationRouter private router;
    GraduationRouter private directRouter;
    ZeroXPump private pump;
    MockUniswapV2Factory private factory;
    UniswapV2GraduationAdapter private adapter;
    UniswapV2GraduationAdapter private directAdapter;
    MockLPToken private token;
    uint256 private reservationNonce;

    address private constant CREATOR = address(0xC0FFEE);
    address private constant TRADER = address(0xA11CE);
    address private constant DONOR = address(0xD0D0);

    function setUp() public {
        vm.warp(1_000_000);
        nusd = new NUSD(address(this));
        nusd.bindVault(address(this));
        locker = new PermanentLiquidityLocker(address(this));
        router = new GraduationRouter(address(this), DELAY, address(locker));
        pump = new ZeroXPump(
            address(nusd), address(nusd), address(router), address(this), SUPPLY, VIRTUAL_NUSD, MARKET_CAP_TARGET
        );
        router.bindPump(address(pump));
        locker.bindRouter(address(router));
        factory = new MockUniswapV2Factory();
        adapter = new UniswapV2GraduationAdapter(address(factory), address(nusd), address(router), MAX_DEV_BPS, SLIPPAGE_BPS);
        PermanentLiquidityLocker directLocker = new PermanentLiquidityLocker(address(this));
        directRouter = new GraduationRouter(address(this), DELAY, address(directLocker));
        directLocker.bindRouter(address(directRouter));
        directRouter.bindPump(address(this));
        directAdapter = new UniswapV2GraduationAdapter(
            address(factory), address(nusd), address(directRouter), MAX_DEV_BPS, SLIPPAGE_BPS
        );
        token = new MockLPToken();
        token.mint(address(this), 1_000_000 ether);
        nusd.mint(address(this), 1_000_000 ether);
        nusd.mint(CREATOR, 100 ether);
        nusd.mint(TRADER, 100_000 ether);
        nusd.mint(DONOR, 10_000 ether);
        vm.prank(CREATOR);
        nusd.approve(address(pump), type(uint256).max);
        vm.prank(TRADER);
        nusd.approve(address(pump), type(uint256).max);
        token.approve(address(router), type(uint256).max);
        nusd.approve(address(router), type(uint256).max);
        token.approve(address(directRouter), type(uint256).max);
        nusd.approve(address(directRouter), type(uint256).max);
    }

    function testConstructorRejectsUnsafeConfiguration() public {
        vm.expectRevert(UniswapV2GraduationAdapter.InvalidConfiguration.selector);
        new UniswapV2GraduationAdapter(address(0), address(nusd), address(router), MAX_DEV_BPS, SLIPPAGE_BPS);
        vm.expectRevert(UniswapV2GraduationAdapter.InvalidConfiguration.selector);
        new UniswapV2GraduationAdapter(address(factory), address(nusd), address(router), 10_001, SLIPPAGE_BPS);
        vm.expectRevert(UniswapV2GraduationAdapter.InvalidConfiguration.selector);
        new UniswapV2GraduationAdapter(address(factory), address(nusd), address(router), MAX_DEV_BPS, 1_001);
    }

    function testFreshPairQuoteMatchesSqrtMinusMinimumLiquidityWithSlippage() public {
        uint256 tokenAmount = 400 ether;
        uint256 nusdAmount = 100 ether;
        directAdapter.preparePool(address(token));
        uint256 expected = MathX.sqrt(tokenAmount * nusdAmount) - 1_000;
        assertEq(
            directAdapter.quoteMinimumLp(address(token), address(nusd), tokenAmount, nusdAmount),
            (expected * 9_900) / 10_000,
            "fresh quote"
        );
    }

    function testGraduateFreshPairSkimsDonationAndLocksLp() public {
        _enableDirect();
        directAdapter.preparePool(address(token));
        address pair = factory.getPair(address(token), address(nusd));
        token.mint(DONOR, 50 ether);
        vm.prank(DONOR);
        token.transfer(pair, 50 ether);

        uint256 minLp = directAdapter.quoteMinimumLp(address(token), address(nusd), 400 ether, 100 ether);
        IGraduationAdapter.GraduationResult memory result = directRouter.executeGraduation(
            address(directAdapter), address(token), address(nusd), 400 ether, 100 ether, minLp, block.timestamp
        );

        uint256 expected = MathX.sqrt(400 ether * 100 ether) - 1_000;
        assertEq(result.lpAmount, expected, "donation did not mint extra LP");
        assertEq(token.balanceOf(pair), 400 ether, "skimmed then seeded");
        assertEq(nusd.balanceOf(pair), 100 ether, "exact nusd");
        assertEq(MockUniswapV2Pair(pair).balanceOf(directRouter.lpRecipient()), expected, "locker LP");
        assertEq(token.balanceOf(address(1)), 50 ether, "donation sunk");
    }

    function testExistingBalancedPairUsesReserveAwareMinLp() public {
        directAdapter.preparePool(address(token));
        address pair = factory.getPair(address(token), address(nusd));
        token.transfer(pair, 40 ether);
        nusd.transfer(pair, 10 ether);
        MockUniswapV2Pair(pair).mint(address(this));
        uint256 supply = MockUniswapV2Pair(pair).totalSupply();

        uint256 tokenIn = 400 ether;
        uint256 nusdIn = 100 ether;
        uint256 expected = tokenIn * supply / 40 ether;
        uint256 quoted = directAdapter.quoteMinimumLp(address(token), address(nusd), tokenIn, nusdIn);
        assertEq(quoted, (expected * 9_900) / 10_000, "reserve-aware quote");

        _enableDirect();
        IGraduationAdapter.GraduationResult memory result = directRouter.executeGraduation(
            address(directAdapter), address(token), address(nusd), tokenIn, nusdIn, quoted, block.timestamp
        );
        assertGe(result.lpAmount, quoted, "mint meets quote");
        assertEq(result.lpAmount, expected, "exact proportional LP");
    }

    function testSkewedPairWithinBoundStillGraduates() public {
        directAdapter.preparePool(address(token));
        address pair = factory.getPair(address(token), address(nusd));
        token.transfer(pair, 40 ether);
        nusd.transfer(pair, 11 ether);
        MockUniswapV2Pair(pair).mint(address(this));

        uint256 quoted = directAdapter.quoteMinimumLp(address(token), address(nusd), 400 ether, 100 ether);
        _enableDirect();
        IGraduationAdapter.GraduationResult memory result = directRouter.executeGraduation(
            address(directAdapter), address(token), address(nusd), 400 ether, 100 ether, quoted, block.timestamp
        );
        assertGe(result.lpAmount, quoted, "skew within 10%");
    }

    function testSkewedPairBeyondBoundReverts() public {
        directAdapter.preparePool(address(token));
        address pair = factory.getPair(address(token), address(nusd));
        token.transfer(pair, 40 ether);
        nusd.transfer(pair, 20 ether);
        MockUniswapV2Pair(pair).mint(address(this));

        vm.expectRevert();
        directAdapter.quoteMinimumLp(address(token), address(nusd), 400 ether, 100 ether);
    }

    function testDonateToExistingPairIsSkimmedBeforeMint() public {
        directAdapter.preparePool(address(token));
        address pair = factory.getPair(address(token), address(nusd));
        token.transfer(pair, 40 ether);
        nusd.transfer(pair, 10 ether);
        MockUniswapV2Pair(pair).mint(address(this));
        token.mint(DONOR, 25 ether);
        vm.prank(DONOR);
        token.transfer(pair, 25 ether);

        uint256 quoted = directAdapter.quoteMinimumLp(address(token), address(nusd), 400 ether, 100 ether);
        _enableDirect();
        uint256 sinkBefore = token.balanceOf(address(1));
        directRouter.executeGraduation(
            address(directAdapter), address(token), address(nusd), 400 ether, 100 ether, quoted, block.timestamp
        );
        assertEq(token.balanceOf(address(1)), sinkBefore + 25 ether, "skimmed donation");
    }

    function testOnlyRouterCanGraduate() public {
        adapter.preparePool(address(token));
        token.approve(address(adapter), 1 ether);
        nusd.approve(address(adapter), 1 ether);
        vm.expectRevert(UniswapV2GraduationAdapter.InvalidGraduationCaller.selector);
        adapter.graduate(
            IGraduationAdapter.GraduationParams({
                token: address(token),
                nusd: address(nusd),
                tokenAmount: 1 ether,
                nusdAmount: 1 ether,
                minimumLp: 1,
                deadline: block.timestamp,
                lpRecipient: address(this)
            })
        );
    }

    function testPumpGraduateUsesAdapterQuoteOnFreshPair() public {
        _enableAdapter();
        address market = _createMarket();
        vm.prank(TRADER);
        pump.buy(market, 50_000 ether, 0, type(uint256).max);
        pump.setGraduationAdapter(address(adapter));
        pump.graduate(market, address(0), 0, type(uint256).max);
        assertEq(pump.status(market), uint8(ZeroXPump.Lifecycle.GRADUATED), "graduated");
        (address lpToken, uint256 lpAmount,,,) = locker.locks(market);
        assertGt(lpAmount, 0, "locked");
        assertEq(MockUniswapV2Pair(lpToken).balanceOf(address(locker)), lpAmount, "custody");
    }

    function testPumpGraduateHandlesPreexistingPair() public {
        _enableAdapter();
        address market = _createMarket();
        vm.prank(TRADER);
        pump.buy(market, 50_000 ether, 0, type(uint256).max);

        (, uint256 tokenReserve, uint256 realNusdReserve,,,,,,,,) = pump.markets(market);
        uint256 tokenLiquidity = MathX.mulDiv(realNusdReserve, 1e18, pump.spotPriceNusdWad(market));
        uint256 nusdSeed = 6 ether;
        uint256 tokenSeed = MathX.mulDiv(nusdSeed, tokenLiquidity, realNusdReserve);

        adapter.preparePool(market);
        address pair = factory.getPair(market, address(nusd));
        vm.prank(TRADER);
        PumpToken(market).transfer(pair, tokenSeed);
        nusd.mint(pair, nusdSeed);
        MockUniswapV2Pair(pair).mint(address(this));

        pump.graduate(market, address(0), 0, type(uint256).max);
        assertEq(pump.status(market), uint8(ZeroXPump.Lifecycle.GRADUATED), "preexisting pair");
        assertTrue(tokenReserve > tokenLiquidity, "unused curve inventory burned");
    }

    function _enableDirect() private {
        directRouter.scheduleAdapter(address(directAdapter));
        directRouter.scheduleEnable();
        vm.warp(block.timestamp + DELAY);
        directRouter.activateAdapter(address(directAdapter));
        directRouter.enableRouter();
    }

    function _enableAdapter() private {
        router.scheduleAdapter(address(adapter));
        router.scheduleEnable();
        vm.warp(block.timestamp + DELAY);
        router.activateAdapter(address(adapter));
        router.enableRouter();
        pump.setGraduationAdapter(address(adapter));
    }

    function _createMarket() private returns (address created) {
        bytes32 commitment = keccak256(abi.encode("univ2-market", ++reservationNonce));
        vm.startPrank(CREATOR);
        pump.reserveMarket(commitment);
        created = pump.createMarket("Nothing Meme", "MEME", "ipfs://bafybeimetadata", "ipfs://bafybeiimage", commitment);
        vm.stopPrank();
    }
}
