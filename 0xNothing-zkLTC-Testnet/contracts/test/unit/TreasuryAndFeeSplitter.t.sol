// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "../TestBase.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FeeSplitter} from "../../src/treasury/FeeSplitter.sol";
import {OwnerTreasury} from "../../src/treasury/OwnerTreasury.sol";
import {MarketplaceNusdMock} from "../mocks/NusdMarketplaceMocks.sol";

contract TreasuryAndFeeSplitterTest is TestBase {
    MarketplaceNusdMock private nusd;
    MarketplaceNusdMock private wzkltc;
    OwnerTreasury private treasury;
    FeeSplitter private splitter;

    address private constant POOL = address(0xB001);
    address private constant OWNER = address(0x0E1);
    address private constant STRANGER = address(0xBAD);

    function setUp() public {
        nusd = new MarketplaceNusdMock();
        wzkltc = new MarketplaceNusdMock();
        treasury = new OwnerTreasury(OWNER);
        splitter = new FeeSplitter(IERC20(address(nusd)), POOL, address(treasury));
    }

    function testDistributeSplitsNusdInHalfRoundingTowardTreasury() public {
        nusd.mint(address(splitter), 101);
        vm.prank(STRANGER);
        uint256 amount = splitter.distribute();

        assertEq(amount, 101, "distributed");
        assertEq(nusd.balanceOf(POOL), 50, "pool half");
        assertEq(nusd.balanceOf(address(treasury)), 51, "treasury rest");
        assertEq(nusd.balanceOf(address(splitter)), 0, "nothing stuck");

        vm.expectRevert(FeeSplitter.NothingToDistribute.selector);
        splitter.distribute();
    }

    function testSynthMintFeeHookPullsAndSplits() public {
        nusd.mint(address(this), 10 ether);
        nusd.mint(address(splitter), 2 ether); // an earlier fee nobody distributed yet
        nusd.approve(address(splitter), 10 ether);

        uint256 flushed = splitter.routeMintFee(10 ether);
        assertEq(flushed, 12 ether, "flushes the whole balance");
        assertEq(nusd.balanceOf(POOL), 6 ether, "pool");
        assertEq(nusd.balanceOf(address(treasury)), 6 ether, "treasury");

        assertEq(splitter.routeMintFee(0), 0, "empty hook is a no-op");
    }

    function testOtherAssetsGoEntirelyToTreasury() public {
        wzkltc.mint(address(splitter), 7 ether);
        vm.prank(STRANGER);
        splitter.sweep(IERC20(address(wzkltc)));
        assertEq(wzkltc.balanceOf(address(treasury)), 7 ether, "token to treasury");
        assertEq(wzkltc.balanceOf(POOL), 0, "pool only takes NUSD");

        vm.expectRevert(FeeSplitter.InvalidConfiguration.selector);
        splitter.sweep(IERC20(address(nusd)));

        vm.deal(address(this), 3 ether);
        (bool ok,) = address(splitter).call{value: 3 ether}("");
        assertTrue(ok, "native accepted");
        splitter.sweepNative();
        assertEq(address(treasury).balance, 3 ether, "native to treasury");
        vm.expectRevert(FeeSplitter.NothingToDistribute.selector);
        splitter.sweepNative();
    }

    function testSplitterRejectsBadWiring() public {
        vm.expectRevert(FeeSplitter.InvalidConfiguration.selector);
        new FeeSplitter(IERC20(address(nusd)), POOL, POOL);
        vm.expectRevert(FeeSplitter.InvalidConfiguration.selector);
        new FeeSplitter(IERC20(address(0xDEAD)), POOL, address(treasury));
        vm.expectRevert(FeeSplitter.InvalidConfiguration.selector);
        new FeeSplitter(IERC20(address(nusd)), address(0), address(treasury));
    }

    function testOnlyOwnerSpendsTreasury() public {
        nusd.mint(address(treasury), 5 ether);
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

    /// The pool always receives floor(half) and the treasury the rest; nothing stays behind.
    function testFuzzSplitConservesEveryWei(uint256 rawA, uint256 rawB) public {
        uint256 a = bound(rawA, 1, 1e30);
        uint256 b = bound(rawB, 0, 1e30);
        nusd.mint(address(splitter), a);
        splitter.distribute();
        if (b != 0) {
            nusd.mint(address(splitter), b);
            splitter.distribute();
        }
        assertEq(nusd.balanceOf(POOL) + nusd.balanceOf(address(treasury)), a + b, "lost NUSD");
        assertEq(nusd.balanceOf(POOL), a / 2 + b / 2, "pool share");
        assertEq(nusd.balanceOf(address(splitter)), 0, "stuck NUSD");
    }
}
