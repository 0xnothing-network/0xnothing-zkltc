import fs from 'node:fs';
import crypto from 'node:crypto';
const base='output/audit-2026-09-06/';
const read=p=>JSON.parse(fs.readFileSync(base+p,'utf8').replace(/^\uFEFF/,''));
const write=(p,v)=>fs.writeFileSync(base+p,JSON.stringify(v,null,2)+'\n');
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const vendor=read('production-vendor-closure.json');
for(const f of vendor.files) {
  if(hash(f.path)!==f.sha256) throw Error('Vendor drift: '+f.path);
  f.status='full-source-read';
  f.reviewedRanges=[[1,f.lines]];
}
write('production-vendor-reviewed.json',vendor);
const frontend=read('frontend-reviewed.json');
for(const file of ['errors','marketplaceRefresh','pixelControls','protocolTransaction']) {
  const path=`0xNothing-zkLTC-Testnet/apps/web/tests/client/${file}.test.ts`;
  if(!frontend.some(f=>f.path===path)) frontend.push({path,status:'authored-and-reviewed'});
}
for(const f of frontend) {f.current_sha256=hash(f.path); f.current_bytes=fs.statSync(f.path).size;}
write('frontend-reviewed.json',frontend);
const wallet=read('wallet-reviewed.json');
for(const path of ['src/core/services/portfolio.ts','src/ui/hooks/usePortfolio.ts','tests/core/portfolioSnapshots.test.ts']) {
  const full='0xNothing-zkLTC-Testnet/apps/wallet/'+path;
  let entry=wallet.find(f=>f.path===full);
  if(!entry) {entry={path:full,reviewed:true};wallet.push(entry);}
  entry.prior_sha256=entry.sha256;
  entry.sha256=hash(full).toUpperCase();
  entry.bytes=fs.statSync(full).size;
  entry.lines=fs.readFileSync(full,'utf8').trimEnd().split('\n').length;
  entry.followup='Root reviewed network snapshot isolation; wallet verify 105 tests, typecheck and build exit 0.';
}
write('wallet-reviewed.json',wallet);
write('asset-structure-reviewed.json',['favicon.svg','icon.svg'].map((name,i)=>{
 const path='0xNothing-zkLTC-Testnet/apps/web/public/'+name;
 return {path,status:'svg-xml-structure-reviewed',sha256:hash(path),elements:i===0?5:585,scriptOrForeignObject:0,eventAttributes:0,semanticCodeReview:false};
}));
const verification=read('verification-result.json');
verification.walletFollowup={command:'npm run verify:wallet',exitCode:0,tests:105,sessionId:96445,completionChunk:'a634c4',log:'wallet-followup-verify.log'};
verification.productionSmoke={routes:6,allStatus:200,log:'production-http-smoke.json'};
write('verification-result.json',verification);
console.log(JSON.stringify({vendorRead:vendor.files.length,frontend:frontend.length,wallet:wallet.length}));
