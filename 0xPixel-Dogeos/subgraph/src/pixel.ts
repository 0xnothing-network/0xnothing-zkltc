import {Address,BigInt} from '@graphprotocol/graph-ts';
import {Transfer,Approval,ApprovalForAll,Minted,CollectionCreated,CollectionUpdated,TokenCollectionChanged,DogeosPixel} from '../generated/DogeosPixel/DogeosPixel';
import {Pixel,Collection,Listing} from '../generated/schema';
import {ZERO,stats,activity,approval} from './shared';
import {MARKET_ADDRESS} from './config';
export function handleTransfer(event:Transfer):void {
 const id=event.params.tokenId.toString();let p=Pixel.load(id);
 if(!p){const data=DogeosPixel.bind(event.address).tokenPackedData(event.params.tokenId);p=new Pixel(id);p.tokenId=event.params.tokenId;p.name=data.getArtName();p.description=data.getDescription();p.grid=data.getGridSize().toI32();p.pixels=data.getPixelData();p.artworkHash=data.getArtworkHash();p.creator=data.getCreator();p.mintedAt=data.getMintedAt();p.ownershipNonce=ZERO;}
 if(event.params.from.notEqual(event.params.to))p.ownershipNonce=p.ownershipNonce.plus(BigInt.fromI32(1));
 p.owner=event.params.to;
 p.tokenApproved=false;p.ownerApproval=approval(event.params.to).id;
 if(event.params.from.notEqual(event.params.to)&&p.listing!=null){const l=Listing.load(p.listing!);if(l){l.status='INVALIDATED';l.save();}p.listing=null;}p.save();
 activity(event,'Transfer',event.params.tokenId,event.params.to,ZERO);
}
export function handleApproval(event:Approval):void {const p=Pixel.load(event.params.tokenId.toString());if(!p)return;p.tokenApproved=event.params.approved.equals(Address.fromString(MARKET_ADDRESS));p.save();}
export function handleApprovalForAll(event:ApprovalForAll):void {if(event.params.operator.notEqual(Address.fromString(MARKET_ADDRESS)))return;const a=approval(event.params.owner);a.approved=event.params.approved;a.save();}
export function handleMinted(event:Minted):void {const s=stats();s.minted=s.minted.plus(BigInt.fromI32(1));s.save();activity(event,'Minted',event.params.tokenId,event.params.creator,ZERO);}
export function handleCollectionCreated(event:CollectionCreated):void {const c=new Collection(event.params.collectionId.toString());c.owner=event.params.owner;c.name=event.params.name;c.description=event.params.description;c.createdAt=event.block.timestamp;c.pixelCount=0;c.save();const s=stats();s.collections=s.collections.plus(BigInt.fromI32(1));s.save();activity(event,'CollectionCreated',ZERO,event.params.owner,ZERO);}
export function handleCollectionUpdated(event:CollectionUpdated):void {const c=Collection.load(event.params.collectionId.toString());if(!c)return;c.name=event.params.name;c.description=event.params.description;c.save();activity(event,'CollectionUpdated',event.params.collectionId,Address.fromBytes(c.owner),ZERO);}
export function handleTokenCollectionChanged(event:TokenCollectionChanged):void {const p=Pixel.load(event.params.tokenId.toString());if(!p)return;if(event.params.previousCollection.equals(event.params.collectionId))return;const previous=Collection.load(event.params.previousCollection.toString());if(previous){previous.pixelCount=previous.pixelCount-1;previous.save();}const c=Collection.load(event.params.collectionId.toString());if(c){c.pixelCount=c.pixelCount+1;c.save();p.collection=c.id;}else p.collection=null;p.save();activity(event,'TokenCollectionChanged',event.params.tokenId,Address.fromBytes(p.owner),ZERO);}
