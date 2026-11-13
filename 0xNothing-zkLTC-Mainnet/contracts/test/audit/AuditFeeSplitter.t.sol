// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "../TestBase.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FeeSplitter} from "../../src/treasury/FeeSplitter.sol";
import {OwnerTreasury} from "../../src/treasury/OwnerTreasury.sol";
import {OracleNUSDv2} from "../../src/nusd/OracleNUSDv2.sol";
import {IPriceOracle} from "../../src/oracle/IPriceOracle.sol";
import {RewardStaking} from "../../src/rewards/RewardStaking.sol";
import {MockFeeSource, MockPriceOracle, MockWrappedNative} from "../mocks/TokenomicsMocks.sol";

/// A fee source that answers every call with as much data as it is told to.
contract LargeAnswerSource {
    uint256 public size;

    function set(uint256 newSize) external {
        size = newSize;
    }

    fallback() external {
        uint256 s = size;
        assembly {
            return(0, s)
        }
    }
}

/// Test for the change the static analysis of 2026-11 led to in the fee splitter
/// (docs/AUDIT_2026-11.md, section 9.6, S-02). A harvest gives each source a gas cap, but the
/// compiled call still copied the whole answer of the source, and the cost of that copy fell on
/// the harvest. As reviewed, two sources answering with 512 KB each took a harvest from 163,187
/// gas to 3.48 million, more than the 3,000,000 the staking pool forwards, so every stake, claim
/// and sync skipped it. The answer is no longer copied.
contract AuditFeeSplitterTest is TestBase {
    address private constant OWNER = address(0x0E1);

    function testAudit_S02_theAnswerOfASourceNoLongerPricesTheHarvestOut() public {
        vm.warp(1_000_000);
        vm.deal(address(this), 100 ether);
        MockPriceOracle oracle = new MockPriceOracle(100 ether);
        OracleNUSDv2 nusd = new OracleNUSDv2(IPriceOracle(address(oracle)), address(this), 1_000_000 ether);
        MockWrappedNative wrapped = new MockWrappedNative();
        OwnerTreasury treasury = new OwnerTreasury(OWNER);
        RewardStaking staking = new RewardStaking(IERC20(address(nusd)));
        FeeSplitter splitter = new FeeSplitter(address(nusd), address(wrapped), address(treasury), address(this));
        splitter.setRecipients(address(staking), address(treasury));
        staking.bindHarvester(address(splitter));

        MockFeeSource honest = new MockFeeSource(IERC20(address(nusd)), address(splitter));
        FeeSplitter.Source[] memory list = new FeeSplitter.Source[](3);
        for (uint256 index; index < 2; ++index) {
            LargeAnswerSource large = new LargeAnswerSource();
            large.set(512 * 1024);
            list[index] = FeeSplitter.Source(address(large), abi.encodeWithSignature("distributeFees()"));
        }
        list[2] = FeeSplitter.Source(address(honest), abi.encodeWithSignature("distributeFees()"));
        splitter.setSources(list);

        nusd.mintAtOracle{value: 1 ether}(0, address(honest)); // 100 NUSD of fees wait in the honest source
        uint256 before = gasleft();
        staking.sync();
        uint256 used = before - gasleft();
        assertEq(nusd.balanceOf(address(staking)), 70 ether, "the fees reach the stakers through the pool harvest");
        assertLe(used, 2_000_000, "a large answer costs the gas cap of its source and nothing more");
    }

    /// The gas cap itself: a source that burns everything it is given takes its 600,000 and no
    /// more, so the sources after it still run inside the 3,000,000 the staking pool forwards.
    function testAudit_S02_aSourceThatBurnsItsGasCannotStarveTheOthers() public {
        vm.warp(1_000_000);
        vm.deal(address(this), 100 ether);
        MockPriceOracle oracle = new MockPriceOracle(100 ether);
        OracleNUSDv2 nusd = new OracleNUSDv2(IPriceOracle(address(oracle)), address(this), 1_000_000 ether);
        MockWrappedNative wrapped = new MockWrappedNative();
        OwnerTreasury treasury = new OwnerTreasury(OWNER);
        RewardStaking staking = new RewardStaking(IERC20(address(nusd)));
        FeeSplitter splitter = new FeeSplitter(address(nusd), address(wrapped), address(treasury), address(this));
        splitter.setRecipients(address(staking), address(treasury));
        staking.bindHarvester(address(splitter));

        MockFeeSource honest = new MockFeeSource(IERC20(address(nusd)), address(splitter));
        FeeSplitter.Source[] memory list = new FeeSplitter.Source[](2);
        list[0] = FeeSplitter.Source(address(new GasBurningSource()), abi.encodeWithSignature("distributeFees()"));
        list[1] = FeeSplitter.Source(address(honest), abi.encodeWithSignature("distributeFees()"));
        splitter.setSources(list);

        nusd.mintAtOracle{value: 1 ether}(0, address(honest));
        staking.sync();
        assertEq(nusd.balanceOf(address(staking)), 70 ether, "the honest source is still harvested");
    }
}

/// A fee source that never returns: it spends all the gas it is given.
contract GasBurningSource {
    fallback() external {
        while (true) {}
    }
}
