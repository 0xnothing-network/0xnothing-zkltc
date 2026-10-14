// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "../TestBase.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {NUSD} from "../../src/nusd/NUSD.sol";
import {ZeroXPumpV2} from "../../src/pump/ZeroXPumpV2.sol";
import {PumpToken} from "../../src/pump/PumpToken.sol";
import {GraduationRouter} from "../../src/graduation/GraduationRouter.sol";
import {PermanentLiquidityLocker} from "../../src/graduation/PermanentLiquidityLocker.sol";
import {FeeSplitter} from "../../src/treasury/FeeSplitter.sol";

contract ZeroXPumpV2Test is TestBase {
    uint256 private constant SUPPLY = 1_000_000_000 ether;
    uint256 private constant VIRTUAL_NUSD = 1_500 ether;
    uint256 private constant MARKET_CAP_TARGET = 6_000 ether;

    NUSD private nusd;
    GraduationRouter private router;
    ZeroXPumpV2 private pump;
    FeeSplitter private splitter;
    uint256 private reservationNonce;

    address private constant CREATOR = address(0xC0FFEE);
    address private constant TRADER = address(0xA11CE);
    address private constant POOL = address(0xB001);
    address private constant TREASURY = address(0x7EA5);

    function setUp() public {
        vm.warp(1_000_000);
        nusd = new NUSD(address(this));
        nusd.bindVault(address(this));
        PermanentLiquidityLocker locker = new PermanentLiquidityLocker(address(this));
        router = new GraduationRouter(address(this), 1 hours, address(locker));
        splitter = new FeeSplitter(IERC20(address(nusd)), POOL, TREASURY);
        pump = new ZeroXPumpV2(
            address(nusd),
            address(nusd),
            address(router),
            address(splitter),
            address(this),
            SUPPLY,
            VIRTUAL_NUSD,
            MARKET_CAP_TARGET
        );
        router.bindPump(address(pump));
        locker.bindRouter(address(router));

        nusd.mint(CREATOR, 100 ether);
        nusd.mint(TRADER, 100_000 ether);
        vm.prank(CREATOR);
        nusd.approve(address(pump), type(uint256).max);
        vm.prank(TRADER);
        nusd.approve(address(pump), type(uint256).max);
    }

    function _createMarket() private returns (address token) {
        bytes32 commitment = keccak256(abi.encode("v2-market", ++reservationNonce));
        vm.startPrank(CREATOR);
        pump.reserveMarket(commitment);
        token = pump.createMarket("Nothing Meme", "MEME", "ipfs://bafybeimetadata", "ipfs://bafybeiimage", commitment);
        vm.stopPrank();
    }

    function testAnyoneSendsFeesToTheSplitterWithoutTouchingReserves() public {
        address token = _createMarket();
        vm.prank(TRADER);
        pump.buy(token, 1_000 ether, 0, vm.getBlockTimestamp() + 1);
        uint256 reserves = pump.totalRealNusdReserves();
        uint256 fees = pump.accruedProtocolFeesNusd();
        assertEq(fees, 1 ether + 1 ether, "creation fee + 10 bps of 1,000");

        vm.prank(TRADER);
        uint256 sent = pump.distributeFees();
        assertEq(sent, fees, "all fees");
        assertEq(pump.accruedProtocolFeesNusd(), 0, "ledger cleared");
        assertEq(nusd.balanceOf(address(pump)), reserves, "only curve reserves remain");
        assertEq(nusd.balanceOf(address(splitter)), 0, "split in the same call");
        assertEq(nusd.balanceOf(POOL), fees / 2, "50% reward pool");
        assertEq(nusd.balanceOf(TREASURY), fees - fees / 2, "50% treasury");

        vm.expectRevert(ZeroXPumpV2.InsufficientProtocolFees.selector);
        pump.distributeFees();
    }

    function testAdminCannotWithdrawFeesDirectly() public {
        _createMarket();
        (bool ok,) = address(pump).call(
            abi.encodeWithSignature("withdrawProtocolFees(address,uint256)", address(this), 1 ether)
        );
        assertFalse(ok, "admin fee withdrawal still exists");
        assertEq(pump.feeRecipient(), address(splitter), "fixed recipient");
    }

    function testPauseStopsNewExposureButHoldersCanStillSell() public {
        address token = _createMarket();
        vm.prank(TRADER);
        (uint256 bought,) = pump.buy(token, 10 ether, 0, vm.getBlockTimestamp() + 1);
        bytes32 commitment = keccak256("paused-create");
        vm.prank(CREATOR);
        pump.reserveMarket(commitment);
        pump.setPaused(true);

        vm.prank(CREATOR);
        vm.expectRevert();
        pump.createMarket("Paused", "PAUSE", "ipfs://metadata", "ipfs://image", commitment);
        vm.prank(TRADER);
        vm.expectRevert();
        pump.buy(token, 1 ether, 0, vm.getBlockTimestamp() + 1);

        vm.prank(TRADER);
        PumpToken(token).approve(address(pump), bought);
        uint256 before = nusd.balanceOf(TRADER);
        vm.prank(TRADER);
        uint256 received = pump.sell(token, bought, 0, vm.getBlockTimestamp() + 1);
        assertGt(received, 0, "sell while paused");
        assertEq(nusd.balanceOf(TRADER) - before, received, "paid out");
    }

    function testConstructorRejectsMissingFeeRecipient() public {
        vm.expectRevert(ZeroXPumpV2.InvalidConfiguration.selector);
        new ZeroXPumpV2(
            address(nusd), address(nusd), address(router), address(0), address(this), SUPPLY, VIRTUAL_NUSD, MARKET_CAP_TARGET
        );
    }
}
