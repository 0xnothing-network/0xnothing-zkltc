import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const campaign = path.dirname(here);
const repo = path.resolve(here, '../../..');
const require = createRequire(path.join(repo, '0xNothing-zkLTC-Testnet/apps/web/package.json'));
const sharp = require('sharp');
sharp.concurrency(2);

const DURATION = 10;
const FPS = 30;
// Geometry follows the canonical white N and red point in public/0xNothing.jpg.
// This is a motion master, not a replacement for the application's brand asset.
const N = 'M145 135 L232.5 230.5 L232.5 135.5 L254 135.5 L254 281.5 L167 186.8 L167 280.5 L145 280.5 Z';
const clamp = (x) => Math.min(1, Math.max(0, x));
const ease = (x) => { const p = clamp(x); return 1 - (1 - p) ** 3; };
const smooth = (x) => { const p = clamp(x); return p * p * (3 - 2 * p); };
const gate = (t, a, b) => smooth((t - a) / (b - a));
const n = (v) => Number(v.toFixed(4));

function frameSvg(width, height, t) {
  const portrait = height > width;
  const cx = width / 2;
  const cy = height * (portrait ? 0.445 : 0.43);
  const size = portrait ? width * 0.515 : height * 0.395;
  const scale = size / 146.5 * (1.025 - 0.025 * ease((t - 0.5) / 4.5));
  const globalFade = gate(t, 0.05, 0.45) * (1 - gate(t, 9.55, 10));
  const markFade = 1 - gate(t, 8.95, 9.55);
  const p1 = ease((t - 0.45) / 1.45);
  const p2 = ease((t - 1.28) / 1.48);
  const p3 = ease((t - 2.05) / 1.45);
  const dotP = clamp((t - 3.35) / 0.6);
  const dotSpring = 1 + 2.70158 * (dotP - 1) ** 3 + 1.70158 * (dotP - 1) ** 2;
  const dotR = Math.max(0, 6.2 * dotSpring) * (1 + 0.025 * Math.sin((t - 4) * Math.PI));
  const outline = 0.38 * gate(t, 0.1, 0.9) * (1 - gate(t, 3, 4.2));
  const lightX = 110 + 190 * clamp((t - 4.1) / 1.6);
  const ringP = clamp((t - 3.4) / 1.25);
  const ringOpacity = 0.30 * Math.sin(Math.PI * ringP);
  const wordFade = gate(t, 4.05, 5.05) * (1 - gate(t, 8.9, 9.45));
  const wordY = cy + size * 0.5 + (portrait ? 115 : 94);
  const wordSize = portrait ? 41 : 36;
  const sloganY = wordY + (portrait ? 106 : 87);
  const sloganSize = portrait ? 53 : 52;
  const sloganFade = 1 - gate(t, 8.9, 9.45);
  const driftY = t > 4 ? -3.5 * Math.sin(clamp((t - 4) / 5) * Math.PI) : 0;
  const transform = `translate(${n(cx - 207.4 * scale)} ${n(cy - 208.25 * scale + driftY)}) scale(${n(scale)})`;
  const cornerLength = portrait ? 17 : 13;
  const cornerInset = portrait ? 72 : 74;
  const registration = [
    [cornerInset, cornerInset, 1, 1], [width-cornerInset, cornerInset, -1, 1],
    [cornerInset, height-cornerInset, 1, -1], [width-cornerInset, height-cornerInset, -1, -1],
  ].map(([x,y,dx,dy]) => `<path d="M${x+dx*cornerLength} ${y}H${x}V${y+dy*cornerLength}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <defs>
      <radialGradient id="bg"><stop stop-color="#101512"/><stop offset="0.6" stop-color="#060907"/><stop offset="1" stop-color="#020303"/></radialGradient>
      <radialGradient id="red"><stop stop-color="#ed293b" stop-opacity="0.24"/><stop offset="1" stop-color="#ed293b" stop-opacity="0"/></radialGradient>
      <linearGradient id="surface" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#ffffff"/><stop offset="0.55" stop-color="#e4eae7"/><stop offset="1" stop-color="#ffffff"/></linearGradient>
      <linearGradient id="sweep"><stop stop-color="white" stop-opacity="0"/><stop offset="0.5" stop-color="white" stop-opacity="0.7"/><stop offset="1" stop-color="white" stop-opacity="0"/></linearGradient>
      <clipPath id="nclip"><path d="${N}"/></clipPath>
      <mask id="reveal" maskUnits="userSpaceOnUse" x="130" y="125" width="135" height="175">
        <path d="M156 295V125" fill="none" stroke="white" stroke-width="34" stroke-dasharray="170" stroke-dashoffset="${n(170*(1-p1))}"/>
        <path d="M137 121L260 291" fill="none" stroke="white" stroke-width="37" stroke-dasharray="211" stroke-dashoffset="${n(211*(1-p2))}"/>
        <path d="M244 291V125" fill="none" stroke="white" stroke-width="34" stroke-dasharray="166" stroke-dashoffset="${n(166*(1-p3))}"/>
      </mask>
      <filter id="soft"><feGaussianBlur stdDeviation="3.5"/></filter>
    </defs>
    <rect width="100%" height="100%" fill="#020303"/>
    <g opacity="${n(globalFade)}">
      <rect width="100%" height="100%" fill="url(#bg)"/>
      <g fill="none" stroke="#819087" stroke-width="0.7" opacity="${n(0.24*gate(t,0.6,2)*(1-gate(t,8.2,9.6)))}">${registration}</g>
      <g transform="${transform}">
        <g opacity="${n(markFade)}">
          <path d="${N}" fill="none" stroke="#8b9b92" stroke-width="0.45" opacity="${n(outline)}"/>
          <path d="${N}" fill="#e8f6ed" filter="url(#soft)" opacity="0.07" mask="url(#reveal)"/>
          <g mask="url(#reveal)">
            <path d="${N}" fill="url(#surface)"/>
            <g clip-path="url(#nclip)"><path d="M${n(lightX)} 112l-35 192h28l35-192Z" fill="url(#sweep)"/></g>
          </g>
        </g>
        <circle cx="269.8" cy="275.8" r="${n(20+20*ringP)}" fill="url(#red)" opacity="${n(ringOpacity)}"/>
        <circle cx="269.8" cy="275.8" r="${n(6.2+16*ringP)}" fill="none" stroke="#f13948" stroke-width="0.45" opacity="${n(ringOpacity)}"/>
        <circle cx="269.8" cy="275.8" r="${n(dotR)}" fill="#ed293b"/>
      </g>
      <text x="${cx}" y="${n(wordY+12*(1-wordFade))}" fill="#eaf0ec" text-anchor="middle" font-family="Arial, sans-serif" font-size="${wordSize}" font-weight="400" letter-spacing="${portrait?5:4.5}" opacity="${n(wordFade)}">0xNothing</text>
      <text x="${cx}" y="${n(sloganY)}" xml:space="preserve" fill="#edf5f0" text-anchor="middle" font-family="Arial, sans-serif" font-size="${sloganSize}" font-weight="400" letter-spacing="1.2" opacity="${n(sloganFade)}"><tspan opacity="${n(gate(t,4.7,5.35))}">nothing</tspan><tspan opacity="${n(gate(t,5.05,5.65))}"> to </tspan><tspan opacity="${n(gate(t,5.4,6.2))}">everything</tspan></text>
    </g>
  </svg>`;
}

async function soundtrack() {
  const sampleRate = 48000;
  const count = sampleRate * DURATION;
  const pcm = Buffer.alloc(count * 4);
  let seed = 79221;
  const noise = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2147483648 - 1; };
  let previousNoise = 0;
  for (let i=0;i<count;i++) {
    const t=i/sampleRate;
    previousNoise = 0.965*previousNoise+0.035*noise();
    let v=0;
    for (const [start, frequency] of [[0.5,680],[1.32,760],[2.1,860]]) {
      const dt=t-start;
      if(dt>=0&&dt<0.4) v+=0.032*Math.sin(2*Math.PI*frequency*dt)*Math.exp(-dt*26)*(1-Math.exp(-dt*500));
    }
    const sweep=clamp((t-1.25)/1.65);
    v+=0.035*previousNoise*Math.sin(Math.PI*sweep)**2;
    const hit=t-3.38;
    if(hit>=0) {
      const attack=1-Math.exp(-hit*120);
      v+=0.095*Math.sin(2*Math.PI*(58*hit+3*(1-Math.exp(-hit*8))))*Math.exp(-hit*5)*attack;
      v+=0.022*(Math.sin(2*Math.PI*440*hit)+0.32*Math.sin(2*Math.PI*880*hit))*Math.exp(-hit*2.3)*attack;
    }
    v*=1-gate(t,8.7,9.8);
    const sample=Math.round(Math.max(-1,Math.min(1,v))*32767);
    pcm.writeInt16LE(sample,i*4);
    pcm.writeInt16LE(sample,i*4+2);
  }
  const header=Buffer.alloc(44);
  header.write('RIFF');header.writeUInt32LE(pcm.length+36,4);header.write('WAVEfmt ',8);
  header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(2,22);
  header.writeUInt32LE(sampleRate,24);header.writeUInt32LE(sampleRate*4,28);
  header.writeUInt16LE(4,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(pcm.length,40);
  const file=path.join(here,'nothing-original-sound.wav');
  await writeFile(file,Buffer.concat([header,pcm]));
  return file;
}

async function encode(name,width,height,audio) {
  const file=path.join(campaign,'video',name);
  const encoder=spawn('ffmpeg',['-hide_banner','-loglevel','warning','-y','-f','image2pipe','-vcodec','png','-framerate',String(FPS),'-i','pipe:0','-i',audio,'-vf','gradfun=1.2:16,noise=alls=2:allf=t+u:all_seed=799','-c:v','libx264','-preset','medium','-crf','15','-pix_fmt','yuv420p','-c:a','aac','-b:a','160k','-t',String(DURATION),'-movflags','+faststart',file],{windowsHide:true,stdio:['pipe','ignore','pipe']});
  let diagnostic='';
  encoder.stderr.on('data',(chunk)=>{diagnostic=(diagnostic+chunk).slice(-6000);});
  const completed=once(encoder,'close');
  for(let index=0;index<DURATION*FPS;index++) {
    const png=await sharp(Buffer.from(frameSvg(width,height,index/FPS))).png({compressionLevel:1}).toBuffer();
    if(!encoder.stdin.write(png)) await once(encoder.stdin,'drain');
    if(index%60===0) console.log(`${name}: frame ${index}/${DURATION*FPS}`);
  }
  encoder.stdin.end();
  const [code]=await completed;
  if(code!==0) throw new Error(`ffmpeg failed (${code}): ${diagnostic}`);
  console.log(`Ready: ${file}`);
}

await mkdir(path.join(campaign,'video'),{recursive:true});
await mkdir(path.join(campaign,'previews'),{recursive:true});
const previewOnly=process.argv.includes('--preview');
await writeFile(path.join(here,'nothing-motion-master.svg'),frameSvg(1920,1080,6.6));
await sharp(Buffer.from(frameSvg(1920,1080,6.6))).png().toFile(path.join(campaign,'previews','nothing-logo-poster.png'));
const tiles=[];
for(const [index,t] of [0.8,1.7,2.6,3.8,6.6,9.25].entries()) {
  tiles.push({input:await sharp(Buffer.from(frameSvg(1920,1080,t))).resize(480,270).png().toBuffer(),left:(index%3)*480,top:Math.floor(index/3)*270});
}
await sharp({create:{width:1440,height:540,channels:3,background:'#020303'}}).composite(tiles).png().toFile(path.join(campaign,'previews','logo-storyboard.png'));
if(!previewOnly) {
  const audio=await soundtrack();
  await encode('nothing-logo-16x9-1080p.mp4',1920,1080,audio);
  await encode('nothing-logo-9x16-1080p.mp4',1080,1920,audio);
}
