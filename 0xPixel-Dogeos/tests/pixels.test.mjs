import {test} from 'node:test';
import assert from 'node:assert/strict';
import {encodePixels,decodePixels,pixelSVG,floodFill,linePoints,template,pixelStats,pixelDocument,parsePixelDocument,imageDimensions} from '../src/lib/pixels.mjs';
test('templates round-trip with canonical row runs',()=>{for(const name of ['doge','rocket','flower','mushroom','sunset','ghost'])for(const grid of [8,16,32,64,128,256]){const cells=template(name,grid);assert.deepEqual(decodePixels(encodePixels(cells,grid),grid),cells);}});
test('RLE handles the 256-pixel run and transparent boundaries',()=>{const cells=Array(65536).fill(null);cells.fill('#00ff00',256,512);assert.equal(encodePixels(cells,256),'0x0001ff00ff00');assert.deepEqual(decodePixels('0x0001ff00ff00',256),cells);});
test('reject empty, oversized, malformed and non-canonical art',()=>{assert.throws(()=>encodePixels(Array(64).fill(null),8),/Paint/);assert.throws(()=>decodePixels('0x000000ff0000010000ff0000',8),/canonical/);assert.throws(()=>decodePixels('0x070001ff0000',8));assert.throws(()=>decodePixels('0x000000<script',8));assert.throws(()=>encodePixels(Array(65536).fill(null).map((_,i)=>i%2?'#000000':'#ffffff'),256),/4,096/);});
test('flood fill is bounded and does not mutate the original',()=>{const cells=Array(64).fill(null);for(let y=0;y<8;y++)cells[y*8+4]='#000000';const filled=floodFill(cells,8,0,0,'#f4c542');assert.equal(filled.filter(c=>c==='#f4c542').length,32);assert.equal(cells.filter(Boolean).length,8);assert.equal(filled[7],null);});
test('fast pointer strokes interpolate through all diagonal cells',()=>{assert.deepEqual(linePoints(0,0,3,3),[[0,0],[1,1],[2,2],[3,3]]);assert.deepEqual(linePoints(3,0,0,3),[[3,0],[2,1],[1,2],[0,3]]);});
test('SVG comes only from bounded, validated numeric runs',()=>{const svg=decodeURIComponent(pixelSVG('0x000000ff0000',8));assert.ok(svg.includes('width="1"'));assert.ok(svg.includes('fill="#ff0000"'));assert.ok(!svg.includes('<script'));});

test('packed artwork rejects values that only become hex through coercion',()=>{
  for(const value of [['0x000000ff0000'],{toString:()=> '0x000000ff0000'},null,8,undefined])assert.throws(()=>decodePixels(value,8),/Invalid packed/);
  for(const value of [null,{},new Uint8Array(64)])assert.throws(()=>encodePixels(value,8),/Invalid canvas/);
  const cells=Array(64).fill(null);cells[0]=['#ff0000'];assert.throws(()=>encodePixels(cells,8),/Invalid pixel/);
  assert.throws(()=>template('doge',3),/Invalid canvas/);
});

test('the 4,096-run boundary is accepted exactly and rejected immediately above it',()=>{
  const cells=Array(128*128).fill(null);
  for(let at=0;at<4096;at++)cells[at]=at%2?'#ffffff':'#000000';
  const packed=encodePixels(cells,128);assert.equal(packed.length,49154);assert.deepEqual(decodePixels(packed,128),cells);
  cells[4096]='#ff0000';assert.throws(()=>encodePixels(cells,128),/4,096/);
});

test('draft documents retain blank metadata and artwork beyond mint limits',()=>{
  const blank=Array(64).fill(null),document=pixelDocument(blank,8,'Empty draft','Keep this story.');
  assert.equal(document.version,3);assert.deepEqual(parsePixelDocument(JSON.parse(JSON.stringify(document))),{grid:8,cells:blank,name:'Empty draft',description:'Keep this story.'});
  const complex=Array.from({length:65536},(_,at)=>at%2?'#ffffff':'#000000');
  const full=pixelDocument(complex,256,'Detailed draft','');assert.equal(full.version,3);assert.deepEqual(parsePixelDocument(full).cells,complex);
  const valid=template('flower',32),packed=pixelDocument(valid,32,'Flower','');assert.equal(packed.version,2);assert.equal(packed.pixels,encodePixels(valid,32));
  assert.deepEqual(parsePixelDocument({grid:32,pixels:packed.pixels}).cells,valid);
});

