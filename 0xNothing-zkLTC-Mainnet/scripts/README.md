# Mainnet release scripts

This directory is intentionally gated until the official zkLTC mainnet chain
ID, RPC, DIA feed, Goldsky slug, and audited DEX adapter are known. The release
script must parse actual Foundry receipts, verify deployed bytecode and fixed fee
constants over the production RPC, then update the mainnet manifest, promoted
web environment, and subgraph start block from the `ZeroXPump` receipt.

The release must also verify the fixed `6,000 NUSD` READY market-cap target, the
derived reserve target, OracleNUSD's DIA adapter and self-vault binding, the
maximum supply ceiling, both pause states, the official zkLTC stablecoin, the
approved NUSD conversion/bridge route, and the major DEX. Graduation stays
disabled unless the route settles synchronously and returns the ERC-20 LP token
expected by the current router and locker; otherwise deploy only after the
revised architecture has passed audit.

Do not copy Testnet addresses or bypass `DeployMainnet.s.sol` release guards.
