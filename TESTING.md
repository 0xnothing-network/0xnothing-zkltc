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
- Root tooling tests cover cleanup boundaries, manifest rendering, bounded HTTP JSON parsing, and testnet/mainnet Pump subgraph parity.
- `0xPixel-Dogeos/tests/` covers the standalone DogeOS API, indexing, artwork, wallet guards, embedding, and hosting. Root verification also runs its contract tests, TypeScript/Vite build, and subgraph build through `npm run verify:dogeos`.

Keep a fixture or helper beside the domain that owns it. Move it to a shared
`helpers` or `mocks` directory only after multiple test files consume it. Test
doubles must never be imported by production source or deployment scripts.

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

Cleanup includes DogeOS build outputs and the web's regenerated `.dogeos`
embedding bundle. It preserves `0xPixel-Dogeos/src/generated/` ABI and deployment
inputs and the `.runtime/` index checkpoint. Stop local preview servers before
cleaning their build directories; run the owning build command before restarting.
