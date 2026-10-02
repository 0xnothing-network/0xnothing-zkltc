import { writeFile, readFile } from 'node:fs/promises';
import { createWalletClient,http,parseEther,formatEther,keccak256,toBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { signer,publicClient,chain,deployment,artifact,confirmed,assertDogeosChain } from './runtime.mjs';
import { template,encodePixels } from '../src/lib/pixels.mjs';
await assertDogeosChain();
const d=await deployment(),seller=signer(),nft=(await artifact('DogeosPixel')).abi,market=(await artifact('PixelMarket')).abi;
const previouslyPassed=await readFile('output/live-smoke-progress.json','utf8').then(JSON.parse).catch(()=>null);
// Deterministic, domain-separated test signer: recoverable after a failed run.
// The derived key stays in memory and never enters logs, artifacts or the web.
const buyer=createWalletClient({account:privateKeyToAccount(keccak256(toBytes('DOGEOSxPIXEL:smoke:v1:'+process.env.PRIVATE_KEY))),chain,transport:http()});
const transactions=previouslyPassed?.transactions??[];const read=(target,fn,args=[])=>publicClient.readContract({address:d[target].address,abi:target==='DogeosPixel'?nft:market,functionName:fn,args});
async function tx(wallet,target,fn,args=[],value) {const {request}=await publicClient.simulateContract({address:d[target].address,abi:target==='DogeosPixel'?nft:market,functionName:fn,args,account:wallet.account,value});const hash=await wallet.writeContract(request);await confirmed(hash);transactions.push({action:fn,hash,account:wallet.account.address});await writeFile('output/live-smoke-progress.json',JSON.stringify({transactions},null,2));console.log(fn,hash);}
const expiry=()=>BigInt(Math.floor(Date.now()/1000)+86400*30);
const initialBalance=await publicClient.getBalance({address:seller.account.address});
const art=[['doge','Good Doge','The first member of the pack.'],['rocket','To the Tiny Moon','A small rocket with very big plans.'],['flower','Bloom, Shibe, Bloom','Something good is always growing.'],['mushroom','Forest Friend','A little friend from the pixel woods.'],['sunset','Last Light Club','One more sunset before the moon.'],['ghost','Friendly Afterlife','Nothing spooky. Just good company.']];
const ids=[];
for(const [kind,title,description] of art) {const pixels=encodePixels(template(kind),32);if(await read('DogeosPixel','checkOriginalPacked',[pixels,32n]))await tx(seller,'DogeosPixel','mintPacked',[title,description,32n,pixels]);ids.push(await read('DogeosPixel','artworkRegistry',[await import('viem').then(v=>v.keccak256(v.encodePacked(['uint16','bytes'],[32,pixels])))]));}
let collectionId=1n;if(await read('DogeosPixel','collectionCount')===0n){await tx(seller,'DogeosPixel','createCollection',['The First Pack','Six small originals. One very good beginning on DogeOS.']);collectionId=await read('DogeosPixel','collectionCount');}
for(const id of ids)if(await read('DogeosPixel','tokenCollection',[id])!==collectionId)await tx(seller,'DogeosPixel','setTokenCollection',[id,collectionId]);
const currentBuyerBalance=await publicClient.getBalance({address:buyer.account.address});
if(currentBuyerBalance<parseEther('2'))await confirmed(await seller.sendTransaction({to:buyer.account.address,value:parseEther('2')-currentBuyerBalance}));
const id=ids[0];
await tx(seller,'DogeosPixel','approve',[d.PixelMarket.address,id]);await tx(seller,'PixelMarket','list',[id,parseEther('0.01'),expiry()]);
const listing=await read('PixelMarket','listings',[id]);await tx(buyer,'PixelMarket','buy',[id,listing[4]],parseEther('0.01'));
if((await read('DogeosPixel','ownerOf',[id])).toLowerCase()!==buyer.account.address.toLowerCase())throw new Error('Buy did not transfer ownership');
await tx(buyer,'DogeosPixel','createCollection',['A Pixel Passed On','Created by a secondary NFT owner during the live integration test.']);
const buyerCollection=await read('DogeosPixel','collectionCount');await tx(buyer,'DogeosPixel','setTokenCollection',[id,buyerCollection]);
await tx(buyer,'DogeosPixel','approve',[d.PixelMarket.address,id]);await tx(buyer,'PixelMarket','list',[id,parseEther('0.03'),expiry()]);
await tx(seller,'PixelMarket','makeOffer',[id,expiry()],parseEther('0.02'));const offer=await read('PixelMarket','offerCount');
await tx(buyer,'PixelMarket','acceptOffer',[offer]);if((await read('DogeosPixel','ownerOf',[id])).toLowerCase()!==seller.account.address.toLowerCase())throw new Error('Accept offer did not transfer ownership');
await tx(seller,'DogeosPixel','setTokenCollection',[id,collectionId]);
await tx(buyer,'PixelMarket','makeOffer',[id,expiry()],parseEther('0.005'));const cancelId=await read('PixelMarket','offerCount');await tx(buyer,'PixelMarket','cancelOffer',[cancelId]);await tx(buyer,'PixelMarket','withdraw',[buyer.account.address]);
if(await read('PixelMarket','credits',[seller.account.address])>0n)await tx(seller,'PixelMarket','withdraw',[seller.account.address]);
for(let i=0;i<ids.length;i++){await tx(seller,'DogeosPixel','approve',[d.PixelMarket.address,ids[i]]);await tx(seller,'PixelMarket','list',[ids[i],parseEther(String(1+i*.5)),expiry()]);}
const escrow=await read('PixelMarket','totalOfferEscrow'),credits=await read('PixelMarket','totalCredits'),held=await publicClient.getBalance({address:d.PixelMarket.address});
if(held<escrow+credits)throw new Error('Market undercollateralized');
const buyerBalance=await publicClient.getBalance({address:buyer.account.address}),fees=await publicClient.estimateFeesPerGas();const reserve=fees.maxFeePerGas*30000n+parseEther('0.2');
if(buyerBalance>reserve)await confirmed(await buyer.sendTransaction({to:seller.account.address,value:buyerBalance-reserve,gas:21000n,...fees}));
const report={network:chain.name,chainId:chain.id,nft:d.DogeosPixel.address,market:d.PixelMarket.address,temporaryBuyer:buyer.account.address,checked:['mint','collection creation by original and secondary owners','assignment','approval','listing','buy','offer escrow','accept offer','offer cancellation','refund withdrawal','seller withdrawal','royalty accounting'],transactions,accounting:{balance:String(held),escrow:String(escrow),credits:String(credits),solvent:held>=escrow+credits},costDOGE:formatEther(initialBalance-await publicClient.getBalance({address:seller.account.address})),finished:new Date().toISOString()};
await writeFile('output/live-smoke.json',JSON.stringify(report,null,2));console.log('Live smoke passed; evidence in output/live-smoke.json');
