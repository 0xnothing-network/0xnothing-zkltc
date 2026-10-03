import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCatalogStore } from '../server/catalog-store.mjs';
import { queryParams, rpcRequests, tokenId } from '../server/validation.mjs';
import { assertDogeosChain, artifact } from '../scripts/runtime.mjs';

const maker='0x1111111111111111111111111111111111111111',buyer='0x2222222222222222222222222222222222222222',zero='0x0000000000000000000000000000000000000000';
const dep={chainId:6281971,DogeosPixel:{address:'0x3333333333333333333333333333333333333333',startBlock:1},PixelMarket:{address:'0x4444444444444444444444444444444444444444',startBlock:1}};
const now=()=>BigInt(Math.floor(Date.now()/1000)+10000);

async function fixture(t,{syncInterval=0,graphEndpoint=()=>''}={}) {
  const directory=await mkdtemp(path.join(tmpdir(),'dogeos-index-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  let head=1n,logs=[],branch='a',failHash=false,metadata='Doge';
  const reads=[];
  const client={
    getBlockNumber:async()=>head,
    getBlock:async({blockNumber})=>{if(failHash){failHash=false;throw new Error('Transient block lookup failure.');}return {hash:`0x${branch.repeat(62)}${Number(blockNumber).toString(16).padStart(2,'0')}`};},
    getLogs:async({fromBlock,toBlock})=>logs.filter(log=>log.blockNumber>=fromBlock&&log.blockNumber<=toBlock),
    readContract:async request=>{reads.push(request);const id=String(request.args[0]);switch(request.functionName){case 'tokenPackedData':return [metadata+' '+id,'',8,'0x000000',maker,1n,'0x'+'b'.repeat(64)];case 'ownerOf':return maker;case 'tokenCollection':return 0n;case 'listings':return [maker,BigInt(id),now(),1n,BigInt(id)];case 'isListingActive':return true;default:throw new Error('Unexpected read '+request.functionName);}},
  };
  const event=(eventName,args,blockNumber=head)=>({address:eventName==='Listed'?dep.PixelMarket.address:dep.DogeosPixel.address,blockNumber,logIndex:logs.length,transactionHash:'0x'+String(logs.length+1).padStart(64,'0'),eventName,args});
  const add=(name,args)=>logs.push(event(name,args));
  const mint=(id=1n)=>{add('Transfer',{tokenId:id,from:zero,to:maker});add('Minted',{tokenId:id,creator:maker,name:metadata+' '+id});};
  const store=await createCatalogStore({dep,nft:[],market:[],client,cacheFile:path.join(directory,'catalog.json'),syncInterval,graphEndpoint,decode:log=>log});
  return {store,client,reads,add,mint,directory,advance:()=>head++,fail:()=>{failHash=true;},reorg:()=>{branch='c';metadata='Reorg';logs=[];},setLogs:value=>{logs=value;}};
}

test('query and RPC validation reject malformed, oversized and expensive inputs',()=>{
  for(const query of [{owner:['bad']},{owner:'abc'},{limit:'2x'},{limit:'49'},{offset:'-1'},{search:'x'.repeat(101)},{sort:'unknown'},{listed:'maybe'},{collection:'-1'},{unknown:'x'}])assert.throws(()=>queryParams(query),error=>error.status===400);
  assert.equal(queryParams({limit:'2',offset:'3',owner:maker}).limit,2);
  for(const id of ['0','-1','01','1e3','0x1',String(2n**256n)])assert.throws(()=>tokenId(id));
  const request=(method,params=[])=>({jsonrpc:'2.0',id:1,method,params});
  assert.equal(rpcRequests(request('eth_chainId')).length,1);
  assert.equal(rpcRequests(request('eth_call',[{to:dep.DogeosPixel.address,data:'0x',gas:'0x100000'},'latest'])).length,1);
  assert.equal(rpcRequests(request('eth_getLogs',[{address:dep.DogeosPixel.address,fromBlock:'0x1',toBlock:'0x7d0'}])).length,1);
  for(const body of [null,[],request('eth_sendRawTransaction',['0x']),{method:'eth_chainId',id:1},request('eth_getLogs',[{address:maker,fromBlock:'0x0',toBlock:'latest'}]),request('eth_getLogs',[{address:maker,fromBlock:'0x1',toBlock:'0x7d1'}]),request('eth_call',[{to:maker,gas:'0xffffffff'},'latest']),request('eth_getBlockByNumber',['latest',true]),request('eth_feeHistory',['0x10000','latest',[]]),request('eth_feeHistory',['0x10','latest',[50,10]]),request('eth_call',[{to:maker,privateKey:'secret'},'latest'])])assert.throws(()=>rpcRequests(body),error=>error.status===400);
});

test('RPC chain identity is checked before signing and artifact paths cannot escape',async()=>{
  await assertDogeosChain({getChainId:async()=>6281971});
  await assert.rejects(assertDogeosChain({getChainId:async()=>1}),/chain ID/);
  await assert.rejects(artifact('../PRIVATE_KEY'),/Invalid artifact/);
});

test('approval revocation, reapproval and self-transfer update listed counts before pagination',async t=>{
  const f=await fixture(t);f.mint();f.add('ApprovalForAll',{owner:maker,operator:dep.PixelMarket.address,approved:true});f.add('Listed',{tokenId:1n,seller:maker,listingId:1n,price:100n,expiry:now(),nonce:1n});
  assert.equal((await f.store.catalog({listed:'true'})).total,1);
  f.advance();f.add('ApprovalForAll',{owner:maker,operator:dep.PixelMarket.address,approved:false});
  const revoked=await f.store.catalog({listed:'true',limit:'1'});assert.equal(revoked.total,0);assert.equal(revoked.tokens.length,0);assert.equal(revoked.next,null);
  f.advance();f.add('Approval',{tokenId:1n,owner:maker,approved:dep.PixelMarket.address});assert.equal((await f.store.catalog({listed:'true'})).total,1);
  f.advance();f.add('Transfer',{tokenId:1n,from:maker,to:maker});assert.equal((await f.store.catalog({listed:'true'})).total,0);
  f.advance();f.add('ApprovalForAll',{owner:maker,operator:dep.PixelMarket.address,approved:true});assert.equal((await f.store.catalog({listed:'true'})).total,1);
});

test('failed checkpoint does not expose partially applied events or duplicate history on retry',async t=>{
  const f=await fixture(t);f.mint();f.fail();await assert.rejects(f.store.sync(),/Transient/);await f.store.sync();
  const result=await f.store.catalog();assert.equal(result.supply,1);assert.equal(result.activity.filter(event=>event.type==='Minted').length,1);
  const cached=JSON.parse(await readFile(path.join(f.directory,'catalog.json'),'utf8'));assert.equal(cached.block,1);assert.equal(cached.tokens['1'].nonce,'1');
});

test('canonical checkpoint reorg replays events and drops immutable artwork cache',async t=>{
  const f=await fixture(t);f.mint();assert.equal((await f.store.catalog()).tokens[0].name,'Doge 1');f.reorg();f.mint();
  const result=await f.store.catalog();assert.equal(result.tokens[0].name,'Reorg 1');assert.equal(result.activity.filter(event=>event.type==='Minted').length,1);assert.equal(result.supply,1);
});

test('all token reads in one catalogue use its checkpoint and precise integer ordering',async t=>{
  const f=await fixture(t);for(const id of [1n,2n,90071992547409930n,90071992547409931n])f.mint(id);
  const first=await f.store.catalog({limit:'2'});assert.deepEqual(first.tokens.map(token=>token.id),['90071992547409931','90071992547409930']);assert.equal(first.next,2);assert.equal(first.total,4);assert.ok(f.reads.every(request=>request.blockNumber===1n));
  const second=await f.store.catalog({limit:'2',offset:'2'});assert.deepEqual(second.tokens.map(token=>token.id),['2','1']);assert.equal(second.next,null);
});

test('cancelled offers disappear and offers follow current owner with bounded pagination',async t=>{
  const f=await fixture(t);f.mint();for(let id=1n;id<=3n;id++)f.add('OfferMade',{offerId:id,tokenId:1n,bidder:buyer,amount:100n,expiry:now()});
  assert.deepEqual((await f.store.offerList({account:maker,limit:'2'})).map(offer=>offer.id),['3','2']);f.advance();f.add('OfferCancelled',{offerId:3n});f.add('Transfer',{tokenId:1n,from:maker,to:buyer});assert.equal((await f.store.offerList({account:maker})).length,0);assert.equal((await f.store.offerList({account:buyer})).length,2);
});

test('a reorg while fetching a range cannot attach old events to a new canonical hash',async t=>{
  const f=await fixture(t);f.mint();let changed=false;const getLogs=f.client.getLogs;
  f.client.getLogs=async request=>{const logs=await getLogs(request);if(!changed){changed=true;f.reorg();}return logs;};
  await assert.rejects(f.store.sync(),/Chain changed/);assert.equal((await f.store.status()).supply,0);
});

test('price sorting puts active listings first and keeps exact wei ordering and stable ties',async t=>{
  const f=await fixture(t);for(const id of [1n,2n,3n,4n])f.mint(id);f.add('ApprovalForAll',{owner:maker,operator:dep.PixelMarket.address,approved:true});
  for(const [id,price]of[[1n,90071992547409931n],[2n,90071992547409930n],[3n,90071992547409930n]])f.add('Listed',{tokenId:id,seller:maker,listingId:id,price,expiry:now(),nonce:1n});
  assert.deepEqual((await f.store.catalog({sort:'price'})).tokens.map(token=>token.id),['3','2','1','4']);
  f.advance();f.add('ApprovalForAll',{owner:maker,operator:dep.PixelMarket.address,approved:false});assert.deepEqual((await f.store.catalog({sort:'price'})).tokens.map(token=>token.id),['4','3','2','1']);
});

test('concurrent artwork reads share work, and nonexistent NFT errors return 404',async t=>{
  const f=await fixture(t);f.mint();await f.store.sync();await Promise.all([f.store.token('1'),f.store.token('1')]);assert.equal(f.reads.filter(read=>read.functionName==='tokenPackedData').length,1);
  f.client.readContract=async()=>{throw {cause:{data:{errorName:'ERC721NonexistentToken'}}};};
  await assert.rejects(f.store.token('999'),error=>error.status===404);
});

test('an in-flight artwork read cannot repopulate the cache after a reorg',async t=>{
  const f=await fixture(t);f.mint();await f.store.sync();let release,started,first=true;
  const ready=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;}),read=f.client.readContract;
  f.client.readContract=async request=>{if(request.functionName==='tokenPackedData'&&first){first=false;const old=await read(request);started();await gate;return old;}return read(request);};
  const pending=f.store.token('1');await ready;f.reorg();f.mint();await f.store.sync();assert.equal((await f.store.token('1')).name,'Reorg 1');release();await assert.rejects(pending,/Chain changed/);assert.equal((await f.store.token('1')).name,'Reorg 1');
});

