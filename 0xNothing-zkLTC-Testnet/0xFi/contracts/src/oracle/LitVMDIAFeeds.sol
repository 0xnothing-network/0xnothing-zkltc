// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Official DIA asset-specific AggregatorV3 feeds on LitVM LiteForge (chain ID 4441).
library LitVMDIAFeeds {
    address internal constant LTC_USD = 0x45dDa5d881BD2C917976CCfde74fFd6f6412da29;
    address internal constant BTC_USD = 0x7d0445782E383223c7B4B660bb96b87213e9b605;
    address internal constant ETH_USD = 0xc760B46beF9eD3F9A3d2b825164324D6703F0185;

    string internal constant LTC_USD_KEY = "LTC/USD Oracle";
    string internal constant BTC_USD_KEY = "BTC/USD Oracle";
    string internal constant ETH_USD_KEY = "ETH/USD Oracle";
}
