# Security model and known limits

This is the mainnet-candidate implementation, not an audit report. The owner has
formally accepted finding **H-1**: OracleNUSD stays a 1:1, zero-fee mint/redeem at
the current DIA print with `maxPriceAge` default 3600 seconds. Release still
requires the gates in `docs/MAINNET_PLAN.md`.

## Economic controls

- A nonrefundable `1 NUSD` reservation fee is paid before hosted IPFS upload, reducing cheap token and storage spam. It does not prevent bots, sybil identities, frontrunning, or malicious token marketing.
- The `0.1%` trade fee is fixed in contract code so an administrator cannot raise it after launch.
- The curve must remain solvent for every buy/sell sequence. Tests cover reserve accounting, rounding, fee separation, and round-trip behavior.
- Frontend quotes are advisory. Contract-side `minOut` and `deadline` checks are the actual protection.

## Oracle and stablecoin controls

- Reject non-positive, incomplete, future-dated, and stale DIA rounds.
- `DIAOracleAdapter` also rejects prices outside admin-set `minPriceWad`/`maxPriceWad` bounds and prices that move more than `maxDeviationBps` from the last synced anchor per `maxPriceAge` interval. The allowance grows with elapsed time up to `MAX_DEVIATION_INTERVALS` (3), so a genuine large move self-heals without a keeper and without unbounded drift. The constructor try-arms the anchor when the feed is readable (live shanghai DIA). If that read fails — paris Foundry simulation of PUSH0 aggregators — mint/redeem call `ensureAnchor()` and arm on the first successful consume. Permissionless `syncPrice()` remains a fallback after broadcast; it is not part of the deploy script. Deviation is skipped only while the anchor is still zero; min/max bounds always apply. The admin can only accept or reject feed prices, never supply one.
- **R-3.** The deviation anchor never auto-updates on mint or redeem: `ensureAnchor()` writes only when `anchorPriceWad == 0`, then only checks. A move larger than `maxDeviationBps * 3` from the last anchor reverts mint, redeem, and `syncPrice()`. At the default 2000 bps that band is 60%. A 3× price jump stays blocked until the feed returns inside the band (anyone may then `syncPrice()`) or the admin calls `resetPriceAnchor()`.
- Oracle admin powers (bounds, breaker, freshness, round completeness). None of these let the admin inject a price:
  - `setPriceBounds(minPriceWad, maxPriceWad)` — inclusive wad band; `min` must be > 0 and `< max`.
  - `setMaxDeviationBps` — `0` disables the breaker; otherwise 1–10_000 bps per `maxPriceAge` interval, growth capped at three intervals.
  - `setMaxPriceAge` — 5 minutes to 2 hours.
  - `setEnforceAnsweredInRound` — disable if a feed stops populating `answeredInRound`, so that field alone cannot permanently brick OracleNUSD.
  - `resetPriceAnchor` — re-anchor immediately, bypassing only the deviation check; stale and out-of-bounds prices still revert.
- `maxPriceAge` is settable between 5 minutes and 2 hours. Choose it from the final mainnet DIA heartbeat. Values below the feed period halt mint and redeem between updates. The chosen default remains 3600 seconds.
- **H-1 (accepted).** Mint and redeem use the current DIA price with integer rounding and no protocol fee. The owner accepts this residual risk: a stale or manipulated feed can mint NUSD at an off-market rate, and there is no spread to absorb oracle error. Invalid oracle data stops both operations. Keep `DIA_MAX_PRICE_AGE` at 3600 unless the feed heartbeat changes. This model is not overcollateralized.
- `mintPaused` and `redeemPaused` are independent incident controls. `coverReserve` and quote views remain available while paused.
- Mainnet `DeployMainnet` fixes `supplyCeilingNusd` to `type(uint256).max`. There is no practical protocol-wide issuance cap; every mint still requires a native zkLTC deposit valued 1:1 in USD by the DIA oracle. A zkLTC/USD price decline can make the native reserve worth less than outstanding NUSD, and redemptions can then exhaust the reserve.
- There are no user debt positions, collateral ratios, liquidations, or administrator reserve sweep. The accepted H-1 model still needs independent economic review, oracle manipulation analysis, and an explicit reserve-deficit policy before `MAINNET_RELEASE_APPROVED=true`.
- OracleNUSD does not inherit balances or backing from any testnet NUSD or NativeCollateralVault.

## Graduation controls

- READY is determined by `spotPriceNusdWad * fixedTotalSupply / 1e18` reaching
  exactly `6,000 NUSD`; the contract separately derives the real-reserve target
  needed to reach that market cap.
