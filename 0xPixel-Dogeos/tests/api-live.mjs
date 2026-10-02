import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { config } from 'dotenv';
config({path:new URL('../.env.local',import.meta.url),quiet:true});
const base='http://localhost:3300/DOGEOSxPIXEL/api/';
const get=async path=>{const response=await fetch(base+path,{signal:AbortSignal.timeout(45000)});assert.equal(response.status,200);return response.json();};
const post=body=>fetch(base+'rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(45000)});
const cfg=await get('config');assert.equal(cfg.chainId,6281971);assert.ok(!JSON.stringify(cfg).includes('PRIVATE_KEY'));
const full=await get('catalog?limit=48');assert.ok(full.supply>0);assert.equal(full.tokens.length,Math.min(full.total,48));const sample=full.tokens[0];assert.ok(sample);
const page=await get('catalog?limit=2');assert.equal(page.tokens.length,Math.min(full.total,2));assert.equal(page.next,full.total>2?2:null);
const next=await get('catalog?limit=2&offset=2');assert.ok(next.tokens.every(token=>!page.tokens.some(previous=>previous.id===token.id)));
const owner=await get('catalog?owner='+sample.owner);assert.ok(owner.tokens.every(token=>token.owner.toLowerCase()===sample.owner.toLowerCase()));
const filter=await get('catalog?search='+encodeURIComponent(sample.name));assert.ok(filter.tokens.some(token=>token.id===sample.id));assert.ok(filter.tokens.every(token=>token.name.toLowerCase().includes(sample.name.toLowerCase())));
const collections=await get('catalog?collection='+sample.collectionId);assert.ok(collections.tokens.every(token=>token.collectionId===sample.collectionId));
const listed=await get('catalog?listed=true');assert.ok(listed.tokens.every(token=>token.listing));
const offers=await get('offers?tokenId='+sample.id);assert.ok(offers.every(offer=>offer.tokenId===sample.id));
const offerPage=await get('offers?format=page&tokenId='+sample.id+'&limit=2');assert.equal(offerPage.total,offers.length);assert.deepEqual(offerPage.offers,offers.slice(0,2));assert.equal(offerPage.next,offers.length>2?2:null);
const collectionPage=await get('collections?limit=2');assert.equal(collectionPage.collections.length,Math.min(full.collections.length,2));assert.equal(collectionPage.total,full.collections.length);assert.ok(collectionPage.collections.every(collection=>collection.previews.length<=3&&collection.previews.every(preview=>typeof preview.pixels==='string'&&preview.grid>0)));
for(const url of ['catalog?owner=bad','catalog?limit=2x','catalog?limit=49','catalog?offset=-1','catalog?search='+encodeURIComponent('x'.repeat(101)),'catalog?sort=unknown','catalog?owner='+sample.owner+'&owner='+sample.owner,'token/0','token/-1','token/abc','offers?account=bad']){const response=await fetch(base+url);assert.equal(response.status,400,url);}
const missing=await fetch(base+'token/'+(2n**256n-1n));assert.equal(missing.status,404);
for(const body of [{jsonrpc:'2.0',id:1,method:'eth_sendRawTransaction',params:['0x00']},null,[],{id:1,method:'eth_chainId'}, {jsonrpc:'2.0',id:1,method:'eth_getLogs',params:[{address:sample.owner,fromBlock:'0x0',toBlock:'latest'}]}, {jsonrpc:'2.0',id:1,method:'eth_getBlockByNumber',params:['latest',true]}])assert.equal((await post(body)).status,400);
const request=(id,method,params=[])=>({jsonrpc:'2.0',id,method,params});
const chain=await post(request(1,'eth_chainId')).then(response=>response.json());assert.equal(parseInt(chain.result,16),6281971);
const batch=await post([request('chain','eth_chainId'),request('balance','eth_getBalance',[sample.owner,'latest'])]).then(response=>response.json());assert.deepEqual(batch.map(result=>result.id),['chain','balance']);assert.ok(batch.every(result=>typeof result.result==='string'));
const secret=process.env.PRIVATE_KEY;
for(const target of ['.env.local','contracts/src/PixelMarket.sol','scripts/runtime.mjs']){const response=await fetch('http://localhost:3300/DOGEOSxPIXEL/'+target);const content=await response.text();assert.ok(!content.includes('PRIVATE_KEY='),'Environment file exposed at '+target);assert.ok(response.status===404||response.headers.get('content-type')?.includes('text/html'),'Source file exposed at '+target);if(secret)assert.ok(!content.includes(secret));}
const assets=new URL('../dist/assets/',import.meta.url);for(const file of await readdir(assets))if(/\.(js|css)$/.test(file)){const content=await readFile(new URL(file,assets),'utf8');assert.ok(!content.includes('PRIVATE_KEY'),'Server secret configuration leaked in asset '+file);if(secret)assert.ok(!content.includes(secret),'Secret leaked in asset '+file);}
await mkdir(new URL('../output/',import.meta.url),{recursive:true});
await writeFile(new URL('../output/api-smoke.json',import.meta.url),JSON.stringify({passed:true,verifiedAt:new Date().toISOString(),checks:['chain config','live catalog','active listings','pagination','owner/search/collection filters','offers token filter','invalid and repeated query parameter rejection','bounded read-only RPC requests and batches','nonexistent NFT 404','private key excluded from static assets']},null,2));console.log('Live API validation, discovery and secret-isolation tests passed.');
