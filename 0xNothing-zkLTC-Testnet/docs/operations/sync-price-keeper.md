# syncPrice keeper

`DIAOracleAdapter.syncPrice()` re-anchors the deviation breaker to the current DIA LTC/USD round. Mint and redeem already call `ensureAnchor()`; this keeper is the fallback when the constructor never armed the anchor or the anchor is aging inside `maxPriceAge`.

Target only the Pump/OracleNUSD adapter (`0x6d18728bCB57c3Ce7DFb5A522fF22836280D6C98`). The 0xFi DIAOracleV2 adapters are view-only and have no `syncPrice()`.

## Policy

`decideSyncPrice`:

- skip when the feed cannot be read (`isFresh()` is false);
- sync when `anchorPriceWad == 0` (unarmed);
- sync when the anchor age is at least `maxPriceAge - SYNC_PRICE_LEAD_SECONDS` (default 300s);
- skip when the anchor is still fresh.

A stale feed cannot be healed by `syncPrice()` because that call also reads the live round.

## Node CLI

From the workspace root or `0xFi`:

```bash
npm run sync-price:check   # dry-run scan
npm run sync-price:once    # sync once if needed
npm run sync-price         # loop
```

Requires `KEEPER_PRIVATE_KEY` for `--once` and the loop. Optional: `SYNC_PRICE_ADAPTER`, `SYNC_PRICE_LEAD_SECONDS`, `SYNC_PRICE_INTERVAL_SECONDS`.

## Cloudflare Worker cron

`0xFi/keepers/sync-price/` is a Worker that applies the same policy on a 15-minute cron.

```bash
cd 0xNothing-zkLTC-Testnet/0xFi/keepers/sync-price
npx wrangler deploy --dry-run
```

Set `KEEPER_PRIVATE_KEY` as a Worker secret if the isolate should submit `syncPrice()`. HTTP GET stays dry-run. See `docs/CLOUDFLARE_WORKERS.md` for the web Worker; this keeper is a separate cron isolate.
