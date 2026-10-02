import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {ArrowCounterClockwise,ArrowClockwise,PencilSimple,Eraser,PaintBucket,Eyedropper,DownloadSimple,UploadSimple,Trash,GridFour,ArrowUpRight} from '@phosphor-icons/react';
import {PALETTE,GRID_SIZES,encodePixels,floodFill,linePoints,template,pixelStats,pixelDocument,parsePixelDocument,imageDimensions} from '../lib/pixels.mjs';
import {NFT,NFT_ABI,publicClient} from '../lib/chain';
import type {Wallet} from '../lib/wallet';

type Cells=(string|null)[];
type CanvasState={grid:number;cells:Cells};
type Metadata={name:string;description:string};
type Snapshot=CanvasState&{metadata?:Metadata};
type Stroke={pointerId:number;before:CanvasState;cells:Cells;tool:string;color:string;last:number[]|null;changed:boolean};
const DRAFT_KEY='dogeos-pixel-draft';
const HISTORY_LIMIT=25;

function drawPixels(context:CanvasRenderingContext2D,state:CanvasState) {
  const image=context.createImageData(state.grid,state.grid);
  for(let at=0;at<state.cells.length;at++) {
    const color=state.cells[at];if(color===null)continue;
    image.data[at*4]=parseInt(color.slice(1,3),16);
    image.data[at*4+1]=parseInt(color.slice(3,5),16);
    image.data[at*4+2]=parseInt(color.slice(5,7),16);
    image.data[at*4+3]=255;
  }
  context.putImageData(image,0,0);
}

