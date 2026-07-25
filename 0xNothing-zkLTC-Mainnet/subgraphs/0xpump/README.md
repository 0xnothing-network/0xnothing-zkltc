# 0xPump Subgraph - LitVM Mainnet Overlay

Standalone mainnet overlay of the 0xPump Goldsky/Graph Node package. Its schema,
ABI, mappings, and tests intentionally match the Liteforge testnet package so
the frontend can promote the same GraphQL query contract without a fork.

## Current deployment blocker

As of July 24, 2026, Goldsky's LitVM chain documentation lists subgraph support
for Liteforge testnet (`liteforge`) but does not publish a supported LitVM
mainnet chain slug. This package therefore commits:

- `GOLDSKY_NETWORK=litvm-mainnet-pending`
- the zero contract address and start block `0`
- `goldskySupported: false` in `subgraph.config.json`

`npm run deploy:check` must fail while any of those guards remain. Do not bypass
the guard with an arbitrary chain name. Confirm support with Goldsky/LitVM, then
update the slug and `goldskySupported` flag in a reviewed change.

## Indexed contract events

The mainnet contract must emit the exact ABI committed in
`abis/ZeroXPump.json`:

```solidity
event CreationFeePaid(address indexed owner, bytes32 indexed contentHash,
  uint256 creationFeeNusd);

event TokenCreated(address indexed token, address indexed creator,
  bytes32 indexed contentHash, string name, string symbol, string metadataURI,
  string imageURI, uint256 totalSupply,
  uint256 curveTokenSupply, uint256 virtualNusdReserve,
  uint256 virtualTokenReserve, uint256 graduationThresholdNusd,
  uint256 graduationReserveThresholdNusd, uint256 creationFeeNusd);

event TokenTraded(address indexed token, address indexed trader,
  bool indexed isBuy, uint256 tokenAmount, uint256 curveNusdAmount,
  uint256 userNusdAmount, uint256 feeNusd, uint256 realNusdReserveAfter,
  uint256 tokenReserveAfter, uint256 virtualNusdReserveAfter,
  uint256 virtualTokenReserveAfter, uint256 circulatingSupplyAfter,
  uint256 spotPriceNusdWad, uint256 curveProgressBps);

event TokenReadyForGraduation(address indexed token,
  uint256 realNusdReserve, uint256 tokenReserve, uint256 thresholdNusd);

event TokenCurveReopened(address indexed token,
  uint256 realNusdReserve, uint256 tokenReserve);

event TokenGraduated(address indexed token, address indexed dex,
  bytes32 indexed pairId, address pool, uint256 nusdLiquidity,
  uint256 tokenLiquidity, uint256 lpAmount, address lpRecipient);

event ProtocolFeesWithdrawn(address indexed recipient, uint256 amountNusd);
```

The mapping uses emitted post-trade reserves, price, and progress as the source
of truth. It performs no contract or IPFS calls. `curveNusdAmount` is volume;
buys satisfy `userNusdAmount = curveNusdAmount + feeNusd`, while sells satisfy
`userNusdAmount = curveNusdAmount - feeNusd`.
`graduationThresholdNusd` is the fixed `6,000 NUSD` market-cap target, where
market cap is `spotPriceNusdWad * fixedTotalSupply / 1e18`.
`graduationReserveThresholdNusd` is the separately derived real-reserve target
(`1,500 NUSD` with the release parameters), and `curveProgressBps` measures
funding against that derived reserve target.
Creation-fee totals come from `CreationFeePaid`, including reservations that do
not reach `TokenCreated`; the creation event never increments that total again.
The indexed `contentHash` links a consumed reservation to the created market for
idempotent recovery after a lost transaction receipt.
Each created token also starts a dynamic `PumpToken` data source. Because the
initial mint is emitted before `TokenCreated`, the mapping seeds the factory
balance from `curveTokenSupply`; later `Transfer` events track buys, sells,
wallet-to-wallet transfers, and burns. `holderCount` includes only positive
non-factory balances, while the factory `TokenBalance` remains queryable as the
bonding-curve inventory.

## Promotion checklist

1. Confirm the final mainnet chain ID, Goldsky slug, RPC, explorer, NUSD address,
   official zkLTC stablecoin address, approved conversion/bridge route, 0xPump
   address, ABI, and contract creation block.
2. Confirm the graduation adapter settles NUSD into the official stablecoin and
   returns the emitted major DEX, pair/pool, ERC-20 LP amount, and immutable LP
   locker recipient in one transaction. If settlement is asynchronous or the
   DEX returns an NFT position, block promotion until the revised contracts and
   event schema are audited.
3. Set `PUMP_CONTRACT_ADDRESS`, `PUMP_START_BLOCK`, and `GOLDSKY_NETWORK` in a
   local `.env`; never put deployer keys in this package.
4. Update `goldskySupported` only after Goldsky confirms mainnet indexing.
5. Run codegen, build, Matchstick tests, and frontend contract queries.
6. Deploy the contract first and this subgraph last.

```powershell
npm ci
npm run check
npm test
npm run deploy:check
```

When every gate is satisfied, `npm run deploy` targets
`zeroxpump-mainnet/1.0.0` with the stable `prod` tag. Use a new immutable version
for every subsequent deployment.

## Frontend compatibility

The stable entities are `markets`, `tokenBalances`, `trades`, and `candles`.
Holder, trade, and candle queries use `market { id }`; BigInt and BigDecimal
fields cross the GraphQL API as decimal strings. Candle periods are `15`, `60`,
`240`, and `1440` minutes.
Market queries expose both `graduationThresholdNusd` (the market-cap target) and
`graduationReserveThresholdNusd` (the derived real-reserve target).
Canonical `ipfs://` values remain unchanged in the index; gateway selection is
a frontend/API responsibility.
