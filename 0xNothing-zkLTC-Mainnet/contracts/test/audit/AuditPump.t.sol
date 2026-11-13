// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "../TestBase.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {OracleNUSDv2} from "../../src/nusd/OracleNUSDv2.sol";
import {IPriceOracle} from "../../src/oracle/IPriceOracle.sol";
import {ZeroXPumpV2} from "../../src/pump/ZeroXPumpV2.sol";
import {GraduationRouter} from "../../src/graduation/GraduationRouter.sol";
import {PermanentLiquidityLocker} from "../../src/graduation/PermanentLiquidityLocker.sol";
import {FeeSplitter} from "../../src/treasury/FeeSplitter.sol";
import {RewardStaking} from "../../src/rewards/RewardStaking.sol";
import {MockPriceOracle, MockWrappedNative} from "../mocks/TokenomicsMocks.sol";
import {EvilAdapter} from "./mocks/EvilAdapter.sol";

/// Tests for findings B-02, B-03 and B-04 of the 2026-11 audit of the Pump and graduation
/// (docs/AUDIT_2026-11.md). B-02 was fixed: its test asserts the market now becomes READY. B-03 and
/// B-04 are accepted and documented: their tests still pass on the outcome the report describes.
/// The wiring is the one test/unit/ZeroXPumpV2.t.sol uses: this contract is Pump admin and
/// router admin, PARAM_ADMIN sets the terms of new markets.
contract AuditPumpTest is TestBase {
    uint256 private constant SUPPLY = 1_000_000_000 ether;
    uint256 private constant VIRTUAL_NUSD = 1_500 ether;
    uint256 private constant MARKET_CAP_TARGET = 6_000 ether;
    uint256 private constant RESERVE_TARGET = 1_500 ether; // sqrt(1,500 x 6,000) - 1,500
    uint256 private constant CREATE_FEE = 1 ether;
    uint256 private constant TRADE_FEE_BPS = 10;

    uint8 private constant TRADING = 1;
    uint8 private constant READY = 2;
    uint8 private constant GRADUATED = 3;

    address private constant CREATOR = address(0xC0FFEE);
    address private constant TRADER = address(0xA11CE);
    address private constant MALLORY = address(0xBAD);
    address private constant TREASURY = address(0x7EA5);
    address private constant PARAM_ADMIN = address(0x9A9A);
    address private constant OWNER_WALLET = address(0x0A11);

    OracleNUSDv2 private nusd;
    GraduationRouter private router;
    PermanentLiquidityLocker private locker;
    ZeroXPumpV2 private pump;
    uint256 private reservationNonce;

    function setUp() public {
        vm.warp(1_000_000);
        nusd = new OracleNUSDv2(IPriceOracle(address(new MockPriceOracle(100 ether))), address(this), 1_000_000 ether);
        RewardStaking staking = new RewardStaking(IERC20(address(nusd)));
        FeeSplitter splitter = new FeeSplitter(address(nusd), address(new MockWrappedNative()), TREASURY, address(this));
        splitter.setRecipients(address(staking), TREASURY);

        locker = new PermanentLiquidityLocker(address(this));
        router = new GraduationRouter(address(this), 1 hours, address(locker));
        pump = new ZeroXPumpV2(
            address(nusd),
            address(nusd),
            address(router),
            address(splitter),
            address(this),
            PARAM_ADMIN,
            SUPPLY,
            VIRTUAL_NUSD,
            MARKET_CAP_TARGET,
            CREATE_FEE,
            TRADE_FEE_BPS
        );
        router.bindPump(address(pump));
        locker.bindRouter(address(router));

        _fund(CREATOR, 1 ether); // 100 NUSD
        _fund(TRADER, 100 ether); // 10,000 NUSD
        _fund(MALLORY, 1 ether); // 100 NUSD
    }

    function _fund(address account, uint256 collateralWei) private {
        vm.deal(account, collateralWei);
        vm.startPrank(account);
        nusd.mintAtOracle{value: collateralWei}(0, account);
        nusd.approve(address(pump), type(uint256).max);
        vm.stopPrank();
    }

    function _createMarket() private returns (address token) {
        bytes32 commitment = keccak256(abi.encode("market", ++reservationNonce));
        vm.prank(CREATOR);
        pump.reserveMarket(commitment);
        vm.prank(CREATOR);
        token = pump.createMarket("Nothing Meme", "MEME", "ipfs://bafybeimetadata", "ipfs://bafybeiimage", commitment);
    }

    function _deadline() private view returns (uint256) {
        return vm.getBlockTimestamp() + 1;
    }

    function _realReserve(address token) private view returns (uint256 realNusdReserve) {
        (,, realNusdReserve,,,,,,,,) = pump.markets(token);
    }

    /// B-02 (fixed): with tradeFeeBps = 0 the final-buy cap was (R * 10000 - 1) / 10000 = R - 1, so
    /// no buy could add the last wei: the market stopped at 1,500e18 - 1 of reserve, every further
    /// buy reverted InvalidAmount and it could never graduate. The cap is now R * 10000 / (10000 -
    /// fee), which reaches the target exactly for every fee the Pump accepts.
    function testAudit_B02_zeroFeeMarketBecomesReady() public {
        vm.prank(PARAM_ADMIN);
        pump.setMarketParams(CREATE_FEE, 0, VIRTUAL_NUSD, MARKET_CAP_TARGET);
        address token = _createMarket();
        (uint16 fee,, uint120 reserveTarget) = pump.marketParams(token);
        assertEq(fee, 0, "zero-fee market");
        assertEq(reserveTarget, RESERVE_TARGET, "needs 1,500 NUSD of reserve");

        (,,,, bool readyAfter) = pump.quoteBuy(token, 5_000 ether);
        assertTrue(readyAfter, "the quote reports ready");
        uint256 nusdBefore = nusd.balanceOf(TRADER);
        vm.prank(TRADER);
        pump.buy(token, 5_000 ether, 0, _deadline()); // far more than the curve needs
        assertEq(nusdBefore - nusd.balanceOf(TRADER), RESERVE_TARGET, "charged exactly the target");
        assertEq(_realReserve(token), RESERVE_TARGET, "reserve reaches the target");
        assertEq(pump.status(token), READY, "READY");
    }

    /// The same cap never lets a buy overshoot the target, whatever the fee and the path to it.
    function testFuzzAudit_B02_finalBuyLandsExactlyOnTheTarget(uint256 rawFee, uint256 rawFirst) public {
        uint256 feeBps = bound(rawFee, 0, 100);
        vm.prank(PARAM_ADMIN);
        pump.setMarketParams(CREATE_FEE, feeBps, VIRTUAL_NUSD, MARKET_CAP_TARGET);
        address token = _createMarket();

        vm.startPrank(TRADER);
        pump.buy(token, bound(rawFirst, 1 ether, 1_400 ether), 0, _deadline());
        assertEq(pump.status(token), TRADING, "a partial buy leaves it trading");
        pump.buy(token, 5_000 ether, 0, _deadline());
        vm.stopPrank();
        assertEq(_realReserve(token), RESERVE_TARGET, "exactly the target, never above it");
        assertEq(pump.status(token), READY, "READY");
    }

    /// B-03 (accepted): a sell from READY sets the market back to TRADING whatever its size. Mallory sells
    /// 400,000 token-wei (4e-13 of a token), receives 2 wei of NUSD, and the market that held the
    /// full 1,500 NUSD is TRADING at 1,500e18 - 2, so graduate() reverts MarketNotReady. Someone
    /// buys the 2 wei back, she repeats: two rounds cost her 800,000 token-wei and gas.
    function testAudit_B03_dustSellReopensReadyMarket() public {
        address token = _createMarket();
        vm.startPrank(MALLORY);
        pump.buy(token, 1 ether, 0, _deadline()); // a small position bought early
        IERC20(token).approve(address(pump), type(uint256).max);
        vm.stopPrank();
        uint256 malloryTokens = IERC20(token).balanceOf(MALLORY);
        uint256 malloryNusd = nusd.balanceOf(MALLORY);

        vm.prank(TRADER);
        pump.buy(token, 5_000 ether, 0, _deadline());
        assertEq(pump.status(token), READY, "ready");
        assertEq(_realReserve(token), RESERVE_TARGET, "full reserve");

        for (uint256 round = 1; round <= 2; ++round) {
            vm.prank(MALLORY);
            uint256 received = pump.sell(token, 400_000, 1, _deadline());
            assertEq(received, 2, "2 wei of NUSD for the dust");
            assertEq(pump.status(token), TRADING, "back to TRADING");
            assertEq(_realReserve(token), RESERVE_TARGET - 2, "reserve 2 wei short");

            // The admin (the keeper path ends here) can no longer graduate.
            vm.expectRevert(ZeroXPumpV2.MarketNotReady.selector);
            pump.graduate(token, address(0xADA), 1, _deadline());

            // Someone has to buy the 2 wei back before graduation is possible again.
            uint256 traderNusd = nusd.balanceOf(TRADER);
            vm.prank(TRADER);
            pump.buy(token, 1 ether, 0, _deadline());
            assertEq(traderNusd - nusd.balanceOf(TRADER), 2, "2 wei restores it");
            assertEq(pump.status(token), READY, "ready again, until the next dust sell");
        }

        assertEq(malloryTokens - IERC20(token).balanceOf(MALLORY), 800_000, "her whole cost in tokens");
        assertEq(nusd.balanceOf(MALLORY) - malloryNusd, 4, "and she was paid 4 wei for it");
    }

    /// B-04 (accepted, documented owner power): the router admin can allowlist any contract as an adapter after the 1 hour delay, and
    /// the Pump admin picks the adapter on each graduate() call. A market is READY with 1,500
    /// NUSD; an adapter scheduled then is live one hour later and graduate() hands it the whole
    /// reserve (1,500 NUSD) and 250,000,000 tokens. The locker receives 1 wei of a token the
    /// adapter printed, the market reads GRADUATED, and holders can no longer sell on the curve.
    function testAudit_B04_newAdapterTakesReadyReserve() public {
        address token = _createMarket();
        vm.prank(TRADER);
        pump.buy(token, 5_000 ether, 0, _deadline());
        assertEq(pump.status(token), READY, "ready");
        assertEq(_realReserve(token), RESERVE_TARGET, "1,500 NUSD of buyers' money in the curve");
        uint256 feesHeld = pump.accruedProtocolFeesNusd();

        // Router admin: allowlist a new adapter and enable the router. Both wait one hour.
        EvilAdapter evil = new EvilAdapter(OWNER_WALLET);
        router.scheduleAdapter(address(evil));
        router.scheduleEnable();
        vm.warp(vm.getBlockTimestamp() + 1 hours - 1);
        vm.expectRevert(GraduationRouter.TimelockNotReady.selector);
        router.activateAdapter(address(evil));
        vm.warp(vm.getBlockTimestamp() + 1);
        router.activateAdapter(address(evil));
        router.enableRouter();

        // Pump admin: graduate through it.
        pump.graduate(token, address(evil), 1, _deadline());

        assertEq(nusd.balanceOf(address(evil)), RESERVE_TARGET, "the adapter holds the whole reserve");
        assertEq(IERC20(token).balanceOf(address(evil)), 250_000_000 ether, "and the 250M liquidity tokens");
        assertEq(nusd.balanceOf(address(pump)), feesHeld, "the Pump keeps only its accrued fees");
        assertEq(pump.totalRealNusdReserves(), 0, "no curve reserve left");
        assertEq(pump.status(token), GRADUATED, "the market reads graduated");
        assertEq(evil.fakeLp().balanceOf(address(locker)), 1, "the locker locked 1 wei of a made-up token");
        (address lockedLp, uint256 lockedAmount,,,) = locker.locks(token);
        assertEq(lockedLp, address(evil.fakeLp()), "recorded as the permanent lock");
        assertEq(lockedAmount, 1, "of 1 wei");

        // Holders have no curve to sell into any more.
        vm.startPrank(TRADER);
        IERC20(token).approve(address(pump), type(uint256).max);
        vm.expectRevert(ZeroXPumpV2.MarketNotTrading.selector);
        pump.sell(token, 1 ether, 0, _deadline());
        vm.stopPrank();

        // The adapter's owner walks away with the NUSD.
        evil.sweep(address(nusd));
        assertEq(nusd.balanceOf(OWNER_WALLET), RESERVE_TARGET, "1,500 NUSD in the owner's wallet");
    }
}
