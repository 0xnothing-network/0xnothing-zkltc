const fs = require('node:fs');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const ts = require('../0xNothing-zkLTC-Testnet/apps/wallet/node_modules/typescript');
const walletFile = '0xNothing-zkLTC-Testnet/apps/wallet/src/core/services/prices.ts';
const webFile = '0xNothing-zkLTC-Testnet/apps/web/app/0xFi/api/data/pools/route.ts';
const catalogFile = '0xNothing-zkLTC-Testnet/apps/wallet/src/core/services/marketCatalog.ts';
const pause = (ms, value) => new Promise(resolve => setTimeout(() => resolve(value), ms));
const compile = source => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function wallet(source) {
  const wad = 10n ** 18n;
  const ok = result => ({ status: 'success', result });
  const client = {
    readContract: ({ functionName }) => pause(100, functionName === 'getPair' ? '0xpair' : '0xtoken'),
    multicall: ({ contracts }) => pause(100,
      contracts[0].functionName === 'status' ? [ok(3), ok(7n * wad)] :
      contracts[0].functionName === 'getReserves' ? [ok([2n * wad, 10n * wad, 0])] :
      [ok([100n * wad, 1n]), ok(true)]),
  };
  const imports = {
    '../../abis': {},
    '../../config/contracts': { CONTRACTS: { nusd: '0xnusd', dexFactory: '0xfactory', pumpFactory: '0xpump' } },
    '../lib/format': { WAD: wad },
    '../rpc/client': { activeNetwork: { id: 'test', rpcUrl: 'https://rpc.invalid', builtin: true }, publicClient: client },
    './nusdOracle': { nusdOracleAddress: () => pause(100, '0xoracle') },
  };
  const exports = {};
  vm.runInNewContext(compile(source), { exports, require: name => {
    if (!(name in imports)) throw new Error(name);
    return imports[name];
  } });
  return async () => {
    const result = await exports.loadPrices([
      { id: 'native', decimals: 18, priceSource: 'oracle' },
      { id: 'pool', address: '0xtoken', decimals: 18, priceSource: 'pool' },
    ]);
    if (result.get('pool').priceWad !== 5n * wad) throw new Error('Price mismatch');
  };
}

function web(source) {
  const parsed = ts.createSourceFile('route.ts', source, ts.ScriptTarget.Latest, true);
  const fn = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'loadPoolsEnvelope');
  return vm.runInNewContext(compile(fn.getText(parsed) + '\nloadPoolsEnvelope;'), {
    QUERY: 'pools', CANDLES_24H_QUERY: 'candles',
    queryGoldsky: query => query === 'pools'
      ? pause(100, { data: [], meta: { source: 'goldsky', indexedBlock: 1, rpcTail: {} } })
      : pause(300, { data: [] }),
    asPoolPoint: row => row,
    loadCanonicalOracleSnapshots: () => pause(300, { snapshots: new Map(), failed: 0 }),
    refreshPools: () => pause(100, { failedPools: 0, totalPools: 0 }),
    loadRpcTail: () => pause(100, { pools: [], fromBlock: 2n, toBlock: 2n, capped: false }),
    visibleDeploymentPools: rows => pause(10, { pools: rows, communityPoolIds: new Set() }),
    enrichPumpTokenImages: () => pause(10), enrichRegistryImages: () => pause(10),
    enrichLockBurnBadges: () => pause(10), deployment: { contracts: {} },
  });
}

function catalog(source) {
  const parsed = ts.createSourceFile('marketCatalog.ts', source, ts.ScriptTarget.Latest, true);
  const fn = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'fetchCatalog');
  const load = vm.runInNewContext(compile(fn.getText(parsed) + '\nfetchCatalog;'), {
    publicClient: {}, PUBLIC_APP_URL: 'https://app.invalid', MAX_PUMP_TOKENS: 200,
    parsePumpCatalog: value => value, parseFiCatalog: value => value,
    boundedJson: () => pause(100).then(() => { throw new Error('API unavailable'); }),
    pumpCatalogFromGraph: () => pause(100, ['pump']),
    fiCatalogFromGraph: () => pause(100, { entries: ['fi'], changes24h: { fi: 0.1 } }),
    mergeEntries: groups => groups.flat(),
  });
  return () => load({ builtin: true });
}

(async () => {
  const report = { kind: 'controlled I/O simulation, not production page-load timing', rpcReadDelayMs: 100, webMarketReadDelayMs: 300, results: [] };
  for (const [name, file, fixture] of [['wallet-price-load', walletFile, wallet], ['web-pool-envelope', webFile, web], ['wallet-catalog-fallback', catalogFile, catalog]]) {
    const versions = {
      before: execFileSync('git', ['show', `HEAD:${file}`], { encoding: 'utf8' }),
      after: fs.readFileSync(file, 'utf8'),
    };
    const result = { name };
    for (const [version, source] of Object.entries(versions)) {
      const samples = [];
      for (let i = 0; i < 3; i++) {
        const run = fixture(source);
        const start = performance.now();
        await run();
        samples.push(Math.round(performance.now() - start));
      }
      result[version] = samples;
    }
    report.results.push(result);
  }
  const json = JSON.stringify(report, null, 2);
  fs.writeFileSync('output/realtime-benchmark-2026-09-07.json', json + '\n');
  console.log(json);
})().catch(error => { console.error(error); process.exitCode = 1; });