test('document imports reject ambiguous, unsupported and invalid fields without coercion',()=>{
  const valid={version:2,grid:8,pixels:'0x000000ff0000',name:'Test',description:''};
  for(const value of [null,[],{...valid,version:4},{...valid,name:{}},{...valid,description:[]},{...valid,name:'x'.repeat(65)},{...valid,description:'x'.repeat(1025)},{...valid,pixels:[valid.pixels]},{...valid,grid:'8'},{...valid,cells:Array(64).fill(null)}])assert.throws(()=>parsePixelDocument(value));
  for(const cells of [Array(63).fill(null),Array(64).fill('red'),Array(64).fill({}),Array(64)])assert.throws(()=>parsePixelDocument({version:3,grid:8,cells}));
  const hostile='<img src=x onerror=alert(1)>';
  assert.equal(parsePixelDocument({...valid,name:hostile}).name,hostile);
  assert.throws(()=>pixelSVG(`0x000000${hostile}`,8));
});

test('flood fill treats color case as the same region and rejects invalid coordinates',()=>{
  const cells=Array(64).fill('#AABBCC');cells[1]='#aabbcc';
  assert.deepEqual(floodFill(cells,8,0,0,'#aabbcc'),cells);
  assert.equal(floodFill(cells,8,0,0,'#ff0000').filter(color=>color==='#ff0000').length,64);
  for(const [x,y] of [[-1,0],[8,0],[0,8],[0.5,0],[NaN,0],[Infinity,0]])assert.throws(()=>floodFill(cells,8,x,y,'#ff0000'),/Invalid fill/);
  assert.throws(()=>floodFill(cells,8,0,0,'red'),/Invalid pixel/);
});

test('stroke coordinates cannot cause an unbounded fractional or non-finite loop',()=>{
  for(const args of [[0.5,0,2,2],[0,0,Infinity,2],[NaN,0,2,2],[-1,0,2,2],[0,0,256,2]])assert.throws(()=>linePoints(...args),/Invalid stroke/);
});

function seeded(seed=0xdecafbad) {return()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return(seed>>>0)/4294967296;};}
test('500 seeded canonical artworks round-trip and agree with run statistics',()=>{
  const random=seeded(),colors=[null,'#FFFFFF','#000000','#f4c542','#Aa12Ff'];
  for(let example=0;example<500;example++) {
    const grid=[8,16,32,64,128,256][Math.floor(random()*6)],cells=Array(grid*grid).fill(null);
    for(let y=0;y<grid;y++)for(let x=0;x<grid;) {
      const end=Math.min(grid,x+Math.max(1,Math.ceil(random()*grid/4))),color=colors[Math.floor(random()*colors.length)];
      cells.fill(color,y*grid+x,y*grid+end);x=end;
    }
    const {painted,runs}=pixelStats(cells,grid);assert.equal(painted,cells.filter(Boolean).length);
    if(!painted)continue;
    const packed=encodePixels(cells,grid);assert.equal((packed.length-2)/12,runs);
    assert.deepEqual(decodePixels(packed,grid),cells.map(color=>color?.toLowerCase()??null));
    assert.equal(encodePixels(decodePixels(packed,grid),grid),packed);
  }
});

test('2,000 seeded strokes stay bounded, connected and include both endpoints',()=>{
  const random=seeded(42);
  for(let example=0;example<2000;example++) {
    const coordinates=Array.from({length:4},()=>Math.floor(random()*256)),[x0,y0,x1,y1]=coordinates,points=linePoints(...coordinates);
    assert.deepEqual(points[0],[x0,y0]);assert.deepEqual(points.at(-1),[x1,y1]);assert.equal(points.length,Math.max(Math.abs(x1-x0),Math.abs(y1-y0))+1);
    for(let at=1;at<points.length;at++)assert.ok(Math.abs(points[at][0]-points[at-1][0])<=1&&Math.abs(points[at][1]-points[at-1][1])<=1);
    assert.ok(points.every(([x,y])=>x>=0&&x<=255&&y>=0&&y<=255));
  }
});

