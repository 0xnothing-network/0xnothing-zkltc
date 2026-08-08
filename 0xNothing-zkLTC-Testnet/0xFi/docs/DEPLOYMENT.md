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
The reserve-aware synth replacement used a dedicated receipt-journaled workflow.
It refused legacy debt, bad debt, synth supply, lending collateral, and nonzero
legacy pair/gauge state. Debt-free, fully backed legacy user collateral was
allowed so the migration could not confiscate or strand a user withdrawal. Old
minting and gauge deposits remain paused while old vault withdrawals stay open.

The same migration deploys the replacement fee router and a separate synth-fee
gauge factory. The existing gauge factory remains canonical for WzkLTC and old
0xPump gauges; the new factory owns only the new synth/NUSD gauges and their mint
fee routes. No existing LP token or pool reserve is moved.

```powershell
npm.cmd run synth:safety-reserve:check
npm.cmd run synth:safety-reserve:broadcast
# Interrupted transaction sequence only:
npm.cmd run synth:safety-reserve:resume
# Transactions landed but local publication failed only:
npm.cmd run synth:safety-reserve:finalize
npm.cmd run synth:safety-reserve:activate:check
npm.cmd run synth:safety-reserve:activate
```

The receipt-aware finalizer verifies the current creation bytecode, successful
receipts, reserve/vault ownership and bindings, zero initial accounting, oracle
bindings, new pairs/gauges, disabled old lending collateral, and enabled new
collateral before publishing any address. It publishes the router, vaults,
synth-fee factory, public environment, and second subgraph factory source from
the same receipt set; partial local publication is rejected. Funding the reserve is a separate,
irreversible `fund(uint256)` action and is never performed by migration.

The fixed-rate replacement is active at
`0x7CB638F8e10f1bd200A3c5C3fD014C3FD97BA914`. Its receipt journal is stored in
`contracts/deployments/lending-fixed-rate.json`; the finalized historical
manifest remains preserved. The workflow refused borrowing, bad debt, or
lending collateral, paused all risk-increasing actions on the old pool,
conserved the deployer-owned NUSD shares, and validated the fixed 4.5% borrower /
4% lender / 0.5% protocol spread plus 80/85/90 collateral risk before
publication.

```powershell
npm.cmd run lending:fixed-rate:check
npm.cmd run lending:fixed-rate:broadcast
# Interrupted transaction sequence only:
npm.cmd run lending:fixed-rate:resume
# Transactions landed but local publication failed only:
npm.cmd run lending:fixed-rate:finalize
# Finalization publishes the replacement in a paused staged state. Verify first,
# then use the owner-only, receipt-aware activation step:
npm.cmd run lending:fixed-rate:activate:check
npm.cmd run lending:fixed-rate:activate
```

No broadcast command is part of a normal build. Review the dry-run prediction
and generated transaction sequence before using a broadcast command. The
lending finalizer always leaves supply, borrow, and collateral withdrawals
paused. Lending activation is deliberately rejected until the synth migration
is finalized and both replacement vaults and gauges are active. The only safe
order is: finalize staged lending, migrate/finalize synth, activate both synth
vaults and gauges, then activate lending last. Every wrapper is idempotent and
receipt-aware for interrupted local publication.

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

After both migrations are finalized, deploy the configured Goldsky subgraph
with `npm.cmd run deploy` from `subgraph`, wait for 100% sync, and run
`npm.cmd run audit:live` there. The checked generated web configuration already
contains the staging endpoint; production does not depend on an ignored local
environment file. Rebuild the unified web app after publication. The app uses
Goldsky for historical candles/activity and RPC for live state plus the bounded
tail.

`activate:testnet` verifies core governance first, then transfers Pump and router
administration to the controller. If the second phase is interrupted, rerun the
same command or use `pump:automation:activate`; both paths resume from live
state. `activate:core` exists only for isolated legacy-timelock recovery; use
`activate:core:check` before it.

For a fresh recovery, verify the staged lending configuration, complete and
activate synth first, then activate lending and run the live audits:

```powershell
npm.cmd run lending:collateral:check
npm.cmd run synth:safety-reserve:check
npm.cmd run synth:safety-reserve:activate:check
npm.cmd run synth:safety-reserve:activate
npm.cmd run lending:fixed-rate:activate:check
npm.cmd run lending:fixed-rate:activate
npm.cmd run audit:live
Push-Location subgraph
npm.cmd run audit:live
Pop-Location
```

The migration already configures all three collateral assets while risk actions
remain paused. Activation is idempotent, simulates the owner call, requires
fresh DIA oracles and exact caps/80-85-90 risk, and verifies the successful
receipt before public configuration is enabled. The legacy collateral configure
command remains available for isolated recovery, but is not part of this staged
migration path.

Canonical liquidity is a separate, asset-spending operation. It is not hidden
inside migration or build commands. Verify current reserves, stakes, and reward
routes first; only broadcast when the explicit bootstrap budget is approved:

```powershell
npm.cmd run liquidity:bootstrap:check
npm.cmd run liquidity:bootstrap
```

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
