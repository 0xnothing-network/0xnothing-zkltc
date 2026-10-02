import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

// Exercise the actual deployment artifact with an unavailable RPC. Static and
// config requests must boot without networking or a writable application tree.
process.env.NODE_ENV='production';
process.env.VERCEL='1';
process.env.DOGEOS_RPC_URL='http://127.0.0.1:1';
process.env.SUBGRAPH_URL='';
process.env.PRIVATE_KEY='';
const artifact=new URL('../../0xNothing-zkLTC-Testnet/apps/web/.dogeos/',import.meta.url);
const {handleEmbedded}=await import(new URL('server/embedded.mjs',artifact));
const get=(path,method='GET')=>handleEmbedded(new Request('https://public.test'+path,{method}));
let checks=0;
const config=await get('/DOGEOSxPIXEL/api/config');
assert.equal(config.status,200);assert.equal((await config.json()).chainId,6281971);checks++;
const home=await get('/DOGEOSxPIXEL');
assert.equal(home.status,200);assert.match(home.headers.get('content-type'),/text\/html/);
const html=await home.text();assert.ok(!html.includes('temporarily unavailable'));checks++;
for(const route of ['/DOGEOSxPIXEL/market','/DOGEOSxPIXEL/studio','/DOGEOSxPIXEL/collections']){
 const page=await get(route);assert.equal(page.status,200);assert.equal(await page.text(),html);checks++;
}
const assets=[...html.matchAll(/(?:src|href)="(\/DOGEOSxPIXEL\/assets\/[^"?#]+)"/g)].map(match=>match[1]);
assert.ok(assets.some(asset=>asset.endsWith('.js'))&&assets.some(asset=>asset.endsWith('.css')));
for(const asset of assets){const response=await get(asset);assert.equal(response.status,200);assert.ok((await response.arrayBuffer()).byteLength>0);checks++;}
for(const route of ['/DOGEOSxPIXEL','/DOGEOSxPIXEL/api/config',assets[0]]){
 const head=await get(route,'HEAD');assert.equal(head.status,200);assert.equal(await head.text(),'');checks++;
}
for(const [route,status] of [['/DOGEOSxPIXEL/assets/missing.js',404],['/DOGEOSxPIXEL/.env.local',404],['/DOGEOSxPIXEL/assets/%2e%2e%2f.env.local',400],['/unrelated',404]]){
 assert.equal((await get(route)).status,status);checks++;
}
const forbidden=await handleEmbedded(new Request('https://public.test/DOGEOSxPIXEL/api/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_sendRawTransaction',params:['0x1234']})}));
assert.equal(forbidden.status,400);checks++;
const oversized=await handleEmbedded(new Request('https://public.test/DOGEOSxPIXEL/api/rpc',{method:'POST',headers:{'content-type':'application/json'},body:'x'.repeat(65537)}));
assert.equal(oversized.status,413);checks++;
const files=await readdir(artifact,{recursive:true});
assert.ok(files.every(file=>!/(?:^|[\\/])(?:\.env[^\\/]*|\.runtime|node_modules|output|contracts|subgraph)(?:[\\/]|$)/.test(file)));
for(const file of ['deployments/chikyu.json','src/generated/DogeosPixel.json','src/generated/PixelMarket.json']){
 assert.ok(JSON.parse(await readFile(new URL(file,artifact),'utf8')));checks++;
}
console.log(JSON.stringify({artifact:fileURLToPath(artifact),checks,passed:true,rpcUnavailable:true,privateKeyRequired:false}));
