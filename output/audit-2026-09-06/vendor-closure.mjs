import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const root = '0xNothing-zkLTC-Testnet/0xFi/contracts';
const sourceFiles = fs.readdirSync(root + '/src', {recursive:true}).filter(f=>f.endsWith('.sol')).map(f=>root+'/src/'+f.replaceAll('\\','/'));
const visited = new Set();
function visit(file) {
  if(visited.has(file)) return;
  visited.add(file);
  const text=fs.readFileSync(file,'utf8');
  for(const match of text.matchAll(/\bimport\s+(?:[^;]*?\sfrom\s*)?["']([^"']+)["']\s*;/g)) {
    const spec=match[1];
    const target=spec.startsWith('@openzeppelin/contracts/') ? root+'/lib/openzeppelin-contracts/contracts/'+spec.slice('@openzeppelin/contracts/'.length) : path.posix.normalize(path.posix.join(path.posix.dirname(file),spec));
    visit(target);
  }
}
sourceFiles.forEach(visit);
const files=[...visited].filter(f=>f.includes('/lib/')).sort().map(file=>{const data=fs.readFileSync(file);return {path:file,bytes:data.length,lines:data.toString('utf8').split('\n').length,sha256:crypto.createHash('sha256').update(data).digest('hex'),status:'pending-semantic-read'};});
fs.writeFileSync('output/audit-2026-09-06/production-vendor-closure.json',JSON.stringify({roots:sourceFiles,files},null,2)+'\n');
console.log(JSON.stringify({firstPartyRoots:sourceFiles.length,vendorFiles:files.length,bytes:files.reduce((n,f)=>n+f.bytes,0),files:files.map(f=>({path:f.path,lines:f.lines}))},null,2));
