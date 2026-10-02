import {serializeTransaction,parseAbi} from 'viem';
export const L1_ORACLE='0x5300000000000000000000000000000000000002';
const ORACLE_ABI=parseAbi(['function getL1Fee(bytes data) view returns (uint256)']);
/** Include DogeOS data/finality fees, not just Ethereum-style execution gas.
 * A synthetic all-nonzero signature conservatively estimates signed RLP size.
 * It is only oracle input; it is never signed, broadcast or used as authorization.
 */
export async function estimateDogeosFees(client,{account,to,data='0x',value=0n}) {
 const [estimatedGas,fees,nonce]=await Promise.all([client.estimateGas({account,to,data,value}),client.estimateFeesPerGas(),client.getTransactionCount({address:account,blockTag:'pending'})]);
 if(estimatedGas<=0n||fees.maxFeePerGas===undefined||fees.maxPriorityFeePerGas===undefined||fees.maxFeePerGas<fees.maxPriorityFeePerGas||fees.maxPriorityFeePerGas<0n)throw new Error('Unable to estimate DogeOS transaction fees.');
 const gas=(estimatedGas*110n+99n)/100n;
 const raw=serializeTransaction({type:'eip1559',chainId:6281971,to,data,value,nonce,gas,maxFeePerGas:fees.maxFeePerGas,maxPriorityFeePerGas:fees.maxPriorityFeePerGas},{r:'0x'+'ff'.repeat(32),s:'0x'+'ff'.repeat(32),yParity:0});
 const l1Fee=await client.readContract({address:L1_ORACLE,abi:ORACLE_ABI,functionName:'getL1Fee',args:[raw]});
 const execution=gas*fees.maxFeePerGas;
 if(l1Fee<0n)throw new Error('Invalid DogeOS data/finality fee.');
 return {gas,maxFeePerGas:fees.maxFeePerGas,maxPriorityFeePerGas:fees.maxPriorityFeePerGas,execution,dataFinality:l1Fee,total:((execution+l1Fee)*120n+99n)/100n};
}
