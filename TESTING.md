# Testing and generated files

Run the complete local verification from the workspace root:

```powershell
npm run verify
```

## Test layout

- `apps/web/tests/` groups tests by `client`, `data`, `media`, and `server` boundaries.
- `apps/wallet/tests/` groups tests by `config`, `core`, `extension`, `security`, and `ui` boundaries.
- `0xFi/contracts/test/` separates `unit`, `integration`, `risk`, `invariant`, `fork`, shared `helpers`, and reusable `mocks`.
- Testnet and mainnet Pump contracts keep matching `unit`, `fuzz`, `invariant`, `fork`, and `mocks` directories. Their common base contracts intentionally remain at the test root.
- Pump subgraph tests remain flat because `mapping.test.ts` is the explicit AssemblyScript compile target and `event-builders.ts` is its local support module.
- Root tooling tests cover cleanup boundaries, manifest rendering, bounded HTTP JSON parsing, testnet/mainnet Pump subgraph parity, and CI install walk order.
- 0xFi script tests also cover LiteForge liquidity-seed planning and the DIA `syncPrice` keeper policy.
- Web tests cover the faucet claim-state helper under `apps/web/tests/data/`.

Pull requests run the same `npm run verify` command in GitHub Actions. See
`0xNothing-zkLTC-Testnet/docs/operations/ci.md`. Testnet faucet, liquidity
seeding, and the `syncPrice` keeper runbooks live under
`0xNothing-zkLTC-Testnet/docs/operations/`.
Keep a fixture or helper beside the domain that owns it. Move it to a shared
`helpers` or `mocks` directory only after multiple test files consume it. Test
doubles must never be imported by production source or deployment scripts.

## Contract coverage

Pump contract coverage runs without `--ir-minimum`:

```powershell
forge coverage --root 0xNothing-zkLTC-Mainnet/contracts --report summary --no-match-coverage "(test|script)/"
```

The testnet project shares the same Pump sources. Its Pixel V2 contract is
rejected by forge's coverage analyzer, so exclude Pixel there:

```powershell
$env:FOUNDRY_SKIP='["src/0xpixel/**","test/0xPixelV2.t.sol"]'
forge coverage --root 0xNothing-zkLTC-Testnet/contracts --no-match-path test/0xPixelV2.t.sol --report summary --no-match-coverage "(test|script)/"
```

## Testnet Pump deploy dry run

The canonical LiteForge (chain ID 4441) path is `forge script
script/DeployTestnet.s.sol:DeployTestnet --rpc-url $LITVM_RPC_URL` from
`0xNothing-zkLTC-Testnet/contracts`, without `--broadcast`. Exact environment
variables are listed in `0xNothing-zkLTC-Testnet/docs/DEPLOYMENT.md` and
`0xNothing-zkLTC-Testnet/contracts/.env.example`.

## Generated outputs

Preview the directories that can be regenerated safely:

```powershell
npm run clean:generated:dry
```

Remove those outputs after a verification run:

```powershell
npm run clean:generated
```

The cleanup command uses a fixed workspace-relative allowlist. It does not
remove dependencies, deployment broadcasts, manifests, receipts, or secrets.
Generated Graph bindings already tracked by Git are intentionally retained;
their owning subgraph's `codegen` command updates them in place.

Stop local preview servers before cleaning their build directories; run the
owning build command before restarting.
