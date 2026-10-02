import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { isAddress } from 'viem';
import { publicClient, deployment, assertDogeosChain } from '../scripts/runtime.mjs';
import { createCatalogStore } from './catalog-store.mjs';
import { queryParams, tokenId } from './validation.mjs';

export const dep = await deployment();
export const nft = JSON.parse(await readFile(new URL('../src/generated/DogeosPixel.json', import.meta.url), 'utf8'));
export const market = JSON.parse(await readFile(new URL('../src/generated/PixelMarket.json', import.meta.url), 'utf8'));
if(process.env.SUBGRAPH_URL===undefined)process.env.SUBGRAPH_URL='https://api.goldsky.com/api/public/project_cmupqw08z0f4301vmcyh60xs9/subgraphs/dogeos-pixel/prod/gn';
const cacheDir=process.env.DOGEOS_CACHE_DIR?path.resolve(process.env.DOGEOS_CACHE_DIR):process.env.VERCEL?path.join(tmpdir(),'dogeos-pixel'):fileURLToPath(new URL('../.runtime/',import.meta.url));
const cacheFile=path.join(cacheDir,'catalog.json');
const start=Math.min(dep.DogeosPixel.startBlock,dep.PixelMarket.startBlock);
const identity=`${dep.chainId}:${dep.DogeosPixel.address.toLowerCase()}:${dep.PixelMarket.address.toLowerCase()}:${start}`;
let chainFlight=null,storeFlight=null;

export async function ensureDogeosChain() {
  if(!chainFlight)chainFlight=assertDogeosChain().catch(error=>{chainFlight=null;throw error;});
  return chainFlight;
}

async function graph(query,variables={},deadline) {
  const signal=deadline?AbortSignal.any([AbortSignal.timeout(6000),deadline]):AbortSignal.timeout(6000);
  const response=await fetch(process.env.SUBGRAPH_URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query,variables}),signal});
  if(!response.ok)throw new Error('Subgraph unavailable.');
  const result=await response.json();
  if(result.errors?.length||!result.data)throw new Error('Invalid subgraph response.');
  return result.data;
}

async function graphRows(field,selection,block,deadline,filter='') {
  const rows=[];let cursor='';
  // A cold start has a fixed work budget; larger datasets safely use the RPC path.
  for(let page=0;page<20;page++) {
    const data=await graph(`query BootstrapRows($block: Block_height!, $cursor: ID!) { ${field}(first:500,block:$block,where:{id_gt:$cursor${filter}},orderBy:id,orderDirection:asc){${selection}} }`,{block,cursor},deadline);
    const items=data[field];
    if(!Array.isArray(items)||items.length>500)throw new Error('Invalid subgraph page.');
    let last=cursor;for(const item of items){if(typeof item.id!=='string'||item.id<=last)throw new Error('Invalid subgraph cursor.');last=item.id;}
    rows.push(...items);if(items.length<500)return rows;
    cursor=last;
  }
  throw new Error('Subgraph bootstrap exceeds its work budget.');
}

const unsigned=value=>typeof value==='string'&&/^(?:0|[1-9]\d{0,77})$/.test(value)&&BigInt(value)<2n**256n;
const address=value=>typeof value==='string'&&isAddress(value,{strict:false});

