import { createPublicClient,createWalletClient,custom,defineChain,http,type Address,type EIP1193Provider,type Abi } from 'viem';
import nftAbi from '../generated/DogeosPixel.json';
import marketAbi from '../generated/PixelMarket.json';
import deployment from '../generated/deployment.json';
export const BASE='/DOGEOSxPIXEL';
export const chain=defineChain({id:6281971,name:'DogeOS Chikyū Testnet',nativeCurrency:{name:'Dogecoin',symbol:'DOGE',decimals:18},rpcUrls:{default:{http:['https://rpc.testnet.dogeos.com']}},blockExplorers:{default:{name:'DogeOS L2Scan',url:'https://dogeos-testnet.l2scan.co'}}});
export const publicClient=createPublicClient({chain,transport:http(BASE+'/api/rpc')});
export const NFT=deployment.DogeosPixel.address as Address,MARKET=deployment.PixelMarket.address as Address;
export const NFT_ABI=nftAbi as Abi,MARKET_ABI=marketAbi as Abi;
export const walletClient=(provider:Pick<EIP1193Provider,'request'>)=>createWalletClient({chain,transport:custom(provider)});
export const shorten=(a:string)=>a.slice(0,6)+'…'+a.slice(-4);
export const explorer=(hash:string)=>chain.blockExplorers.default.url+'/tx/'+hash;
export async function api<T>(route:string,signal?:AbortSignal):Promise<T> {
 const controller=new AbortController(),abort=()=>controller.abort(signal?.reason);
 if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
 const timeout=setTimeout(()=>controller.abort(new Error('Chain data request timed out. Please retry.')),25000);
 try{const response=await fetch(BASE+'/api/'+route,{signal:controller.signal});if(!response.ok){const body=await response.json().catch(()=>null);throw new Error(typeof body?.error==='string'?body.error.slice(0,240):'Chain data is temporarily unavailable. Please retry.');}return await response.json();}
 finally{clearTimeout(timeout);signal?.removeEventListener('abort',abort);}
}
export type Token={id:string;name:string;description:string;grid:number;pixels:string;owner:Address;creator:Address;mintedAt:number;artworkHash:string;collectionId:string;listing:{id:string;seller:Address;price:string;expiry:number}|null};
export type Collection={id:string;owner:Address;name:string;description:string;count:number;previews?:Pick<Token,'id'|'name'|'grid'|'pixels'>[]};
export type CollectionPage={collections:Collection[];total:number;next:number|null;indexedBlock:number};
export type OfferPage={offers:Offer[];total:number;next:number|null};
export type Activity={id:string;type:string;tokenId:string;account:string|null;amount:string;hash:string;block:number};
export type Catalog={tokens:Token[];total:number;next:number|null;collections:Collection[];activity:Activity[];supply:number;indexedBlock:number;source:string};
export type Offer={id:string;tokenId:string;bidder:Address;amount:string;expiry:number;expired:boolean};
