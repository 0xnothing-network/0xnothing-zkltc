# Testnet architecture

## Product boundary

0xPixel remains the existing onchain pixel-art NFT and native-zkLTC marketplace. Its deployed contracts, routes, public addresses, marketplace subgraph, and RPC fallbacks are preserved.

0xPump is a separate NUSD launchpad. It does not depend on the removed legacy DEX.

## OracleNUSD and DIA

DIA is the price source; it does not mint NUSD. `OracleNUSD` is both the ERC-20
and the native-zkLTC reserve. It reads the DIA adapter for every mint and redeem,
tracks recognized native backing in `totalCollateralWei`, and exposes itself from
`vault()` so the existing 0xPump constructor interface remains compatible.
0xPump only transfers NUSD for creation fees and curve trades; it has no mint or
reserve authority.

Mint output is `floor(msg.value * priceWad / 1e18)`. Redemption output is
`floor(amountNusd * 1e18 / priceWad)`. There is no protocol fee, user debt
position, collateral ratio, or liquidation path. The configured supply ceiling
limits `totalSupply`, and burned supply restores headroom. `coverReserve` can add
recognized backing without minting; there is no administrator reserve sweep.

This is an oracle-priced reserve model, not an overcollateralized stablecoin.
A decline in zkLTC/USD after minting can make reserve value lower than NUSD
supply, while a rise can create reserve surplus. Stale or invalid oracle data
blocks both value-changing paths. Mint and redeem have independent pause controls,
while quote reads and reserve coverage remain available.

The new `OracleNUSD` deployment does not migrate balances or collateral from the
legacy NUSD and `NativeCollateralVault`. Their addresses remain only as
historical `legacy*` deployment-manifest fields and are not exposed by the web app.

## Pump lifecycle

Each token starts in `TRADING`. Its full fixed supply is held by the launchpad and sold or bought back through virtual constant-product reserves.

- Reserving a market costs exactly `1e18` NUSD units before any hosted IPFS upload.
- Every buy and sell charges exactly `10` basis points (`0.1%`).
- Slippage limits and deadlines are mandatory.
- Logo and metadata references use canonical `ipfs://` URIs.
- Authoritative post-trade reserves are emitted for the subgraph.

The READY condition is a literal `6,000 NUSD` market cap, calculated as
`spotPriceNusdWad * fixedTotalSupply / 1e18`. It is not a `6,000 NUSD` real
reserve target. With the release parameters, the initial virtual market cap is
`1,500 NUSD` and the curve derives a `1,500 NUSD` real-reserve target that lands
on the `6,000 NUSD` market-cap boundary. `curveProgressBps` measures progress
toward that derived reserve target.

At the target, the market moves to `READY` and further buys stop. No DEX call
occurs inside the target-crossing buy. Testnet liquidity migration is disabled:
the router starts disabled and has no adapter. Holders retain an exit while
graduation is unavailable; the first successful sell from `READY` atomically
returns the market to `TRADING` and emits `TokenCurveReopened`.

`GRADUATED` is terminal but is not reachable in this testnet release. Mainnet
graduation requires a separately audited adapter that atomically converts or
bridges NUSD into the official zkLTC stablecoin, creates liquidity on the
approved major DEX at the terminal curve price, verifies balance deltas, and
permanently locks the resulting liquidity position. The official stablecoin,
route, DEX, and adapter addresses remain unset until their production interfaces
are published and reviewed.

## Read paths

- Live balances, allowances, quotes, and market state come from RPC.
- Token discovery, trades, candles, and aggregate history come from the 0xPump Goldsky subgraph.
- API responses retain an RPC fallback shape when indexing is unavailable.
- 0xPixel keeps its existing subgraph-first and onchain-fallback behavior.

## IPFS

The web server uploads validated logo files and canonical metadata JSON to Pinata Public IPFS. `PINATA_JWT` is server-only. Before upload, the creator pays the nonrefundable `1 NUSD` fee into an owner-scoped reservation. The reservation hash commits to chain, Pump address, owner, canonical form fields, MIME type, byte length, and the file digest. The server recomputes that hash and checks the live reservation, so a copied hash cannot consume another wallet's reservation and changed content requires a new paid reservation. A successful market creation consumes the reservation; the same exact content remains retryable after a failed upload or transaction.

The versioned hash is `keccak256(abi.encode(...))` over these exact types and values, in order: `string "0xPump Market Content"`, `uint256 1`, `uint256 chainId`, `address factory`, `address owner`, trimmed `string name`, trimmed-uppercase `string symbol`, trimmed `string description`, trimmed `string website`, trimmed `string twitter`, trimmed-lowercase `string MIME type`, `uint256 file length`, and `bytes32 keccak256(file bytes)`.

Contracts store `ipfs://` values, while the UI derives gateway URLs at read time. Direct contract callers may bring their own already-pinned IPFS URIs, but they must still pay and consume a reservation.
