import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { readFile, mkdtemp, rm, access } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { decodeFunctionData, encodeFunctionResult, encodeEventTopics, encodeAbiParameters } from 'viem';

const directory=fileURLToPath(new URL('../',import.meta.url));
const fixtureMode=process.env.DOGEOS_EMBEDDED_FIXTURE;

// Each fixture runs in a fresh process: module initialization and its private
// checkpoint promises must never leak between cold-start scenarios.
async function isolated(mode) {
  const cache=await mkdtemp(path.join(tmpdir(),'dogeos-embedded-'));
  try {
    return await new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,[fileURLToPath(import.meta.url)],{cwd:directory,windowsHide:true,env:{...process.env,DOGEOS_EMBEDDED_FIXTURE:mode,DOGEOS_CACHE_DIR:cache,DOGEOS_RPC_URL:'https://rpc.fixture.invalid',SUBGRAPH_URL:mode==='cold'?'':'https://graph.fixture.invalid',PRIVATE_KEY:'',VERCEL:'1'}});
      let output='',errors='';
      child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{errors+=chunk;});
      const timer=setTimeout(()=>{child.kill();reject(new Error('Embedded fixture timed out.'));},20000);
      child.once('error',error=>{clearTimeout(timer);reject(error);});
      child.once('exit',code=>{clearTimeout(timer);if(code!==0)reject(new Error(errors||'Embedded fixture failed.'));else{try{resolve(JSON.parse(output));}catch{reject(new Error('Embedded fixture did not return a JSON report.'));}}});
    });
  } finally {await rm(cache,{recursive:true,force:true});}
}

