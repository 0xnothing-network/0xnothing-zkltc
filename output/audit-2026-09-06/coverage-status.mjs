import fs from 'node:fs';
import crypto from 'node:crypto';
const base = 'output/audit-2026-09-06/';
const read = p => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const inventory = read(base + 'inventory.json');
const ledgers = fs.readdirSync(base).filter(p => p.endsWith('-reviewed.json'));
const records = ledgers.flatMap(name => {
  const data = read(base + name);
  return (Array.isArray(data) ? data : data.files ?? []).map(f => ({...f, ledger: name}));
});
const byPath = new Map();
for (const record of records) {
  const key = record.path?.replaceAll('\\', '/');
  if (key) byPath.set(key, [...(byPath.get(key) ?? []), record]);
}
const missing = inventory.filter(f => f.category === 'first-party' && !byPath.has(f.path));
const css = read(base + 'styles-before.json').map(f => ({...f, unchanged: crypto.createHash('sha256').update(fs.readFileSync(f.path)).digest('hex').toUpperCase() === f.hash}));
const summary = { ledgers, firstPartyBaseline: inventory.filter(f=>f.category==='first-party').length, missing, css };
fs.writeFileSync(base + 'coverage-status.json', JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ledgers, firstPartyBaseline:summary.firstPartyBaseline, missing:missing.map(f=>f.path), cssUnchanged:css.filter(f=>f.unchanged).length},null,2));
