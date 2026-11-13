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

/// Adversarial review of the B-02 fix: the cap on the last buy is now R * 10000 / (10000 - fee).
/// Disposable evidence; every test passes. Wiring as in test/audit/AuditPump.t.sol.
contract AuditPumpCapTest is TestBase {
    uint256 private constant SUPPLY = 1_000_000_000 ether;
    uint256 private constant VIRTUAL_NUSD = 1_500 ether;
    uint256 private constant MARKET_CAP_TARGET = 6_000 ether;
    uint256 private constant RESERVE_TARGET = 1_500 ether;
    uint256 private constant CREATE_FEE = 1 ether;
    uint256 private constant D = 10_000;
    uint256 private constant HUGE = type(uint128).max;
    uint8 private constant TRADING = 1;
    uint8 private constant READY = 2;

    address private constant CREATOR = address(0xC0FFEE);
    address private constant TREASURY = address(0x7EA5);
    address private constant PARAM_ADMIN = address(0x9A9A);
    address[3] private traders = [address(0xA11CE), address(0xB0B), address(0xCA201)];

    struct State {
        uint256 tokenReserve;
        uint256 real;
        uint256 vToken;
        uint256 vNusd;
        uint8 status;
    }

    /// One market under test and the terms it was created with.
    struct Run {
        address token;
        uint256 fee;
        uint256 threshold;
        uint256 initialVirtualNusd;
        uint256 reservesBefore; // total real reserves of the markets created earlier in the test
    }

    OracleNUSDv2 private nusd;
    ZeroXPumpV2 private pump;
    uint256 private reservationNonce;

    event log_named_uint(string key, uint256 value);

    function setUp() public {
        vm.warp(1_000_000);
        nusd = new OracleNUSDv2(IPriceOracle(address(new MockPriceOracle(100 ether))), address(this), 100_000_000 ether);
        RewardStaking staking = new RewardStaking(IERC20(address(nusd)));
        FeeSplitter splitter = new FeeSplitter(address(nusd), address(new MockWrappedNative()), TREASURY, address(this));
        splitter.setRecipients(address(staking), TREASURY);
        PermanentLiquidityLocker locker = new PermanentLiquidityLocker(address(this));
        GraduationRouter router = new GraduationRouter(address(this), 1 hours, address(locker));
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
            10
        );
        router.bindPump(address(pump));
        locker.bindRouter(address(router));

        _fund(CREATOR, 100 ether); // 10,000 NUSD
        for (uint256 i; i < traders.length; ++i) {
            _fund(traders[i], 200_000 ether); // 20,000,000 NUSD each
        }
    }

    // ------------------------------------------------------------------ helpers

    function _fund(address account, uint256 collateralWei) private {
        vm.deal(account, collateralWei);
        vm.startPrank(account);
        nusd.mintAtOracle{value: collateralWei}(0, account);
        nusd.approve(address(pump), type(uint256).max);
        vm.stopPrank();
    }

    function _createMarket() private returns (address token) {
        bytes32 commitment = keccak256(abi.encode("review-market", ++reservationNonce));
        vm.prank(CREATOR);
        pump.reserveMarket(commitment);
        vm.prank(CREATOR);
        token = pump.createMarket("Review", "RVW", "ipfs://bafybeimetadata", "ipfs://bafybeiimage", commitment);
        for (uint256 i; i < traders.length; ++i) {
            vm.prank(traders[i]);
            IERC20(token).approve(address(pump), type(uint256).max);
        }
    }

    function _deadline() private view returns (uint256) {
        return vm.getBlockTimestamp() + 1;
    }

    function _state(address token) private view returns (State memory s) {
        (, s.tokenReserve, s.real, s.vToken, s.vNusd,,,,,,) = pump.markets(token);
        s.status = pump.status(token);
    }

    function _buy(address trader, address token, uint256 maxNusdIn) private returns (uint256 tokenOut, uint256 paid) {
        uint256 deadline = _deadline();
        uint256 before = nusd.balanceOf(trader);
        vm.prank(trader);
        (tokenOut, paid) = pump.buy(token, maxNusdIn, 0, deadline);
        assertEq(before - nusd.balanceOf(trader), paid, "charged what the call reported");
    }

    function _largestHolder(address token) private view returns (address holder, uint256 balance) {
        for (uint256 i; i < traders.length; ++i) {
            uint256 held = IERC20(token).balanceOf(traders[i]);
            if (held > balance) {
                balance = held;
                holder = traders[i];
            }
        }
    }

    /// From READY, sells exactly as many tokens as take `remainder` wei of NUSD out of the curve.
    function _sellDownTo(address token, address trader, uint256 remainder, uint256 threshold) private {
        State memory s = _state(token);
        assertEq(s.status, READY, "starts from READY");
        // Smallest tokenIn with floor(tokenIn * vN / (vT + tokenIn)) >= remainder.
        uint256 tokenIn = (remainder * s.vToken + (s.vNusd - remainder) - 1) / (s.vNusd - remainder);
        (uint256 curveOut,,) = pump.quoteSell(token, tokenIn);
        assertEq(curveOut, remainder, "the sell takes out exactly the remainder");
        uint256 deadline = _deadline();
        vm.prank(trader);
        pump.sell(token, tokenIn, 0, deadline);
        s = _state(token);
        assertEq(s.status, TRADING, "a sell from READY reopens the curve");
        assertEq(threshold - s.real, remainder, "exactly the remainder is missing");
    }

    /// With `remainder` wei missing: the quote, the wei below and above the cap, then the fill.
    function _checkQuoteAndFill(address token, address trader, uint256 fee, uint256 remainder, uint256 threshold) private {
        (uint256 tokenOut, uint256 curve, uint256 user, uint256 feeNusd, bool ready) = pump.quoteBuy(token, HUGE);
        assertEq(curve, remainder, "the capped buy adds exactly the remainder");
        assertEq(user, remainder * D / (D - fee), "cap = R * 10000 / (10000 - fee)");
        assertEq(feeNusd, user * fee / D, "fee on the capped payment");
        assertEq(user - feeNusd, remainder, "payment minus fee is the remainder");
        assertTrue(ready, "the quote reports READY");
        assertGt(tokenOut, 0, "and pays out tokens");

        // A wei more than the cap is not taken.
        (,, uint256 userAbove,,) = pump.quoteBuy(token, user + 1);
        assertEq(userAbove, user, "payment is capped");
        // A wei less than the cap never adds more than the remainder.
        if (user > 1) {
            (, uint256 curveBelow, uint256 userBelow,, bool readyBelow) = pump.quoteBuy(token, user - 1);
            assertEq(userBelow, user - 1, "below the cap the whole payment is taken");
            assertLe(curveBelow, remainder, "no overshoot below the cap");
            assertTrue(readyBelow == (curveBelow == remainder), "READY exactly when the remainder is covered");
        }

        (, uint256 paid) = _buy(trader, token, HUGE);
        assertEq(paid, user, "the buy charges the quoted cap");
        State memory s = _state(token);
        assertEq(s.real, threshold, "the reserve is exactly the target");
        assertEq(s.status, READY, "READY");
    }

    function _everyRemainder(uint256 firstFee, uint256 lastFee) private {
        uint256[12] memory remainders = [
            uint256(1),
            2,
            3,
            99,
            100,
            101,
            9_999,
            10_000,
            10_001,
            1 ether - 1,
            1 ether + 7,
            1_499 ether + 123_456_789
        ];
        address trader = traders[0];
        for (uint256 fee = firstFee; fee <= lastFee; ++fee) {
            vm.prank(PARAM_ADMIN);
            pump.setMarketParams(CREATE_FEE, fee, VIRTUAL_NUSD, MARKET_CAP_TARGET);
            address token = _createMarket();
            (, uint256 paid) = _buy(trader, token, HUGE);
            assertEq(paid, RESERVE_TARGET * D / (D - fee), "one buy from empty pays the cap");
            State memory s = _state(token);
            assertEq(s.real, RESERVE_TARGET, "and lands on the target");
            assertEq(s.status, READY, "READY after one large buy");
            for (uint256 i; i < remainders.length; ++i) {
                _sellDownTo(token, trader, remainders[i], RESERVE_TARGET);
                _checkQuoteAndFill(token, trader, fee, remainders[i], RESERVE_TARGET);
            }
        }
    }

    // ------------------------------------------------------------------ every fee, chosen remainders

    /// For every fee the Pump accepts (0 to 100 bps) and remainders from 1 wei to almost the whole
    /// target: the capped buy adds exactly the remainder, nothing underflows at 1 wei, a sell from
    /// READY reopens the curve and one buy closes it again on the target.
    function testAudit_B02_everyFeeEveryRemainder_0to33() public {
        _everyRemainder(0, 33);
    }

    function testAudit_B02_everyFeeEveryRemainder_34to67() public {
        _everyRemainder(34, 67);
    }

    function testAudit_B02_everyFeeEveryRemainder_68to100() public {
        _everyRemainder(68, 100);
    }

    // ------------------------------------------------------------------ random terms and paths

    function _invariants(Run memory run) private view returns (State memory s) {
        s = _state(run.token);
        assertLe(s.real, run.threshold, "the reserve is above the target");
        assertTrue((s.status == READY) == (s.real == run.threshold), "READY and a full reserve go together");
        assertEq(s.vNusd, run.initialVirtualNusd + s.real, "virtual NUSD = initial + real");
        assertEq(s.vToken, s.tokenReserve, "virtual tokens = token reserve");
        assertEq(IERC20(run.token).balanceOf(address(pump)), s.tokenReserve, "the Pump holds its token reserve");
        assertEq(pump.totalRealNusdReserves() - run.reservesBefore, s.real, "total reserves track this market");
        assertEq(
            nusd.balanceOf(address(pump)),
            pump.totalRealNusdReserves() + pump.accruedProtocolFeesNusd(),
            "NUSD held = reserves + fees"
        );
    }

    function _randomTerms(uint256 seed) private returns (bool accepted, Run memory run) {
        run.fee = seed % 101;
        uint256 exponent = 15 + ((seed >> 8) % 7); // 1e15 .. 1e21 wei
        uint256 mantissa = 1_000 + ((seed >> 16) % 9_000); // 1.000 .. 9.999
        run.initialVirtualNusd = mantissa * 10 ** (exponent - 3);
        uint256 multiple = 1_001 + ((seed >> 32) % 24_000); // cap = 1.001x .. 25x the virtual reserve
        uint256 marketCap = run.initialVirtualNusd * multiple / 1_000;
        vm.prank(PARAM_ADMIN);
        try pump.setMarketParams(CREATE_FEE, run.fee, run.initialVirtualNusd, marketCap) {
            accepted = true;
        } catch {
            return (false, run); // terms the Pump refuses (rounding in its own curve check)
        }
        run.threshold = pump.graduationReserveThresholdNusd();
        run.reservesBefore = pump.totalRealNusdReserves();
        run.token = _createMarket();
    }

    function _randomBuy(Run memory run, address trader, uint256 r) private returns (uint256 trades) {
        State memory s = _state(run.token);
        if (s.status == READY) {
            vm.prank(trader);
            vm.expectRevert(ZeroXPumpV2.MarketNotTrading.selector);
            pump.buy(run.token, 1 ether, 0, HUGE);
            return 0;
        }
        uint256 remainder = run.threshold - s.real;
        uint256 cap = remainder * D / (D - run.fee);
        uint256 pick = (r >> 16) % 6;
        uint256 amount;
        if (pick == 0) amount = 1;
        else if (pick == 1) amount = 1 + (r >> 24) % remainder;
        else if (pick == 2) amount = cap;
        else if (pick == 3) amount = cap > 1 ? cap - 1 : 1;
        else if (pick == 4) amount = cap + 1;
        else amount = 1 + (r >> 24) % (3 * remainder);
        // While TRADING a buy of 1 wei or more must go through: _buy does not catch a revert.
        (uint256 tokenOut, uint256 paid) = _buy(trader, run.token, amount);
        assertGt(tokenOut, 0, "a buy paid out nothing");
        assertEq(paid, amount < cap ? amount : cap, "payment = min(amount, cap)");
        return 1;
    }

    function _randomSell(Run memory run, address trader, uint256 r) private returns (uint256 trades) {
        uint256 balance = IERC20(run.token).balanceOf(trader);
        if (balance == 0) return 0;
        uint256 pick = (r >> 16) % 3;
        uint256 amount = pick == 0 ? balance : pick == 1 ? 1 + (r >> 24) % balance : 1 + (r >> 24) % 1_000_000;
        if (amount > balance) amount = balance;
        vm.prank(trader);
        try pump.sell(run.token, amount, 0, HUGE) {
            assertEq(pump.status(run.token), TRADING, "any sell leaves the market TRADING");
            return 1;
        } catch {
            return 0; // dust worth less than 1 wei of NUSD
        }
    }

    /// Random terms inside the admin bounds, random buys and sells by three traders. After every
    /// step the reserve is at or below the target; while TRADING every buy of 1 wei or more goes
    /// through (no state where the curve can no longer be filled); one large buy always ends on the
    /// target; a sell from READY reopens and the next large buy closes it again.
    function _randomRun(uint256 seed) private returns (bool ran, uint256 trades) {
        Run memory run;
        (ran, run) = _randomTerms(seed);
        if (!ran) return (false, 0);
        _invariants(run);

        for (uint256 step; step < 14; ++step) {
            uint256 r = uint256(keccak256(abi.encode(seed, step)));
            address trader = traders[r % 3];
            if ((r >> 8) % 8 < 5) trades += _randomBuy(run, trader, r);
            else trades += _randomSell(run, trader, r);
            _invariants(run);
        }

        // One large buy always reaches READY on the target.
        if (pump.status(run.token) == TRADING) {
            (,,,, bool ready) = pump.quoteBuy(run.token, HUGE);
            assertTrue(ready, "the large quote reports READY");
            _buy(traders[0], run.token, HUGE);
        }
        State memory end = _invariants(run);
        assertEq(end.status, READY, "READY after one large buy");
        assertEq(end.real, run.threshold, "on the target");

        // A sell from READY, then the refill by someone else.
        (address holder, uint256 held) = _largestHolder(run.token);
        uint256 part = 1 + (seed >> 64) % held;
        vm.prank(holder);
        try pump.sell(run.token, part, 0, HUGE) {
            end = _invariants(run);
            assertEq(end.status, TRADING, "reopened");
            _buy(holder == traders[1] ? traders[2] : traders[1], run.token, HUGE);
            end = _invariants(run);
            assertEq(end.status, READY, "READY again");
            assertEq(end.real, run.threshold, "on the target again");
        } catch {
            // Dust worth less than 1 wei of NUSD: the sell is refused and READY stands.
            assertEq(pump.status(run.token), READY, "still READY");
        }
    }

    /// forge-config: default.fuzz.runs = 2000
    function testFuzzAudit_B02_randomTermsAndTradesNeverOvershoot(uint256 seed) public {
        _randomRun(seed);
    }

    /// How many of 60 fixed seeds the Pump accepts terms for, so the fuzz above is known not to be
    /// skipping its work.
    function testAudit_B02_randomRunsAreNotVacuous() public {
        uint256 accepted;
        uint256 trades;
        for (uint256 i; i < 60; ++i) {
            (bool ran, uint256 count) = _randomRun(uint256(keccak256(abi.encode("review-pump", i))));
            if (ran) ++accepted;
            trades += count;
        }
        emit log_named_uint("seeds with accepted terms (of 60)", accepted);
        emit log_named_uint("trades executed", trades);
        assertGe(accepted, 40, "most random terms are accepted");
        assertGe(trades, 300, "and traded");
    }

    // ------------------------------------------------------------------ the unit test tolerance

    /// test/unit/ZeroXPumpV2.t.sol::testReadinessUsesTheMarketsOwnTarget accepts a reserve of
    /// target + 1 ("and stopped there"). The same scenario lands on the target exactly, so the
    /// tolerance only hides a 1 wei overshoot if one is ever introduced.
    function testAudit_B02_note_unitTestScenarioLandsExactly() public {
        address early = _createMarket(); // constructor terms: 10 bps, 1,500 target
        _buy(traders[0], early, 5_000 ether);
        State memory s = _state(early);
        assertEq(s.real, RESERVE_TARGET, "exactly 1,500e18, not 1,500e18 + 1");
        assertEq(s.status, READY, "READY");
    }
}
