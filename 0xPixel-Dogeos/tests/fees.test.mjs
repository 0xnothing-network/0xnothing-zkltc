import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseTransaction} from 'viem';
import {estimateDogeosFees,L1_ORACLE} from '../src/lib/fees.mjs';
test('DogeOS fee estimate includes the data/finality oracle and a margin',async()=>{
 let oracleInput;
 const client={estimateGas:async()=>100000n,estimateFeesPerGas:async()=>({maxFeePerGas:20n,maxPriorityFeePerGas:1n}),getTransactionCount:async()=>4,readContract:async request=>{assert.equal(request.address,L1_ORACLE);oracleInput=request.args[0];return 100000000000000000n;}};
 const result=await estimateDogeosFees(client,{account:'0x1111111111111111111111111111111111111111',to:'0x2222222222222222222222222222222222222222',data:'0x123456',value:10n});
 assert.equal(result.gas,110000n);assert.equal(result.execution,2200000n);assert.equal(result.total,(result.execution+result.dataFinality)*120n/100n);
 const input=parseTransaction(oracleInput);assert.equal(input.chainId,6281971);assert.equal(input.data,'0x123456');assert.equal(input.value,10n);assert.equal(input.nonce,4);
});
test('unavailable data/finality oracle fails preflight rather than underquoting',async()=>{
 const client={estimateGas:async()=>21000n,estimateFeesPerGas:async()=>({maxFeePerGas:20n,maxPriorityFeePerGas:1n}),getTransactionCount:async()=>0,readContract:async()=>{throw new Error('Oracle unavailable');}};
 await assert.rejects(()=>estimateDogeosFees(client,{account:'0x1111111111111111111111111111111111111111',to:'0x2222222222222222222222222222222222222222'}),/Oracle unavailable/);
});
test('fee margins round upward and submission fees match the oracle payload',async()=>{
 let raw;
 const client={estimateGas:async()=>121n,estimateFeesPerGas:async()=>({maxFeePerGas:3n,maxPriorityFeePerGas:1n}),getTransactionCount:async()=>0,readContract:async request=>{raw=request.args[0];return 1n;}};
 const result=await estimateDogeosFees(client,{account:'0x1111111111111111111111111111111111111111',to:'0x2222222222222222222222222222222222222222'});
 assert.equal(result.gas,134n);assert.equal(result.total,484n);
 const input=parseTransaction(raw);
 assert.equal(result.maxFeePerGas,input.maxFeePerGas);assert.equal(result.maxPriorityFeePerGas,input.maxPriorityFeePerGas);
});
test('unsupported or invalid fee responses fail before a wallet signing request',async()=>{
 const base={estimateGas:async()=>21000n,getTransactionCount:async()=>0,readContract:async()=>0n};
 for(const fees of [{gasPrice:10n},{maxFeePerGas:1n,maxPriorityFeePerGas:2n},{maxFeePerGas:2n,maxPriorityFeePerGas:-1n}]){
  await assert.rejects(()=>estimateDogeosFees({...base,estimateFeesPerGas:async()=>fees},{account:'0x1111111111111111111111111111111111111111',to:'0x2222222222222222222222222222222222222222'}),/estimate/);
 }
});
