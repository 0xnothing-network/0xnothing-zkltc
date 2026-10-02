import {chromium,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import deployment from '../src/generated/deployment.json' with {type:'json'};

// All providers and API responses are synthetic. This suite deliberately has
// no eth_sendTransaction/signing implementation and reads no wallet secrets.
const base=process.env.WALLET_TEST_BASE||'http://localhost:3300/DOGEOSxPIXEL';
const filter=process.argv[2]||'',target='0x'+deployment.chainId.toString(16);
const first=deployment.deployer,second='0x1111111111111111111111111111111111111111';
const browser=await chromium.launch({headless:true}),contexts=[];
const report={checks:[],errors:[],signedTransactions:0,startedAt:new Date().toISOString()};

async function fixture(settings={}) {
 const context=await browser.newContext({viewport:{width:1440,height:1000}});contexts.push(context);
 await context.addInitScript(({first,second,target,settings})=>{
  const providers=[],calls=[];
  const uuid=index=>'00000000-0000-4000-8000-'+String(index).padStart(12,'0');
  const create=(name,address=first)=>{
   const handlers=new Map(),state={name,address,chain:'0x1',switches:0};
   const emit=(event,data)=>handlers.get(event)?.forEach(fn=>fn(data));
   const provider={on(event,fn){if(!handlers.has(event))handlers.set(event,new Set());handlers.get(event).add(fn);},removeListener(event,fn){handlers.get(event)?.delete(fn);},async request({method,params}){
    calls.push({provider:name,method});
    if(method==='eth_requestAccounts') {
     if(settings.neverResolveConnect&&name==='A'){audit.blocked='connect';return new Promise(()=>{});}
     return [state.address];
    }
    if(method==='eth_accounts')return [state.address];
    if(method==='eth_chainId')return state.chain;
    if(method==='wallet_switchEthereumChain') {
     state.switches++;
     if(name==='A'&&settings.block==='switch'&&state.switches===1){audit.blocked='switch';await new Promise(resolve=>audit.release=resolve);const error=new Error('Unknown chain');error.code=4902;throw error;}
     if(name==='A'&&settings.block==='add'&&state.switches===1){const error=new Error('Unknown chain');error.code=4902;throw error;}
     state.chain=params[0].chainId;emit('chainChanged',state.chain);return null;
    }
    if(method==='wallet_addEthereumChain') {
     if(name==='A'&&settings.block==='add'){audit.blocked='add';await new Promise(resolve=>audit.release=resolve);}
     return null;
    }
    throw new Error('Signing is prohibited in provider regression: '+method);
   }};
   const item={provider,state,emit};providers.push(item);return item;
  };
  const a=create('A'),b=create('B',second);
  const audit=window.__providerAudit={calls,blocked:null,release:null,
   disconnectA(){a.emit('disconnect',{});},swapA(){a.state.address=second;a.emit('accountsChanged',[second]);},
   chain(){return a.state.chain;},walletCalls(){return calls.filter(c=>c.method.startsWith('wallet_'));}};
  window.ethereum=a.provider;
  const announce=(provider,id,name)=>window.dispatchEvent(new CustomEvent('eip6963:announceProvider',{detail:{info:{uuid:id,name},provider}}));
  window.addEventListener('eip6963:requestProvider',()=>{
   if(settings.discovery==='cap')for(let i=0;i<20;i++)announce(create('Discovered '+i).provider,uuid(i+10),'Discovered '+i);
   else if(settings.discovery==='invalid'){
    announce(b.provider,'','Empty UUID');
    announce(b.provider,'x'.repeat(100000),'Oversized UUID');
    announce(b.provider,uuid(10),'');
    announce(b.provider,uuid(11),'   ');
    announce(b.provider,uuid(12),'x'.repeat(101));
    announce({request:null},uuid(13),'Invalid provider');
   } else if(settings.discovery==='identity') {
    announce(a.provider,uuid(10),'Same provider');announce(a.provider,uuid(11),'Duplicate provider');
   } else if(settings.discovery==='uuid') {
    announce(a.provider,uuid(10),'First announcement');announce(b.provider,uuid(10),'Conflicting announcement');
   } else announce(b.provider,uuid(2),'Alternate wallet');
  });
 },{first,second,target,settings});
 const page=await context.newPage();page.on('pageerror',error=>report.errors.push(error.message));
 await page.route('**/DOGEOSxPIXEL/api/**',async route=>{
  const request=route.request(),path=new URL(request.url()).pathname;
  if(path.endsWith('/rpc')){
   const payload=request.postDataJSON();
   const answer=item=>({jsonrpc:'2.0',id:item.id,result:item.method==='eth_getBalance'?'0x56bc75e2d63100000':item.method==='eth_chainId'?target:item.method==='eth_blockNumber'?'0x1':'0x'+'00'.repeat(32)});
   await route.fulfill({json:Array.isArray(payload)?payload.map(answer):answer(payload)});
  }else if(path.endsWith('/catalog'))await route.fulfill({json:{tokens:[],total:0,next:null,collections:[],activity:[],supply:0,indexedBlock:1,source:'fixture'}});
  else if(path.endsWith('/offers'))await route.fulfill({json:{offers:[],total:0,next:null}});
  else await route.fulfill({json:[]});
 });
 await page.goto(base+'/wallet');return page;
}

async function choose(page,name='Browser wallet') {
 await page.getByRole('button',{name:'Connect wallet',exact:true}).first().click();
 await page.getByRole('button',{name,exact:true}).click();
 await expect(page.getByRole('dialog')).toHaveCount(0);
}
async function startSwitch(page,stage) {
 await choose(page);await page.getByRole('button',{name:'Switch to DogeOS',exact:true}).click();
 await page.waitForFunction(stage=>window.__providerAudit.blocked===stage,stage);
}
async function release(page) {await page.evaluate(()=>window.__providerAudit.release());}
async function walletCalls(page) {return page.evaluate(()=>window.__providerAudit.walletCalls());}
async function staleFailure(page) {await expect(page.locator('.toast')).toContainText(/changed|disconnected|Connect/);}
async function check(name,fn) {
 if(filter&&!name.includes(filter))return;
 const start=performance.now(),initialContexts=contexts.length;
 try{await fn();report.checks.push({name,passed:true,durationMs:Math.round(performance.now()-start)});console.log('PASS '+name);}
 catch(error){report.checks.push({name,passed:false,error:error.message});throw error;}
 finally{for(const context of contexts.slice(initialContexts))await context.close();}
}

try {
 await check('discovery has a shared 20-provider cap including injected fallback',async()=>{
  const page=await fixture({discovery:'cap'});await page.getByRole('button',{name:'Connect wallet',exact:true}).first().click();
  assert.equal(await page.locator('.wallet-options button').count(),20);
 });
 await check('blank/oversized provider identities and names are rejected',async()=>{
  const page=await fixture({discovery:'invalid'});await page.getByRole('button',{name:'Connect wallet',exact:true}).first().click();
  assert.deepEqual(await page.locator('.wallet-options button').allTextContents(),['Browser wallet']);
 });
 await check('different UUIDs for the same provider do not create duplicate choices',async()=>{
  const page=await fixture({discovery:'identity'});await page.getByRole('button',{name:'Connect wallet',exact:true}).first().click();
  assert.equal(await page.locator('.wallet-options button').count(),1);
 });
 await check('the first valid provider retains a duplicated UUID',async()=>{
  const page=await fixture({discovery:'uuid'});await page.getByRole('button',{name:'Connect wallet',exact:true}).first().click();
  assert.deepEqual(await page.locator('.wallet-options button').allTextContents(),['First announcement']);
 });
 await check('network switch accepts its own genuine chainChanged notification',async()=>{
  const page=await fixture();await choose(page);await page.getByRole('button',{name:'Switch to DogeOS',exact:true}).click();
  await expect(page.locator('.wrong-network')).toHaveCount(0);
  assert.deepEqual((await walletCalls(page)).map(c=>c.method),['wallet_switchEthereumChain']);
 });
 await check('disconnect cancels the add-chain continuation of a pending switch',async()=>{
  const page=await fixture({block:'switch'});await startSwitch(page,'switch');await page.evaluate(()=>window.__providerAudit.disconnectA());await release(page);await staleFailure(page);
  assert.deepEqual((await walletCalls(page)).map(c=>c.method),['wallet_switchEthereumChain']);
  await expect(page.getByRole('heading',{name:'A wallet makes it yours.'})).toBeVisible();
 });
 await check('account changes cancel interactive continuations from the previous account',async()=>{
  const page=await fixture({block:'switch'});await startSwitch(page,'switch');await page.evaluate(()=>window.__providerAudit.swapA());await release(page);await staleFailure(page);
  assert.deepEqual((await walletCalls(page)).map(c=>c.method),['wallet_switchEthereumChain']);
  await expect(page.locator('.wallet-button')).toContainText('0x1111');
 });
 await check('reconnecting the same provider cannot revive its previous switch operation',async()=>{
  const page=await fixture({block:'switch'});await startSwitch(page,'switch');await page.evaluate(()=>window.__providerAudit.disconnectA());await choose(page);await release(page);await staleFailure(page);
  assert.deepEqual((await walletCalls(page)).map(c=>c.method),['wallet_switchEthereumChain']);
  await expect(page.locator('.wrong-network')).toBeVisible();
 });
 await check('replacing the provider cannot revive the previous switch operation',async()=>{
  const page=await fixture({block:'switch'});await startSwitch(page,'switch');await page.evaluate(()=>window.__providerAudit.disconnectA());await choose(page,'Alternate wallet');await release(page);await staleFailure(page);
  assert.deepEqual(await walletCalls(page),[{provider:'A',method:'wallet_switchEthereumChain'}]);
  await expect(page.locator('.wallet-button')).toContainText('0x1111');await expect(page.locator('.wrong-network')).toBeVisible();
 });
 await check('disconnect during chain addition prevents the subsequent switch request',async()=>{
  const page=await fixture({block:'add'});await startSwitch(page,'add');await page.evaluate(()=>window.__providerAudit.disconnectA());await release(page);await staleFailure(page);
  assert.deepEqual((await walletCalls(page)).map(c=>c.method),['wallet_switchEthereumChain','wallet_addEthereumChain']);
 });
 await check('disconnect unlocks other wallets even if its initial account request never settles',async()=>{
  const page=await fixture({neverResolveConnect:true});await page.getByRole('button',{name:'Connect wallet',exact:true}).first().click();await page.getByRole('button',{name:'Browser wallet',exact:true}).click();
  await page.waitForFunction(()=>window.__providerAudit.blocked==='connect');await page.evaluate(()=>window.__providerAudit.disconnectA());
  await expect(page.getByRole('button',{name:'Alternate wallet',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'Alternate wallet',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.locator('.wallet-button')).toContainText('0x1111');
 });
 assert.deepEqual(report.errors,[]);report.passed=true;
}catch(error){report.passed=false;report.failure=error.stack;process.exitCode=1;}
finally{
 report.finishedAt=new Date().toISOString();
 try{
  if(!filter)await writeFile(new URL('../output/provider-discovery.json',import.meta.url),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
 }finally{await browser.close();}
}
