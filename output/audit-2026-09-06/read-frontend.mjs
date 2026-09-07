import fs from 'node:fs';
import path from 'node:path';
const base = 'output/audit-2026-09-06/';
const inventory = JSON.parse(fs.readFileSync(base + 'inventory.json', 'utf8').replace(/^\uFEFF/, ''));
const prefix = '0xNothing-zkLTC-Testnet/apps/web/';
const owned = inventory.filter(f => f.category === 'first-party' && f.path.startsWith(prefix)
  && !/\/api\/|\/server\/|\/tests\/(server|media)\//.test(f.path)
  && !/\/(erc721Metadata\.server|marketplaceSubgraph|onchainMarketplace|boundedCache)\.ts$/.test(f.path)
  && !/\/[^/]+\.(config\.[^/]+|jsonc|json|svg)$/.test(f.path)
  && !/\/\.(env|gitignore)|\/middleware\.ts$|\/public\//.test(f.path));
const group = process.argv[2] || '';
const start = Number(process.argv[3] || 0);
const end = Number(process.argv[4] || start + 10);
const matches = owned.filter(f=>f.path.includes(group));
if (process.argv.includes('--mark')) {
  const ledgerPath = base + 'frontend-reviewed.json';
  const existing = fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath,'utf8')) : [];
  const byPath = new Map(existing.map(f=>[f.path,f]));
  for(const file of matches.slice(start,end)) byPath.set(file.path,{path:file.path,status:'full-source-read',bytes:file.bytes});
  fs.writeFileSync(ledgerPath,JSON.stringify([...byPath.values()],null,2)+'\n');
  console.log(`Recorded ${byPath.size} completed reads`);
} else if (process.argv.includes('--list')) {
  matches.forEach((f,i)=>console.log(`${i}\t${f.path.slice(prefix.length)}\t${f.bytes}`));
} else {
  for (const f of matches.slice(start,end)) {
    const data = fs.readFileSync(f.path,'utf8');
    console.log(`\nFILE ${f.path}\n${data}\nEND FILE ${f.path}`);
  }
}
