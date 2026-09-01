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
- The router was deployed disabled with no adapter. On testnet it is now enabled
  with the pinned 0xFi adapter allowed; both transitions were delayed and are
  visible onchain.
- Adding an adapter is delayed and visible onchain.
- Only allowlisted adapter code may receive reserves.
- A holder can sell from `READY`; that sell reopens the curve as `TRADING` so reserves are not indefinitely trapped while graduation is unavailable.
- `graduateReady` is permissionless and cannot choose the adapter, pool, recipient, price, or liquidity amount. It reverts unless `graduationsPaused` is false, the router is enabled, and the pinned adapter is allowed. Only `governance` may unpause; the guardian and `governance` may call `emergencyPause`, which pauses graduations, pauses Pump, and disables the router in one call and cannot itself unpause. The Pump trade pause blocks create, buy, and sell, and the router and adapter disable controls independently stop graduation.
- Adapter failures revert graduation and leave the market in `READY` with its reserves intact.
- Mainnet graduation additionally requires an audited NUSD-to-official-zkLTC-
  stablecoin conversion or bridge, a real major-DEX fork test, terminal-price
  continuity checks, explicit minimum-output/deadline controls, and an LP lock
  or burn path.

## Upload controls

- The Pinata JWT is server-only and scoped to the minimum public-upload permissions.
- Uploads require a recent wallet signature, an owner-scoped paid reservation, and a content hash binding the canonical metadata and file bytes. The multipart body is bounded before parsing, and uploads are always rate-limited by the authenticated wallet. A trusted proxy IP adds a second quota when configured; without one, no spoofable forwarding header is accepted and unrelated wallets are not collapsed into a shared bucket.
- Reservations do not expire or refund. A failed attempt can retry only with the same canonical fields and logo; changing content requires another reservation.
- Only PNG, JPEG, and WebP are accepted. SVG is rejected because it can carry active content.
- File size and magic bytes are checked server-side. Mainnet must additionally re-encode images, strip metadata, and use durable distributed rate limiting.
- Production deployments must set `UPLOAD_SIGNING_DOMAIN` to the public host used by wallet signatures; the request `Host` header is not trusted as a production fallback.

## NUSD staking and xPoints controls

- Fixed-duration NUSD positions, xPoints accounting, withdrawals, voucher nonces, conversion rate versions, and redemption settlement are enforced by `NusdPointsStaking` on-chain.
- Locked user principal and the redemption reserve are accounted separately. Owner reserve withdrawals and excess recovery cannot consume locked principal, while matured user withdrawals remain available during pauses.
- Public direct redemption is disabled at deployment and remains unavailable unless the separately funded reserve is non-zero, the rate is non-zero, redemption is enabled and unpaused, and the contract is solvent. The UI hides the action until all conditions hold, while the contract remains the fail-closed authority.
- Every successful direct or voucher redemption increases `spentPointCredits`, so on-chain available credits remain `earnedPointCredits - spentPointCredits`; settlement also decreases only the separate redemption reserve, never locked principal.
- Short-lived, account- and recipient-bound EIP-712 vouchers from a separate unfunded signer are optional and reserved for airdrop or relayed redemption. Rate changes and signer rotation invalidate outstanding voucher authorization paths; per-account nonces block replay.
- The optional voucher signer private key is server-only and never a `NEXT_PUBLIC_` variable. The `/dev` client supplies an owner wallet signature; it cannot read the signer key or bypass contract authorization.
- Neither redemption path is secret on-chain. Rates, configured addresses, events, reserves, and successful redemptions are public. See `0xFi/docs/NUSD_POINTS.md` for the testnet runbook and mainnet gates.

## Operational controls

- Contract ownership and fee recipient roles must move to a Safe multisig before production use.
- Deployment manifests, bytecode, constructor arguments, and start blocks must be checked before publishing a subgraph.
- No mainnet deployment is allowed until the gates in the mainnet plan are complete.