test('200 seeded flood fills match an independent bounded breadth-first reference',()=>{
  const random=seeded(77),colors=[null,'#aabbcc','#AABBCC','#ffffff'];
  for(let example=0;example<200;example++) {
    const grid=8,cells=Array.from({length:64},()=>colors[Math.floor(random()*colors.length)]),x=Math.floor(random()*8),y=Math.floor(random()*8),result=cells.slice(),target=result[y*grid+x]?.toLowerCase()??null;
    const queue=[[x,y]],visited=new Set();
    while(queue.length){const [cx,cy]=queue.shift(),at=cy*grid+cx;if(cx<0||cy<0||cx>=grid||cy>=grid||visited.has(at))continue;visited.add(at);if((cells[at]?.toLowerCase()??null)!==target)continue;result[at]='#ff0000';queue.push([cx-1,cy],[cx+1,cy],[cx,cy-1],[cx,cy+1]);}
    assert.deepEqual(floodFill(cells,grid,x,y,'#ff0000'),result);
  }
});

function pngHeader(width,height) {
  const bytes=new Uint8Array(33),data=new DataView(bytes.buffer);bytes.set([137,80,78,71,13,10,26,10]);data.setUint32(8,13);bytes.set([73,72,68,82],12);data.setUint32(16,width);data.setUint32(20,height);return bytes;
}
function webpHeader(kind,width,height) {
  const length=kind==='VP8L'?5:10,bytes=new Uint8Array(20+length+(length%2)),data=new DataView(bytes.buffer);
  bytes.set(Buffer.from('RIFF'));data.setUint32(4,bytes.length-8,true);bytes.set(Buffer.from('WEBP'),8);bytes.set(Buffer.from(kind),12);data.setUint32(16,length,true);
  if(kind==='VP8X'){for(let n=0;n<3;n++){bytes[24+n]=(width-1)>>>n*8&255;bytes[27+n]=(height-1)>>>n*8&255;}}
  else if(kind==='VP8L'){bytes[20]=47;data.setUint32(21,(width-1)|((height-1)<<14),true);}
  else{bytes.set([157,1,42],23);data.setUint16(26,width,true);data.setUint16(28,height,true);}
  return bytes;
}
test('PNG, baseline/progressive JPEG and all WebP header variants have bounded source dimensions',()=>{
  assert.deepEqual(imageDimensions(pngHeader(512,256),'image/png'),{width:512,height:256});
  for(const marker of [192,194]) {
    const bytes=Uint8Array.from([255,216,255,224,0,4,0,0,255,marker,0,17,8,1,0,2,0,3,0,0,0,0,0,0,0,0,0]);
    assert.deepEqual(imageDimensions(bytes,'image/jpeg'),{width:512,height:256});
  }
  for(const kind of ['VP8X','VP8L','VP8 '])assert.deepEqual(imageDimensions(webpHeader(kind,512,256),'image/webp'),{width:512,height:256});
  for(const dimensions of [[0,64],[8193,64],[8192,8192]])assert.throws(()=>imageDimensions(pngHeader(...dimensions),'image/png'),/dimensions|megapixels/);
  for(const kind of ['VP8X','VP8L','VP8 '])assert.throws(()=>imageDimensions(webpHeader(kind,8192,8192),'image/webp'),/megapixels/);
});

test('malformed, truncated or mismatched image headers cannot reach a decoder',()=>{
  const png=pngHeader(32,32);for(let at=0;at<png.length;at++)assert.throws(()=>imageDimensions(png.slice(0,at),'image/png'));
  assert.throws(()=>imageDimensions(png,'image/jpeg'));assert.throws(()=>imageDimensions(png,'image/svg+xml'));
  for(const kind of ['VP8X','VP8L','VP8 ']){const webp=webpHeader(kind,32,32);for(let at=0;at<webp.length;at++)assert.throws(()=>imageDimensions(webp.slice(0,at),'image/webp'));}
  const malicious=Uint8Array.from([255,216,255,224,0,0]);assert.throws(()=>imageDimensions(malicious,'image/jpeg'));
});
