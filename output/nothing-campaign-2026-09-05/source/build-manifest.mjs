import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = path.dirname(fileURLToPath(import.meta.url));
const campaign = path.dirname(source);
const repo = path.resolve(source, '../../..');
const require = createRequire(path.join(repo, '0xNothing-zkLTC-Testnet/apps/web/package.json'));
const sharp = require('sharp');
const files = [];
for (const directory of ['images','video','previews']) {
  for (const name of await readdir(path.join(campaign,directory))) {
    const relative = `${directory}/${name}`;
    const file = path.join(campaign,relative);
    const bytes = await readFile(file);
    const entry = {file:relative,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
    if(name.endsWith('.png')) {
      const info=await sharp(bytes).metadata();
      Object.assign(entry,{format:info.format,width:info.width,height:info.height});
    }
    if(name.endsWith('.mp4')) {
      const info=JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','stream=codec_name,width,height,r_frame_rate,sample_rate,channels','-show_entries','format=duration','-of','json',file],{encoding:'utf8',windowsHide:true}));
      Object.assign(entry,{format:'mp4',durationSeconds:Number(info.format.duration),streams:info.streams});
      const video=info.streams.find(s=>s.codec_name==='h264');
      if(!video||video.r_frame_rate!=='30/1'||Number(info.format.duration)!==10) throw new Error(`Unexpected video metadata: ${relative}`);
    }
    files.push(entry);
  }
}
const html=await readFile(path.join(campaign,'index.html'),'utf8');
for(const match of html.matchAll(/(?:src|href|poster)="([^"]+)"/g)) {
  if(match[1].includes('://')) continue;
  await readFile(path.join(campaign,match[1]));
}
const manifest={brand:'0xNothing',slogan:'nothing to everything',campaign:'0xWallet — browser extension and Android app preview',created:'2026-09-05',videoContents:'Logo, brand name and nothing to everything slogan; no products',imageMethod:'Built-in image generation with canonical logo and public demo UI references',videoMethod:'Deterministic vector animation, original synthesized sound, FFmpeg H.264/AAC',files};
await writeFile(path.join(campaign,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({mediaFiles:files.length,links:'all local gallery links resolve',files:files.map(({file,bytes,width,height,durationSeconds})=>({file,bytes,width,height,durationSeconds}))},null,2));
