import type {Address,Hex} from 'viem';
export const L1_ORACLE:Address;
export function estimateDogeosFees(client:unknown,request:{account:Address;to:Address;data?:Hex;value?:bigint}):Promise<{gas:bigint;maxFeePerGas:bigint;maxPriorityFeePerGas:bigint;execution:bigint;dataFinality:bigint;total:bigint}>;
