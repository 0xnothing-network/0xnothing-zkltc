import {useEffect,useId,useRef} from 'react';
import {X} from '@phosphor-icons/react';
let openCount=0;
let previousOverflow='';
export function Modal({title,children,onClose,wide=false}:{title:string;children:React.ReactNode;onClose:()=>void;wide?:boolean}) {
 const dialog=useRef<HTMLDialogElement>(null),backdropPress=useRef(false),titleId=useId();
 useEffect(()=>{const el=dialog.current!;if(openCount++===0){previousOverflow=document.body.style.overflow;document.body.style.overflow='hidden';}el.showModal();return()=>{el.close();if(--openCount===0)document.body.style.overflow=previousOverflow;};},[]);
 const outside=(x:number,y:number)=>{const rect=dialog.current!.getBoundingClientRect();return x<rect.left||x>rect.right||y<rect.top||y>rect.bottom;};
 return <dialog ref={dialog} aria-labelledby={titleId} className={'modal '+(wide?'wide':'')} onCancel={e=>{e.preventDefault();onClose();}} onPointerDown={e=>{backdropPress.current=outside(e.clientX,e.clientY);}} onClick={e=>{if(backdropPress.current&&outside(e.clientX,e.clientY))onClose();backdropPress.current=false;}}><div className="modal-header"><h2 id={titleId}>{title}</h2><button type="button" className="icon-button" aria-label="Close dialog" onClick={onClose}><X/></button></div>{children}</dialog>;
}
