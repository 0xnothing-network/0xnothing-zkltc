# Testnet deployment

The live suite since 2026-10-15 is v3, deployed by `scripts/deploy-v3.mjs`. Its
rules and stage-by-stage runbook are in `../../docs/TOKENOMICS.md`. v3 is already
broadcast: never rerun `deploy:v3`.

```powershell
npm.cmd run deploy:v3:status
```

## Policy

All behavioral testing runs locally or against read-only fork state. Broadcast
only once after the rehearsal is reviewed. Do not send test swaps merely to
check whether the UI button works; use contract simulation first.

## Retired v1 suite

The v1 deploy, governance, migration, activation, liquidity, points and
graduation-keeper scripts, and `audit:live`, were removed on 2026-11-02; git
history keeps them. Their records stay in `contracts/deployments/`
(`latest.json` is the v1 suite) for tracing an old address or transaction.
