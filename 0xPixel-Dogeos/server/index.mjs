import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dep,catalog,offerList,collectionPage,token,status } from './catalog.mjs';
import { publicClient } from '../scripts/runtime.mjs';
import { rpcRequests, tokenId } from './validation.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),app=express(),base='/DOGEOSxPIXEL';
app.disable('x-powered-by'); app.use(express.json({limit:'64kb'}));
app.use((req,res,next)=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');next();});
const endpoint=(fn)=>async(req,res,next)=>{try {res.set('Cache-Control','no-store');res.json(await fn(req));}catch(e){next(e);}};
app.get(base+'/api/config',endpoint(()=>({deployment:dep,chainId:6281971,explorer:'https://dogeos-testnet.l2scan.co',rpc:base+'/api/rpc'})));
app.get(base+'/api/catalog',endpoint(req=>catalog(req.query)));
app.get(base+'/api/token/:id',endpoint(req=>token(tokenId(req.params.id))));
app.get(base+'/api/offers',endpoint(req=>offerList(req.query)));
app.get(base+'/api/collections',endpoint(req=>collectionPage(req.query)));
app.get(base+'/api/status',endpoint(()=>status()));
app.post(base+'/api/rpc',async(req,res,next)=>{
  let requests;try{requests=rpcRequests(req.body);}catch(error){return next(error);}
  const replies=new Array(requests.length);let cursor=0;
  await Promise.all(Array.from({length:Math.min(6,requests.length)},async()=>{while(cursor<requests.length){const index=cursor++,r=requests[index];try{const params=['eth_call','eth_estimateGas'].includes(r.method)?[{...r.params[0],gas:r.params[0].gas??'0x989680'},...r.params.slice(1)]:r.params;replies[index]={jsonrpc:'2.0',id:r.id,result:await publicClient.request({method:r.method,params})};}catch(e){replies[index]={jsonrpc:'2.0',id:r.id,error:{code:-32000,message:'RPC request failed'}};}}}));
  res.set('Cache-Control','no-store').json(Array.isArray(req.body)?replies:replies[0]);
});
if(process.argv.includes('--dev')) {
  const {createServer}=await import('vite'); const vite=await createServer({root,server:{middlewareMode:true,hmr:false},appType:'spa'});app.use(vite.middlewares);
} else { app.use(base,express.static(path.join(root,'dist'),{maxAge:'1h',index:false,dotfiles:'deny'})); app.get([base,base+'/{*rest}'],(req,res)=>res.sendFile(path.join(root,'dist/index.html'))); }
app.use((error,req,res,next)=>{const status=error.status>=400&&error.status<500?error.status:503;if(status===503)console.error('Chain data request failed.');res.status(status).json({error:status===503?'Chain data is temporarily unavailable. Retry shortly.':status===404?'Pixel not found.':'Invalid request parameters or body.'});});
const port=Number(process.env.PORT||3300);app.listen(port,'127.0.0.1',()=>console.log(`DOGEOSxPIXEL: http://localhost:${port}${base}`));

