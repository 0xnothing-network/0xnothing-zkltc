import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const directory = path.join(root, 'output/deep-audit-2026-10-01');
const inventory = JSON.parse(readFileSync(path.join(directory, 'inventory.json'), 'utf8'));
const contractLedger = JSON.parse(readFileSync(path.join(directory, 'contract-subgraph-ledger.json'), 'utf8'));
const contractRows = new Map(contractLedger.files.map(row => [row.file, row]));
const rootManual = new Set([
  '0xNothing-zkLTC-Testnet/shared/rwa/core.ts',
  '0xNothing-zkLTC-Testnet/shared/rwa/markets.ts',
  '0xNothing-zkLTC-Testnet/shared/transactions/tokenDelivery.ts',
  'scripts/clean-generated.mjs', 'scripts/check-pump-subgraph-parity.mjs',
  'scripts/lib/evm-rpc.mjs', 'scripts/lib/generated-cleanup.mjs',
  'scripts/lib/http-json.mjs', 'scripts/lib/pump-subgraph-parity.mjs',
  'scripts/lib/subgraph-manifest.mjs',
]);
const focused = new Set([
  '0xNothing-zkLTC-Testnet/apps/web/lib/walletSession.ts',
  '0xNothing-zkLTC-Testnet/apps/web/lib/contract.ts',
  '0xNothing-zkLTC-Testnet/apps/web/lib/onchainMarketplace.ts',
  '0xNothing-zkLTC-Testnet/apps/web/features/pixel/components/MintPanel.tsx',
  '0xNothing-zkLTC-Testnet/apps/web/app/api/marketplace/activity/route.ts',
  '0xNothing-zkLTC-Testnet/apps/wallet/src/core/services/dappExecution.ts',
  '0xNothing-zkLTC-Testnet/apps/wallet/src/core/services/dapp.ts',
  '0xNothing-zkLTC-Testnet/apps/wallet/src/core/services/tx.ts',
  '0xNothing-zkLTC-Testnet/apps/wallet/src/core/services/tokens.ts',
  '0xNothing-zkLTC-Testnet/apps/wallet/src/core/rpc/client.ts',
  '0xNothing-zkLTC-Testnet/apps/wallet/src/core/keyring/vault.ts',
  '0xNothing-zkLTC-Testnet/apps/wallet/src/core/lib/format.ts',
  '0xNothing-zkLTC-Testnet/apps/wallet/src/ui/screens/Approve.tsx',
  '0xNothing-zkLTC-Testnet/apps/wallet/src/extension/background.ts',
]);
const files = inventory.files.map(row => {
  const existing = contractRows.get(row.file);
  if (existing) return { ...row, review: existing.review, notes: existing.notes };
  if (row.category === 'excluded-vendor-or-generated') return { ...row, review: 'excluded', notes: 'Vendor or generated files; no claim of an independent manual dependency audit.' };
  if (rootManual.has(row.file)) return { ...row, review: 'manual-function-review', notes: 'Graft API/caller context plus exact implementation spans; relevant tooling/shared regressions passed.' };
  if (focused.has(row.file)) return { ...row, review: 'targeted-fix-and-regression-review', notes: 'Reviewed affected transaction, parsing or RPC recovery behavior; meaningful regressions and final workspace checks passed.' };
  return { ...row, review: 'workspace-checks-and-inventory', notes: 'Included in the relevant workspace verification and source inventory. This does not claim every line was manually reviewed or executed.' };
});
const totals = {};
for (const row of files) totals[row.review] = (totals[row.review] || 0) + 1;
writeFileSync(path.join(directory, 'coverage.json'), JSON.stringify({ generatedAt: new Date().toISOString(), inventoryCounts: inventory.counts, reviewCounts: totals, method: 'First-party workspace checks plus bounded manual and regression review; no numerical line-coverage claim.', files }, null, 2) + '\n');
console.log(JSON.stringify(totals, null, 2));
