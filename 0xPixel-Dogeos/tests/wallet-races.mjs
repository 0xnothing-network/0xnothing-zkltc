import {chromium,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import deployment from '../src/generated/deployment.json' with {type:'json'};

const browser=await chromium.launch({headless:true});
const base=process.env.PIXEL_TEST_URL||'http://localhost:3300/DOGEOSxPIXEL';
const report={startedAt:new Date().toISOString(),checks:[],errors:[],signedTransactions:0};
async function fixture(settings={}) {
 const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'en-US'});
 await context.addInitScript(({address,chainId,settings})=>{
  const handlers=new Map(),calls=[];let chain=settings.wrongChain?'0x1':chainId,accounts=[address],chainCalls=0,sends=0,switches=0;
  const emit=(event,data)=>handlers.get(event)?.forEach(fn=>fn(data));
  const audit=window.__audit={calls,blocked:false,blockChainAt:0,release:null,
   swap(){accounts=['0x1111111111111111111111111111111111111111'];emit('accountsChanged',accounts);},
   wrongNetwork(){chain='0x1';emit('chainChanged',chain);},
   duplicate(){emit('accountsChanged',accounts);emit('chainChanged',chain);},
   disconnect(){emit('disconnect',{});},get sends(){return sends;},get chainCalls(){return chainCalls;}};
  const provider={on(event,fn){if(!handlers.has(event))handlers.set(event,new Set());handlers.get(event).add(fn);},removeListener(event,fn){handlers.get(event)?.delete(fn);},async request({method,params}){
   calls.push(method);
   if(method==='eth_requestAccounts'){const result=settings.invalidAccount?['bad']:accounts.slice();if(settings.blockConnect){audit.blocked=true;await new Promise(resolve=>audit.release=resolve);}return result;}
   if(method==='eth_accounts')return accounts.slice();
   if(method==='eth_chainId'){chainCalls++;const result=settings.invalidChain?'not-a-chain':chain;if(audit.blockChainAt===chainCalls){audit.blocked=true;await new Promise(resolve=>audit.release=resolve);}return result;}
   if(method==='wallet_switchEthereumChain'){switches++;if(settings.addChain&&switches===1){const error=new Error('Unknown chain');error.code=4902;throw error;}chain=params[0].chainId;emit('chainChanged',chain);return null;}
   if(method==='wallet_addEthereumChain')return null;
   if(method==='eth_sendTransaction'){sends++;const error=new Error('User rejected transaction');error.code=4001;throw error;}
   throw new Error('Unexpected provider method '+method);
  }};
  window.ethereum=provider;
  if(settings.eip6963)window.addEventListener('eip6963:requestProvider',()=>{
   window.dispatchEvent(new CustomEvent('eip6963:announceProvider',{detail:{info:{uuid:'audit-wallet',name:'Audit wallet'},provider}}));
   window.dispatchEvent(new CustomEvent('eip6963:announceProvider',{detail:{info:{uuid:'invalid-wallet',name:'x'.repeat(101)},provider}}));
  });
  if(settings.clipboardDenied)Object.defineProperty(navigator,'clipboard',{value:{writeText:async()=>{throw new Error('Clipboard denied by test');}}});
 },{address:deployment.deployer,chainId:'0x'+deployment.chainId.toString(16),settings});
 const page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));
 await page.goto(base+'/wallet',{waitUntil:'networkidle'});return page;
}
async function choose(page,name='Browser wallet') {
 await page.getByRole('button',{name:'Connect wallet',exact:true}).first().click();
 await page.getByRole('button',{name,exact:true}).click();
}
async function connected(page) {
 await choose(page);await expect(page.getByRole('dialog')).toHaveCount(0);await page.locator('.art-card').first().waitFor();
}
async function cancelListing(page) {
 await page.locator('.art-card').first().click();await page.getByRole('button',{name:'Cancel listing',exact:true}).click();
}
async function check(name,fn) {
 const start=performance.now();try{await fn();report.checks.push({name,pass:true,durationMs:Math.round(performance.now()-start)});console.log('PASS '+name);}catch(e){report.checks.push({name,pass:false,error:e.message});throw e;}
}
try {
 await check('pending disconnect cannot resurrect a connection from cached account results',async()=>{
  const page=await fixture({blockConnect:true});await choose(page);await page.waitForFunction(()=>window.__audit.blocked);
  await expect(page.getByRole('button',{name:'Browser wallet',exact:true})).toBeDisabled();
  await page.evaluate(()=>{window.__audit.disconnect();window.__audit.release();});
  await expect(page.locator('.toast')).toContainText('connection changed');await expect(page.getByRole('heading',{name:'A wallet makes it yours.'})).toBeVisible();assert.equal(await page.evaluate(()=>window.__audit.sends),0);
 });
 await check('account change during connection cannot commit a cached previous account',async()=>{
  const page=await fixture();await page.evaluate(()=>window.__audit.blockChainAt=1);await choose(page);await page.waitForFunction(()=>window.__audit.blocked);
  await page.evaluate(()=>{window.__audit.swap();window.__audit.release();});await expect(page.locator('.toast')).toContainText('connection changed');await expect(page.getByRole('heading',{name:'A wallet makes it yours.'})).toBeVisible();assert.equal(await page.evaluate(()=>window.__audit.sends),0);
 });
 await check('invalid wallet account and chain responses fail without connecting',async()=>{
  for(const settings of [{invalidAccount:true},{invalidChain:true}]){const page=await fixture(settings);await choose(page);await expect(page.locator('.toast')).toContainText(/valid|invalid/);await expect(page.getByRole('heading',{name:'A wallet makes it yours.'})).toBeVisible();await expect(page.getByRole('button',{name:'Browser wallet',exact:true})).toBeEnabled();}
 });
 await check('EIP-6963 deduplicates injected providers and rejects invalid descriptions',async()=>{
  const page=await fixture({eip6963:true});await page.getByRole('button',{name:'Connect wallet',exact:true}).first().click();assert.equal(await page.locator('.wallet-options button').count(),1);await page.getByRole('button',{name:'Audit wallet',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
 });
 await check('missing chain is added and explicitly switched before trading',async()=>{
  const page=await fixture({wrongChain:true,addChain:true});await choose(page);await page.getByRole('button',{name:'Switch to DogeOS',exact:true}).click();await expect(page.locator('.wrong-network')).toHaveCount(0);
  const calls=await page.evaluate(()=>window.__audit.calls.filter(x=>x.startsWith('wallet_')));assert.deepEqual(calls,['wallet_switchEthereumChain','wallet_addEthereumChain','wallet_switchEthereumChain']);
 });
 for(const race of ['swap','wrongNetwork','disconnect'])await check(race+' immediately before signing aborts without reaching eth_sendTransaction',async()=>{
  const page=await fixture();await connected(page);await page.evaluate(()=>window.__audit.blockChainAt=window.__audit.chainCalls+4);await cancelListing(page);await page.waitForFunction(()=>window.__audit.blocked,{timeout:30000});
  await page.evaluate(race=>{window.__audit[race]();window.__audit.release();},race);await expect(page.locator('.toast')).toContainText(/changed|Switch to/);assert.equal(await page.evaluate(()=>window.__audit.sends),0);await expect(page.locator('.transaction-status')).toHaveCount(0);
 });
 await check('duplicate account and chain events preserve a valid transaction and denial resets state',async()=>{
  const page=await fixture();await connected(page);await page.evaluate(()=>window.__audit.blockChainAt=window.__audit.chainCalls+4);await cancelListing(page);await page.waitForFunction(()=>window.__audit.blocked,{timeout:30000});await page.evaluate(()=>{window.__audit.duplicate();window.__audit.release();});
  await expect(page.locator('.toast')).toContainText('You declined');assert.equal(await page.evaluate(()=>window.__audit.sends),1);await expect(page.locator('.transaction-status')).toHaveCount(0);await expect(page.getByRole('button',{name:'Cancel listing',exact:true})).toBeEnabled();
 });
 await check('account changes clear old NFT cards and earnings before new account reads resolve',async()=>{
  const page=await fixture();await connected(page);await expect(page.locator('.account-bar')).not.toContainText('Reading…');await page.route('**/api/catalog?**',async route=>{if(new URL(route.request().url()).searchParams.get('owner')?.toLowerCase()==='0x1111111111111111111111111111111111111111'){await new Promise(resolve=>setTimeout(resolve,700));}await route.continue();});
  await page.evaluate(()=>window.__audit.swap());await expect(page.locator('.art-card')).toHaveCount(0);await expect(page.getByRole('heading',{name:'Your wall is waiting.'})).toBeVisible();assert.ok((await page.locator('.account-bar').innerText()).includes('0 DOGE'));
 });
 await check('clipboard denial is handled and dialog padding preserves the form',async()=>{
  const page=await fixture({clipboardDenied:true});await connected(page);await page.locator('.wallet-button').click();const dialog=page.getByRole('dialog',{name:'Your wallet'});await expect(dialog).toBeVisible();await page.getByRole('button',{name:'Copy address',exact:true}).click();await expect(page.locator('.toast')).toContainText('Clipboard denied by test');
  const rect=await dialog.boundingBox();await page.mouse.click(rect.x+3,rect.y+rect.height/2);await expect(dialog).toBeVisible();await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);assert.equal(await page.evaluate(()=>document.body.style.overflow),'');
 });
 assert.deepEqual(report.errors,[]);report.passed=true;
}catch(error){report.passed=false;report.failure=error.stack;throw error;}
finally{report.finishedAt=new Date().toISOString();await writeFile('output/wallet-races.json',JSON.stringify(report,null,2));await browser.close();}
