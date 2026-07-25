// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "../TestBase.sol";
import {DIAOracleAdapter} from "../../src/nusd/DIAOracleAdapter.sol";

contract MainnetDIAForkTest is TestBase {
    function testForkReadsConfiguredFreshLtcUsdPrice() public {
        string memory rpcUrl = vm.envOr("MAINNET_RPC_URL", string(""));
        address feed = vm.envOr("DIA_LTC_USD_FEED", address(0));
        if (bytes(rpcUrl).length == 0 || feed == address(0)) return;

        vm.createSelectFork(rpcUrl);
        assertGt(feed.code.length, 0, "configured DIA feed missing");

        uint256 maxPriceAge = vm.envOr("DIA_MAX_PRICE_AGE", uint256(90 minutes));
        DIAOracleAdapter adapter = new DIAOracleAdapter(feed, maxPriceAge);
        (uint256 priceWad, uint256 updatedAt,) = adapter.readPriceWad();

        assertGt(priceWad, 0, "LTC/USD price");
        assertLe(updatedAt, block.timestamp, "oracle timestamp");
        assertLe(block.timestamp - updatedAt, maxPriceAge, "oracle freshness");
    }
}
