export const PALETTE=['#24291e','#f4c542','#fff9e6','#df8051','#a55c38','#92ab79','#466653','#98b9b5','#577c97','#bf929e','#f3b7a2','#ffffff','#161919','#6b63a8','#e65252','#b9c6ce'];
export const GRID_SIZES=Object.freeze([8,16,32,64,128,256]);
const COLOR=/^#[0-9a-f]{6}$/i;
function checkCanvas(cells,grid) {
  if(!GRID_SIZES.includes(grid)||!Array.isArray(cells)||cells.length!==grid*grid) throw new Error('Invalid canvas size');
}
function checkColor(color) {
  if(color!==null&&(typeof color!=='string'||!COLOR.test(color))) throw new Error('Invalid pixel color');
}
export function encodePixels(cells,grid) {
  checkCanvas(cells,grid);
  const bytes=[];
  for(let y=0;y<grid;y++) for(let x=0;x<grid;) {
    const color=cells[y*grid+x]; if(color===null) {x++;continue;}
    checkColor(color);
    const normalized=color.toLowerCase();
    let end=x+1; while(end<grid&&typeof cells[y*grid+end]==='string'&&cells[y*grid+end].toLowerCase()===normalized) end++;
    bytes.push(x,y,end-x-1,...[1,3,5].map(at=>parseInt(color.slice(at,at+2),16))); x=end;
    if(bytes.length>24576) throw new Error('This piece exceeds 4,096 runs. Use fewer colors or a smaller canvas.');
  }
  if(!bytes.length) throw new Error('Paint a few pixels first.');
  return '0x'+bytes.map(n=>n.toString(16).padStart(2,'0')).join('');
}
export function decodePixels(hex,grid) {
  if(!GRID_SIZES.includes(grid)||typeof hex!=='string'||hex.length>49154||!/^0x(?:[0-9a-f]{12})+$/i.test(hex)) throw new Error('Invalid packed artwork');
  const cells=Array(grid*grid).fill(null); let py=-1,pend=0,pc='';
  for(let at=2;at<hex.length;at+=12) {
    const x=parseInt(hex.slice(at,at+2),16),y=parseInt(hex.slice(at+2,at+4),16),count=parseInt(hex.slice(at+4,at+6),16)+1,color='#'+hex.slice(at+6,at+12).toLowerCase();
    if(y>=grid||x+count>grid||y<py||(y===py&&(x<pend||(x===pend&&color===pc)))) throw new Error('Non-canonical artwork');
    for(let i=0;i<count;i++) cells[y*grid+x+i]=color; py=y;pend=x+count;pc=color;
  } return cells;
}
export function pixelSVG(hex,grid) {
  decodePixels(hex,grid);
  let rects=''; for(let at=2;at<hex.length;at+=12) rects+=`<rect x="${parseInt(hex.slice(at,at+2),16)}" y="${parseInt(hex.slice(at+2,at+4),16)}" width="${parseInt(hex.slice(at+4,at+6),16)+1}" height="1" fill="#${hex.slice(at+6,at+12)}"/>`;
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${grid} ${grid}" shape-rendering="crispEdges">${rects}</svg>`)}`;
}
export function floodFill(cells,grid,x,y,color) {
  checkCanvas(cells,grid);checkColor(color);
  if(!Number.isInteger(x)||!Number.isInteger(y)||x<0||y<0||x>=grid||y>=grid) throw new Error('Invalid fill position');
  const result=cells.slice(),target=result[y*grid+x];checkColor(target);
  const equal=(a,b)=>a===b||(typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase());
  if(equal(target,color)) return result;
  const queue=[y*grid+x];result[queue[0]]=color;
  while(queue.length) {const at=queue.pop(),cx=at%grid,cy=Math.floor(at/grid);for(const n of [cx>0?at-1:-1,cx<grid-1?at+1:-1,cy>0?at-grid:-1,cy<grid-1?at+grid:-1]) if(n>=0&&equal(result[n],target)){result[n]=color;queue.push(n);}}
  return result;
}
export function linePoints(x0,y0,x1,y1) {
  if(![x0,y0,x1,y1].every(n=>Number.isInteger(n)&&n>=0&&n<=255)) throw new Error('Invalid stroke position');
  const out=[],dx=Math.abs(x1-x0),sx=x0<x1?1:-1,dy=-Math.abs(y1-y0),sy=y0<y1?1:-1; let error=dx+dy;
  while(true) {out.push([x0,y0]);if(x0===x1&&y0===y1) break;const e2=2*error;if(e2>=dy){error+=dy;x0+=sx;}if(e2<=dx){error+=dx;y0+=sy;}}
  return out;
}
export function template(kind,grid=32) {
  if(!GRID_SIZES.includes(grid)) throw new Error('Invalid canvas size');
  const out=Array(grid*grid).fill(null); const at=(x,y,c)=>{const sx=Math.floor(x*grid/32),sy=Math.floor(y*grid/32),ex=Math.ceil((x+1)*grid/32),ey=Math.ceil((y+1)*grid/32);for(let yy=sy;yy<ey;yy++)for(let xx=sx;xx<ex;xx++)if(xx>=0&&yy>=0&&xx<grid&&yy<grid)out[yy*grid+xx]=c;};
  const rect=(x,y,w,h,c)=>{for(let yy=y;yy<y+h;yy++)for(let xx=x;xx<x+w;xx++)at(xx,yy,c);};
  if(kind==='doge') {
    rect(0,0,32,32,'#98b9b5');rect(5,25,22,7,'#466653');rect(7,6,6,12,'#a55c38');rect(20,6,6,12,'#a55c38');rect(8,8,3,7,'#24291e');rect(22,8,3,7,'#24291e');rect(6,14,21,12,'#df8051');rect(9,12,15,15,'#f4c542');rect(10,16,4,4,'#24291e');rect(21,16,3,4,'#24291e');rect(11,16,1,1,'#fff9e6');rect(22,16,1,1,'#fff9e6');rect(12,21,12,6,'#fff9e6');rect(16,21,5,3,'#24291e');rect(18,24,1,2,'#24291e');rect(20,25,2,2,'#e65252');
  } else if(kind==='rocket') {
    rect(0,0,32,32,'#24291e');for(const [x,y] of [[4,5],[24,7],[5,24],[27,22],[19,3],[10,10]])rect(x,y,1,1,'#fff9e6');rect(14,3,4,3,'#e65252');rect(12,6,8,13,'#fff9e6');rect(14,9,4,4,'#577c97');rect(9,15,3,8,'#e65252');rect(20,15,3,8,'#e65252');rect(13,19,6,4,'#df8051');rect(14,23,4,4,'#f4c542');rect(15,27,2,3,'#fff9e6');
  } else if(kind==='flower') {
    rect(0,0,32,32,'#f3b7a2');rect(15,15,2,14,'#466653');rect(9,21,6,3,'#92ab79');rect(17,24,6,3,'#92ab79');rect(13,5,6,15,'#fff9e6');rect(9,9,14,7,'#fff9e6');rect(13,10,6,6,'#f4c542');rect(15,12,2,2,'#a55c38');
  } else if(kind==='mushroom') {
    rect(0,0,32,32,'#92ab79');rect(4,27,24,2,'#466653');rect(12,15,9,13,'#fff9e6');rect(7,10,19,10,'#e65252');rect(10,7,13,5,'#e65252');rect(13,5,7,3,'#e65252');rect(11,10,4,3,'#fff9e6');rect(21,13,4,3,'#fff9e6');rect(7,17,4,2,'#fff9e6');rect(14,22,2,2,'#24291e');rect(18,22,2,2,'#24291e');
  } else if(kind==='sunset') {
    rect(0,0,32,32,'#bf929e');rect(0,11,32,9,'#f3b7a2');rect(12,8,10,10,'#f4c542');rect(10,11,14,4,'#f4c542');rect(0,20,32,12,'#577c97');rect(0,25,32,2,'#98b9b5');rect(13,22,10,1,'#f4c542');rect(15,27,7,1,'#f3b7a2');rect(3,15,3,17,'#24291e');rect(1,15,12,2,'#24291e');rect(4,13,5,2,'#24291e');rect(7,17,5,2,'#24291e');
  } else if(kind==='ghost') {
    rect(0,0,32,32,'#6b63a8');rect(11,6,10,3,'#fff9e6');rect(8,9,16,16,'#fff9e6');rect(8,25,4,3,'#fff9e6');rect(15,25,3,3,'#fff9e6');rect(21,25,3,3,'#fff9e6');rect(12,13,3,5,'#24291e');rect(19,13,3,5,'#24291e');rect(10,20,4,2,'#f3b7a2');rect(20,20,4,2,'#f3b7a2');
  } else throw new Error('Unknown template');
  return out;
}

