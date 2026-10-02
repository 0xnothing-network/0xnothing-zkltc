import { readFile, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dep, catalog, offerList, collectionPage, token, status, ensureDogeosChain } from './catalog.mjs';
import { publicClient } from '../scripts/runtime.mjs';
import { rpcRequests, tokenId } from './validation.mjs';

const base='/DOGEOSxPIXEL',dist=fileURLToPath(new URL('../dist/',import.meta.url)),maxBody=64*1024;
const security={'X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin'};
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.ico':'image/x-icon','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.json':'application/json; charset=utf-8','.woff':'font/woff','.woff2':'font/woff2','.txt':'text/plain; charset=utf-8'};
const error=(status,message)=>Object.assign(new Error(message),{status});
function json(value,status=200,head=false){const body=JSON.stringify(value);return new Response(head?null:body,{status,headers:{...security,'Content-Type':'application/json; charset=utf-8','Content-Length':String(Buffer.byteLength(body)),'Cache-Control':'no-store'}});}
function query(url){const result=Object.create(null);for(const [name,value]of url.searchParams){if(Object.hasOwn(result,name))throw error(400,'Invalid query parameters.');result[name]=value;}return result;}

async function bodyJson(request) {
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||''))throw error(415,'JSON body required.');
  const length=request.headers.get('content-length');if(length&&(!/^\d+$/.test(length)||Number(length)>maxBody))throw error(413,'Request body is too large.');
  if(!request.body)throw error(400,'Invalid JSON body.');
  const reader=request.body.getReader(),parts=[];let size=0;
  try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxBody){await reader.cancel();throw error(413,'Request body is too large.');}parts.push(value);}}
  catch(cause){if(cause.status)throw cause;throw error(400,'Invalid request body.');}
  finally{reader.releaseLock();}
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts)));}catch{throw error(400,'Invalid JSON body.');}
}

async function rpc(request) {
  const body=await bodyJson(request),requests=rpcRequests(body);await ensureDogeosChain();
  let cursor=0;const replies=new Array(requests.length);
  await Promise.all(Array.from({length:Math.min(6,requests.length)},async()=>{while(cursor<requests.length){const index=cursor++,item=requests[index];try{const params=['eth_call','eth_estimateGas'].includes(item.method)?[{...item.params[0],gas:item.params[0].gas??'0x989680'},...item.params.slice(1)]:item.params;replies[index]={jsonrpc:'2.0',id:item.id,result:await publicClient.request({method:item.method,params})};}catch{replies[index]={jsonrpc:'2.0',id:item.id,error:{code:-32000,message:'RPC request failed'}};}}}));
  return json(Array.isArray(body)?replies:replies[0]);
}

const inside=(root,target)=>{const relative=path.relative(root,target);return relative===''||!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);};
async function staticResponse(relative,head) {
  const target=path.resolve(dist,relative||'index.html');if(!inside(dist,target))throw error(404,'Not found.');
  let file=target;
  try{if(!(await stat(file)).isFile())throw error(404,'Not found.');}
  catch(cause){if(cause.code!=='ENOENT'&&cause.code!=='ENOTDIR')throw cause;if(path.extname(relative)||relative==='assets'||relative.startsWith('assets/'))throw error(404,'Not found.');file=path.join(dist,'index.html');}
  const [root,actual]=await Promise.all([realpath(dist),realpath(file)]);if(!inside(root,actual))throw error(404,'Not found.');
  const info=await stat(actual),headers={...security,'Content-Type':mime[path.extname(actual).toLowerCase()]||'application/octet-stream','Content-Length':String(info.size),'Cache-Control':path.extname(actual)==='.html'?'no-cache':'public, max-age=3600'};
  return new Response(head?null:await readFile(actual),{status:200,headers});
}

export async function handleEmbedded(request) {
  const head=request.method==='HEAD';
  try {
    const url=new URL(request.url);if(url.pathname!==base&&!url.pathname.startsWith(base+'/'))return json({error:'Not found.'},404,head);
    let relative;try{relative=decodeURIComponent(url.pathname.slice(base.length)).replace(/^\//,'');}catch{throw error(400,'Invalid path.');}
    if(relative.includes('\\')||relative.includes('\0')||relative.split('/').some(part=>part==='.'||part==='..')||/%(?:2e|2f|5c|00)/i.test(relative))throw error(400,'Invalid path.');
    if(relative==='api'||relative.startsWith('api/')) {
      if(relative==='api/rpc'){if(request.method!=='POST')return json({error:'Method not allowed.'},405,head);return await rpc(request);}
      if(request.method!=='GET'&&!head)return json({error:'Method not allowed.'},405,head);
      if(relative==='api/config')return json({deployment:dep,chainId:6281971,explorer:'https://dogeos-testnet.l2scan.co',rpc:base+'/api/rpc'},200,head);
      const params=query(url);
      if(relative==='api/catalog')return json(await catalog(params),200,head);
      if(relative==='api/offers')return json(await offerList(params),200,head);
      if(relative==='api/collections')return json(await collectionPage(params),200,head);
      if(relative==='api/status')return json(await status(),200,head);
      if(/^api\/token\/[^/]+$/.test(relative))return json(await token(tokenId(relative.slice('api/token/'.length))),200,head);
      return json({error:'Not found.'},404,head);
    }
    if(request.method!=='GET'&&!head)return json({error:'Method not allowed.'},405,head);
    if(relative.split('/').some(part=>part.startsWith('.')))return json({error:'Not found.'},404,head);
    return await staticResponse(relative,head);
  } catch(cause) {
    const status=cause.status>=400&&cause.status<500?cause.status:503;
    return json({error:status===503?'Chain data is temporarily unavailable. Retry shortly.':status===404?'Not found.':status===413?'Request body is too large.':status===415?'JSON body required.':'Invalid request parameters or body.'},status,head);
  }
}
