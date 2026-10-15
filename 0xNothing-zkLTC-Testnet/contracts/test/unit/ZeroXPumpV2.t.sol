// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "../TestBase.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {OracleNUSDv2} from "../../src/nusd/OracleNUSDv2.sol";
import {IPriceOracle} from "../../src/oracle/IPriceOracle.sol";
import {ZeroXPumpV2} from "../../src/pump/ZeroXPumpV2.sol";
import {PumpToken} from "../../src/pump/PumpToken.sol";
import {GraduationRouter} from "../../src/graduation/GraduationRouter.sol";
import {PermanentLiquidityLocker} from "../../src/graduation/PermanentLiquidityLocker.sol";
import {FeeSplitter} from "../../src/treasury/FeeSplitter.sol";
import {RewardStaking} from "../../src/rewards/RewardStaking.sol";
import {TwoStepAdmin} from "../../src/common/TwoStepAdmin.sol";
import {MockPriceOracle, MockWrappedNative} from "../mocks/TokenomicsMocks.sol";

contract ZeroXPumpV2Test is TestBase {
    uint256 private constant SUPPLY = 1_000_000_000 ether;
    uint256 private constant VIRTUAL_NUSD = 1_500 ether;
    uint256 private constant MARKET_CAP_TARGET = 6_000 ether;
    uint256 private constant RESERVE_TARGET = 1_500 ether; // sqrt(1,500 x 6,000) - 1,500
    uint256 private constant CREATE_FEE = 1 ether;
    uint256 private constant TRADE_FEE_BPS = 10;

    address private constant CREATOR = address(0xC0FFEE);
    address private constant TRADER = address(0xA11CE);
    address private constant TREASURY = address(0x7EA5);
    address private constant PARAM_ADMIN = address(0x9A9A);
    address private constant STRANGER = address(0xBAD);

    OracleNUSDv2 private nusd;
    RewardStaking private staking;
    FeeSplitter private splitter;
    GraduationRouter private router;
    ZeroXPumpV2 private pump;
    uint256 private reservationNonce;

    function setUp() public {
        vm.warp(1_000_000);
        nusd = new OracleNUSDv2(IPriceOracle(address(new MockPriceOracle(100 ether))), address(this), 1_000_000 ether);
        staking = new RewardStaking(IERC20(address(nusd)));
        splitter = new FeeSplitter(address(nusd), address(new MockWrappedNative()), TREASURY, address(this));
        splitter.setRecipients(address(staking), TREASURY);

        PermanentLiquidityLocker locker = new PermanentLiquidityLocker(address(this));
        router = new GraduationRouter(address(this), 1 hours, address(locker));
        pump = _deployPump(address(splitter), PARAM_ADMIN, VIRTUAL_NUSD, MARKET_CAP_TARGET);
        router.bindPump(address(pump));
        locker.bindRouter(address(router));

        _fund(CREATOR, 1 ether); // 100 NUSD
        _fund(TRADER, 100 ether); // 10,000 NUSD
    }

    function _deployPump(address feeRecipient, address paramAdmin, uint256 virtualNusd, uint256 marketCap)
        private
        returns (ZeroXPumpV2)
    {
        return new ZeroXPumpV2(
            address(nusd),
            address(nusd),
            address(router),
            feeRecipient,
            address(this),
            paramAdmin,
            SUPPLY,
            virtualNusd,
            marketCap,
            CREATE_FEE,
            TRADE_FEE_BPS
        );
    }

    function _fund(address account, uint256 collateralWei) private {
        vm.deal(account, collateralWei);
        vm.startPrank(account);
        nusd.mintAtOracle{value: collateralWei}(0, account);
        nusd.approve(address(pump), type(uint256).max);
        vm.stopPrank();
    }

    function _reserve() private returns (bytes32 commitment) {
        commitment = keccak256(abi.encode("market", ++reservationNonce));
        vm.prank(CREATOR);
        pump.reserveMarket(commitment);
    }

    function _create(bytes32 commitment) private returns (address token) {
        vm.prank(CREATOR);
        token = pump.createMarket("Nothing Meme", "MEME", "ipfs://bafybeimetadata", "ipfs://bafybeiimage", commitment);
    }

    function _createMarket() private returns (address token) {
        token = _create(_reserve());
    }

    function _deadline() private view returns (uint256) {
        return vm.getBlockTimestamp() + 1;
    }

    // ---------------------------------------------------------------- fees

    function testFeesFlowToTheSplitterAndAreSplitInTheSameCall() public {
        address token = _createMarket();
        vm.prank(TRADER);
        pump.buy(token, 1_000 ether, 0, _deadline());
        uint256 reserves = pump.totalRealNusdReserves();
        assertEq(pump.accruedProtocolFeesNusd(), 2 ether, "creation fee + 10 bps of 1,000");

        uint256 supplyBefore = nusd.totalSupply();
        vm.prank(STRANGER);
        assertEq(pump.distributeFees(), 2 ether, "all fees");
        assertEq(pump.accruedProtocolFeesNusd(), 0, "ledger cleared");
        assertEq(nusd.balanceOf(address(pump)), reserves, "only curve reserves remain");
        assertEq(nusd.balanceOf(address(splitter)), 0, "split in the same call");
        assertEq(nusd.balanceOf(address(staking)), 1.4 ether, "70% stakers");
        assertEq(nusd.balanceOf(TREASURY), 0.2 ether, "10% treasury");
        assertEq(supplyBefore - nusd.totalSupply(), 0.4 ether, "20% burned");

        vm.expectRevert(ZeroXPumpV2.InsufficientProtocolFees.selector);
        pump.distributeFees();
    }

    function testAdminCannotWithdrawFeesDirectly() public {
        _createMarket();
        (bool ok,) = address(pump).call(
            abi.encodeWithSignature("withdrawProtocolFees(address,uint256)", address(this), 1 ether)
        );
        assertFalse(ok, "admin fee withdrawal exists");
        assertEq(pump.feeRecipient(), address(splitter), "fixed recipient");
    }

    // ---------------------------------------------------------------- per-market terms

    function testNewTermsApplyOnlyToMarketsCreatedLater() public {
        address early = _createMarket();

        vm.prank(PARAM_ADMIN);
        pump.setMarketParams(2 ether, 50, 3_000 ether, 12_000 ether);
        assertEq(pump.createFee(), 2 ether, "next create fee");
        assertEq(pump.tradeFeeBps(), 50, "next trade fee");
        assertEq(pump.initialVirtualNusdReserve(), 3_000 ether, "next virtual reserve");
        assertEq(pump.graduationThresholdNusd(), 12_000 ether, "next market cap target");
        assertEq(pump.graduationReserveThresholdNusd(), 3_000 ether, "sqrt(3,000 x 12,000) - 3,000");

        uint256 creatorBefore = nusd.balanceOf(CREATOR);
        address late = _createMarket();
        assertEq(creatorBefore - nusd.balanceOf(CREATOR), 2 ether, "new create fee charged");

        (uint16 earlyFee, uint120 earlyCap, uint120 earlyReserve) = pump.marketParams(early);
        assertEq(earlyFee, TRADE_FEE_BPS, "early market keeps its fee");
        assertEq(earlyCap, MARKET_CAP_TARGET, "early market keeps its target");
        assertEq(earlyReserve, RESERVE_TARGET, "early market keeps its reserve target");
        (uint16 lateFee, uint120 lateCap, uint120 lateReserve) = pump.marketParams(late);
        assertEq(lateFee, 50, "late fee");
        assertEq(lateCap, 12_000 ether, "late target");
        assertEq(lateReserve, 3_000 ether, "late reserve target");

        (,,,, uint256 earlyVirtual,,,,,,) = pump.markets(early);
        (,,,, uint256 lateVirtual,,,,,,) = pump.markets(late);
        assertEq(earlyVirtual, VIRTUAL_NUSD, "early curve");
        assertEq(lateVirtual, 3_000 ether, "late curve");

        (,,, uint256 earlyTradeFee,) = pump.quoteBuy(early, 100 ether);
        (,,, uint256 lateTradeFee,) = pump.quoteBuy(late, 100 ether);
        assertEq(earlyTradeFee, 0.1 ether, "10 bps");
        assertEq(lateTradeFee, 0.5 ether, "50 bps");

        vm.prank(TRADER);
        pump.buy(early, 750 ether, 0, _deadline());
        vm.prank(TRADER);
        pump.buy(late, 750 ether, 0, _deadline());
        assertEq(pump.curveProgressBps(early), 4_995, "749.25 of 1,500");
        assertEq(pump.curveProgressBps(late), 2_487, "746.25 of 3,000");
    }

    function testReadinessUsesTheMarketsOwnTarget() public {
        address early = _createMarket();
        vm.prank(PARAM_ADMIN);
        pump.setMarketParams(CREATE_FEE, TRADE_FEE_BPS, 3_000 ether, 12_000 ether);
        address late = _createMarket();

        vm.prank(TRADER);
        pump.buy(early, 5_000 ether, 0, _deadline());
        assertEq(pump.status(early), 2, "ready at its own 1,500 target");
        (,, uint256 earlyReserve,,,,,,,,) = pump.markets(early);
        assertGe(earlyReserve, RESERVE_TARGET, "reached");
        assertLe(earlyReserve, RESERVE_TARGET + 1, "and stopped there");

        vm.prank(TRADER);
        pump.buy(late, 1_600 ether, 0, _deadline());
        assertEq(pump.status(late), 1, "still trading below 3,000");
    }

    function testAReservationKeepsTheFeeItPaid() public {
        bytes32 commitment = _reserve();
        assertTrue(pump.creationReservations(CREATOR, commitment), "reserved");
        assertEq(pump.accruedProtocolFeesNusd(), CREATE_FEE, "paid at reservation");

        vm.prank(PARAM_ADMIN);
        pump.setMarketParams(5 ether, TRADE_FEE_BPS, VIRTUAL_NUSD, MARKET_CAP_TARGET);

        uint256 creatorBefore = nusd.balanceOf(CREATOR);
        vm.expectEmit(false, true, true, true, address(pump));
        emit ZeroXPumpV2.TokenCreated(
            address(0),
            CREATOR,
            commitment,
            "Nothing Meme",
            "MEME",
            "ipfs://bafybeimetadata",
            "ipfs://bafybeiimage",
            SUPPLY,
            SUPPLY,
            VIRTUAL_NUSD,
            SUPPLY,
            MARKET_CAP_TARGET,
            RESERVE_TARGET,
            CREATE_FEE
        );
        address token = _create(commitment);
        assertEq(nusd.balanceOf(CREATOR), creatorBefore, "nothing more charged");
        assertFalse(pump.creationReservations(CREATOR, commitment), "reservation used");
        assertEq(pump.createdTokenByContentHash(CREATOR, commitment), token, "indexed");

        vm.prank(CREATOR);
        vm.expectRevert(ZeroXPumpV2.InvalidReservation.selector);
        pump.reserveMarket(commitment);
    }

    function testCreationCanBeFree() public {
        vm.prank(PARAM_ADMIN);
        pump.setMarketParams(0, TRADE_FEE_BPS, VIRTUAL_NUSD, MARKET_CAP_TARGET);
        vm.prank(CREATOR);
        nusd.approve(address(pump), 0);

        bytes32 commitment = _reserve();
        assertTrue(pump.creationReservations(CREATOR, commitment), "a free reservation still counts");
        assertEq(pump.accruedProtocolFeesNusd(), 0, "no fee");
        address token = _create(commitment);
        assertEq(pump.status(token), 1, "trading");

        vm.prank(CREATOR);
        vm.expectRevert(ZeroXPumpV2.InvalidReservation.selector);
        pump.createMarket("Again", "AGN", "ipfs://bafybeimetadata", "ipfs://bafybeiimage", commitment);
    }

    function testTermsAreCheckedLikeTheConstructor() public {
        vm.startPrank(PARAM_ADMIN);
        vm.expectRevert(ZeroXPumpV2.InvalidConfiguration.selector);
        pump.setMarketParams(CREATE_FEE, 101, VIRTUAL_NUSD, MARKET_CAP_TARGET);
        vm.expectRevert(ZeroXPumpV2.InvalidConfiguration.selector);
        pump.setMarketParams(100 ether + 1, TRADE_FEE_BPS, VIRTUAL_NUSD, MARKET_CAP_TARGET);
        vm.expectRevert(ZeroXPumpV2.InvalidConfiguration.selector);
        pump.setMarketParams(CREATE_FEE, TRADE_FEE_BPS, 0, MARKET_CAP_TARGET);
        vm.expectRevert(ZeroXPumpV2.InvalidConfiguration.selector);
        pump.setMarketParams(CREATE_FEE, TRADE_FEE_BPS, VIRTUAL_NUSD, VIRTUAL_NUSD);
        vm.expectRevert(ZeroXPumpV2.InvalidConfiguration.selector);
        pump.setMarketParams(CREATE_FEE, TRADE_FEE_BPS, VIRTUAL_NUSD, uint256(type(uint120).max) + 1);

        pump.setMarketParams(100 ether, 100, VIRTUAL_NUSD, MARKET_CAP_TARGET);
        vm.stopPrank();
        assertEq(pump.createFee(), 100 ether, "upper bound accepted");
        assertEq(pump.tradeFeeBps(), 100, "1% accepted");
    }

    function testOnlyTheParamAdminTunesTermsAndHandsOverInTwoSteps() public {
        vm.expectRevert(TwoStepAdmin.Unauthorized.selector);
        pump.setMarketParams(CREATE_FEE, TRADE_FEE_BPS, VIRTUAL_NUSD, MARKET_CAP_TARGET);
        vm.prank(STRANGER);
        vm.expectRevert(TwoStepAdmin.Unauthorized.selector);
        pump.transferParamAdmin(STRANGER);

        vm.prank(PARAM_ADMIN);
        pump.transferParamAdmin(STRANGER);
        assertEq(pump.paramAdmin(), PARAM_ADMIN, "not before acceptance");
        assertEq(pump.pendingParamAdmin(), STRANGER, "pending");
        vm.expectRevert(TwoStepAdmin.Unauthorized.selector);
        pump.acceptParamAdmin();

        vm.prank(STRANGER);
        pump.acceptParamAdmin();
        assertEq(pump.paramAdmin(), STRANGER, "handed over");
        assertEq(pump.pendingParamAdmin(), address(0), "cleared");
        vm.prank(PARAM_ADMIN);
        vm.expectRevert(TwoStepAdmin.Unauthorized.selector);
        pump.setMarketParams(CREATE_FEE, TRADE_FEE_BPS, VIRTUAL_NUSD, MARKET_CAP_TARGET);
        assertEq(pump.admin(), address(this), "graduation admin untouched");
    }

    // ---------------------------------------------------------------- pause

    function testPauseStopsNewExposureButHoldersCanStillSell() public {
        address token = _createMarket();
        vm.prank(TRADER);
        (uint256 bought,) = pump.buy(token, 10 ether, 0, _deadline());
        bytes32 commitment = _reserve();
        pump.setPaused(true);

        vm.prank(CREATOR);
        vm.expectRevert(ZeroXPumpV2.ContractPaused.selector);
        pump.createMarket("Paused", "PAUSE", "ipfs://bafybeimetadata", "ipfs://bafybeiimage", commitment);
        vm.prank(TRADER);
        vm.expectRevert(ZeroXPumpV2.ContractPaused.selector);
        pump.buy(token, 1 ether, 0, _deadline());

        vm.prank(TRADER);
        PumpToken(token).approve(address(pump), bought);
        uint256 before = nusd.balanceOf(TRADER);
        vm.prank(TRADER);
        uint256 received = pump.sell(token, bought, 0, _deadline());
        assertGt(received, 0, "sell while paused");
        assertEq(nusd.balanceOf(TRADER) - before, received, "paid out");
    }

    // ---------------------------------------------------------------- deployment

    function testConstructorRejectsMissingWiring() public {
        vm.expectRevert(ZeroXPumpV2.InvalidConfiguration.selector);
        _deployPump(address(0), PARAM_ADMIN, VIRTUAL_NUSD, MARKET_CAP_TARGET);
        vm.expectRevert(ZeroXPumpV2.InvalidConfiguration.selector);
        _deployPump(address(splitter), address(0), VIRTUAL_NUSD, MARKET_CAP_TARGET);
        vm.expectRevert(ZeroXPumpV2.InvalidConfiguration.selector);
        _deployPump(address(splitter), PARAM_ADMIN, MARKET_CAP_TARGET, MARKET_CAP_TARGET);
    }

    function testRuntimeFitsTheContractSizeLimit() public view {
        assertLe(address(pump).code.length, 24_576, "EIP-170");
    }
}
