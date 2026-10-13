# Testnet faucet

LiteForge-only contract that drips small zkLTC and NUSD amounts to the calling EOA. It is not part of `DeployTestnet` and must never be deployed on mainnet.

## Contract

`TestnetFaucet` lives in `0xNothing-zkLTC-Testnet/contracts/src/nusd/TestnetFaucet.sol`.

- Constructor reverts unless `block.chainid == 4441`.
- `claim()` sends `nativeDrip` zkLTC and `nusdDrip` NUSD to `msg.sender`.
- `tx.origin == msg.sender` (contracts cannot claim).
- Per-address cooldown (default 8 hours).
- UTC daily caps (default 2 zkLTC / 1,000 NUSD).
- Admin (two-step) can retune drip/cooldown/caps, pause, and withdraw.

Defaults: 0.05 zkLTC and 25 NUSD every 8 hours.

## Deploy (no broadcast until approved)

From `0xNothing-zkLTC-Testnet/contracts`:

```bash
export PRIVATE_KEY="$(cast wallet new | awk '/Private key/{print $3}')"
export LITVM_RPC_URL=https://liteforge.rpc.caldera.xyz/infra-partner-http
export NUSD_ADDRESS=0x677D63c78E77E0b1971530e1494Caee4Bd7d631e
forge script script/DeployFaucet.s.sol:DeployFaucet --rpc-url "$LITVM_RPC_URL"
```

The script writes prediction-only `deployments/faucet.json` with `broadcasted: false`. After an approved `--broadcast`, fund the faucet with native zkLTC and NUSD, then set `NEXT_PUBLIC_FAUCET_ADDRESS` for the web app.

Environment knobs are listed in `contracts/.env.example`.

## Web

`/faucet` reads the live drip, cooldown, daily remaining, and inventory, then submits `claim()` with the same wallet-guard and receipt checks as the NUSD panel. The page stays disabled until the faucet address is configured. It uses the current OracleNUSD (`0x677D…`), not a stale Pump alias.