async function runFixture(mode) {
  const dep=JSON.parse(await readFile(new URL('../deployments/chikyu.json',import.meta.url),'utf8'));
  const nft=JSON.parse(await readFile(new URL('../src/generated/DogeosPixel.json',import.meta.url),'utf8'));
  const market=JSON.parse(await readFile(new URL('../src/generated/PixelMarket.json',import.meta.url),'utf8'));
  const maker='0x1111111111111111111111111111111111111111',buyer='0x2222222222222222222222222222222222222222',zero='0x'+'0'.repeat(40);
  const start=Math.min(dep.DogeosPixel.startBlock,dep.PixelMarket.startBlock),seed=start+2000,head=mode==='tail'?seed+1:seed;
  const hash=number=>'0x'+BigInt(number).toString(16).padStart(64,'0'),transaction='0x'+'a'.repeat(64),expiry=String(Math.floor(Date.now()/1000)+86400);
  const calls=[],ranges=[];let seedChecks=0;
  const log=(abi,eventName,args,block,index)=>{
    const definition=abi.find(item=>item.type==='event'&&item.name===eventName),inputs=definition.inputs.filter(item=>!item.indexed);
    return {address:abi===nft?dep.DogeosPixel.address:dep.PixelMarket.address,topics:encodeEventTopics({abi,eventName,args}),data:encodeAbiParameters(inputs,inputs.map(item=>args[item.name])),blockNumber:'0x'+block.toString(16),blockHash:hash(block),transactionHash:transaction,transactionIndex:'0x0',logIndex:'0x'+index.toString(16),removed:false};
  };
  const history=[log(nft,'Transfer',{tokenId:1n,from:zero,to:maker},start,0),log(nft,'Minted',{tokenId:1n,creator:maker,name:'Fixture Pixel'},start,1)];
  const tail=[log(nft,'Transfer',{tokenId:1n,from:maker,to:buyer},seed+1,0),log(market,'OfferCancelled',{offerId:1n},seed+1,1)];
  const meta={block:{number:mode==='ahead'?seed+6:seed,hash:mode==='bad-hash'?'0x'+'b'.repeat(64):hash(mode==='ahead'?seed+6:seed)},hasIndexingErrors:mode==='index-errors'};
  const pinnedMeta={block:{number:seed,hash:hash(seed)},hasIndexingErrors:mode==='index-errors'};
  const pixels=[{id:'1',tokenId:'1',name:'Fixture Pixel',creator:maker,owner:mode==='bad-address'?'bad-address':maker,ownershipNonce:'1',tokenApproved:false,ownerApproval:{id:maker,approved:mode!=='bad-approval'},collection:{id:'1'},listing:{id:'1',seller:maker,price:mode==='bad-number'?'1'.repeat(79):'50',expiry,nonce:'1',status:'ACTIVE'}}];
  const collections=[{id:'1',owner:maker,name:'Fixture Collection',description:'Public collection fixture'}];
  const offers=[{id:'1',pixel:{id:'1'},bidder:buyer,amount:'10',expiry}];
  const approvals=[{id:maker,approved:true}];
  globalThis.fetch=async(url,options={})=>{
    const target=String(url);calls.push(target.includes('graph')?'graph':'rpc');
    if(mode==='cold')throw new Error('Network is unavailable in cold static fixture.');
    const payload=JSON.parse(options.body);
    if(target.includes('graph')) {
      if(mode==='graph-offline')return Response.json({errors:[{message:'Unavailable fixture'}]},{status:503});
      const query=payload.query;
      if(query.includes('BootstrapRows')) {
        assert.deepEqual(payload.variables.block,{hash:hash(seed)},'bootstrap must pin every entity query by canonical hash');
        const field=/\{ (pixels|collections|offers|marketApprovals)\(/.exec(query)?.[1];
        assert.ok(field,'recognized bounded bootstrap entity query');
        const entities={pixels,collections,offers,marketApprovals:approvals};
        return Response.json({data:{[field]:payload.variables.cursor?[]:entities[field]}});
      }
      if(query.includes('BootstrapDetails')){assert.deepEqual(payload.variables.block,{hash:hash(seed)});return Response.json({data:{_meta:pinnedMeta,stats:{minted:mode==='bad-stats'?'2':'1',collections:'1'},activities:[{id:transaction+'-1',kind:'Minted',tokenId:'1',account:maker,amount:'0',transaction,block:String(start)}]}});}
      if(query.includes('query Catalog'))return Response.json({data:{_meta:meta,pixels:[{id:'1'}],stats:{minted:'1'}}});
      return Response.json({data:{_meta:meta}});
    }
    const answer=item=>{
      let result;
      switch(item.method) {
        case 'eth_chainId':result='0x'+dep.chainId.toString(16);break;
        case 'eth_blockNumber':result='0x'+head.toString(16);break;
        case 'eth_getBlockByNumber': {
          const number=Number(BigInt(item.params[0]));if(number===seed)seedChecks++;
          result={number:item.params[0],hash:mode==='changing-hash'&&number===seed&&seedChecks>1?'0x'+'c'.repeat(64):hash(number),parentHash:hash(number-1),timestamp:'0x1',gasLimit:'0x989680',gasUsed:'0x0',size:'0x1',difficulty:'0x0',totalDifficulty:'0x0',baseFeePerGas:'0x1',nonce:'0x0000000000000000',miner:zero,transactions:[],uncles:[]};break;
        }
        case 'eth_getLogs': {
          const from=Number(BigInt(item.params[0].fromBlock)),to=Number(BigInt(item.params[0].toBlock));ranges.push([from,to]);
          result=[...history,...(mode==='tail'?tail:[])].filter(entry=>Number(BigInt(entry.blockNumber))>=from&&Number(BigInt(entry.blockNumber))<=to);break;
        }
        case 'eth_call': {
          const abi=item.params[0].to.toLowerCase()===dep.DogeosPixel.address.toLowerCase()?nft:market;
          const {functionName}=decodeFunctionData({abi,data:item.params[0].data});
          const values={totalSupply:mode==='chain-count' ?2n:1n,collectionCount:1n,tokenPackedData:['Fixture Pixel','',8,'0x'+'112233'.repeat(64),maker,1n,hash(1)],ownerOf:mode==='tail'?buyer:maker,tokenCollection:1n,listings:[maker,50n,BigInt(expiry),1n,1n],isListingActive:mode!=='tail'};
          assert.ok(Object.hasOwn(values,functionName),'read-only fixture recognizes '+functionName);
          result=encodeFunctionResult({abi,functionName,result:values[functionName]});break;
        }
        case 'eth_getBalance':result='0x1';break;
        default:throw new Error('Unexpected fixture RPC method '+item.method);
      }
      return {jsonrpc:'2.0',id:item.id,result};
    };
    return Response.json(Array.isArray(payload)?payload.map(answer):answer(payload));
  };
  const {handleEmbedded}=await import('../server/embedded.mjs');
  const get=(suffix,method='GET')=>handleEmbedded(new Request('https://site.fixture/DOGEOSxPIXEL'+suffix,{method}));
  const rpc=(body,headers={'Content-Type':'application/json'})=>handleEmbedded(new Request('https://site.fixture/DOGEOSxPIXEL/api/rpc',{method:'POST',headers,body}));
  if(mode==='cold') {
    const response=await get('/api/config');assert.equal(response.status,200);const config=await response.json();assert.equal(config.chainId,6281971);assert.equal(config.rpc,'/DOGEOSxPIXEL/api/rpc');
    const headResponse=await get('/api/config','HEAD');assert.equal(headResponse.status,200);assert.equal(await headResponse.text(),'');assert.ok(Number(headResponse.headers.get('Content-Length'))>0);
    for(const suffix of ['/api/catalog?limit=49','/api/catalog?limit=1&limit=2','/api/catalog?__proto__=x','/api/offers?format=unknown','/api/collections?owner=bad','/api/token/0','/api/token/01','/%255csecret','/%252e%252e/secret','/%5csecret','/%00secret'])assert.equal((await get(suffix)).status,400,suffix);
    assert.equal((await get('/assets/nonexistent-bundle.js')).status,404);assert.equal((await get('/assets/nonexistent-bundle')).status,404);assert.equal((await get('/api/unknown')).status,404);
    assert.equal((await handleEmbedded(new Request('https://site.fixture/other'))).status,404);
    assert.equal((await get('/api/config','POST')).status,405);assert.equal((await get('/api/rpc')).status,405);
    assert.equal((await rpc('{')).status,400);assert.equal((await rpc('{}',{'Content-Type':'text/plain'})).status,415);
    assert.equal((await rpc(JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_sendRawTransaction',params:['0x00']}))).status,400);
    assert.equal((await rpc('x'.repeat(65537))).status,413);
    assert.equal((await rpc('{}',{'Content-Type':'application/json','Content-Length':'65537'})).status,413);
    assert.equal((await rpc(new Uint8Array([0xff,0xfe]))).status,400);
    // Built artifacts are covered when present; the separate packaging test
    // creates a clean immutable dist fixture and verifies the same cold path.
    let htmlChecked=false;try{await access(path.join(directory,'dist/index.html'));htmlChecked=true;}catch{}
    if(htmlChecked){assert.equal((await get('/')).status,200);const html=await get('/studio','HEAD');assert.equal(html.status,200);assert.equal(await html.text(),'');assert.match(html.headers.get('Content-Type'),/text\/html/);}
    assert.equal(calls.length,0,'config/static and invalid requests must never need RPC or Graph');
    return {cold:true,zeroNetwork:true,htmlChecked};
  }
  const response=await get('/api/catalog');assert.equal(response.status,200);const catalogue=await response.json();
  assert.equal(catalogue.total,1);assert.equal(catalogue.supply,1);assert.equal(catalogue.tokens[0].id,'1');assert.equal(catalogue.tokens[0].owner.toLowerCase(),mode==='tail'?buyer:maker);
  assert.equal(catalogue.tokens[0].listing!==null,mode!=='tail');assert.equal(catalogue.next,null);
  if(mode==='seed'||mode==='ahead') {
    assert.equal(catalogue.source,'subgraph');assert.deepEqual(ranges,[],'healthy checkpoint avoids replaying the full deployment history');
    const offerResponse=await get('/api/offers?format=page');assert.equal(offerResponse.status,200);const page=await offerResponse.json();assert.equal(page.total,1);assert.equal(page.offers[0].id,'1');
    const collectionResponse=await get('/api/collections');assert.equal(collectionResponse.status,200);const collectionPage=await collectionResponse.json();assert.equal(collectionPage.total,1);assert.equal(collectionPage.collections[0].previews[0].id,'1');
    const status=await (await get('/api/status')).json();assert.equal(status.supply,1);assert.equal(status.indexedBlock,seed);
    const replies=await (await rpc(JSON.stringify([{jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]},{jsonrpc:'2.0',id:2,method:'eth_getBalance',params:[maker,'latest']}]))).json();assert.deepEqual(replies.map(item=>item.result),['0x'+dep.chainId.toString(16),'0x1']);
  } else if(mode==='tail') {
    assert.equal(catalogue.source,'rpc');assert.deepEqual(ranges,[[seed+1,seed+1]],'only canonical RPC events after the graph checkpoint are replayed');
    const offersPage=await (await get('/api/offers?format=page')).json();assert.equal(offersPage.total,0,'cancelled escrow offer must disappear after RPC tail');
    const listed=await (await get('/api/catalog?listed=true')).json();assert.equal(listed.total,0);assert.deepEqual(listed.tokens,[]);
  } else assert.equal(ranges[0]?.[0],start,'untrusted graph state must fall back to canonical RPC history');
  const checkpoint=JSON.parse(await readFile(path.join(process.env.DOGEOS_CACHE_DIR,'catalog.json'),'utf8'));
  assert.equal(checkpoint.block,head);assert.equal(checkpoint.tokens['1'].owner.toLowerCase(),mode==='tail'?buyer:maker);
  return {mode,source:catalogue.source,total:catalogue.total,block:checkpoint.block,replayRanges:ranges};
}

if(fixtureMode) {
  runFixture(fixtureMode).then(result=>process.stdout.write(JSON.stringify(result))).catch(error=>{process.stderr.write(error.stack||error.message);process.exitCode=1;});
} else {
  test('embedded cold config/static and invalid requests need no network',async()=>{const result=await isolated('cold');assert.equal(result.zeroNetwork,true);});
  test('embedded healthy Graph snapshot skips deployment history and preserves API shapes',async()=>{const result=await isolated('seed');assert.equal(result.source,'subgraph');});
  test('embedded Graph ahead of RPC pins the canonical common block without historical replay',async()=>{const result=await isolated('ahead');assert.equal(result.source,'subgraph');});
  test('embedded RPC tail updates live owners, invalidated listings and cancelled offers',async()=>{const result=await isolated('tail');assert.equal(result.source,'rpc');});
  for(const mode of ['bad-hash','changing-hash','index-errors','bad-stats','chain-count','bad-address','bad-approval','bad-number','graph-offline'])test('embedded rejects '+mode+' Graph checkpoint and replays RPC',async()=>{await isolated(mode);});
}
