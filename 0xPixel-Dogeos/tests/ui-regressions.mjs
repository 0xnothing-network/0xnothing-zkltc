import {chromium,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import deployment from '../src/generated/deployment.json' with {type:'json'};
const base='http://localhost:3300/DOGEOSxPIXEL',browser=await chromium.launch({headless:true});
const report={checks:[],errors:[],startedAt:new Date().toISOString()};
try {
 const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'en-US',colorScheme:'light'}),page=await context.newPage();page.on('pageerror',error=>report.errors.push(error.message));
 for(const width of [1440,375])for(const theme of ['light','dark']){
  await page.setViewportSize({width,height:1000});await page.emulateMedia({colorScheme:theme});
  for(const path of ['','/market','/collections','/studio','/wallet','/activity']){
   await page.goto(base+path,{waitUntil:'networkidle'});assert.equal(await page.evaluate(()=>document.documentElement.dataset.theme),theme);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),theme+' overflow '+width+path);assert.ok(await page.locator('h1').isVisible());report.checks.push(theme+' '+width+' '+(path||'/'));
  }
 }
 await page.goto(base+'/market',{waitUntil:'networkidle'});const artwork=await page.locator('.art-card img').first().getAttribute('src');await page.getByLabel('Switch to light mode',{exact:true}).click();assert.equal(await page.locator('.art-card img').first().getAttribute('src'),artwork);await page.reload({waitUntil:'networkidle'});assert.equal(await page.evaluate(()=>document.documentElement.dataset.theme),'light');report.checks.push('saved theme survives reload without changing SVG artwork');

 const live=await fetch(base+'/api/catalog?limit=48').then(r=>r.json()),sample=live.tokens[0],owner=deployment.deployer;
 const paged=await browser.newContext({viewport:{width:1440,height:1000},locale:'en-US'});
 await paged.addInitScript(({owner,id})=>window.ethereum={request:async({method})=>{if(method==='eth_accounts'||method==='eth_requestAccounts')return[owner];if(method==='eth_chainId')return'0x'+id.toString(16);throw new Error('Pagination tests must not request a transaction.');}},{owner,id:deployment.chainId});
 const ui=await paged.newPage();ui.on('pageerror',error=>report.errors.push(error.message));
 const tokens=Array.from({length:30},(_,n)=>({...sample,id:String(n+1),name:'Paginated pixel '+(n+1),owner}));
 const offers=Array.from({length:50},(_,n)=>({id:String(n+1),tokenId:'1',bidder:owner,amount:String(BigInt(n+1)*10n**18n),expiry:Math.floor(Date.now()/1000)+3600,expired:false}));
 const collections=Array.from({length:25},(_,n)=>({id:String(n+1),name:'Paged collection '+(n+1),description:'Independent preview '+(n+1),owner,count:1,previews:[{id:String(n+1),name:'Member '+(n+1),grid:sample.grid,pixels:sample.pixels}]}));
 await ui.route('**/api/catalog?**',route=>{const query=new URL(route.request().url()).searchParams,offset=Number(query.get('offset')||0),limit=Number(query.get('limit')||24);return route.fulfill({json:{...live,tokens:tokens.slice(offset,offset+limit),total:tokens.length,next:offset+limit<tokens.length?offset+limit:null}});});
 await ui.route('**/api/offers?**',route=>{const query=new URL(route.request().url()).searchParams,offset=Number(query.get('offset')||0),limit=Number(query.get('limit')||48);return route.fulfill({json:{offers:offers.slice(offset,offset+limit),total:offers.length,next:offset+limit<offers.length?offset+limit:null}});});
 await ui.route('**/api/collections?**',route=>{const query=new URL(route.request().url()).searchParams,offset=Number(query.get('offset')||0),limit=Number(query.get('limit')||24);return route.fulfill({json:{collections:collections.slice(offset,offset+limit),total:collections.length,next:offset+limit<collections.length?offset+limit:null,indexedBlock:live.indexedBlock}});});
 await ui.goto(base+'/wallet',{waitUntil:'networkidle'});await ui.getByRole('button',{name:'Connect wallet',exact:true}).first().click();await ui.getByRole('button',{name:'Browser wallet',exact:true}).click();await expect(ui.locator('.art-card')).toHaveCount(24);await ui.getByRole('button',{name:'Load more pixels',exact:true}).click();await expect(ui.locator('.art-card')).toHaveCount(30);assert.equal(new Set(await ui.locator('.art-card h3').allTextContents()).size,30);report.checks.push('NFT pagination appends all 30 unique artworks');
 await expect(ui.locator('.wallet-offers .offer-row')).toHaveCount(48);await ui.getByRole('button',{name:'Load more offers',exact:true}).click();await expect(ui.locator('.wallet-offers .offer-row')).toHaveCount(50);report.checks.push('wallet offer pagination retains every escrowed offer beyond 48');
 await ui.getByRole('link',{name:'Collections',exact:true}).click();await expect(ui.locator('.collection-card')).toHaveCount(24);await ui.getByRole('button',{name:'Load more collections',exact:true}).click();await expect(ui.locator('.collection-card')).toHaveCount(25);assert.equal(await ui.locator('.collection-card img').count(),25);report.checks.push('collection pagination retains independent previews beyond 24');
 await ui.getByRole('link',{name:'My pixels',exact:true}).click();await ui.locator('.art-card').first().click();const detail=ui.getByRole('dialog',{name:'Pixel #1'});await detail.getByRole('button',{name:'Offers (48)',exact:true}).click();await expect(detail.locator('.offer-row')).toHaveCount(48);await detail.getByRole('button',{name:'Load more offers',exact:true}).click();await expect(detail.locator('.offer-row')).toHaveCount(50);report.checks.push('NFT detail pagination exposes all 50 offers without truncation');
 assert.deepEqual(report.errors,[]);report.passed=true;
}catch(error){report.passed=false;report.failure=error.stack;throw error;}
finally{report.finishedAt=new Date().toISOString();await writeFile('output/ui-regressions.json',JSON.stringify(report,null,2));await browser.close();}
console.log('Theme, route and discovery pagination regressions passed.');