export function pixelStats(cells,grid) {
  checkCanvas(cells,grid);
  let painted=0,runs=0;
  for(let y=0;y<grid;y++) {
    let previous=null;
    for(let x=0;x<grid;x++) {
      const color=cells[y*grid+x];checkColor(color);
      const normalized=color===null?null:color.toLowerCase();
      if(normalized!==null){painted++;if(normalized!==previous)runs++;}
      previous=normalized;
    }
  }
  return {painted,runs};
}

function metadata(name='',description='') {
  if(typeof name!=='string'||typeof description!=='string') throw new Error('Artwork title and story must be text.');
  if(name.length>64||description.length>1024) throw new Error('Artwork title or story is too long.');
  return {name,description};
}

// Drafts can be blank or more detailed than the mint format permits. Keep those
// cells instead of silently discarding them; valid v2 artwork remains unchanged.
export function pixelDocument(cells,grid,name='',description='') {
  const fields=metadata(name,description),stats=pixelStats(cells,grid);
  return stats.runs>0&&stats.runs<=4096
    ? {version:2,...fields,grid,pixels:encodePixels(cells,grid)}
    : {version:3,...fields,grid,cells:cells.map(color=>color===null?null:color.toLowerCase())};
}

export function parsePixelDocument(value) {
  if(!value||typeof value!=='object'||Array.isArray(value)||
    (value.version!==undefined&&value.version!==2&&value.version!==3)) throw new Error('Unsupported pixel document.');
  const fields=metadata(value.name,value.description);
  let cells;
  if(Object.hasOwn(value,'cells')) {
    if(value.version!==3||Object.hasOwn(value,'pixels')) throw new Error('Invalid pixel document.');
    pixelStats(value.cells,value.grid);
    cells=value.cells.map(color=>color===null?null:color.toLowerCase());
  } else cells=decodePixels(value.pixels,value.grid);
  return {...fields,grid:value.grid,cells};
}