test('offer pages expose every escrowed offer without duplication beyond the first 48',async t=>{
  const f=await fixture(t);f.mint();for(let id=1n;id<=61n;id++)f.add('OfferMade',{offerId:id,tokenId:1n,bidder:buyer,amount:100n,expiry:now()});
  const first=await f.store.offerList({account:buyer,format:'page'}),second=await f.store.offerList({account:buyer,format:'page',offset:String(first.next)});
  assert.equal(first.total,61);assert.equal(first.offers.length,48);assert.equal(first.next,48);assert.equal(second.offers.length,13);assert.equal(second.next,null);assert.equal(new Set([...first.offers,...second.offers].map(offer=>offer.id)).size,61);
});

test('collection previews include older members absent from the global NFT page',async t=>{
  const f=await fixture(t);for(let id=1n;id<=30n;id++)f.mint(id);
  for(let id=1n;id<=3n;id++)f.add('CollectionCreated',{collectionId:id,owner:maker,name:'Pack '+id,description:''});
  for(let id=1n;id<=30n;id++)f.add('TokenCollectionChanged',{tokenId:id,previousCollection:0n,collectionId:id<=3n?1n:2n});
  const catalog=await f.store.catalog();assert.ok(catalog.tokens.every(token=>BigInt(token.id)>3n));
  const first=await f.store.collectionPage({limit:'2'});assert.equal(first.total,3);assert.equal(first.next,2);assert.equal(first.collections[0].count,0);assert.equal(first.collections[0].previews.length,0);assert.deepEqual(first.collections[1].previews.map(preview=>preview.id),['30','29','28']);
  const older=await f.store.collectionPage({offset:'2',limit:'2'});assert.equal(older.next,null);assert.equal(older.collections[0].count,3);assert.deepEqual(older.collections[0].previews.map(preview=>preview.id),['3','2','1']);assert.ok(older.collections[0].previews.every(preview=>preview.grid===8&&preview.pixels==='0x000000'));
});

