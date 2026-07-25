// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "../TestBase.sol";
import {DIAOracleAdapter} from "../../src/nusd/DIAOracleAdapter.sol";

contract LitVMDIAForkTest is TestBase {
    address private constant LITVM_TESTNET_LTC_USD_FEED = 0x45dDa5d881BD2C917976CCfde74fFd6f6412da29;

    function testForkReadsFreshLtcUsdPriceWhenRpcIsConfigured() public {
        string memory rpcUrl = vm.envOr("LITVM_RPC_URL", string(""));
        if (bytes(rpcUrl).length == 0) return;

        vm.createSelectFork(rpcUrl);
        assertGt(LITVM_TESTNET_LTC_USD_FEED.code.length, 0, "documented DIA feed missing");

        uint256 maxPriceAge = vm.envOr("DIA_MAX_PRICE_AGE", uint256(90 minutes));
        DIAOracleAdapter adapter = new DIAOracleAdapter(LITVM_TESTNET_LTC_USD_FEED, maxPriceAge);
        (uint256 priceWad, uint256 updatedAt,) = adapter.readPriceWad();

        assertGt(priceWad, 0, "LTC/USD price");
        assertLe(updatedAt, block.timestamp, "oracle timestamp");
        assertLe(block.timestamp - updatedAt, maxPriceAge, "oracle freshness");
    }
}
