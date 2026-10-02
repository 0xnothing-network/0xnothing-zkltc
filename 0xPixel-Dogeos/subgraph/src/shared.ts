import {Address,BigInt,ethereum} from '@graphprotocol/graph-ts';
import {Stats,Activity,Account,MarketApproval} from '../generated/schema';
export const ZERO=BigInt.zero();
export function approval(owner:Address):MarketApproval {let a=MarketApproval.load(owner.toHexString());if(!a){a=new MarketApproval(owner.toHexString());a.approved=false;a.save();}return a;}
export function stats(): Stats {let s=Stats.load('global');if(!s){s=new Stats('global');s.minted=ZERO;s.collections=ZERO;s.sales=ZERO;s.volume=ZERO;s.royalties=ZERO;s.fees=ZERO;}return s;}
export function credit(account:Address,amount:BigInt):void {let a=Account.load(account.toHexString());if(!a){a=new Account(account.toHexString());a.credits=ZERO;}a.credits=a.credits.plus(amount);a.save();}
export function activity(e:ethereum.Event,kind:string,token:BigInt,account:Address,amount:BigInt):void {const a=new Activity(e.transaction.hash.toHexString()+'-'+e.logIndex.toString());a.kind=kind;a.tokenId=token;a.account=account;a.amount=amount;a.transaction=e.transaction.hash;a.block=e.block.number;a.timestamp=e.block.timestamp;a.save();}
