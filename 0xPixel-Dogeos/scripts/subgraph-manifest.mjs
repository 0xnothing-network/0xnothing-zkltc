import { readFile,writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
const root=new URL('../',import.meta.url); config({path:fileURLToPath(new URL('.env.local',root)),quiet:true});
const deployment=JSON.parse(await readFile(new URL('deployments/chikyu.json',root),'utf8'));
const network=process.env.SUBGRAPH_NETWORK||'dogeos-testnet';if(!/^[a-z0-9-]+$/.test(network))throw new Error('Invalid SUBGRAPH_NETWORK');
if(deployment.chainId!==6281971||!/^0x[0-9a-fA-F]{40}$/.test(deployment.deployer)||['DogeosPixel','PixelMarket'].some(name=>!/^0x[0-9a-fA-F]{40}$/.test(deployment[name]?.address)||!Number.isSafeInteger(deployment[name]?.startBlock)||deployment[name].startBlock<1))throw new Error('Invalid deployment record for manifest.');
const sources=[['DogeosPixel',[
 ['Transfer(indexed address,indexed address,indexed uint256)','handleTransfer'],
 ['Approval(indexed address,indexed address,indexed uint256)','handleApproval'],
 ['ApprovalForAll(indexed address,indexed address,bool)','handleApprovalForAll'],
 ['Minted(indexed address,indexed uint256,string)','handleMinted'],
 ['CollectionCreated(indexed uint256,indexed address,string,string)','handleCollectionCreated'],
 ['CollectionUpdated(indexed uint256,string,string)','handleCollectionUpdated'],
 ['TokenCollectionChanged(indexed uint256,indexed uint256,indexed uint256)','handleTokenCollectionChanged']
]],['PixelMarket',[
 ['Listed(indexed uint256,indexed address,indexed uint256,uint256,uint64,uint256)','handleListed'],
 ['ListingCancelled(indexed uint256,indexed uint256)','handleListingCancelled'],
 ['Sold(indexed uint256,indexed address,indexed address,uint256,uint256,uint256,uint256)','handleSold'],
 ['OfferMade(indexed uint256,indexed uint256,indexed address,uint256,uint64)','handleOfferMade'],
 ['OfferCancelled(indexed uint256)','handleOfferCancelled'],
 ['OfferAccepted(indexed uint256,indexed uint256,indexed address,address,uint256,uint256,uint256)','handleOfferAccepted'],
 ['Withdrawn(indexed address,indexed address,uint256)','handleWithdrawn']
]]];
let output='specVersion: 1.0.0\nindexerHints:\n  prune: auto\nschema:\n  file: ./schema.graphql\ndataSources:\n';
for(const [name,events] of sources) output+=`  - kind: ethereum/contract\n    name: ${name}\n    network: ${network}\n    source:\n      address: '${deployment[name].address}'\n      abi: ${name}\n      startBlock: ${deployment[name].startBlock}\n    mapping:\n      kind: ethereum/events\n      apiVersion: 0.0.9\n      language: wasm/assemblyscript\n      entities: [Pixel, Collection, Listing, Offer, Sale, Activity, Account, Stats, MarketApproval]\n      abis:\n        - name: DogeosPixel\n          file: ./abis/DogeosPixel.json\n        - name: PixelMarket\n          file: ./abis/PixelMarket.json\n      eventHandlers:\n${events.map(([event,handler])=>`        - event: ${event}\n          handler: ${handler}`).join('\n')}\n      file: ./src/${name==='DogeosPixel'?'pixel':'market'}.ts\n`;
await writeFile(new URL('subgraph/subgraph.yaml',root),output);console.log('Manifest prepared for',network,'with deployed addresses and blocks.');
await writeFile(new URL('subgraph/src/config.ts',root),`// Generated from the recorded deployment.\nexport const FEE_RECIPIENT = '${deployment.deployer}';\nexport const MARKET_ADDRESS = '${deployment.PixelMarket.address}';\n`);
