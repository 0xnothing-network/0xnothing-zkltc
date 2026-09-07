import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const types={'.html':'text/html; charset=utf-8','.png':'image/png','.mp4':'video/mp4','.md':'text/plain; charset=utf-8','.json':'application/json','.mjs':'text/plain; charset=utf-8','.svg':'image/svg+xml','.wav':'audio/wav'};
http.createServer(async(req,res)=>{
  try {
    if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);res.end();return;}
    const requested=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname);
    const file=path.resolve(root,'.'+(requested==='/'?'/index.html':requested));
    if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
    const info=await stat(file);
    if(!info.isFile()){res.writeHead(404);res.end();return;}
    let start=0,end=info.size-1,status=200;
    const range=req.headers.range;
    if(range){
      const match=/^bytes=(\d+)-(\d*)$/.exec(range);
      if(!match){res.writeHead(416,{'Content-Range':`bytes */${info.size}`});res.end();return;}
      start=Number(match[1]);end=match[2]?Math.min(Number(match[2]),end):end;
      if(start>end||start<0){res.writeHead(416,{'Content-Range':`bytes */${info.size}`});res.end();return;}
      status=206;
    }
    const headers={'Content-Type':types[path.extname(file)]??'application/octet-stream','Content-Length':end-start+1,'Accept-Ranges':'bytes','X-Content-Type-Options':'nosniff'};
    if(status===206)headers['Content-Range']=`bytes ${start}-${end}/${info.size}`;
    res.writeHead(status,headers);
    if(req.method==='HEAD'){res.end();return;}
    const stream=createReadStream(file,{start,end});
    stream.on('error',()=>res.destroy());stream.pipe(res);res.on('close',()=>stream.destroy());
  } catch {if(!res.headersSent)res.writeHead(404);res.end();}
}).listen(4197,'127.0.0.1',()=>console.log('Campaign preview: http://127.0.0.1:4197'));
