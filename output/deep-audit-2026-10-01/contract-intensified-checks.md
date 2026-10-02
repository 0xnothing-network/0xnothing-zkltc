# Intensified contract checks

Results captured from completed Forge tool output in this audit. No Solidity production source was changed.

| Workspace | Command/configuration | Actual result |
| --- | --- | --- |
| Testnet/contracts | `FOUNDRY_INVARIANT_RUNS=256 FOUNDRY_INVARIANT_DEPTH=128 forge test --match-path test/invariant/*.t.sol --fuzz-runs 2048` | 6 invariants passed; each 256 runs / 32,768 calls; zero handler reverts |
| Testnet/0xFi/contracts | Same invariant command/configuration | 11 invariants passed; each 256 runs / 32,768 calls; zero handler reverts |
| Testnet/contracts | `forge test --match-contract ZeroXPixelV2Test --match-test testFuzz --fuzz-runs 2048` | 2 fuzz tests passed: Base64 differential and single-run packed round trip; 2,048 runs each |

Covered properties: native collateral/NUSD accounting; Pump inventory, constant-product and graduation threshold; Fi AMM reserve identity and router fee backing; lending asset/debt-share/collateral identity; synthetic collateral, supply/debt identity, reserve and routed fees; Pixel Base64 differential correctness and byte-level round trips.

Limits: these are properties of the existing handlers and their bounded scenarios, not an exhaustive proof against arbitrary oracle changes, governance changes, malicious token behavior or every contract callback. Mainnet standard tests are part of root verification; additional Mainnet fuzz/invariant runs are recorded separately if performed.
