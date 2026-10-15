// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "../TestBase.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FeeSplitter} from "../../src/treasury/FeeSplitter.sol";
import {OwnerTreasury} from "../../src/treasury/OwnerTreasury.sol";
import {OracleNUSDv2} from "../../src/nusd/OracleNUSDv2.sol";
import {IPriceOracle} from "../../src/oracle/IPriceOracle.sol";
import {RewardStaking} from "../../src/rewards/RewardStaking.sol";
import {TwoStepAdmin} from "../../src/common/TwoStepAdmin.sol";
import {
    GasBurningFeeSource,
    MockFeeSource,
    MockPriceOracle,
    MockWrappedNative,
    ReenteringFeeSource,
    RevertingFeeSource
} from "../mocks/TokenomicsMocks.sol";

contract TreasuryAndFeeSplitterTest is TestBase {
    address private constant OWNER = address(0x0E1);
    address private constant STRANGER = address(0xBAD);

    MockPriceOracle private oracle;
    OracleNUSDv2 private nusd;
    MockWrappedNative private wrapped;
    OwnerTreasury private treasury;
    RewardStaking private staking;
    FeeSplitter private splitter;

    function setUp() public {
        vm.warp(1_000_000);
        oracle = new MockPriceOracle(100 ether);
        nusd = new OracleNUSDv2(IPriceOracle(address(oracle)), address(this), 1_000_000 ether);
        wrapped = new MockWrappedNative();
        treasury = new OwnerTreasury(OWNER);
        staking = new RewardStaking(IERC20(address(nusd)));
        splitter = new FeeSplitter(address(nusd), address(wrapped), address(treasury), address(this));
        splitter.setRecipients(address(staking), address(treasury));
        vm.deal(address(this), 1_000_000 ether);
    }

    /// Mints NUSD worth `collateralWei` at $100 straight to `to`.
    function _nusdTo(address to, uint256 collateralWei) private returns (uint256) {
        return nusd.mintAtOracle{value: collateralWei}(0, to);
    }

    function _sources(address[] memory targets) private pure returns (FeeSplitter.Source[] memory list) {
        list = new FeeSplitter.Source[](targets.length);
        for (uint256 index; index < targets.length; ++index) {
            list[index] = FeeSplitter.Source(targets[index], abi.encodeWithSignature("distributeFees()"));
        }
    }

    // ---------------------------------------------------------------- NUSD split

    function testNusdSplitsSeventyStakersTwentyBurnTenTreasury() public {
        _nusdTo(address(splitter), 1 ether); // 100 NUSD
        vm.prank(STRANGER);
        assertEq(splitter.distribute(), 100 ether, "distributed");
        assertEq(nusd.balanceOf(address(staking)), 70 ether, "stakers");
        assertEq(nusd.balanceOf(address(treasury)), 10 ether, "treasury");
        assertEq(nusd.totalSupply(), 80 ether, "20 burned");
        assertEq(nusd.totalCollateralWei(), 1 ether, "burn keeps the collateral");
        assertEq(nusd.balanceOf(address(splitter)), 0, "nothing stuck");

        assertEq(splitter.distribute(), 0, "an empty split is a no-op, never a revert");
    }

    function testStakerShareWaitsForTheStakingPool() public {
        FeeSplitter fresh = new FeeSplitter(address(nusd), address(wrapped), address(treasury), address(this));
        _nusdTo(address(fresh), 1 ether);
        (bool ok,) = address(fresh).call{value: 1 ether}("");
        assertTrue(ok, "native accepted");

        assertEq(fresh.distribute(), 0, "no NUSD moves without a staking pool");
        assertEq(nusd.balanceOf(address(fresh)), 100 ether, "waits");
        assertEq(address(treasury).balance, 0.1 ether, "zkLTC still flows");

        fresh.setRecipients(address(staking), address(treasury));
        assertEq(fresh.distribute(), 100 ether, "released once bound");
        assertEq(nusd.balanceOf(address(staking)), 70 ether, "stakers");
    }

    function testZkltcGoesNinetyToTheReserveTenToTreasury() public {
        wrapped.deposit{value: 1 ether}();
        wrapped.transfer(address(splitter), 1 ether);
        (bool ok,) = address(splitter).call{value: 1 ether}("");
        assertTrue(ok, "native accepted");

        uint256 reserveBefore = nusd.totalCollateralWei();
        splitter.distribute();
        assertEq(nusd.totalCollateralWei() - reserveBefore, 1.8 ether, "90% backs NUSD");
        assertEq(address(treasury).balance, 0.2 ether, "10% treasury");
        assertEq(wrapped.balanceOf(address(splitter)), 0, "unwrapped");
        assertEq(address(splitter).balance, 0, "nothing stuck");
    }

    // ---------------------------------------------------------------- harvest

    function testHarvestCollectsSourcesSkipsBrokenOnesAndReleasesSurplus() public {
        MockFeeSource source = new MockFeeSource(IERC20(address(nusd)), address(splitter));
        _nusdTo(address(source), 1 ether); // 100 NUSD of accrued fees
        address[] memory targets = new address[](3);
        targets[0] = address(new RevertingFeeSource());
        targets[1] = address(new GasBurningFeeSource());
        targets[2] = address(source);
        splitter.setSources(_sources(targets));

        // Supply is 100 NUSD against $400 of zkLTC: 4.0x, above the 3.3x trigger.
        nusd.setSurplusRecipients(address(staking), address(treasury), 2_000);
        oracle.setPrice(400 ether);

        vm.prank(STRANGER);
        assertEq(splitter.harvest(), 1, "one source paid, two were skipped");
        assertEq(nusd.lastSurplusReleaseAt(), vm.getBlockTimestamp(), "surplus released");
        assertEq(nusd.balanceOf(address(source)), 0, "fees collected");
        assertEq(nusd.balanceOf(address(splitter)), 0, "and split");
        // Fees first: 70 to stakers, 20 burned, 10 to treasury. Then the surplus against the
        // 80 NUSD left: 400/3 - 80 = 53.33, split 80/20.
        uint256 surplus = uint256(400 ether) * 10_000 / 30_000 - 80 ether;
        uint256 surplusTreasury = surplus * 2_000 / 10_000;
        assertEq(nusd.balanceOf(address(staking)), 70 ether + surplus - surplusTreasury, "stakers");
        assertEq(nusd.balanceOf(address(treasury)), 10 ether + surplusTreasury, "treasury");
    }

    function testHarvestCannotReenterItself() public {
        ReenteringFeeSource source = new ReenteringFeeSource(address(splitter));
        address[] memory targets = new address[](1);
        targets[0] = address(source);
        splitter.setSources(_sources(targets));

        assertEq(splitter.harvest(), 1, "outer harvest completes");
        assertEq(source.innerResult(), 0, "inner harvest was a no-op");
        assertEq(splitter.harvest(), 1, "and the guard resets");
    }

    function testHarvestWithNoSourcesStillSplits() public {
        _nusdTo(address(splitter), 1 ether);
        assertEq(splitter.harvest(), 0, "no sources");
        assertEq(nusd.balanceOf(address(staking)), 70 ether, "split anyway");
    }

    function testSourcesCannotTouchAssetsOrRecipients() public {
        address[] memory bad = new address[](6);
        bad[0] = address(nusd);
        bad[1] = address(wrapped);
        bad[2] = address(staking);
        bad[3] = address(treasury);
        bad[4] = address(splitter);
        bad[5] = STRANGER; // no code
        for (uint256 index; index < bad.length; ++index) {
            address[] memory one = new address[](1);
            one[0] = bad[index];
            vm.expectRevert(FeeSplitter.InvalidSource.selector);
            splitter.setSources(_sources(one));
        }

        FeeSplitter.Source[] memory shortData = new FeeSplitter.Source[](1);
        shortData[0] = FeeSplitter.Source(address(new RevertingFeeSource()), hex"aabbcc");
        vm.expectRevert(FeeSplitter.InvalidSource.selector);
        splitter.setSources(shortData);

        address[] memory tooMany = new address[](9);
        for (uint256 index; index < tooMany.length; ++index) {
            tooMany[index] = address(new RevertingFeeSource());
        }
        vm.expectRevert(FeeSplitter.InvalidSource.selector);
        splitter.setSources(_sources(tooMany));

        address[] memory eight = new address[](8);
        for (uint256 index; index < eight.length; ++index) {
            eight[index] = tooMany[index];
        }
        splitter.setSources(_sources(eight));
        assertEq(splitter.sourceCount(), 8, "eight sources");
        (address target, bytes memory data) = splitter.sourceAt(7);
        assertEq(target, eight[7], "target");
        assertEq(keccak256(data), keccak256(abi.encodeWithSignature("distributeFees()")), "calldata");

        splitter.setSources(new FeeSplitter.Source[](0));
        assertEq(splitter.sourceCount(), 0, "cleared");
    }

    // ---------------------------------------------------------------- admin

    function testSplitsAreBounded() public {
        vm.expectRevert(FeeSplitter.InvalidSplit.selector);
        splitter.setNusdSplit(6_000, 1_900, 2_100);
        vm.expectRevert(FeeSplitter.InvalidSplit.selector);
        splitter.setNusdSplit(7_000, 2_000, 999);
        vm.expectRevert(FeeSplitter.InvalidSplit.selector);
        splitter.setNativeSplit(7_900, 2_100);
        vm.expectRevert(FeeSplitter.InvalidSplit.selector);
        splitter.setNativeSplit(9_000, 999);

        splitter.setNusdSplit(10_000, 0, 0);
        _nusdTo(address(splitter), 1 ether);
        splitter.distribute();
        assertEq(nusd.balanceOf(address(staking)), 100 ether, "all to stakers");

        splitter.setNativeSplit(8_000, 2_000);
        assertEq(splitter.reserveBps(), 8_000, "reserve");
        assertEq(splitter.nativeTreasuryBps(), 2_000, "treasury");
    }

    function testOnlyTheAdminChangesPolicy() public {
        vm.startPrank(STRANGER);
        vm.expectRevert(TwoStepAdmin.Unauthorized.selector);
        splitter.setNusdSplit(7_000, 2_000, 1_000);
        vm.expectRevert(TwoStepAdmin.Unauthorized.selector);
        splitter.setNativeSplit(9_000, 1_000);
        vm.expectRevert(TwoStepAdmin.Unauthorized.selector);
        splitter.setRecipients(address(staking), address(treasury));
        vm.expectRevert(TwoStepAdmin.Unauthorized.selector);
        splitter.setSources(new FeeSplitter.Source[](0));
        vm.stopPrank();

        vm.expectRevert(FeeSplitter.InvalidConfiguration.selector);
        splitter.setRecipients(STRANGER, address(treasury)); // staking must be a contract
        vm.expectRevert(FeeSplitter.InvalidConfiguration.selector);
        splitter.setRecipients(address(staking), address(staking));
        vm.expectRevert(FeeSplitter.InvalidConfiguration.selector);
        splitter.setRecipients(address(staking), address(0));
    }

    function testConstructorRejectsBadWiring() public {
        vm.expectRevert(FeeSplitter.InvalidConfiguration.selector);
        new FeeSplitter(STRANGER, address(wrapped), address(treasury), address(this));
        vm.expectRevert(FeeSplitter.InvalidConfiguration.selector);
        new FeeSplitter(address(nusd), STRANGER, address(treasury), address(this));
        vm.expectRevert(FeeSplitter.InvalidConfiguration.selector);
        new FeeSplitter(address(nusd), address(wrapped), address(0), address(this));
    }

    // ---------------------------------------------------------------- synth vault hook

    function testSynthMintFeeHookPullsAndSplits() public {
        _nusdTo(address(this), 1 ether);
        nusd.approve(address(splitter), 10 ether);
        assertEq(splitter.routeMintFee(10 ether), 10 ether, "flushed");
        assertEq(nusd.balanceOf(address(staking)), 7 ether, "stakers");
        assertEq(nusd.balanceOf(address(treasury)), 1 ether, "treasury");
        assertEq(splitter.routeMintFee(0), 0, "empty hook is a no-op");
    }

    function testSynthVaultActivationShimIsAnIdentityMapping() public view {
        address vault = address(0x5A17);
        assertEq(splitter.mintFeePairForVault(vault), vault, "pair of vault");
        assertEq(splitter.mintFeeVaultForPair(splitter.mintFeePairForVault(vault)), vault, "round trip");
        assertEq(address(splitter.nusd()), address(nusd), "vault constructor check");
    }

    // ---------------------------------------------------------------- owner treasury

    function testOnlyOwnerSpendsTreasury() public {
        _nusdTo(address(treasury), 0.05 ether);
        vm.deal(address(treasury), 2 ether);

        vm.prank(STRANGER);
        vm.expectRevert();
        treasury.withdrawToken(IERC20(address(nusd)), STRANGER, 1 ether);
        vm.prank(STRANGER);
        vm.expectRevert();
        treasury.withdrawNative(payable(STRANGER), 1 ether);

        vm.prank(OWNER);
        treasury.withdrawToken(IERC20(address(nusd)), OWNER, 5 ether);
        assertEq(nusd.balanceOf(OWNER), 5 ether, "token withdrawn");
        vm.prank(OWNER);
        treasury.withdrawNative(payable(OWNER), 2 ether);
        assertEq(OWNER.balance, 2 ether, "native withdrawn");

        vm.prank(OWNER);
        vm.expectRevert(OwnerTreasury.InvalidRecipient.selector);
        treasury.withdrawToken(IERC20(address(nusd)), address(0), 0);
    }

    function testOwnershipMovesInTwoSteps() public {
        vm.prank(OWNER);
        treasury.transferOwnership(STRANGER);
        assertEq(treasury.owner(), OWNER, "not moved before acceptance");

        vm.prank(STRANGER);
        treasury.acceptOwnership();
        assertEq(treasury.owner(), STRANGER, "accepted");
    }

    // ---------------------------------------------------------------- fuzz

    /// Every NUSD wei is sent or burned and every zkLTC wei lands in the reserve or the treasury.
    function testFuzzSplitConservesEveryWei(uint256 rawCollateral, uint256 rawNative) public {
        uint256 minted = _nusdTo(address(splitter), bound(rawCollateral, 1, 1_000 ether));
        uint256 native = bound(rawNative, 0, 1_000 ether);
        if (native != 0) {
            (bool ok,) = address(splitter).call{value: native}("");
            assertTrue(ok, "native accepted");
        }
        uint256 supplyBefore = nusd.totalSupply();
        uint256 reserveBefore = nusd.totalCollateralWei();

        assertEq(splitter.distribute(), minted, "amount");
        uint256 burned = supplyBefore - nusd.totalSupply();
        assertEq(
            nusd.balanceOf(address(staking)) + nusd.balanceOf(address(treasury)) + burned, minted, "NUSD lost"
        );
        assertEq(nusd.balanceOf(address(staking)), minted * 7_000 / 10_000, "stakers");
        assertEq(
            nusd.totalCollateralWei() - reserveBefore + address(treasury).balance, native, "zkLTC lost"
        );
        assertEq(address(treasury).balance, native * 1_000 / 10_000, "treasury zkLTC");
    }
}
