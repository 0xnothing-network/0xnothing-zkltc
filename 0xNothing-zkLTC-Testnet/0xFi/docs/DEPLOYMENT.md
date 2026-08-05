# Testnet deployment

## Policy

All behavioral testing runs locally or against read-only fork state. Broadcast
only once after the dry-run manifest is reviewed. Do not send test swaps merely
to check whether the UI button works; use contract simulation first.

Fresh deployment predictions use `contracts/deployments/fresh-deployment.json`.
The testnet governance migration uses
`contracts/deployments/direct-governance.json`; these recovery artifacts must
never share a path.

`audit:live` is a health gate and exits nonzero unless the full suite is
operational. During a planned transition, use `audit:live:report` to print the
same read-only evidence without treating inactive state as command failure.

## Order

1. Verify chain ID 4441, deployer, balance, existing NUSD, Pump, Pump router,
   locker, NUSD reserve coverage, DIA oracle code, and fresh LTC/USD, BTC/USD,
   ETH/USD timestamps.
2. Deploy WzkLTC, DEX factory/router, the synth safety reserve, synth tokens and
   vaults, lending pool, farming factory, and Pump graduation adapter.
3. Configure caps and roles, renounce synthetic-token ownership, and verify the
   deployer remains the direct testnet owner/guardian with no pending owner.
4. Create the three canonical NUSD pools and fund them only through explicit
   user-approved liquidity transactions.
5. Deploy the Goldsky subgraph from the final deployment block.
6. Publish the generated public manifest to the web app.
7. Deploy and verify the pinned Pump graduation controller without transferring
   either admin role. Its governance and guardian are the recorded direct
   testnet deployer.
8. Record status as pending graduation activation, not fully active. Wait the
   Pump router's intrinsic 48-hour adapter/enable delay, run
   `npm.cmd run activate:check`, then execute `npm.cmd run activate:testnet`.
   Activation verifies all five direct owners and pending-owner slots, adapter
   allowlisting, router enablement, controller bindings, and both final admin
   roles.

## Recovery commands

```powershell
npm.cmd run deploy:dry
npm.cmd run deploy:testnet
npm.cmd run deploy:resume
npm.cmd run deploy:finalize
npm.cmd run migrate:finalize
npm.cmd run governance:direct:check
npm.cmd run governance:direct:broadcast
npm.cmd run governance:direct:resume
npm.cmd run governance:direct:finalize
npm.cmd run pump:controller:check
npm.cmd run activate:check
npm.cmd run pump:controller:deploy
npm.cmd run activate:testnet
npm.cmd run pump:automation:activate
npm.cmd run pump:keeper:check
npm.cmd run pump:keeper
```

The global NUSD health guard remains removed from lending and the synth 150%
fallback. The 100%-user-funded synth path is narrower: it requires a dedicated
100,000 NUSD Safety Reserve, a 24-hour activation delay, full NUSD reserve
backing, a fresh DIA price, free reserve allocation, and all normal debt-ceiling
and pause checks. Falling below 90,000 NUSD disables new sponsorship without
removing collateral already assigned to existing positions.

The old guard-removal migration is permanently retired and must not be replayed.
To replace the currently empty synth markets with reserve-aware vaults, run the
dedicated migration dry-run, review its predicted addresses, then broadcast and
finalize. The migration refuses nonzero legacy vault debt/collateral, synth
supply, LP/gauge state, or lending collateral. It pauses old minting and gauge
deposits, but deliberately leaves old vault withdrawals open so no later deposit
can be trapped.

The same migration deploys the replacement fee router and a separate synth-fee
gauge factory. The existing gauge factory remains canonical for WzkLTC and old
0xPump gauges; the new factory owns only the new synth/NUSD gauges and their mint
fee routes. No existing LP token or pool reserve is moved.

```powershell
$env:PRIVATE_KEY = "<testnet-deployer-key>"
forge script script/MigrateSynthSafetyReserve.s.sol:MigrateSynthSafetyReserve --root contracts --rpc-url $env:LITEFORGE_RPC_URL
forge script script/MigrateSynthSafetyReserve.s.sol:MigrateSynthSafetyReserve --root contracts --rpc-url $env:LITEFORGE_RPC_URL --broadcast
node scripts/finalize-synth-safety-reserve.mjs
Remove-Item Env:PRIVATE_KEY
```

The receipt-aware finalizer verifies the current creation bytecode, successful
receipts, reserve/vault ownership and bindings, zero initial accounting, oracle
bindings, new pairs/gauges, disabled old lending collateral, and enabled new
collateral before publishing any address. It publishes the router, vaults,
synth-fee factory, public environment, and second subgraph factory source from
the same receipt set; partial local publication is rejected. Funding the reserve is a separate,
irreversible `fund(uint256)` action and is never performed by migration.

The legacy migration originally scheduled timelock ownership. This testnet now
uses direct deployer governance. To cancel those pending operations, clear every
pending owner, deploy a controller bound to the deployer, and transfer Pump
administration, use the dedicated wrapper. Always run its dry-run first:

```powershell
npm.cmd run governance:direct:check
npm.cmd run governance:direct:broadcast
```

If the broadcast is interrupted use `governance:direct:resume`; if transactions
landed but local publication failed use `governance:direct:finalize`. The
finalizer refuses to publish until receipts, cancelled operations, nine direct
owner/guardian bindings, controller bindings, router state, and both Pump admin
slots match. These commands are hard-pinned to chain 4441 and are not a mainnet
governance template.

After broadcast, deploy the configured Goldsky subgraph and copy its endpoint
to `NEXT_PUBLIC_GOLDSKY_ENDPOINT` in `web/.env.local`. Rebuild the web app after
that endpoint change. The app uses Goldsky for historical candles/activity and
RPC for live state plus the bounded tail.

`activate:testnet` verifies core governance first, then transfers Pump and router
administration to the controller. If the second phase is interrupted, rerun the
same command or use `pump:automation:activate`; both paths resume from live
state. `activate:core` exists only for isolated legacy-timelock recovery; use
`activate:core:check` before it.

For an already-finalized deployment, verify and apply the three lending
collateral bindings before graduation activation:

```powershell
npm.cmd run lending:collateral:check
npm.cmd run lending:collateral:configure
npm.cmd run audit:live
```

The configure command is idempotent, simulates every changed call, and only
uses the current lending owner. It does not bypass DIA freshness, collateral
caps, LTV thresholds, liquidity checks, or guardian pauses.

The keeper must use `KEEPER_PRIVATE_KEY`, a separate wallet holding only gas.
There is deliberately no fallback to `DEPLOYER_PRIVATE_KEY`.
It scans sequentially, limits each pass with
`GRADUATION_KEEPER_MAX_PER_SCAN`, simulates every call, and can be restarted
without a local database. Run one primary instance to avoid duplicate gas races;
execution remains open to another keeper or the 0xPump UI.

The controller prepares each token/NUSD pool atomically inside
`graduateReady`. Manual preparation is no longer required. The command below is
retained only for read/simulation-assisted recovery:

```powershell
npm.cmd run pump:prepare -- 0xPumpTokenAddress
npm.cmd run pump:prepare:broadcast -- 0xPumpTokenAddress
```

The first command only simulates or verifies. The explicit `:broadcast` command
creates the pair when required. Both verify the chain, token registration,
bytecode, and that the canonical pair is empty and locked to the graduation
adapter.
