# RWA spot trading

`RwaMarket` is a prefunded ERC-20 spot market shared by `/0xFi/rwa`, the dev reserve console, and 0xWallet's RWA tab. It does not issue tokens or certify real-world backing. The issuer's custody, transfer restrictions and redemption rights must be documented separately. The initial catalog is empty because no issuer token or RWA price feed has been verified on LitVM.

## Settlement and reserve accounting

- Buy: transfer existing asset inventory to the buyer; collect oracle value plus 1% in the settlement token.
- Sell: receive existing asset tokens; pay oracle value less 1% in the settlement token.
- Fee is `ceil(gross / 100)` in settlement base units. Buy value rounds up; sell value rounds down. Dust sells where the fee consumes the proceeds revert.
- `availableLiquidity = max(settlementBalance - feeReserve - reserveFloor, 0)`.
- `withdrawableFees = min(feeReserve, max(settlementBalance - reserveFloor, 0))`.
- Dev/owner can withdraw **only accrued fees**, to an explicit recipient. A withdrawal cannot reduce available trading liquidity. Ownership transfers require acceptance. Use a multisig as owner for a live deployment.
- Owner can permanently convert fee reserves into sell liquidity using `reinvestFees`. Collected fees are segregated until reinvested; simply accumulating fees does not increase executable sell liquidity.
- Funding is a **permanent donation**, not an LP deposit. There are no LP shares, inventory withdrawals, arbitrary rescue calls or owner withdrawals of trading principal. The fixed reserve floor is locked, including after pausing. Do not fund this model expecting principal redemption.
- Both directions have an immutable maximum trade value; aggregate gross sells have a UTC calendar-day limit. This is not a rolling 24-hour cap: two daily budgets may be consumed around midnight. Quote checks reflect inventory, liquidity and daily limits before approval.

For example, at a price of 100 settlement tokens, buying one asset costs 101 and selling one returns 99. Each operation books 1 into fee reserves. These fees cannot guarantee liquidity against price moves or sustained selling.

## Price security and availability

`RwaPriceOracle` requires four distinct WAD-normalized `IPriceOracle` adapters: two asset/USD sources and two settlement/USD sources. It validates timestamps, nonzero prices/rounds and pairwise deviation, then divides the two midpoint prices. It never assumes NUSD is worth one USD. Feed addresses, freshness, divergence limit, token addresses and risk limits are immutable; there is no manual admin price override.

Deploy audited feed-specific adapters that pin the **actual feed identity**, normalize decimals, check round completion and enforce economically meaningful absolute bounds. Existing `DIAOracleV2Adapter` provides these checks for compatible aggregator feeds. Distinct adapter addresses are **not proof of independent data**: operators must verify different upstream sources, their control keys, feed identity, update cadence, denomination and bounds. Two wrappers for one feed must not be used. Underlying proxy/upgrader powers also need review.

Both pairs must be healthy. A stale, future-dated, zero, reverting or divergent source stops quotes and trades; there is no fallback to last-known or browser-supplied prices. Market contracts accept orders at any time, but continuous execution requires genuinely continuous, asset-appropriate feeds and replenished reserves. Do not extend stale-price windows through market closures to advertise 24/7 availability. L2 deployments also require chain/sequencer health controls in the selected adapters where applicable.

References: [Chainlink feed selection and market hours](https://docs.chain.link/data-feeds/selecting-data-feeds), [feed timestamps](https://docs.chain.link/data-feeds/api-reference), [OpenZeppelin two-step ownership](https://docs.openzeppelin.com/contracts/5.x/api/access), [SafeERC20](https://docs.openzeppelin.com/contracts/5.x/api/token/erc20).

## Deploy and activate on testnet

1. Select a real issuer ERC-20 and settlement ERC-20 (0–18 decimals). Both must be non-rebasing, exact-transfer tokens. Verify issuer restrictions allow the market and intended users to hold/transfer them. Transfers check both sender debits and recipient credits, rejecting observed taxes charged on either side. These checks cannot establish an issuer's real-world backing or future behavior.
2. Deploy and independently verify the four suitable price adapters. Do not use `MockPriceOracle` or fiat-pegged constants in a public market. Choose source-specific bounds, freshness and divergence parameters.
3. Set these environment variables (amounts are settlement **base units**):

   `RWA_OWNER`, `RWA_ASSET`, `RWA_SETTLEMENT`, `RWA_ASSET_PRIMARY`, `RWA_ASSET_SECONDARY`, `RWA_SETTLEMENT_PRIMARY`, `RWA_SETTLEMENT_SECONDARY`, `RWA_MAX_PRICE_AGE`, `RWA_MAX_DEVIATION_BPS`, `RWA_RESERVE_FLOOR`, `RWA_MAX_TRADE_VALUE`, `RWA_DAILY_SELL_LIMIT`.

   Freshness must be 300–86400 seconds, divergence 1–500 bps, floor/trade limit positive, and daily limit at least the trade limit. These constructor settings cannot be loosened later.
4. Run from `0xFi`: `forge script contracts/script/DeployRwaMarket.s.sol:DeployRwaMarket --root contracts --rpc-url <verified-rpc> --account <keystore-account>`. This is a simulation; inspect the result. Add `--broadcast` only for the intended onchain deployment. The script supports chain 4441 and local chain 31337 and deploys the market **paused**.
5. Approve and call `fund(true, assetAmount)` for inventory and `fund(false, settlementAmount)` for settlement liquidity. Funding must exceed the reserve floor. The owner calls `setPaused(false)` only after price and reserve checks pass. Use an independent review of the deployed bytecode/configuration before public funding.
6. Add the verified market to `shared/rwa/markets.json`, in the `markets` array. Required fields: `chainId`, `market`, `asset`, `settlement`, `assetSymbol`, `settlementSymbol`, `assetDecimals`, `settlementDecimals`, `name`, `issuer`, `documentationUrl`, `sourceUrls` (four HTTPS references in adapter order). Both clients validate the catalog and confirm token addresses, decimals and fee against the market before enabling trades.
7. Run `node scripts/check-rwa-markets.mjs --rpc-url <verified-rpc>`. It checks chain, catalog identities, oracle health, actual upstream feed separation and adapter feed descriptions. Rebuild both applications after changing the bundled catalog.

The web dev panel supports fee withdrawal, fee reinvestment, permanent settlement funding and pause/open. Onchain ownership is authoritative. Token inventory funding uses `fund(true, amount)` with the issuer's token approval.

## Validation

Run `forge test --root contracts --match-contract RwaMarketTest`; `forge build --root contracts`; then `node scripts/generate-rwa-abi.mjs`. Both clients use the generated shared ABI. Shared client regression tests live under the web and wallet test trees. Contract tests cover reserve separation, fees, mixed decimals, limits, faulty feeds, taxes and round-trip fuzzing; passing tests are not an independent security audit.