async function bootstrapGraphCheckpoint() {
  if(!process.env.SUBGRAPH_URL)return;
  try {
    const existing=JSON.parse(await readFile(cacheFile,'utf8'));
    if(existing.version===2&&existing.identity===identity&&Number.isSafeInteger(existing.block)&&existing.block>=start&&existing.hash)return;
  } catch {}
  try {
    const deadline=AbortSignal.timeout(15000);
    const latest=await graph('{ _meta { block { number hash } hasIndexingErrors } }',{},deadline);
    const meta=latest._meta;
    if(!meta||meta.hasIndexingErrors!==false||!Number.isSafeInteger(meta.block?.number)||meta.block.number<start||!/^0x[0-9a-fA-F]{64}$/.test(meta.block.hash))return;
    const head=await publicClient.getBlockNumber({cacheTime:0});
    if(head<BigInt(start)||head-BigInt(meta.block.number)>10000n)return;
    // RPC and Graph heads can differ briefly. Pin their latest common block by
    // its canonical hash: Graph Node returns a null _meta hash for number pins.
    const block=Number(head<BigInt(meta.block.number)?head:BigInt(meta.block.number));
    const canonical=await publicClient.getBlock({blockNumber:BigInt(block)});
    if(!/^0x[0-9a-fA-F]{64}$/.test(canonical.hash)||block===meta.block.number&&canonical.hash.toLowerCase()!==meta.block.hash.toLowerCase())return;
    const pinned={hash:canonical.hash};
    const [pixels,collections,offers,approvals,details,supply,collectionCount]=await Promise.all([
      graphRows('pixels','id tokenId name creator owner ownershipNonce tokenApproved ownerApproval { id approved } collection { id } listing { id seller price expiry nonce status }',pinned,deadline),
      graphRows('collections','id owner name description',pinned,deadline),
      graphRows('offers','id pixel { id } bidder amount expiry',pinned,deadline,',status:"OPEN"'),
      graphRows('marketApprovals','id approved',pinned,deadline),
      graph(`query BootstrapDetails($block: Block_height!) { _meta(block:$block){block{number hash} hasIndexingErrors} stats(id:"global",block:$block){minted collections} activities(first:300,block:$block,orderBy:block,orderDirection:desc){id kind tokenId account amount transaction block} }`,{block:pinned},deadline),
      publicClient.readContract({address:dep.DogeosPixel.address,abi:nft,functionName:'totalSupply',blockNumber:BigInt(block)}),
      publicClient.readContract({address:dep.DogeosPixel.address,abi:nft,functionName:'collectionCount',blockNumber:BigInt(block)}),
    ]);
    if(details._meta?.hasIndexingErrors!==false||details._meta.block.number!==block||details._meta.block.hash?.toLowerCase()!==canonical.hash.toLowerCase()||!unsigned(details.stats?.minted)||!unsigned(details.stats?.collections)||BigInt(details.stats.minted)!==BigInt(pixels.length)||BigInt(details.stats.collections)!==BigInt(collections.length)||supply!==BigInt(pixels.length)||collectionCount!==BigInt(collections.length)||!Array.isArray(details.activities)||details.activities.length>300)return;
    const next={version:2,identity,block,eventBlock:block,hash:canonical.hash,tokens:{},collections:{},offers:{},approvals:{},activity:[]};
    for(const item of approvals){if(!address(item.id)||typeof item.approved!=='boolean')throw new Error('Invalid approval.');next.approvals[item.id.toLowerCase()]=item.approved;}
    for(const item of collections){if(!unsigned(item.id)||item.id==='0'||!address(item.owner)||typeof item.name!=='string'||item.name.length>4096||typeof item.description!=='string'||item.description.length>16384)throw new Error('Invalid collection.');next.collections[item.id]={id:item.id,owner:item.owner,name:item.name,description:item.description};}
    for(const item of pixels){
      if(!unsigned(item.id)||item.id==='0'||item.tokenId!==item.id||!address(item.owner)||!address(item.creator)||typeof item.name!=='string'||item.name.length>4096||!unsigned(item.ownershipNonce)||typeof item.tokenApproved!=='boolean'||!address(item.ownerApproval?.id)||item.ownerApproval.id.toLowerCase()!==item.owner.toLowerCase()||typeof item.ownerApproval.approved!=='boolean'||next.approvals[item.owner.toLowerCase()]!==item.ownerApproval.approved)throw new Error('Invalid pixel.');
      const collectionId=item.collection?.id||'0';if(collectionId!=='0'&&!next.collections[collectionId])throw new Error('Invalid collection membership.');
      const listing=item.listing?.status==='ACTIVE'?item.listing:null;
      if(listing&&(!unsigned(listing.id)||listing.id==='0'||!address(listing.seller)||!unsigned(listing.price)||listing.price==='0'||!unsigned(listing.expiry)||!unsigned(listing.nonce)||BigInt(listing.expiry)>BigInt(Number.MAX_SAFE_INTEGER)))throw new Error('Invalid listing.');
      next.tokens[item.id]={id:item.id,name:item.name,creator:item.creator,owner:item.owner,collectionId,minted:true,nonce:item.ownershipNonce,tokenApproved:item.tokenApproved,listing:listing?{id:listing.id,seller:listing.seller,price:listing.price,expiry:Number(listing.expiry),nonce:listing.nonce}:null};
      next.approvals[item.owner.toLowerCase()]=item.ownerApproval.approved;
    }
    for(const item of offers){if(!unsigned(item.id)||item.id==='0'||!next.tokens[item.pixel?.id]||!address(item.bidder)||!unsigned(item.amount)||item.amount==='0'||!unsigned(item.expiry)||BigInt(item.expiry)>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('Invalid offer.');next.offers[item.id]={id:item.id,tokenId:item.pixel.id,bidder:item.bidder,amount:item.amount,expiry:Number(item.expiry)};}
    next.activity=details.activities.map(item=>{
      const logIndex=Number(item.id.split('-').at(-1));if(!Number.isSafeInteger(logIndex)||logIndex<0||!/^0x[0-9a-fA-F]{64}$/.test(item.transaction)||!unsigned(item.block)||BigInt(item.block)>BigInt(block)||!unsigned(item.tokenId)||!address(item.account)||!unsigned(item.amount)||typeof item.kind!=='string')throw new Error('Invalid activity.');
      return {id:`${item.transaction}:${logIndex}`,type:item.kind,tokenId:item.tokenId==='0'?'':item.tokenId,account:item.account,amount:item.amount,block:Number(item.block),hash:item.transaction,logIndex};
    }).sort((a,b)=>b.block-a.block||b.logIndex-a.logIndex).map(({logIndex,...item})=>item);
    // Validate the pinned block again before publishing a checkpoint from GraphQL.
    if((await publicClient.getBlock({blockNumber:BigInt(block)})).hash.toLowerCase()!==next.hash.toLowerCase())return;
    await mkdir(cacheDir,{recursive:true});const temporary=`${cacheFile}.${process.pid}.seed.tmp`;await writeFile(temporary,JSON.stringify(next));await rename(temporary,cacheFile);
  } catch {
    // RPC replay remains authoritative when the graph is unavailable or incomplete.
  }
}

async function getStore() {
  if(!storeFlight)storeFlight=(async()=>{await ensureDogeosChain();await bootstrapGraphCheckpoint();return createCatalogStore({dep,nft,market,client:publicClient,cacheFile});})().catch(error=>{storeFlight=null;throw error;});
  return storeFlight;
}

export const sync=async(...args)=>(await getStore()).sync(...args);
export const token=async(id,...args)=>{tokenId(String(id));return (await getStore()).token(id,...args);};
export const catalog=async(raw={})=>{queryParams(raw);return (await getStore()).catalog(raw);};
export const offerList=async(raw={})=>{queryParams(raw,'offers');return (await getStore()).offerList(raw);};
export const collectionPage=async(raw={})=>{queryParams(raw,'collections');return (await getStore()).collectionPage(raw);};
export const status=async(...args)=>(await getStore()).status(...args);
export const readNFT=async(functionName,args=[],blockNumber)=>{await ensureDogeosChain();return publicClient.readContract({address:dep.DogeosPixel.address,abi:nft,functionName,args,blockNumber});};
export const readMarket=async(functionName,args=[],blockNumber)=>{await ensureDogeosChain();return publicClient.readContract({address:dep.PixelMarket.address,abi:market,functionName,args,blockNumber});};
