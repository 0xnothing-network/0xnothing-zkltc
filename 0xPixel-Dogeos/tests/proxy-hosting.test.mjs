import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';

const route=new URL('../../0xNothing-zkLTC-Testnet/apps/web/app/DOGEOSxPIXEL/[[...path]]/route.ts',import.meta.url);
const source=await readFile(route,'utf8');
const helper=new URL('../../0xNothing-zkLTC-Testnet/apps/web/lib/server/dogeosEmbedded.ts',import.meta.url).href;
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace("'../../../lib/server/dogeosEmbedded'",JSON.stringify(helper));
const proxy=await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'));

test('workspace proxy typechecks and forwards a configured production backend with bounded bodies',async()=>{
 const program=ts.createProgram([fileURLToPath(route)],{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,lib:['lib.es2022.d.ts','lib.dom.d.ts','lib.dom.iterable.d.ts'],types:['node'],skipLibCheck:true,noEmit:true});
 assert.deepEqual(ts.getPreEmitDiagnostics(program).map(d=>ts.flattenDiagnosticMessageText(d.messageText,'\n')),[]);
 const previous={node:process.env.NODE_ENV,origin:process.env.DOGEOS_PIXEL_ORIGIN,cwd:process.cwd()},errors=[],requests=[],originalError=console.error;
 const fixture=await mkdtemp(path.join(tmpdir(),'dogeos-next-proxy-'));
 const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;requests.push({method:req.method,url:req.url,body});res.setHeader('content-type','application/json');res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');res.setHeader('referrer-policy','strict-origin-when-cross-origin');res.end(JSON.stringify({path:req.url,body}));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const backend='http://127.0.0.1:'+server.address().port;
 try {
  console.error=(...args)=>errors.push(args.join(' '));process.env.NODE_ENV='production';delete process.env.DOGEOS_PIXEL_ORIGIN;
  const request=()=>new Request('https://frontend.test/DOGEOSxPIXEL/api/config');
  process.chdir(fixture);
  const missing=await proxy.GET(request());assert.equal(missing.status,503);assert.ok(!(await missing.text()).includes('npm start'));assert.equal(requests.length,0);
  await mkdir(path.join(fixture,'.dogeos','server'),{recursive:true});
  await writeFile(path.join(fixture,'.dogeos','server','embedded.mjs'),"export async function handleEmbedded(request){return Response.json({embedded:true,path:new URL(request.url).pathname})}");
  const embedded=await proxy.GET(request());assert.equal(embedded.status,200);assert.deepEqual(await embedded.json(),{embedded:true,path:'/DOGEOSxPIXEL/api/config'});assert.equal(requests.length,0);
  for(const origin of ['ftp://backend.test','https://user:secret@backend.test','https://backend.test/DOGEOSxPIXEL','https://backend.test?token=secret','https://frontend.test']){process.env.DOGEOS_PIXEL_ORIGIN=origin;assert.equal((await proxy.GET(request())).status,503);}
  process.env.DOGEOS_PIXEL_ORIGIN=backend;
  const response=await proxy.GET(new Request('https://frontend.test/DOGEOSxPIXEL/api/catalog?search=Golden%20Doge&offset=2'));assert.equal(response.status,200);assert.equal((await response.json()).path,'/DOGEOSxPIXEL/api/catalog?search=Golden%20Doge&offset=2');assert.equal(response.headers.get('referrer-policy'),'strict-origin-when-cross-origin');
  const body=JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]});const post=await proxy.POST(new Request('https://frontend.test/DOGEOSxPIXEL/api/rpc',{method:'POST',headers:{'content-type':'application/json'},body}));assert.equal(post.status,200);assert.equal((await post.json()).body,body);
  const before=requests.length;
  for(const headers of [{},{'content-length':'65537'}]){const oversized=new Request('https://frontend.test/DOGEOSxPIXEL/api/rpc',{method:'POST',headers,body:'x'.repeat(65537)});assert.equal((await proxy.POST(oversized)).status,413);}assert.equal(requests.length,before);
  assert.equal((await proxy.GET(new Request('https://frontend.test/unrelated'))).status,404);assert.equal(requests.length,before);
  const head=await proxy.HEAD(new Request('https://frontend.test/DOGEOSxPIXEL',{method:'HEAD'}));assert.equal(head.status,200);assert.equal(await head.text(),'');assert.equal(requests.at(-1).method,'HEAD');
  await new Promise(resolve=>server.close(resolve));assert.equal((await proxy.GET(request())).status,503);
  assert.ok(errors.every(error=>!error.includes('secret')));
 }finally{console.error=originalError;process.chdir(previous.cwd);for(const [key,value] of [['NODE_ENV',previous.node],['DOGEOS_PIXEL_ORIGIN',previous.origin]]){if(value===undefined)delete process.env[key];else process.env[key]=value;}if(server.listening)await new Promise(resolve=>server.close(resolve));assert.ok(fixture.startsWith(path.resolve(tmpdir())+path.sep)&&path.basename(fixture).startsWith('dogeos-next-proxy-'));await rm(fixture,{recursive:true,force:true});}
});
