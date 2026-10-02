import {ArrowUpRight} from '@phosphor-icons/react';
import {useMemo} from 'react';
import {formatEther} from 'viem';
import {pixelSVG} from '../lib/pixels.mjs';
import {shorten,type Token} from '../lib/chain';
export function TokenCard({token,onClick}:{token:Token;onClick:()=>void}) {
 const artwork=useMemo(()=>pixelSVG(token.pixels,token.grid),[token.pixels,token.grid]);
 return <button className="art-card" onClick={onClick}><div className="art-image"><img alt={token.name} src={artwork} loading="lazy" width="320" height="320"/></div><div className="art-meta"><div><span>PIXEL #{token.id}</span><h3>{token.name}</h3><small>by {shorten(token.creator)}</small></div><ArrowUpRight/></div><div className="art-price"><span>{token.listing?'Asking price':'In a collection'}</span><strong>{token.listing?formatEther(BigInt(token.listing.price))+' DOGE':'View artwork'}</strong></div></button>;
}
