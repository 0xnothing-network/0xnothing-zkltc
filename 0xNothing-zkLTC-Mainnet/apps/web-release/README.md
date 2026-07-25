# Web release promotion

Mainnet uses a tested immutable release tag from `0xNothing-zkLTC-Testnet/apps/web`; it does not fork a second application source tree.

A promotion record must contain:

- Git commit and signed release tag
- production chain ID, RPC, explorer, and multicall address
- OracleNUSD self-vault, DIA adapter, 0xPump, router, official zkLTC stablecoin, approved NUSD
  conversion/bridge route, major DEX, and graduation adapter addresses
- fixed `6,000 NUSD` READY market-cap target and verified derived reserve target
- 0xPump subgraph endpoint and indexed start block
- IPFS gateway and redundant pinning configuration
- completed contract, frontend, indexing, and security gates

0xPixel remains on its current testnet deployment and is not silently pointed at mainnet.
The promoted UI must expose direct oracle-priced mint/redeem flows and must not
describe NUSD as a collateralized loan or show a minimum collateral ratio.
The promoted UI must not show graduation as available until the settlement route,
adapter, DEX, and liquidity-lock path are all enabled and verified onchain.
