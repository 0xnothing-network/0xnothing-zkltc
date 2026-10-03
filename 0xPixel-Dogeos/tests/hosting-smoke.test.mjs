import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const listen=server=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve(server.address().port));});
const close=server=>new Promise(resolve=>server.close(resolve));
const occupied=port=>new Promise(resolve=>{const socket=createConnection({host:'127.0.0.1',port});socket.setTimeout(1000);socket.once('connect',()=>{socket.destroy();resolve(true);});socket.once('error',()=>resolve(false));socket.once('timeout',()=>{socket.destroy();resolve(false);});});
function child(script,env){const process=spawn(globalThis.process.execPath,[script],{cwd:root,env:{...globalThis.process.env,...env},stdio:['ignore','pipe','pipe'],windowsHide:true});let output='';process.stdout.on('data',chunk=>{output+=chunk;});process.stderr.on('data',chunk=>{output+=chunk;});return {process,output:()=>output};}
function exited(process){return new Promise((resolve,reject)=>{process.once('error',reject);process.once('exit',code=>resolve(code));});}

test('production startup refuses an occupied assigned PORT instead of using workspace 3301',async t=>{
  let blocker=null;
  if(!await occupied(3300)){blocker=createServer((req,res)=>res.end('test'));await new Promise((resolve,reject)=>{blocker.once('error',reject);blocker.listen(3300,'127.0.0.1',resolve);});t.after(()=>close(blocker));}
  const app=child('scripts/serve.mjs',{NODE_ENV:'production',PORT:'3300',HOST:'127.0.0.1'});
  t.after(()=>app.process.kill());assert.equal(await exited(app.process),1);assert.match(app.output(),/Production must use its assigned port/);assert.doesNotMatch(app.output(),/Serving through|listening on/);
});

test('public HOST and assigned PORT serve the read-only API using a mock RPC and no signer',async t=>{
  const rpcMethods=[];
  const rpc=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;const request=JSON.parse(body);rpcMethods.push(request.method);res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:request.id,result:'0x'+(6281971).toString(16)}));});
  const rpcPort=await listen(rpc);t.after(()=>close(rpc));const reservation=createServer();const port=await listen(reservation);await close(reservation);
  const app=child('server/index.mjs',{NODE_ENV:'production',PORT:String(port),HOST:'0.0.0.0',DOGEOS_RPC_URL:`http://127.0.0.1:${rpcPort}`,PRIVATE_KEY:'',SUBGRAPH_URL:''});
  const stopped=exited(app.process);t.after(async()=>{app.process.kill();await stopped;});
  let result;
  const deadline=Date.now()+20000;
  while(Date.now()<deadline){try{const response=await fetch(`http://127.0.0.1:${port}/DOGEOSxPIXEL/api/config`,{signal:AbortSignal.timeout(1000)});if(response.ok){result=await response.json();break;}}catch{}if(app.process.exitCode!==null)break;await new Promise(resolve=>setTimeout(resolve,50));}
  assert.ok(result,`Public listener did not serve its assigned port. ${app.output()}`);assert.equal(result.chainId,6281971);assert.match(app.output(),/listening on 0\.0\.0\.0/);assert.deepEqual(rpcMethods,[]);
});
