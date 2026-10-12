// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "../TestBase.sol";
import {MockDIAFeed} from "../mocks/MockDIAFeed.sol";
import {NUSD} from "../../src/nusd/NUSD.sol";
import {DIAOracleAdapter} from "../../src/nusd/DIAOracleAdapter.sol";
import {NativeCollateralVault} from "../../src/nusd/NativeCollateralVault.sol";
import {ZeroXPump} from "../../src/pump/ZeroXPump.sol";
import {GraduationRouter} from "../../src/graduation/GraduationRouter.sol";
import {PermanentLiquidityLocker} from "../../src/graduation/PermanentLiquidityLocker.sol";

contract ConstructorValidationTest is TestBase {
    NUSD private nusd;
    DIAOracleAdapter private oracle;
    PermanentLiquidityLocker private locker;
    GraduationRouter private router;

    function setUp() public {
        MockDIAFeed feed = new MockDIAFeed(18);
        feed.setRound(1, 100 ether, block.timestamp, 1);
        nusd = new NUSD(address(this));
        oracle = new DIAOracleAdapter(address(feed), 2 hours, address(this), 1, type(uint256).max, 0);
        locker = new PermanentLiquidityLocker(address(this));
        router = new GraduationRouter(address(this), 1 hours, address(locker));
    }

    function testNusdRejectsZeroBinder() public {
        vm.expectRevert();
        new NUSD(address(0));
    }

    function testOracleRejectsEoaFeed() public {
        vm.expectRevert();
        new DIAOracleAdapter(address(0xD1A), 2 hours, address(this), 1, type(uint256).max, 0);
    }

    function testOracleRejectsUnsafeConfiguration() public {
        MockDIAFeed feed = new MockDIAFeed(8);
        vm.expectRevert(DIAOracleAdapter.InvalidMaxPriceAge.selector);
        new DIAOracleAdapter(address(feed), 2 hours + 1, address(this), 1, type(uint256).max, 0);

        vm.expectRevert(DIAOracleAdapter.InvalidMaxPriceAge.selector);
        new DIAOracleAdapter(address(feed), 5 minutes - 1, address(this), 1, type(uint256).max, 0);

        vm.expectRevert(DIAOracleAdapter.InvalidPriceBounds.selector);
        new DIAOracleAdapter(address(feed), 30 minutes, address(this), 0, 1 ether, 0);

        vm.expectRevert(DIAOracleAdapter.InvalidPriceBounds.selector);
        new DIAOracleAdapter(address(feed), 30 minutes, address(this), 1 ether, 1 ether, 0);

        vm.expectRevert(DIAOracleAdapter.InvalidDeviation.selector);
        new DIAOracleAdapter(address(feed), 30 minutes, address(this), 1, 1 ether, 10_001);

        vm.expectRevert();
        new DIAOracleAdapter(address(feed), 30 minutes, address(0), 1, 1 ether, 0);

        MockDIAFeed wideFeed = new MockDIAFeed(37);
        vm.expectRevert(DIAOracleAdapter.InvalidFeedDecimals.selector);
        new DIAOracleAdapter(address(wideFeed), 30 minutes, address(this), 1, 1 ether, 0);
    }

    function testVaultRejectsNonContractDependencies() public {
        vm.expectRevert();
        new NativeCollateralVault(address(0xA11CE), address(oracle), address(this), 17_500, 15_000, 800, 5_000, 1 ether);

        vm.expectRevert();
        new NativeCollateralVault(address(nusd), address(0xD1A), address(this), 17_500, 15_000, 800, 5_000, 1 ether);
    }

    function testVaultRejectsUnsafeRiskParameters() public {
        vm.expectRevert();
        new NativeCollateralVault(address(nusd), address(oracle), address(this), 15_000, 15_000, 800, 5_000, 1 ether);
    }

    function testVaultRejectsZeroDebtCeiling() public {
        vm.expectRevert();
        new NativeCollateralVault(address(nusd), address(oracle), address(this), 17_500, 15_000, 800, 5_000, 0);
    }

    function testRouterRequiresContractLockerAndMinimumDelay() public {
        vm.expectRevert();
        new GraduationRouter(address(this), 1 hours, address(0xBEEF));

        vm.expectRevert();
        new GraduationRouter(address(this), 1 hours - 1, address(locker));
    }

    function testPumpRejectsNonContractVault() public {
        vm.expectRevert();
        new ZeroXPump(
            address(nusd),
            address(0xBEEF),
            address(router),
            address(this),
            1_000_000_000 ether,
            1_500 ether,
            6_000 ether
        );
    }

    function testPumpRejectsMarketCapTargetAtOrBelowInitialMarketCap() public {
        vm.expectRevert();
        new ZeroXPump(
            address(nusd), address(nusd), address(router), address(this), 1_000_000_000 ether, 1_500 ether, 1_500 ether
        );
    }

    function testPumpRejectsConfigurationWithZeroInitialSpotPrice() public {
        vm.expectRevert();
        new ZeroXPump(address(nusd), address(nusd), address(router), address(this), type(uint128).max, 1, 1 ether);
    }

    function testPumpRejectsConfigurationWithZeroTerminalLiquidity() public {
        vm.expectRevert();
        new ZeroXPump(address(nusd), address(nusd), address(router), address(this), 1, 1, 4);
    }
}
