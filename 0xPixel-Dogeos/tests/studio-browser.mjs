import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {encodePixels,pixelDocument,parsePixelDocument,template,imageDimensions} from '../src/lib/pixels.mjs';

const base=process.env.PIXEL_TEST_URL||'http://localhost:3300/DOGEOSxPIXEL';
const browser=await chromium.launch({headless:true});
const report={url:base,startedAt:new Date().toISOString(),checks:[],errors:[],performance:{}};
const contexts=[];
async function pageFor(options={},initialize) {
  const context=await browser.newContext({viewport:{width:1440,height:1000},colorScheme:'dark',locale:'en-US',...options});contexts.push(context);
  if(initialize)await context.addInitScript(initialize);
  const page=await context.newPage();page.on('pageerror',error=>report.errors.push({url:page.url(),message:error.message}));
  await page.goto(base+'/studio',{waitUntil:'networkidle'});await page.getByLabel('Pixel drawing canvas').waitFor();return page;
}
async function check(name,fn) {
  const start=performance.now();
  try{await fn();report.checks.push({name,pass:true,durationMs:Math.round(performance.now()-start)});console.log('PASS '+name);}
  catch(error){report.checks.push({name,pass:false,error:error.message});throw error;}
}
const title=page=>page.getByPlaceholder('A name for your tiny masterpiece');
const story=page=>page.getByPlaceholder("What's behind these pixels?");
const size=page=>page.getByLabel('Canvas size');
const footer=page=>page.locator('.canvas-footer span').first();
const hash=async page=>createHash('sha256').update(await page.getByLabel('Pixel drawing canvas').evaluate(canvas=>canvas.toDataURL())).digest('hex');
const painted=page=>page.getByLabel('Pixel drawing canvas').evaluate(canvas=>{const data=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;let count=0;for(let at=3;at<data.length;at+=4)if(data[at])count++;return count;});
async function clickCell(page,x,y,button='left') {
  const box=await page.getByLabel('Pixel drawing canvas').boundingBox(),grid=Number(await size(page).inputValue());
  await page.mouse.click(box.x+(x+.5)/grid*box.width,box.y+(y+.5)/grid*box.height,{button});
}
async function importJSON(page,value,name='artwork.json') {
  await page.locator('input[type=file]').setInputFiles({name,mimeType:'application/json',buffer:Buffer.from(JSON.stringify(value))});
}
async function exportJSON(page) {
  const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'JSON',exact:true}).click();
  const download=await downloadPromise;await download.saveAs('output/deep-studio-export.json');return JSON.parse(await readFile('output/deep-studio-export.json','utf8'));
}

