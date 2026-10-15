// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TestBase} from "../TestBase.sol";
import {OracleNUSDv2} from "../../src/nusd/OracleNUSDv2.sol";
import {OracleRouter} from "../../src/oracle/OracleRouter.sol";
import {IPriceOracle} from "../../src/oracle/IPriceOracle.sol";
import {RewardStaking} from "../../src/rewards/RewardStaking.sol";
import {FeeSplitter} from "../../src/treasury/FeeSplitter.sol";
import {ZeroXPumpV2} from "../../src/pump/ZeroXPumpV2.sol";

interface VmFork {
    function mockCall(address callee, bytes calldata data, bytes calldata returnData) external;
}

interface IRouterV3 {
    function feeSplitter() external view returns (address);
    function treasury() external view returns (address);
}

interface ILendingV3 {
    function feeSplitter() external view returns (address);
}

/// Operator smoke test of the DEPLOYED v3 suite (deployments/liteforge-testnet/v3.json) on a local
/// LiteForge fork. Runs only when LITVM_RPC_URL is set; nothing is broadcast. Prices are pinned
/// at the routers so a stale DIA round at the fork block cannot fail the run.
contract TokenomicsSmokeForkTest is TestBase {
    address private constant DEPLOYER = 0x58633401dCc383F010688e950878000000000000;
    OracleRouter private constant LTC_ORACLE = OracleRouter(0xf9CCF611b7c4e642852D3d1a7A6C3883985A2962);
    address private constant LTC_ADAPTER = 0x54361dB5F9DF455B448E882Ce65612D5e418f3Ee;
    OracleNUSDv2 private constant NUSD = OracleNUSDv2(payable(0x69320A82ACCeC1b8A5EF59fd02b217e7ea4aEa19));
    address private constant TREASURY = 0xC5353F677E69c3386c752ab3b3FD7CA2c9372052;
    RewardStaking private constant STAKING = RewardStaking(0x59589d9a5840D2CEF7A6e4A8cB55C258cc73E483);
    FeeSplitter private constant SPLITTER = FeeSplitter(payable(0xAea1Ef82Dbe800BB3683009630813457D990a9B0));
    ZeroXPumpV2 private constant PUMP = ZeroXPumpV2(0x0239baEc3c695A6EA893Ad90a7608112e0580526);
    address private constant CONTROLLER = 0x935ec3B5ED5ef330895C87139e0a905B009187a5;
    IRouterV3 private constant DEX_ROUTER = IRouterV3(0x1cda4793122a223A09be54ED5f664ba222eEe042);
    ILendingV3 private constant LENDING = ILendingV3(0x6Cc96c044321b3205Ac108107Fc6d2d47e0B3E44);

    address private constant USER = address(0x5A0E);
    VmFork private constant vmf = VmFork(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private pinnedPrice;

    function _fork() private returns (bool) {
        string memory rpcUrl = vm.envOr("LITVM_RPC_URL", string(""));
        if (bytes(rpcUrl).length == 0) return false;
        vm.createSelectFork(rpcUrl);
        try LTC_ORACLE.readPriceWad() returns (uint256 price, uint256, uint80) {
            pinnedPrice = price;
        } catch {
            pinnedPrice = 60 ether; // DIA stale at the fork block: pin a representative price.
        }
        _pinPrice(pinnedPrice);
        return true;
    }

    function _pinPrice(uint256 price) private {
        vmf.mockCall(
            address(LTC_ORACLE),
            abi.encodeWithSelector(IPriceOracle.readPriceWad.selector),
            abi.encode(price, vm.getBlockTimestamp(), uint80(1))
        );
    }

    function _skip(uint256 seconds_) private {
        vm.warp(vm.getBlockTimestamp() + seconds_);
        _pinPrice(pinnedPrice);
    }

    function testDeployedWiringMatchesTheDesign() public {
        if (!_fork()) return;
        assertEq(address(NUSD.oracle()), address(LTC_ORACLE), "NUSD oracle router");
        assertEq(address(LTC_ORACLE.source()), LTC_ADAPTER, "router source");
        assertEq(LTC_ORACLE.admin(), DEPLOYER, "router admin");
        assertEq(NUSD.surplusStaking(), address(STAKING), "surplus to stakers");
        assertEq(NUSD.surplusTreasury(), TREASURY, "surplus to treasury");
        assertEq(NUSD.surplusTreasuryBps(), 2_000, "80/20");
        assertEq(NUSD.surplusFloorBps(), 30_000, "3.0x floor");
        assertEq(NUSD.surplusTriggerBps(), 33_000, "3.3x trigger");
        assertGe(NUSD.supplyCeilingNusd(), 1_000_000 ether, "ceiling");
        assertTrue(NUSD.hasRole(NUSD.DEFAULT_ADMIN_ROLE(), DEPLOYER), "owner");

        assertEq(SPLITTER.staking(), address(STAKING), "splitter stakers");
        assertEq(SPLITTER.treasury(), TREASURY, "splitter treasury");
        assertEq(SPLITTER.stakerBps(), 7_000, "70% stakers");
        assertEq(SPLITTER.burnBps(), 2_000, "20% burn");
        assertEq(SPLITTER.treasuryBps(), 1_000, "10% treasury");
        assertEq(SPLITTER.reserveBps(), 9_000, "90% of zkLTC backs NUSD");
        assertEq(SPLITTER.sourceCount(), 4, "Pump, router NUSD, router WzkLTC, lending");
        assertEq(STAKING.harvester(), address(SPLITTER), "stakes harvest the splitter");

        assertEq(PUMP.feeRecipient(), address(SPLITTER), "Pump fees");
        assertEq(PUMP.admin(), CONTROLLER, "graduation controller");
        assertEq(PUMP.paramAdmin(), DEPLOYER, "Pump terms");
        assertEq(DEX_ROUTER.feeSplitter(), address(SPLITTER), "router NUSD fees");
        assertEq(DEX_ROUTER.treasury(), address(SPLITTER), "router WzkLTC fees");
        assertEq(LENDING.feeSplitter(), address(SPLITTER), "lending spread");
    }

    function testPumpFeesHarvestStreamAndRedeemOnLiveBytecode() public {
        if (!_fork()) return;
        vm.deal(USER, 10 ether);
        vm.startPrank(USER);
        NUSD.mintAtOracle{value: 1 ether}(0, USER);
        IERC20(address(NUSD)).approve(address(PUMP), type(uint256).max);
        bytes32 commitment = keccak256("v3-fork-smoke");
        PUMP.reserveMarket(commitment);
        address token = PUMP.createMarket("Smoke", "SMK", "ipfs://bafybeimetadata", "ipfs://bafybeiimage", commitment);
        PUMP.buy(token, 10 ether, 0, vm.getBlockTimestamp() + 1);
        vm.stopPrank();
        (uint16 tradeFeeBps,,) = PUMP.marketParams(token);
        assertEq(tradeFeeBps, 10, "market snapshot");

        uint256 fees = PUMP.accruedProtocolFeesNusd();
        uint256 stakingBefore = NUSD.balanceOf(address(STAKING));
        uint256 supplyBefore = NUSD.totalSupply();
        SPLITTER.harvest();
        assertEq(PUMP.accruedProtocolFeesNusd(), 0, "collected");
        assertGe(NUSD.balanceOf(address(STAKING)) - stakingBefore, fees * 7_000 / 10_000, "stakers' 70%");
        assertGe(supplyBefore - NUSD.totalSupply(), fees * 2_000 / 10_000, "20% burned");

        // A stake picks the income up and streams it; a week later it is claimable.
        vm.startPrank(USER);
        IERC20(address(NUSD)).approve(address(STAKING), 10 ether);
        uint256 positionId = STAKING.stake(10 ether, 30 days);
        vm.stopPrank();
        assertGt(STAKING.rewardRate(), 0, "streaming");
        _skip(7 days);
        assertGt(STAKING.earned(USER), 0, "rewards accrued");
        vm.prank(USER);
        assertGt(STAKING.claim(USER), 0, "claimed");

        _skip(30 days);
        vm.prank(USER);
        STAKING.withdraw(positionId);

        uint256 quote = NUSD.quoteRedeem(5 ether);
        assertGt(quote, 0, "redeem quote");
        vm.prank(USER);
        assertEq(NUSD.redeemAtOracle(5 ether, quote, USER), quote, "redeemed");
    }

    function testSurplusReleasesEightyTwentyWhenLtcRallies() public {
        if (!_fork()) return;
        (, bool readyNow) = NUSD.surplusMintCapacity();
        assertFalse(readyNow, "no surplus near 1x");

        pinnedPrice = pinnedPrice * 4; // 4x: well above the 3.3x trigger
        _pinPrice(pinnedPrice);
        (uint256 capacity, bool ready) = NUSD.surplusMintCapacity();
        if (!ready) return; // a release ran within the last week on the live chain
        uint256 stakingBefore = NUSD.balanceOf(address(STAKING));
        uint256 treasuryBefore = NUSD.balanceOf(TREASURY);
        assertEq(NUSD.releaseSurplus(), capacity, "released");
        uint256 toTreasury = capacity * 2_000 / 10_000;
        assertEq(NUSD.balanceOf(TREASURY) - treasuryBefore, toTreasury, "20% treasury");
        assertEq(NUSD.balanceOf(address(STAKING)) - stakingBefore, capacity - toTreasury, "80% stakers");
        assertGe(NUSD.backingRatioWad(), 3e18, "back at 3.0x");
    }
}
