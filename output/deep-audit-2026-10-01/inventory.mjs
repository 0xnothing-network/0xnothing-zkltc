import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const files = [...new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', windowsHide: true }).split('\0').filter(Boolean))].filter(file => existsSync(path.join(root, file)));
const isSource = /\.(?:sol|ts|tsx|js|mjs|cjs|sh|cmd|ps1|css|scss|sass|html)$/i;
const isConfig = /\.(?:json|ya?ml|toml|graphql)$/i;
const excluded = /(?:^|\/)(?:node_modules|generated|build|out|cache|dist|\.next|\.git|graft|output|\.codex)(?:\/|$)|\/contracts\/lib\/|\/abis\/|\/artifacts\//;
const scoped = file => /^(?:0xNothing-zkLTC-(?:Testnet|Mainnet)\/|scripts\/)/.test(file) || ['package.json', 'package-lock.json', 'AGENTS.md'].includes(file);
const owner = file => file.includes('/apps/web/') ? 'web' : file.includes('/apps/wallet/') ? 'wallet' : file.includes('/shared/') || file.startsWith('scripts/') || !file.startsWith('0xNothing-') ? 'root' : 'contracts-subgraphs';
const rows = files.filter(scoped).filter(file => isSource.test(file) || isConfig.test(file)).map(file => ({ file, owner: owner(file), category: excluded.test(file) ? 'excluded-vendor-or-generated' : /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:test|t)\./.test(file) ? 'test' : isConfig.test(file) ? 'configuration' : 'source' }));
const counts = {};
for (const row of rows) {
  const key = `${row.owner}:${row.category}`;
  counts[key] = (counts[key] || 0) + 1;
}
writeFileSync(path.join(root, 'output/deep-audit-2026-10-01/inventory.json'), JSON.stringify({ generatedAt: new Date().toISOString(), counts, files: rows }, null, 2) + '\n');
console.log(JSON.stringify(counts, null, 2));
