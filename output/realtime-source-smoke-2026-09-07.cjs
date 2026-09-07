// Runs the actual pool route source with its real RPC/indexer boundaries.
// Only Next's response/background lifecycle is adapted for a standalone process.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const app = path.resolve('0xNothing-zkLTC-Testnet/apps/web');
const appRequire = Module.createRequire(path.join(app, 'package.json'));
const ts = appRequire('typescript');
process.loadEnvFile(path.join(app, '.env.local'));
const resolve = Module._resolveFilename;
Module._resolveFilename = function(request, parent, ...rest) {
  if (request.startsWith('@fi/')) request = path.join(app, 'features/fi', request.slice(4));
  else if (request.startsWith('@/')) request = path.join(app, request.slice(2));
  return resolve.call(this, request, parent, ...rest);
};
const load = Module._load;
Module._load = function(request, ...rest) {
  if (request === 'server-only') return {};
  if (request === 'next/server') return { NextResponse: Response, after: task => { void task(); } };
  return load.call(this, request, ...rest);
};
require.extensions['.ts'] = (mod, filename) => {
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  mod._compile(code, filename);
};
const route = appRequire('./app/0xFi/api/data/pools/route.ts');
(async () => {
  const results = [];
  for (let sample = 1; sample <= 2; sample++) {
    const start = performance.now();
    const response = await route.GET();
    const payload = await response.json();
    const row = { sample, ms: Math.round(performance.now() - start), status: response.status, cache: response.headers.get('x-0xfi-cache'), pools: payload.data?.length, source: payload.meta?.source, warning: payload.warning };
    results.push(row);
    console.log(JSON.stringify(row));
  }
  fs.writeFileSync('output/realtime-source-smoke-2026-09-07.json', JSON.stringify(results, null, 2) + '\n');
})().catch(error => { console.error(error); process.exitCode = 1; });
