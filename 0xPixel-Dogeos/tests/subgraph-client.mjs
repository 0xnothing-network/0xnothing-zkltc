import {createServer} from 'node:http';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {catalog} from '../server/catalog.mjs';
const live=await catalog({});let mode='healthy',seen=[];
const graph=createServer(async(req,res)=>{
 let body='';for await(const chunk of req)body+=chunk;const query=JSON.parse(body);seen.push(query.variables);
 if(mode==='offline'){res.statusCode=503;res.end('unavailable');return;}
 const where=query.variables.where;
 function matches(t,filter){
   if(filter.or){assert.deepEqual(Object.keys(filter),['or'],'Graph Node rejects column filters alongside or');return filter.or.some(branch=>matches(t,branch));}
   return (!filter.owner||t.owner.toLowerCase()===filter.owner)&&(!filter.collection||t.collectionId===filter.collection)&&(!filter.name_contains_nocase||t.name.toLowerCase().includes(filter.name_contains_nocase.toLowerCase()))&&(!filter.listing_||(t.listing&&t.listing.expiry>Number(filter.listing_.expiry_gt)))&&(!filter.tokenApproved&&!filter.ownerApproval_||Boolean(t.listing));
 }
 let tokens=live.tokens.filter(t=>matches(t,where));
 if(mode==='inconsistent')tokens=tokens.slice(1);
 res.setHeader('content-type','application/json');res.end(JSON.stringify({data:{_meta:{block:{number:mode==='stale'?1:live.indexedBlock},hasIndexingErrors:mode==='indexing-error'},pixels:tokens.slice(query.variables.skip,query.variables.skip+query.variables.first).map(t=>({id:t.id})),collections:live.collections.map(c=>({...c,pixelCount:c.count})),stats:{minted:mode==='wrong-supply'?'999999':String(live.supply)}}}));
});
await new Promise(resolve=>graph.listen(0,'127.0.0.1',resolve));process.env.SUBGRAPH_URL='http://127.0.0.1:'+graph.address().port;
try {
 assert.ok(live.tokens.length>0);const sample=live.tokens[0];
 const healthy=await catalog({search:sample.name});assert.equal(healthy.source,'subgraph');assert.equal(healthy.tokens[0].name,sample.name);
 const owned=await catalog({owner:sample.owner});assert.equal(owned.source,'subgraph');assert.ok(owned.tokens.every(t=>t.owner.toLowerCase()===sample.owner.toLowerCase()));
 const listed=await catalog({listed:'true'});assert.equal(listed.source,'subgraph');assert.ok(seen.at(-1).where.or);
 const combined=await catalog({listed:'true',owner:sample.owner,search:sample.name});assert.equal(combined.source,'subgraph');assert.equal(combined.tokens[0].id,sample.id);assert.ok(seen.at(-1).where.or.every(branch=>branch.owner===sample.owner.toLowerCase()&&branch.name_contains_nocase===sample.name&&branch.listing_));
 const page=await catalog({limit:'2',offset:'2'});assert.equal(page.source,'subgraph');assert.deepEqual(page.tokens.map(t=>t.id),live.tokens.slice(2,4).map(t=>t.id));
 for(const variant of ['offline','stale','indexing-error','inconsistent','wrong-supply']){mode=variant;const data=await catalog({});assert.equal(data.source,'rpc');assert.equal(data.tokens.length,live.tokens.length);}
 mode='healthy';const injection='" } { privateKey } #';await catalog({search:injection});assert.equal(seen.at(-1).where.name_contains_nocase,injection);
 await writeFile('output/subgraph-client.json',JSON.stringify({passed:true,checks:['healthy subgraph discovery with live contract revalidation','owner/filter variables and approval-aware listed filter','pagination','endpoint failure fallback','stale index fallback','indexing error fallback','inconsistent discovery fallback','wrong supply fallback','query values passed as variables'],realGraphNodeDeployed:false},null,2));console.log('Subgraph integration and RPC fallback tests passed.');
} finally {delete process.env.SUBGRAPH_URL;await new Promise(resolve=>graph.close(resolve));}
