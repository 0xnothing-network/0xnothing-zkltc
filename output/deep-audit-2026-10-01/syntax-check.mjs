import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const root = process.cwd();
const require = createRequire(path.join(root, '0xNothing-zkLTC-Testnet/apps/web/package.json'));
const ts = require('typescript');
const inventory = JSON.parse(readFileSync(path.join(root, 'output/deep-audit-2026-10-01/inventory.json'), 'utf8'));
const results = [];
for (const row of inventory.files) {
  if (row.category === 'excluded-vendor-or-generated') continue;
  if (/\.(?:mjs|cjs|js)$/.test(row.file)) {
    try {
      execFileSync(process.execPath, ['--check', row.file], { cwd: root, encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
      results.push({ file: row.file, check: 'node-syntax', ok: true });
    } catch (error) {
      results.push({ file: row.file, check: 'node-syntax', ok: false, message: String(error.stderr || error.message) });
    }
  } else if (row.file.endsWith('.json')) {
    try {
      const contents = readFileSync(path.join(root, row.file), 'utf8');
      const jsonc = /(?:^|\/)tsconfig[^/]*\.json$/.test(row.file);
      if (jsonc) {
        const parsed = ts.parseConfigFileTextToJson(row.file, contents);
        if (parsed.error) throw new Error(ts.flattenDiagnosticMessageText(parsed.error.messageText, '\n'));
      } else JSON.parse(contents);
      results.push({ file: row.file, check: jsonc ? 'jsonc-parse' : 'json-parse', ok: true });
    } catch (error) {
      results.push({ file: row.file, check: 'json-parse', ok: false, message: error.message });
    }
  }
}
writeFileSync(path.join(root, 'output/deep-audit-2026-10-01/syntax-results.json'), JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify({ checked: results.length, failed: results.filter(row => !row.ok) }, null, 2));
process.exitCode = results.some(row => !row.ok) ? 1 : 0;