- `DeployMainnet` deploys the router disabled with no adapter. Adding an adapter
  is delayed and visible onchain. Only allowlisted adapter code may receive
  reserves.
- A `READY` market rejects further buys. Sells are frozen only while graduation is possible (a `graduationAdapter` is set, the router is enabled, and that adapter is allowlisted). If graduation is impossible, holders can sell immediately. When the freeze applies, sells reopen the curve only after `readyExitDelay` (default 24 hours, admin-settable between 1 and 3 days).
- `ZeroXPump.graduate` is pause-gated for every caller, including the admin. Graduation is **disabled by default**: `graduate` reverts `GraduationDisabled` until the admin sets `graduationAdapter`. The admin may graduate a READY market without waiting; any other account may graduate once `permissionlessGraduationDelay` (default 1 hour, at most 1 day) has elapsed. Caller-supplied `adapter` and `minimumLp` are ignored. The Pump uses `graduationAdapter` and an on-chain UniV2 minLP with 100 bps of slippage.
- **R-1 (known issue, follow-up).** `graduationMinimumLp` is `sqrt(tokenLiq * nusdLiq) - 1000` with 100 bps slack and assumes a **fresh** UniV2 pair. A pre-created or reserve-skewed pool can make `addLiquidity` return less LP than this floor (DoS, market stays READY) or, with the 1% slack, allow roughly 1% extraction. Do not set `graduationAdapter` against a live pair. A later UniV2 adapter PR must compute reserve-aware minLP and handle a pre-existing pair. This PR does not add that adapter.
- Launch protection caps each buyer's cumulative gross NUSD at `launchMaxBuyNusd` during the first `launchProtectionWindow` seconds (at most 1 hour) after creation. The contract default is off; the deploy script enables 15 minutes / 50 NUSD unless overridden. It does not stop a sniper splitting buys across accounts.
- The Pump pause blocks reservation, create, buy, and every graduation but leaves sells open so holders can exit. A separate admin `setSellPause` can halt sells for at most 24 hours and auto-expires; after a halt is armed, a new one cannot start until 72 hours after that halt's expiry (R-2), so rolling 24h pauses cannot become a perpetual lock. The router and adapter disable controls independently stop graduation.
- Adapter failures revert graduation and leave the market in `READY` with its reserves intact.
- Mainnet graduation additionally requires an audited NUSD-to-official-zkLTC-
  stablecoin conversion or bridge, a real major-DEX fork test, terminal-price
  continuity checks, explicit minimum-output/deadline controls, and an LP lock
  or burn path.

## Upload controls

Mainnet must not reuse the testnet Pinata JWT or Host-header fallback.

- Uploads require a recent wallet signature, an owner-scoped paid reservation, and a content hash binding the canonical metadata and file bytes.
- Only PNG, JPEG, and WebP are accepted. SVG is rejected because it can carry active content.
- File size and magic bytes are checked server-side. Mainnet must additionally re-encode images, strip metadata, and use durable distributed rate limiting.
- Production deployments must set `UPLOAD_SIGNING_DOMAIN` to the public host used by wallet signatures; the request `Host` header is not trusted as a production fallback.

## Operational controls

- **L-3.** Oracle admin setters (`setPriceBounds`, `setMaxDeviationBps`, `setMaxPriceAge`, `setEnforceAnsweredInRound`, `resetPriceAnchor`) have **no on-chain timelock**. Mainnet must place those roles, plus Pump `setPaused` / `setSellPause` / `setGraduationAdapter`, OracleNUSD pauser, and router enable/allowlist, behind **Safe multisig + timelock**. A hot EOA must not hold them. `DeployMainnet` rejects `DIA_MAX_DEVIATION_BPS == 0` and out-of-band price bounds; an admin can still widen or disable the breaker later, which is why the timelock is required.
- When `PROTOCOL_ADMIN` differs from the deployer, that address must call `acceptAdmin()` on all three TwoStepAdmin contracts — `ZeroXPump`, `GraduationRouter`, and `DIAOracleAdapter` — before it can change pause, oracle, or graduation policy. OracleNUSD uses RoleControl and grants the pauser to `PROTOCOL_ADMIN` at construction.
- Contract ownership and fee recipient roles must be the same Safe. Timelock delay must cover oracle-parameter and graduation-adapter changes.
- Deployment manifests, bytecode, constructor arguments, and start blocks must be checked before publishing a subgraph.
- No mainnet deployment is allowed until the gates in `docs/MAINNET_PLAN.md` are complete.