test('checkpoint identity includes marketplace address and a new deployment cannot reuse its state',async t=>{
  const f=await fixture(t);f.mint();await f.store.sync();f.setLogs([]);
  const other=await createCatalogStore({dep:{...dep,PixelMarket:{...dep.PixelMarket,address:'0x5555555555555555555555555555555555555555'}},nft:[],market:[],client:f.client,cacheFile:path.join(f.directory,'catalog.json'),syncInterval:0,graphEndpoint:()=>'',decode:log=>log});
  assert.equal((await other.status()).supply,0);
});

test('standalone token reads invalidate forked artwork during the sync cooldown',async t=>{
  const f=await fixture(t,{syncInterval:60000});f.mint();assert.equal((await f.store.catalog()).tokens[0].name,'Doge 1');
  f.reorg();f.mint();const standalone=await f.store.token('1');assert.equal(standalone.name,'Reorg 1');assert.ok(f.reads.every(request=>request.blockNumber===1n));
});

test('a catalogue waiting for Graph cannot mix its old checkpoint with a new fork',async context=>{
  const testFixture=await fixture(context,{graphEndpoint:()=> 'https://graph.fixture.invalid'});testFixture.mint();await testFixture.store.sync();
  let started,release;
  const ready=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  context.mock.method(globalThis,'fetch',async()=>{started();await gate;return Response.json({errors:[{message:'Retry'}]});});
  context.after(()=>release());
  const pending=testFixture.store.catalog();await ready;
  testFixture.reorg();testFixture.mint(2n);await testFixture.store.sync();release();
  await assert.rejects(pending,/Chain changed/);
  assert.deepEqual((await testFixture.store.catalog()).tokens.map(token=>token.name),['Reorg 2']);
});

test('an oversized Graph discovery response is cancelled before falling back to RPC',async context=>{
  const testFixture=await fixture(context,{graphEndpoint:()=> 'https://graph.fixture.invalid'});testFixture.mint();
  let cancelled=false;
  context.mock.method(globalThis,'fetch',async()=>new Response(new ReadableStream({
    start(controller){controller.enqueue(new Uint8Array(1024*1024+1));},
    cancel(){cancelled=true;},
  })));
  const pending=testFixture.store.catalog();
  const result=await Promise.race([pending,new Promise((_resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Graph body was not bounded.')),1000);context.after(()=>clearTimeout(timer));})]);
  assert.equal(cancelled,true);assert.equal(result.source,'rpc');assert.equal(result.tokens[0].name,'Doge 1');
});
