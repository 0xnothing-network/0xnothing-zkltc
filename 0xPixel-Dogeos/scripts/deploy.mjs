import { writeFile, readFile } from 'node:fs/promises';
import { formatEther } from 'viem';
import { signer, publicClient, chain, artifact, confirmed, assertDogeosChain } from './runtime.mjs';
await assertDogeosChain();const chainId=chain.id;
try { await readFile('deployments/chikyu.json'); throw new Error('Deployment already exists; reuse it. Archive it explicitly before deploying another version.'); } catch(e) { if(e.code!=='ENOENT') throw e; }
try { await readFile('deployments/chikyu.partial.json'); throw new Error('A partial deployment exists. Recover its recorded contracts before attempting a new deployment.'); } catch(e) { if(e.code!=='ENOENT') throw e; }
const wallet=signer();
console.log('Deployer', wallet.account.address, 'Balance',formatEther(await publicClient.getBalance({address:wallet.account.address})),'DOGE');
const deployed={chainId,rpc:chain.rpcUrls.default.http[0],deployer:wallet.account.address,compiler:'0.8.34',evm:'prague',createdAt:new Date().toISOString()};
for(const name of ['DogeosPixel','PixelMarket']) {
  const art=await artifact(name); const args=name==='PixelMarket'?[deployed.DogeosPixel.address,wallet.account.address]:[];
  const hash=await wallet.deployContract({abi:art.abi,bytecode:art.bytecode.object,args}); const receipt=await confirmed(hash);
  deployed[name]={address:receipt.contractAddress,transactionHash:hash,startBlock:Number(receipt.blockNumber),gasUsed:receipt.gasUsed.toString()};
  await writeFile('deployments/chikyu.partial.json',JSON.stringify(deployed,null,2));
  console.log(name,receipt.contractAddress,'block',receipt.blockNumber.toString());
}
await writeFile('deployments/chikyu.json',JSON.stringify(deployed,null,2));
await writeFile('src/generated/deployment.json',JSON.stringify(deployed,null,2));
console.log('Contracts recorded. Rebuild the frontend and subgraph manifest for these addresses.');
