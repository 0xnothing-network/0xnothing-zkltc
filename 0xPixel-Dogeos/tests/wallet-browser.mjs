import {chromium,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import deployment from '../src/generated/deployment.json' with {type:'json'};
const browser=await chromium.launch({headless:true});
try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),address=deployment.deployer,errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(({address})=>{
   const handlers=new Map();let chain='0x1',accounts=[address],sends=0;
   const emit=(type,value)=>handlers.get(type)?.forEach(fn=>fn(value));
   window.ethereum={on:(type,fn)=>{if(!handlers.has(type))handlers.set(type,new Set());handlers.get(type).add(fn);},removeListener:(type,fn)=>handlers.get(type)?.delete(fn),request:async({method,params})=>{
     if(['eth_accounts','eth_requestAccounts'].includes(method))return accounts;
     if(method==='eth_chainId')return chain;
     if(method==='wallet_switchEthereumChain'){chain=params[0].chainId;emit('chainChanged',chain);return null;}
     if(method==='eth_sendTransaction'){sends++;const error=new Error('User rejected transaction');error.code=4001;throw error;}
     throw new Error('Unexpected provider request: '+method);
   }};
   window.__walletTest={swap:()=>{accounts=['0x1111111111111111111111111111111111111111'];emit('accountsChanged',accounts);},disconnect:()=>emit('disconnect',{}),get sends(){return sends;}};
 },{address});
 await page.goto('http://localhost:3300/DOGEOSxPIXEL/wallet');await page.getByRole('button',{name:'Connect wallet',exact:true}).first().click();
 await page.getByRole('button',{name:'Browser wallet',exact:true}).click();await expect(page.getByText('Your wallet is on another network.')).toBeVisible();
 await page.getByRole('button',{name:'Switch to DogeOS',exact:true}).click();await expect(page.locator('.wrong-network')).toHaveCount(0);
 await page.locator('.art-card').first().waitFor({timeout:60000});assert.equal(await page.locator('.art-card').count(),6);
 await page.screenshot({path:'output/desktop-connected-wallet.png',fullPage:true});
 await page.locator('.art-card').first().click();await page.getByRole('button',{name:'Cancel listing',exact:true}).waitFor();
 await page.getByRole('button',{name:'Cancel listing',exact:true}).click();await expect(page.locator('.toast')).toContainText('You declined',{timeout:30000});
 assert.equal(await page.evaluate(()=>window.__walletTest.sends),1);await expect(page.locator('.transaction-status')).toHaveCount(0);
 await page.getByLabel('Close dialog').click();await page.evaluate(()=>window.__walletTest.swap());await expect(page.locator('.art-card')).toHaveCount(0,{timeout:30000});
 await expect(page.getByRole('heading',{name:'Your wall is waiting.'})).toBeVisible();await page.evaluate(()=>window.__walletTest.disconnect());
 await expect(page.getByRole('heading',{name:'A wallet makes it yours.'})).toBeVisible();assert.deepEqual(errors,[]);
 await writeFile('output/wallet-browser.json',JSON.stringify({passed:true,checks:['injected wallet connection','wrong network','switch to DogeOS','real owned NFT reads','real transaction simulation','user rejection resets pending state','account change clears stale NFT data','provider disconnect'],signedTransactions:0,errors},null,2));console.log('Wallet browser tests passed (no private key or signed transaction in browser).');
} finally {await browser.close();}
