// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "../TestBase.sol";
import {OracleRouter} from "../../src/oracle/OracleRouter.sol";
import {TwoStepAdmin} from "../../src/common/TwoStepAdmin.sol";
import {MockPriceOracle} from "../mocks/TokenomicsMocks.sol";

contract OracleRouterTest is TestBase {
    address private constant STRANGER = address(0xBAD);

    MockPriceOracle private source;
    OracleRouter private router;

    function setUp() public {
        vm.warp(1_000_000);
        source = new MockPriceOracle(100 ether);
        router = new OracleRouter("LTC/USD", address(source), address(this));
    }

    function testReadsThroughTheSource() public {
        (uint256 price, uint256 updatedAt, uint80 roundId) = router.readPriceWad();
        assertEq(price, 100 ether, "price");
        assertEq(updatedAt, vm.getBlockTimestamp(), "updated");
        assertEq(roundId, 1, "round");
        assertTrue(router.isFresh(), "fresh");
        assertEq(keccak256(bytes(router.description())), keccak256("LTC/USD"), "description");

        source.setPrice(0);
        assertFalse(router.isFresh(), "zero price is not fresh");
        source.setBroken(true);
        assertFalse(router.isFresh(), "dead source is not fresh");
        vm.expectRevert();
        router.readPriceWad();
    }

    function testReplacementMustPriceAndStayWithinTwentyFivePercent() public {
        vm.expectRevert(OracleRouter.InvalidSource.selector);
        router.setSource(STRANGER);
        vm.expectRevert(OracleRouter.InvalidSource.selector);
        router.setSource(address(source));

        MockPriceOracle dead = new MockPriceOracle(100 ether);
        dead.setBroken(true);
        vm.expectRevert(OracleRouter.SourceUnusable.selector);
        router.setSource(address(dead));
        MockPriceOracle zero = new MockPriceOracle(0);
        vm.expectRevert(OracleRouter.SourceUnusable.selector);
        router.setSource(address(zero));

        MockPriceOracle far = new MockPriceOracle(126 ether);
        vm.expectRevert(abi.encodeWithSelector(OracleRouter.SourceDeviation.selector, 100 ether, 126 ether));
        router.setSource(address(far));
        MockPriceOracle low = new MockPriceOracle(74 ether);
        vm.expectRevert(abi.encodeWithSelector(OracleRouter.SourceDeviation.selector, 100 ether, 74 ether));
        router.setSource(address(low));

        MockPriceOracle near = new MockPriceOracle(125 ether);
        router.setSource(address(near));
        assertEq(address(router.source()), address(near), "switched at exactly 25%");
        (uint256 price,,) = router.readPriceWad();
        assertEq(price, 125 ether, "reads the new source");
    }

    function testADeadSourceCanBeReplacedAtAnyPrice() public {
        source.setBroken(true);
        MockPriceOracle replacement = new MockPriceOracle(500 ether);
        router.setSource(address(replacement));
        assertEq(address(router.source()), address(replacement), "replaced");

        replacement.setPrice(0);
        MockPriceOracle next = new MockPriceOracle(1 ether);
        router.setSource(address(next));
        assertEq(address(router.source()), address(next), "a zero price counts as dead");
    }

    function testOnlyTheAdminSwitchesAndHandsOverInTwoSteps() public {
        MockPriceOracle near = new MockPriceOracle(101 ether);
        vm.prank(STRANGER);
        vm.expectRevert(TwoStepAdmin.Unauthorized.selector);
        router.setSource(address(near));

        router.transferAdmin(STRANGER);
        assertEq(router.admin(), address(this), "not before acceptance");
        vm.prank(STRANGER);
        router.acceptAdmin();
        vm.prank(STRANGER);
        router.setSource(address(near));
        assertEq(address(router.source()), address(near), "new admin switched");
    }

    function testConstructorNeedsAContractSource() public {
        vm.expectRevert(OracleRouter.InvalidSource.selector);
        new OracleRouter("LTC/USD", STRANGER, address(this));
    }
}
