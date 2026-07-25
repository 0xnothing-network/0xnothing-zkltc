# Security model and known limits

This code is a testnet implementation, not an audit report.

## Economic controls

- A nonrefundable `1 NUSD` reservation fee is paid before hosted IPFS upload, reducing cheap token and storage spam. It does not prevent bots, sybil identities, frontrunning, or malicious token marketing.
- The `0.1%` trade fee is fixed in contract code so an administrator cannot raise it after launch.
- The curve must remain solvent for every buy/sell sequence. Tests cover reserve accounting, rounding, fee separation, and round-trip behavior.
- Frontend quotes are advisory. Contract-side `minOut` and `deadline` checks are the actual protection.

## Oracle and stablecoin controls

- Reject non-positive, incomplete, future-dated, and stale DIA rounds.
- Mint and redeem use the current DIA price with integer rounding and no protocol fee. Invalid oracle data stops both operations.
- `mintPaused` and `redeemPaused` are independent incident controls. `coverReserve` and quote views remain available while paused.
- The supply ceiling limits NUSD issuance, but it does not guarantee solvency. A zkLTC/USD price decline can make the native reserve worth less than outstanding NUSD, and redemptions can then exhaust the reserve.
- There are no user debt positions, collateral ratios, liquidations, or administrator reserve sweep. Before mainnet, the zero-fee oracle-priced reserve model needs independent economic review, oracle manipulation analysis, and an explicit reserve-deficit policy.
- The new OracleNUSD does not inherit balances or backing from the old testnet NUSD and NativeCollateralVault. Legacy addresses are recovery-only and must not be presented as current protocol backing.

## Graduation controls

- READY is determined by `spotPriceNusdWad * fixedTotalSupply / 1e18` reaching
  exactly `6,000 NUSD`; the contract separately derives the real-reserve target
  needed to reach that market cap.
- The testnet router is disabled and no graduation adapter is configured.
- Adding an adapter is delayed and visible onchain.
- Only allowlisted adapter code may receive reserves.
- A holder can sell from `READY`; that sell reopens the curve as `TRADING` so reserves are not indefinitely trapped while no adapter exists.
- Graduation is admin/Safe-triggered. The Pump trade pause blocks create, buy, and sell, but the router and adapter disable controls independently stop graduation.
- Adapter failures revert graduation and leave the market in `READY` with its reserves intact.
- Mainnet graduation additionally requires an audited NUSD-to-official-zkLTC-
  stablecoin conversion or bridge, a real major-DEX fork test, terminal-price
  continuity checks, explicit minimum-output/deadline controls, and an LP lock
  or burn path.

## Upload controls

- The Pinata JWT is server-only and scoped to the minimum public-upload permissions.
- Uploads require a recent wallet signature, an owner-scoped paid reservation, and a content hash binding the canonical metadata and file bytes. They are rate-limited by wallet and IP on a best-effort basis.
- Reservations do not expire or refund. A failed attempt can retry only with the same canonical fields and logo; changing content requires another reservation.
- Only PNG, JPEG, and WebP are accepted. SVG is rejected because it can carry active content.
- File size and magic bytes are checked server-side. Mainnet must additionally re-encode images, strip metadata, and use durable distributed rate limiting.

## Operational controls

- Contract ownership and fee recipient roles must move to a Safe multisig before production use.
- Deployment manifests, bytecode, constructor arguments, and start blocks must be checked before publishing a subgraph.
- No mainnet deployment is allowed until the gates in the mainnet plan are complete.