try {
  await check('blank canvas metadata and selected size persist through reload',async()=>{
    const page=await pageFor();await title(page).fill('My blank draft');await story(page).fill('A story before the pixels. 🐕');await size(page).selectOption('16');
    await page.waitForFunction(()=>{const raw=localStorage.getItem('dogeos-pixel-draft');return raw&&JSON.parse(raw).name==='My blank draft'&&JSON.parse(raw).grid===16;});
    await page.reload({waitUntil:'networkidle'});assert.equal(await title(page).inputValue(),'My blank draft');assert.equal(await story(page).inputValue(),'A story before the pixels. 🐕');assert.equal(await size(page).inputValue(),'16');assert.equal(await painted(page),0);
  });
  await check('template, resize and imported metadata have reversible undo and redo',async()=>{
    const page=await pageFor();await page.getByRole('button',{name:'flower',exact:true}).click();await title(page).fill('Original flower');const original=await hash(page);
    await size(page).selectOption('8');await page.getByLabel('Undo',{exact:true}).click();assert.equal(await size(page).inputValue(),'32');assert.equal(await hash(page),original);
    await page.getByLabel('Redo',{exact:true}).click();assert.equal(await size(page).inputValue(),'8');await page.getByLabel('Undo',{exact:true}).click();
    const imported=pixelDocument(template('ghost',16),16,'Imported ghost','Imported story');await importJSON(page,imported);await page.getByText('Imported. Review the canvas before minting.',{exact:true}).waitFor();const ghost=await hash(page);
    assert.equal(await title(page).inputValue(),'Imported ghost');assert.equal(await size(page).inputValue(),'16');await page.getByLabel('Undo',{exact:true}).click();assert.equal(await title(page).inputValue(),'Original flower');assert.equal(await size(page).inputValue(),'32');assert.equal(await hash(page),original);
    await page.getByLabel('Redo',{exact:true}).click();assert.equal(await title(page).inputValue(),'Imported ghost');assert.equal(await story(page).inputValue(),'Imported story');assert.equal(await hash(page),ghost);
  });
  await check('primary strokes interpolate, ignore right/secondary pointers and avoid no-op history',async()=>{
    const page=await pageFor();await clickCell(page,0,0,'right');assert.equal(await painted(page),0);assert.ok(await page.getByLabel('Undo',{exact:true}).isDisabled());
    const box=await page.getByLabel('Pixel drawing canvas').boundingBox();await page.mouse.move(box.x+box.width/64,box.y+box.height/64);await page.mouse.down();
    await page.getByLabel('Pixel drawing canvas').evaluate(canvas=>{const box=canvas.getBoundingClientRect();canvas.dispatchEvent(new PointerEvent('pointerdown',{pointerId:99,pointerType:'touch',isPrimary:false,button:0,buttons:1,clientX:box.right-1,clientY:box.top+1,bubbles:true}));canvas.dispatchEvent(new PointerEvent('pointermove',{pointerId:99,pointerType:'touch',isPrimary:false,buttons:1,clientX:box.left+1,clientY:box.bottom-1,bubbles:true}));});
    await page.mouse.move(box.x+box.width+50,box.y+box.height+50,{steps:1});await page.mouse.up();assert.equal(await painted(page),32);
    await clickCell(page,0,0);await page.getByLabel('Undo',{exact:true}).click();assert.equal(await painted(page),0);
    await page.getByLabel('Redo',{exact:true}).click();assert.equal(await painted(page),32);await page.evaluate(()=>document.activeElement?.blur());await page.keyboard.press('Control+z');assert.equal(await painted(page),0);await page.keyboard.press('Control+y');assert.equal(await painted(page),32);
  });
  await check('primary pointerup paints its final coordinate without consuming no-op history',async()=>{
    const page=await pageFor();const drawing=page.getByLabel('Pixel drawing canvas'),box=await drawing.boundingBox();
    await page.mouse.move(box.x+box.width/64,box.y+box.height/64);await page.mouse.down();
    await page.waitForFunction(()=>document.querySelector('canvas').getContext('2d').getImageData(0,0,1,1).data[3]===255);
    await drawing.evaluate(canvas=>{const box=canvas.getBoundingClientRect();canvas.dispatchEvent(new PointerEvent('pointerup',{pointerId:99,pointerType:'touch',isPrimary:false,button:0,clientX:box.right-box.width/64,clientY:box.bottom-box.height/64,bubbles:true}));});
    assert.equal(await painted(page),1);
    await drawing.evaluate(canvas=>{const box=canvas.getBoundingClientRect();canvas.dispatchEvent(new PointerEvent('pointerup',{pointerId:1,pointerType:'mouse',isPrimary:true,button:0,clientX:box.right-box.width/64,clientY:box.bottom-box.height/64,bubbles:true}));});
    await page.mouse.up();assert.equal(await painted(page),32);
    await clickCell(page,0,0);await page.getByLabel('Undo',{exact:true}).click();assert.equal(await painted(page),0);assert.ok(await page.getByLabel('Undo',{exact:true}).isDisabled());
  });
  await check('fill no-ops do not consume history and eyedropper does not alter art',async()=>{
    const page=await pageFor();await page.getByLabel('Fill (G)',{exact:true}).click();await clickCell(page,0,0);assert.equal(await painted(page),1024);const filled=await hash(page);await clickCell(page,1,1);await page.getByLabel('Pick color (I)',{exact:true}).click();await clickCell(page,1,1);assert.equal(await hash(page),filled);await page.getByLabel('Undo',{exact:true}).click();assert.equal(await painted(page),0);assert.ok(await page.getByLabel('Undo',{exact:true}).isDisabled());
  });
  await check('cancelled pointer commits exactly once and editable shortcuts leave tools unchanged',async()=>{
    const page=await pageFor();const box=await page.getByLabel('Pixel drawing canvas').boundingBox();await page.mouse.move(box.x+box.width/64,box.y+box.height/64);await page.mouse.down();
    await page.getByLabel('Pixel drawing canvas').evaluate(canvas=>canvas.dispatchEvent(new PointerEvent('pointercancel',{pointerId:1,pointerType:'mouse',isPrimary:true,bubbles:true})));await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.up();assert.equal(await painted(page),1);await page.getByLabel('Undo',{exact:true}).click();assert.equal(await painted(page),0);
    await page.evaluate(()=>{const editor=document.createElement('div');editor.contentEditable='true';editor.id='test-editable';document.body.append(editor);editor.focus();});await page.keyboard.press('e');assert.equal(await page.getByLabel('Pencil (B)',{exact:true}).getAttribute('aria-pressed'),'true');await page.evaluate(()=>document.getElementById('test-editable').remove());
  });
  await check('invalid JSON imports preserve draft and imported text cannot execute markup',async()=>{
    const page=await pageFor();await page.getByRole('button',{name:'doge',exact:true}).click();await title(page).fill('Preserved doge');const before=await hash(page);
    await importJSON(page,{version:2,grid:8,pixels:['0x000000ff0000'],name:'Invalid'});await page.getByText('Invalid packed artwork',{exact:true}).waitFor();assert.equal(await hash(page),before);assert.equal(await title(page).inputValue(),'Preserved doge');
    await importJSON(page,{version:2,grid:8,pixels:'0x000000ff0000010000ff0000',name:'Invalid'});await page.getByText('Non-canonical artwork',{exact:true}).waitFor();assert.equal(await hash(page),before);
    const hostile='<img src=x onerror=alert(1)>';await importJSON(page,{version:2,grid:8,pixels:'0x000000ff0000',name:hostile,description:'<script>throw 1</script>'});await page.getByText('Imported. Review the canvas before minting.',{exact:true}).waitFor();assert.equal(await title(page).inputValue(),hostile);assert.equal(await page.locator('.studio img').count(),0);assert.equal(await painted(page),1);
  });
  await check('async import cannot overwrite drawing made while reading its file',async()=>{
    const page=await pageFor({},()=>{const original=File.prototype.text;File.prototype.text=async function(){const text=await original.call(this);if(this.name==='slow.json')await new Promise(resolve=>window.__releaseStudioImport=resolve);return text;};});
    await importJSON(page,pixelDocument(template('ghost',16),16,'Late ghost',''),'slow.json');await page.waitForFunction(()=>typeof window.__releaseStudioImport==='function');await page.getByRole('button',{name:'flower',exact:true}).click();const before=await hash(page);await page.evaluate(()=>window.__releaseStudioImport());await page.getByText('Your draft changed while importing. Choose the file again when you are ready.',{exact:true}).waitFor();assert.equal(await hash(page),before);assert.equal(await size(page).inputValue(),'32');
  });
  await check('navigation flushes a draft before its debounce timeout',async()=>{
    const page=await pageFor();await page.getByRole('button',{name:'mushroom',exact:true}).click();await title(page).fill('Saved on navigation');const before=await hash(page);await page.getByRole('link',{name:'Explore',exact:true}).click();assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('dogeos-pixel-draft')).name),'Saved on navigation');await page.getByRole('link',{name:'Pixel studio',exact:true}).click();await page.waitForFunction(()=>document.querySelector('input[placeholder="A name for your tiny masterpiece"]')?.value==='Saved on navigation');assert.equal(await hash(page),before);
  });
  await check('corrupt drafts and denied/quota storage leave studio usable',async()=>{
    const corrupt=await pageFor({},()=>localStorage.setItem('dogeos-pixel-draft','{broken'));await corrupt.getByText('The saved draft could not be restored. You can still draw or import JSON.',{exact:true}).waitFor();await clickCell(corrupt,0,0);assert.equal(await painted(corrupt),1);
    const quota=await pageFor({},()=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key==='dogeos-pixel-draft')throw new DOMException('Test quota','QuotaExceededError');return original.call(this,key,value);};});await quota.getByText('Draft not saved · export JSON',{exact:true}).waitFor();await title(quota).fill('Quota draft');await clickCell(quota,0,0);const document=await exportJSON(quota);assert.equal(parsePixelDocument(document).name,'Quota draft');assert.equal(parsePixelDocument(document).cells.filter(Boolean).length,1);
    const denied=await pageFor({},()=>Object.defineProperty(window,'localStorage',{get(){throw new DOMException('Test storage denied','SecurityError');}}));await denied.getByText('Draft not saved · export JSON',{exact:true}).waitFor();await clickCell(denied,0,0);assert.equal(await painted(denied),1);
  });
  await check('65,536-run draft restores, persists and exports without truncation',async()=>{
    const page=await pageFor({},()=>{const cells=Array.from({length:65536},(_,at)=>at%2?'#ffffff':'#000000');localStorage.setItem('dogeos-pixel-draft',JSON.stringify({version:3,grid:256,cells,name:'Complex draft',description:'Full detail'}));});
    assert.equal(await painted(page),65536);assert.match(await footer(page).innerText(),/65,536 runs/);assert.ok(await page.getByRole('button',{name:/Mint your pixel/}).isDisabled());
    const document=await exportJSON(page);assert.equal(document.version,3);assert.equal(document.cells.length,65536);await page.reload({waitUntil:'networkidle'});assert.equal(await painted(page),65536);assert.equal(await title(page).inputValue(),'Complex draft');
  });
  await check('PNG and JSON exports preserve current canvas and import round-trips',async()=>{
    const page=await pageFor();await page.getByRole('button',{name:'ghost',exact:true}).click();await title(page).fill('Export / ghost');await size(page).selectOption('16');const before=await hash(page);
    const source=template('ghost',32),scaled=Array.from({length:256},(_,at)=>source[Math.floor(at/16)*2*32+(at%16)*2]);
    const json=await exportJSON(page);assert.equal(json.version,2);assert.equal(json.pixels,encodePixels(scaled,16));
    const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'PNG',exact:true}).click();const download=await downloadPromise;assert.ok(!download.suggestedFilename().includes('/'));await download.saveAs('output/deep-studio-export.png');const bytes=await readFile('output/deep-studio-export.png');assert.deepEqual(imageDimensions(bytes,'image/png'),{width:128,height:128});
    await page.getByLabel('Clear canvas',{exact:true}).click();await page.locator('input[type=file]').setInputFiles({name:'roundtrip.png',mimeType:'image/png',buffer:bytes});await page.getByText('Imported. Review the canvas before minting.',{exact:true}).waitFor();assert.equal(await hash(page),before);
  });
  await check('image source dimensions are checked before bitmap decode',async()=>{
    const page=await pageFor({},()=>{const original=window.createImageBitmap;window.__studioBitmapCalls=0;window.createImageBitmap=(...args)=>{window.__studioBitmapCalls++;return original(...args);};});
    const bytes=new Uint8Array(33),data=new DataView(bytes.buffer);bytes.set([137,80,78,71,13,10,26,10]);data.setUint32(8,13);bytes.set([73,72,68,82],12);data.setUint32(16,8192);data.setUint32(20,8192);
    await page.locator('input[type=file]').setInputFiles({name:'too-large.png',mimeType:'image/png',buffer:Buffer.from(bytes)});await page.getByText('Use an image up to 8,192 pixels per side and 16 megapixels.',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.__studioBitmapCalls),0);assert.equal(await painted(page),0);
    const images=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=canvas.height=16;canvas.getContext('2d').fillRect(0,0,16,16);return['image/jpeg','image/webp'].map(type=>({type,url:canvas.toDataURL(type)}));});
    for(const [index,image] of images.entries()){await page.locator('input[type=file]').setInputFiles({name:image.type==='image/jpeg'?'sample.jpg':'sample.webp',mimeType:image.type,buffer:Buffer.from(image.url.split(',')[1],'base64')});await page.waitForFunction(expected=>window.__studioBitmapCalls===expected,index+1);await page.getByText('Imported. Review the canvas before minting.',{exact:true}).waitFor();assert.equal(await painted(page),1024);}
    assert.equal(await page.evaluate(()=>window.__studioBitmapCalls),2);
  });
  await check('256-grid stroke performance and storage messages remain bounded on mobile',async()=>{
    const page=await pageFor({},()=>{localStorage.setItem('dogeos-pixel-draft',JSON.stringify({version:3,grid:256,cells:Array(65536).fill(null),name:'Large canvas',description:''}));window.__studioLongTasks=[];new PerformanceObserver(list=>window.__studioLongTasks.push(...list.getEntries().map(entry=>entry.duration))).observe({type:'longtask',buffered:false});});
    await page.evaluate(()=>window.__studioLongTasks=[]);const box=await page.getByLabel('Pixel drawing canvas').boundingBox(),start=performance.now();await page.mouse.move(box.x+box.width/512,box.y+box.height/512);await page.mouse.down();await page.mouse.move(box.x+box.width-box.width/512,box.y+box.height-box.height/512,{steps:50});await page.mouse.up();assert.equal(await painted(page),256);
    report.performance={stroke256DurationMs:Math.round(performance.now()-start),longTasksMs:await page.evaluate(()=>window.__studioLongTasks)};
    for(const width of [320,375]){await page.setViewportSize({width,height:812});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Studio overflow at '+width);await page.screenshot({path:`output/deep-studio-${width}.png`,fullPage:true});}
  });
  assert.deepEqual(report.errors,[]);report.passed=true;
} catch(error){report.passed=false;report.failure=error.stack;throw error;}
finally {report.finishedAt=new Date().toISOString();await writeFile('output/deep-studio-regression.json',JSON.stringify(report,null,2));await browser.close();}
