import { config } from 'dotenv';
import { readFile } from 'node:fs/promises';
import { createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { isAddress } from 'viem';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
config({path: fileURLToPath(new URL('.env.local', root)), quiet:true});
export const chain = defineChain({id:6281971,name:'DogeOS Chikyū Testnet',nativeCurrency:{name:'Dogecoin',symbol:'DOGE',decimals:18},rpcUrls:{default:{http:[process.env.DOGEOS_RPC_URL || 'https://rpc.testnet.dogeos.com']}},blockExplorers:{default:{name:'DogeOS L2Scan',url:'https://dogeos-testnet.l2scan.co'}}});
export const publicClient = createPublicClient({chain,transport:http(chain.rpcUrls.default.http[0],{timeout:20000,retryCount:2})});
export async function assertDogeosChain(client=publicClient) { if(await client.getChainId()!==chain.id) throw new Error('RPC chain ID does not match DogeOS Chikyū Testnet.'); }
export function signer() {
  let key=process.env.PRIVATE_KEY || ''; if(!key.startsWith('0x')) key='0x'+key;
  if(!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('PRIVATE_KEY missing or invalid in .env.local');
  const account=privateKeyToAccount(key);
  return createWalletClient({account,chain,transport:http()});
}
export async function artifact(name) { if(!/^[A-Za-z][A-Za-z0-9_]*$/.test(name))throw new Error('Invalid artifact name.');return JSON.parse(await readFile(new URL(`contracts/out/${name}.sol/${name}.json`,root),'utf8')); }
export async function deployment() { const value=JSON.parse(await readFile(new URL('deployments/chikyu.json',root),'utf8'));if(value.chainId!==chain.id||!isAddress(value.deployer,{strict:false})||['DogeosPixel','PixelMarket'].some(name=>!isAddress(value[name]?.address,{strict:false})||!Number.isSafeInteger(value[name]?.startBlock)||value[name].startBlock<1))throw new Error('Invalid DogeOS deployment record.');return value; }
export async function confirmed(hash) { const receipt=await publicClient.waitForTransactionReceipt({hash,timeout:180000}); if(receipt.status!=='success') throw new Error(`Transaction reverted: ${hash}`); return receipt; }
