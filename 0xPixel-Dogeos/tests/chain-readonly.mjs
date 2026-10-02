import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {keccak256} from 'viem';
import {publicClient,assertDogeosChain,artifact,deployment} from '../scripts/runtime.mjs';
await assertDogeosChain();
const dep=await deployment(),blockNumber=await publicClient.getBlockNumber(),contracts={};
const json=async file=>JSON.parse(await readFile(new URL('../'+file,import.meta.url),'utf8'));
const mask=(code,ranges)=>{let value=code.slice(2);for(const {start,length} of ranges)value=value.slice(0,start*2)+'0'.repeat(length*2)+value.slice((start+length)*2);return '0x'+value;};
for(const name of ['DogeosPixel','PixelMarket']){
 const compiled=await artifact(name),code=await publicClient.getCode({address:dep[name].address,blockNumber});assert.ok(code&&code!=='0x');
 const ranges=Object.values(compiled.deployedBytecode.immutableReferences||{}).flat();
 assert.equal(mask(code,ranges).toLowerCase(),mask(compiled.deployedBytecode.object,ranges).toLowerCase(),name+' deployed bytecode differs from the compiled source');
 for(const file of ['src/generated/'+name+'.json','subgraph/abis/'+name+'.json']){const exported=await json(file);assert.deepEqual(Array.isArray(exported)?exported:exported.abi,compiled.abi,file+' ABI differs from the compiled contract');}
 contracts[name]={address:dep[name].address,bytecodeMatches:true,abiMatches:true,runtimeBytes:(code.length-2)/2,codeHash:keccak256(code),immutableRanges:ranges};
}
const market=await artifact('PixelMarket');
const read=functionName=>publicClient.readContract({address:dep.PixelMarket.address,abi:market.abi,functionName,blockNumber});
const [held,escrow,credits,nft,recipient]=await Promise.all([publicClient.getBalance({address:dep.PixelMarket.address,blockNumber}),read('totalOfferEscrow'),read('totalCredits'),read('nft'),read('feeRecipient')]);
assert.equal(nft.toLowerCase(),dep.DogeosPixel.address.toLowerCase());assert.equal(recipient.toLowerCase(),dep.deployer.toLowerCase());assert.ok(held>=escrow+credits,'Market liabilities exceed its balance');
await writeFile('output/chain-readonly.json',JSON.stringify({passed:true,verifiedAt:new Date().toISOString(),block:String(blockNumber),chainId:dep.chainId,contracts,accounting:{held:String(held),escrow:String(escrow),credits:String(credits),solvent:true},signedTransactions:0},null,2));
console.log('Read-only bytecode, ABI, immutable configuration and market solvency verification passed.');
