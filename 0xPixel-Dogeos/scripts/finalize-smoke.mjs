import {writeFile} from 'node:fs/promises';
import {createWalletClient,http,keccak256,toBytes,parseEther,parseEventLogs,formatEther} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {signer,publicClient,chain,deployment,artifact,confirmed,assertDogeosChain} from './runtime.mjs';
await assertDogeosChain();
const seller=signer(),dep=await deployment(),nft=(await artifact('DogeosPixel')).abi,market=(await artifact('PixelMarket')).abi;
const buyer=createWalletClient({account:privateKeyToAccount(keccak256(toBytes('DOGEOSxPIXEL:smoke:v1:'+process.env.PRIVATE_KEY))),chain,transport:http()});
const read=(fn,args=[])=>publicClient.readContract({address:dep.PixelMarket.address,abi:market,functionName:fn,args});
const balance=await publicClient.getBalance({address:buyer.account.address}),fees=await publicClient.estimateFeesPerGas(),reserve=parseEther('0.2');
let refund=null;if(balance>reserve){refund=await buyer.sendTransaction({to:seller.account.address,value:balance-reserve,gas:21000n,...fees});await confirmed(refund);}
const end=await publicClient.getBlockNumber(),logs=await publicClient.getLogs({address:[dep.DogeosPixel.address,dep.PixelMarket.address],fromBlock:BigInt(dep.DogeosPixel.startBlock),toBlock:end});
const events=logs.flatMap(log=>parseEventLogs({abi:log.address.toLowerCase()===dep.DogeosPixel.address.toLowerCase()?nft:market,logs:[log],strict:true}));
const required=['Minted','CollectionCreated','TokenCollectionChanged','Listed','Sold','OfferMade','OfferAccepted','OfferCancelled','Withdrawn'];
for(const event of required)if(!events.some(e=>e.eventName===event))throw new Error('Missing live evidence: '+event);
if(!events.some(e=>e.eventName==='CollectionCreated'&&e.args.owner.toLowerCase()===buyer.account.address.toLowerCase()))throw new Error('Secondary collection not proven');
for(const e of events.filter(e=>['Sold','OfferAccepted'].includes(e.eventName))){const value=e.args.price??e.args.amount;if(e.args.royalty!==value/100n||e.args.fee!==value/100n)throw new Error('Incorrect royalty/fee');}
for(let id=1n;id<=6n;id++){const owner=await publicClient.readContract({address:dep.DogeosPixel.address,abi:nft,functionName:'ownerOf',args:[id]});if(owner.toLowerCase()!==seller.account.address.toLowerCase())throw new Error('NFT not returned to funded wallet');if(!await read('isListingActive',[id]))throw new Error('Seed NFT not actively listed');}
const escrow=await read('totalOfferEscrow'),credits=await read('totalCredits'),held=await publicClient.getBalance({address:dep.PixelMarket.address});if(held!==escrow+credits||escrow!==0n)throw new Error('Accounting mismatch');
await writeFile('output/live-smoke.json',JSON.stringify({passed:true,network:chain.name,chainId:chain.id,contracts:{nft:dep.DogeosPixel.address,market:dep.PixelMarket.address},testBuyer:buyer.account.address,checked:required,royaltyAndFeeVerified:true,secondaryOwnerCollectionVerified:true,supply:6,activeListings:6,refundHash:refund,testBuyerReserveDOGE:formatEther(await publicClient.getBalance({address:buyer.account.address})),accounting:{held:String(held),escrow:String(escrow),credits:String(credits)},transactions:events.filter(e=>required.includes(e.eventName)).map(e=>({type:e.eventName,hash:e.transactionHash,block:Number(e.blockNumber)})),finished:new Date().toISOString()},null,2));console.log('Live smoke verified; 6 real NFTs and listings, refunds and royalties confirmed.');