export function Studio({wallet,run,onMint}:{wallet:Wallet;run:(fn:()=>Promise<unknown>,message:string)=>Promise<boolean>;onMint:()=>void}) {
  const [document,setDocument]=useState<CanvasState>(()=>({grid:32,cells:Array(1024).fill(null)}));
  const {grid,cells}=document;
  const [color,setColor]=useState(PALETTE[1]),[tool,setTool]=useState('draw'),[showGrid,setShowGrid]=useState(true);
  const [name,setName]=useState(''),[description,setDescription]=useState(''),[message,setMessage]=useState('');
  const [ready,setReady]=useState(false),[draftStatus,setDraftStatus]=useState('Restoring draft…');
  const [historyCount,setHistoryCount]=useState(0),[futureCount,setFutureCount]=useState(0);
  const canvas=useRef<HTMLCanvasElement>(null),input=useRef<HTMLInputElement>(null);
  const current=useRef(document),metadata=useRef<Metadata>({name,description});metadata.current={name,description};
  const history=useRef<Snapshot[]>([]),future=useRef<Snapshot[]>([]),stroke=useRef<Stroke|null>(null);
  const frame=useRef<number|null>(null),revision=useRef(0),importSequence=useRef(0),mounted=useRef(false),draftReady=useRef(false);
  const stats=useMemo(()=>pixelStats(cells,grid),[cells,grid]);

  const setCurrent=(next:CanvasState)=>{current.current=next;revision.current++;setDocument(next);};
  const updateHistory=()=>{setHistoryCount(history.current.length);setFutureCount(future.current.length);};
  const remember=(snapshot:Snapshot)=>{history.current=[...history.current.slice(-(HISTORY_LIMIT-1)),snapshot];future.current=[];updateHistory();};
  const cancelFrame=()=>{if(frame.current!==null)cancelAnimationFrame(frame.current);frame.current=null;};
  const finish=(pointerId?:number)=>{
    const active=stroke.current;
    if(!active||(pointerId!==undefined&&active.pointerId!==pointerId))return;
    stroke.current=null;cancelFrame();
    if(active.changed){setCurrent({grid:active.before.grid,cells:active.cells.slice()});remember(active.before);}
  };
  const actions=useRef({finish,undo:()=>{},redo:()=>{}});

  const saveDraft=useCallback((notify=true)=>{
    if(!draftReady.current)return;
    const active=stroke.current,state=active?{grid:active.before.grid,cells:active.cells}:current.current;
    try {
      const fields=metadata.current;
      localStorage.setItem(DRAFT_KEY,JSON.stringify(pixelDocument(state.cells,state.grid,fields.name,fields.description)));
      if(notify&&mounted.current)setDraftStatus('Draft saved on this device');
    } catch {
      if(notify&&mounted.current)setDraftStatus('Draft not saved · export JSON');
    }
  },[]);

  useEffect(()=>{
    mounted.current=true;
    try {
      const raw=localStorage.getItem(DRAFT_KEY);
      if(raw) {
        const restored=parsePixelDocument(JSON.parse(raw));
        current.current={grid:restored.grid,cells:restored.cells};
        metadata.current={name:restored.name,description:restored.description};
        setDocument(current.current);setName(restored.name);setDescription(restored.description);
      }
    } catch {setMessage('The saved draft could not be restored. You can still draw or import JSON.');}
    draftReady.current=true;setReady(true);
    const pagehide=()=>saveDraft(false);window.addEventListener('pagehide',pagehide);
    return()=>{mounted.current=false;window.removeEventListener('pagehide',pagehide);cancelFrame();saveDraft(false);};
  },[saveDraft]);

  useEffect(()=>{
    if(!ready)return;
    setDraftStatus('Saving draft…');const timer=setTimeout(()=>saveDraft(),200);
    return()=>clearTimeout(timer);
  },[document,name,description,ready,saveDraft]);

  useEffect(()=>{const context=canvas.current?.getContext('2d');if(context)drawPixels(context,document);},[document]);

  const change=(next:CanvasState,fields?:Metadata)=>{
    finish();const old=current.current;
    const same=old.grid===next.grid&&old.cells.every((value,index)=>value===next.cells[index]);
    const sameMetadata=!fields||(fields.name===metadata.current.name&&fields.description===metadata.current.description);
    if(same&&sameMetadata)return;
    remember(fields?{...old,metadata:{...metadata.current}}:old);setCurrent(next);
    if(fields){metadata.current=fields;setName(fields.name);setDescription(fields.description);}
  };
  const restore=(snapshot:Snapshot)=>{
    setCurrent({grid:snapshot.grid,cells:snapshot.cells});
    if(snapshot.metadata){metadata.current=snapshot.metadata;setName(snapshot.metadata.name);setDescription(snapshot.metadata.description);}
  };
  const undo=()=>{
    finish();const previous=history.current.pop();if(!previous)return;
    future.current.unshift(previous.metadata?{...current.current,metadata:{...metadata.current}}:current.current);
    restore(previous);updateHistory();
  };
  const redo=()=>{
    finish();const next=future.current.shift();if(!next)return;
    history.current.push(next.metadata?{...current.current,metadata:{...metadata.current}}:current.current);
    restore(next);updateHistory();
  };
  actions.current={finish,undo,redo};

  const point=(event:{clientX:number;clientY:number},size:number)=>{
    const bounds=canvas.current?.getBoundingClientRect();
    if(!bounds||bounds.width<=0||bounds.height<=0)return null;
    return [Math.max(0,Math.min(size-1,Math.floor((event.clientX-bounds.left)/bounds.width*size))),Math.max(0,Math.min(size-1,Math.floor((event.clientY-bounds.top)/bounds.height*size)))];
  };
  const paint=(event:{clientX:number;clientY:number})=>{
    const active=stroke.current;if(!active)return;
    const p=point(event,active.before.grid);if(!p)return;
    const nextColor=active.tool==='erase'?null:active.color;
    let changed=false;
    for(const [x,y] of linePoints(...(active.last??p) as [number,number],...p as [number,number])) {
      const at=y*active.before.grid+x;
      if(active.cells[at]!==nextColor){active.cells[at]=nextColor;changed=true;}
    }
    active.last=p;if(!changed)return;
    active.changed=true;
    if(frame.current===null)frame.current=requestAnimationFrame(()=>{
      frame.current=null;const latest=stroke.current;
      if(latest)setCurrent({grid:latest.before.grid,cells:latest.cells.slice()});
    });
  };
  const begin=(event:React.PointerEvent<HTMLCanvasElement>)=>{
    if(event.button!==0||!event.isPrimary||stroke.current)return;
    event.preventDefault();const state=current.current,p=point(event,state.grid);if(!p)return;
    if(tool==='pick'){const picked=state.cells[p[1]*state.grid+p[0]];if(picked)setColor(picked);return;}
    if(tool==='fill'){change({grid:state.grid,cells:floodFill(state.cells,state.grid,p[0],p[1],color)});return;}
    try{event.currentTarget.setPointerCapture(event.pointerId);}catch{return;}
    stroke.current={pointerId:event.pointerId,before:state,cells:state.cells.slice(),tool,color,last:null,changed:false};paint(event);
  };
  useEffect(()=>{
    const handler=(event:KeyboardEvent)=>{
      const target=event.target;
      if(event.defaultPrevented||(target instanceof HTMLElement&&(target.isContentEditable||target.closest('input,textarea,select,[role="textbox"]')))||window.document.querySelector('dialog[open]'))return;
      const key=event.key.toLowerCase();
      if((event.ctrlKey||event.metaKey)&&!event.altKey&&(key==='z'||key==='y')){event.preventDefault();key==='y'||event.shiftKey?actions.current.redo():actions.current.undo();return;}
      if(event.ctrlKey||event.metaKey||event.altKey)return;
      if(key==='b')setTool('draw');else if(key==='e')setTool('erase');else if(key==='g')setTool('fill');else if(key==='i')setTool('pick');
    };
    const release=(event:PointerEvent)=>actions.current.finish(event.pointerId);
    window.addEventListener('keydown',handler);window.addEventListener('pointerup',release);window.addEventListener('pointercancel',release);
    return()=>{window.removeEventListener('keydown',handler);window.removeEventListener('pointerup',release);window.removeEventListener('pointercancel',release);};
  },[]);

  const resize=(size:number)=>{
    finish();const old=current.current;if(size===old.grid)return;
    const next:Cells=Array(size*size).fill(null);
    for(let y=0;y<size;y++)for(let x=0;x<size;x++)next[y*size+x]=old.cells[Math.floor(y*old.grid/size)*old.grid+Math.floor(x*old.grid/size)];
    change({grid:size,cells:next});
  };
  const filename=()=>{const safe=metadata.current.name.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_');return safe||'pixel';};
  const download=(data:Blob,file:string)=>{
    const url=URL.createObjectURL(data),anchor=window.document.createElement('a');
    anchor.href=url;anchor.download=file;window.document.body.append(anchor);anchor.click();anchor.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  const exportPNG=()=>{
    finish();const state=current.current,source=window.document.createElement('canvas');source.width=source.height=state.grid;
    const sourceContext=source.getContext('2d');if(!sourceContext){setMessage('PNG export is unavailable in this browser.');return;}drawPixels(sourceContext,state);
    const output=window.document.createElement('canvas');output.width=output.height=state.grid*8;
    const context=output.getContext('2d');if(!context){setMessage('PNG export is unavailable in this browser.');return;}
    context.imageSmoothingEnabled=false;context.drawImage(source,0,0,output.width,output.height);
    const file=filename()+'.png';output.toBlob(blob=>{if(blob)download(blob,file);else setMessage('PNG export failed. Try exporting JSON.');});
  };
  const exportJSON=()=>{
    finish();try{const state=current.current,fields=metadata.current;download(new Blob([JSON.stringify(pixelDocument(state.cells,state.grid,fields.name,fields.description),null,2)],{type:'application/json'}),filename()+'.json');}
    catch(error){setMessage((error as Error).message);}
  };
  const importFile=async(file:File)=>{
    finish();const sequence=++importSequence.current,baseline=revision.current,targetGrid=current.current.grid,fields={...metadata.current};
    const stillCurrent=()=>mounted.current&&sequence===importSequence.current;
    try {
      if(file.size>10*1024*1024)throw new Error('Choose a file smaller than 10 MB.');
      let next:CanvasState,nextFields:Metadata|undefined;
      if(file.name.toLowerCase().endsWith('.json')||file.type==='application/json') {
        const restored=parsePixelDocument(JSON.parse(await file.text()));next={grid:restored.grid,cells:restored.cells};nextFields={name:restored.name,description:restored.description};
      } else {
        const inferred=file.name.toLowerCase().match(/\.(png|jpe?g|webp)$/)?.[1];
        const type=file.type||(inferred==='png'?'image/png':inferred==='webp'?'image/webp':inferred?'image/jpeg':'');
        imageDimensions(new Uint8Array(await file.arrayBuffer()),type);
        if(!stillCurrent())return;
        const bitmap=await createImageBitmap(file,{resizeWidth:targetGrid,resizeHeight:targetGrid,resizeQuality:'pixelated'});
        try {
          const image=window.document.createElement('canvas');image.width=image.height=targetGrid;
          const context=image.getContext('2d');if(!context)throw new Error('Image import is unavailable in this browser.');
          context.imageSmoothingEnabled=false;context.drawImage(bitmap,0,0,targetGrid,targetGrid);
          const data=context.getImageData(0,0,targetGrid,targetGrid).data;
          next={grid:targetGrid,cells:Array.from({length:targetGrid*targetGrid},(_,at)=>data[at*4+3]<128?null:'#'+[data[at*4],data[at*4+1],data[at*4+2]].map(n=>n.toString(16).padStart(2,'0')).join(''))};
        } finally {bitmap.close();}
      }
      if(!stillCurrent())return;
      if(revision.current!==baseline||stroke.current||metadata.current.name!==fields.name||metadata.current.description!==fields.description)throw new Error('Your draft changed while importing. Choose the file again when you are ready.');
      change(next,nextFields);setMessage('Imported. Review the canvas before minting.');
    } catch(error){if(stillCurrent())setMessage((error as Error).message);}
  };
  const mint=async(event:React.FormEvent)=>{
    event.preventDefault();finish();
    const succeeded=await run(async()=>{
      const state=current.current,fields=metadata.current,pixels=encodePixels(state.cells,state.grid),title=fields.name.trim();
      if(!title)throw new Error('Give your artwork a title first.');
      if(new TextEncoder().encode(title).length>64)throw new Error('Artwork title must be at most 64 UTF-8 bytes.');
      if(new TextEncoder().encode(fields.description).length>1024)throw new Error('Description must be at most 1,024 UTF-8 bytes.');
      const original=await publicClient.readContract({address:NFT,abi:NFT_ABI,functionName:'checkOriginalPacked',args:[pixels,BigInt(state.grid)]});
      if(!original)throw new Error('This exact artwork is already minted. Change the pixels to create an original.');
      await wallet.transact(NFT,NFT_ABI,'mintPacked',[title,fields.description,BigInt(state.grid),pixels]);
    },'Your artwork is on-chain.');
    if(succeeded)onMint();
  };

  return <section className="studio">
    <div className="page-intro"><div><span className="eyebrow">THE PIXEL WORKSHOP</span><h1>A little square.<br/>A lot of you.</h1><p>Draw something original. Keep it on-chain, forever.</p></div><span className="intro-note">No mint fee.<br/>Just network gas.</span></div>
    <div className="studio-layout"><div className="drawing-room">
      <div className="canvas-bar"><span>{grid} × {grid} canvas</span><div><button className="icon-button" aria-label="Undo" disabled={!historyCount} onClick={undo}><ArrowCounterClockwise/></button><button className="icon-button" aria-label="Redo" disabled={!futureCount} onClick={redo}><ArrowClockwise/></button><button className={'icon-button '+(showGrid?'selected':'')} aria-label="Toggle grid" aria-pressed={showGrid} onClick={()=>setShowGrid(!showGrid)}><GridFour/></button></div></div>
      <div className={'canvas-wrap '+(showGrid&&grid<=64?'with-grid':'')} style={{'--grid':grid} as React.CSSProperties}>
        <canvas aria-label="Pixel drawing canvas" ref={canvas} width={grid} height={grid} onPointerDown={begin} onPointerMove={event=>{if(stroke.current?.pointerId===event.pointerId)paint(event);}} onPointerUp={event=>{if(!event.isPrimary||stroke.current?.pointerId!==event.pointerId)return;paint(event);finish(event.pointerId);}} onPointerCancel={event=>finish(event.pointerId)} onLostPointerCapture={event=>finish(event.pointerId)}/>
      </div>
      <div className="canvas-footer"><span>{stats.painted.toLocaleString()} painted pixels · {stats.runs.toLocaleString()} runs</span><span role="status">{draftStatus}</span></div>
      <div className="studio-tools">{[{id:'draw',label:'Pencil (B)',Icon:PencilSimple},{id:'erase',label:'Eraser (E)',Icon:Eraser},{id:'fill',label:'Fill (G)',Icon:PaintBucket},{id:'pick',label:'Pick color (I)',Icon:Eyedropper}].map(({id,label,Icon})=><button key={id} title={label} aria-label={label} aria-pressed={tool===id} className={tool===id?'selected':''} onClick={()=>setTool(id)}><Icon/><span>{label.split(' ')[0]}</span></button>)}<button aria-label="Clear canvas" onClick={()=>change({grid:current.current.grid,cells:Array(current.current.grid**2).fill(null)})}><Trash/><span>Clear</span></button></div>
      <div className="palette">{PALETTE.map(c=><button key={c} aria-label={'Color '+c} aria-pressed={color===c} style={{background:c}} className={color===c?'chosen':''} onClick={()=>setColor(c)}/>)}<label className="custom-color" title="Custom color"><input aria-label="Custom color" type="color" value={color} onChange={event=>setColor(event.target.value)}/></label><code>{color}</code></div>
      <div className="canvas-options"><label>Canvas size<select value={grid} onChange={event=>resize(Number(event.target.value))}>{GRID_SIZES.map(n=><option key={n} value={n}>{n} × {n}</option>)}</select></label><button className="text-button" onClick={()=>input.current?.click()}><UploadSimple/>Import</button><button className="text-button" onClick={exportPNG}><DownloadSimple/>PNG</button><button className="text-button" onClick={exportJSON}>JSON</button><input hidden ref={input} type="file" accept="image/png,image/jpeg,image/webp,.json" onChange={event=>{if(event.target.files?.[0])void importFile(event.target.files[0]);event.target.value='';}}/></div>
      {stats.runs>4096&&<p role="status" className="inline-note">This draft has more than 4,096 color runs. Simplify it before minting; you can still save or export the full draft.</p>}
      {message&&<p role="status" className="inline-note">{message}</p>}
    </div><aside className="mint-room"><h2>Make it yours.</h2><p>The image, title and description live entirely on DogeOS. Your signature makes it an NFT.</p>
      <form onSubmit={mint}><label>Artwork title<input required maxLength={64} placeholder="A name for your tiny masterpiece" value={name} onChange={event=>setName(event.target.value)}/></label><label>The story <span>(optional)</span><textarea maxLength={1024} rows={4} placeholder="What's behind these pixels?" value={description} onChange={event=>setDescription(event.target.value)}/></label><div className="mint-facts"><div><span>Mint price</span><strong>Free</strong></div><div><span>Creator royalty</span><strong>1% on our market</strong></div><div><span>Artwork storage</span><strong>100% on-chain</strong></div></div><button className="button primary full" disabled={wallet.pending||!stats.painted||stats.runs>4096||!name.trim()} type="submit">Mint your pixel <ArrowUpRight/></button><small>Wallet confirmation required. Network gas is paid in test DOGE.</small></form>
      <div className="template-list"><h3>Need a starting point?</h3><p>Remix one of our studio sketches.</p><div>{['doge','rocket','flower','mushroom','sunset','ghost'].map(kind=><button key={kind} onClick={()=>change({grid:current.current.grid,cells:template(kind,current.current.grid)})}>{kind}</button>)}</div><small>Change a sketch before minting: identical art can only be minted once.</small></div>
    </aside></div>
  </section>;
}