// Read source dimensions before decoding. A tiny compressed file can otherwise
// ask the browser to allocate hundreds of megabytes. The browser still validates
// the actual image bitstream after this bounded header check.
// PNG: w3.org/TR/PNG-Chunks.html; WebP: developers.google.com/speed/webp/docs/riff_container.
export function imageDimensions(bytes,type) {
  if(!(bytes instanceof Uint8Array)||bytes.length>10*1024*1024) throw new Error('Invalid image file.');
  const data=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const text=at=>String.fromCharCode(...bytes.subarray(at,at+4));
  let width,height;
  if(type==='image/png') {
    if(bytes.length<33||![137,80,78,71,13,10,26,10].every((n,i)=>bytes[i]===n)||text(12)!=='IHDR'||data.getUint32(8)!==13) throw new Error('Invalid PNG image.');
    width=data.getUint32(16);height=data.getUint32(20);
  } else if(type==='image/jpeg') {
    if(bytes[0]!==255||bytes[1]!==216) throw new Error('Invalid JPEG image.');
    let at=2;
    while(at<bytes.length) {
      if(bytes[at++]!==255) throw new Error('Invalid JPEG image.');
      while(bytes[at]===255)at++;
      const marker=bytes[at++];
      if(marker===217||marker===218)break;
      if(marker===1||(marker>=208&&marker<=215))continue;
      if(at+2>bytes.length)break;
      const length=data.getUint16(at);
      if(length<2||at+length>bytes.length)throw new Error('Invalid JPEG image.');
      if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) {
        if(length<8)throw new Error('Invalid JPEG image.');
        height=data.getUint16(at+3);width=data.getUint16(at+5);break;
      }
      at+=length;
    }
  } else if(type==='image/webp') {
    if(bytes.length<20||text(0)!=='RIFF'||text(8)!=='WEBP')throw new Error('Invalid WebP image.');
    const end=data.getUint32(4,true)+8;
    if(end>bytes.length||end<20)throw new Error('Invalid WebP image.');
    const uint24=at=>bytes[at]|bytes[at+1]<<8|bytes[at+2]<<16;
    for(let at=12;at+8<=end;) {
      const kind=text(at),length=data.getUint32(at+4,true),start=at+8;
      if(start+length>end)throw new Error('Invalid WebP image.');
      if(kind==='VP8X'&&length>=10){width=uint24(start+4)+1;height=uint24(start+7)+1;break;}
      if(kind==='VP8L'&&length>=5&&bytes[start]===47){const bits=data.getUint32(start+1,true);width=(bits&16383)+1;height=((bits>>>14)&16383)+1;break;}
      if(kind==='VP8 '&&length>=10&&bytes[start+3]===157&&bytes[start+4]===1&&bytes[start+5]===42){width=data.getUint16(start+6,true)&16383;height=data.getUint16(start+8,true)&16383;break;}
      at=start+length+(length%2);
    }
  } else throw new Error('Import a PNG, JPEG or WebP image.');
  if(!width||!height)throw new Error('Invalid image dimensions.');
  if(width>8192||height>8192||width*height>16777216)throw new Error('Use an image up to 8,192 pixels per side and 16 megapixels.');
  return {width,height};
}
