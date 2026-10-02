import {useCallback,useEffect,useRef,useState} from 'react';
import {encodeFunctionData,type EIP1193Provider,type Address,type Abi,type Hash} from 'viem';
import {chain,publicClient,walletClient} from './chain';
import {estimateDogeosFees} from './fees.mjs';
import {formatDoge} from './amounts.mjs';
import {walletAccount,walletChain,assertReceiptSuccess,walletErrorMessage,WalletSessionError} from './wallet-guards.mjs';
export type Provider=Pick<EIP1193Provider,'request'> & {on?:(event:string,fn:(data:unknown)=>void)=>void;removeListener?:(event:string,fn:(data:unknown)=>void)=>void};
export type WalletOption={id:string;name:string;provider:Provider};
declare global { interface Window { ethereum?:Provider } }

export function useWallet() {
 const [options,setOptions]=useState<WalletOption[]>([]),[provider,setProvider]=useState<Provider|null>(null),[address,setAddress]=useState<Address|null>(null),[network,setNetwork]=useState<number|null>(null),[connecting,setConnecting]=useState(false),[pending,setPending]=useState(false),[stage,setStage]=useState(''),[lastHash,setLastHash]=useState<Hash|null>(null),[feeEstimate,setFeeEstimate]=useState<bigint|null>(null);
 const session=useRef(0),attempt=useRef(0),busy=useRef(false),active=useRef<{provider:Provider|null;address:Address|null;network:number|null}>({provider:null,address:null,network:null});
 const observers=useRef(new Set<()=>void>()),liveObserver=useRef<(()=>void)|null>(null),mounted=useRef(true);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;attempt.current++;session.current++;active.current={provider:null,address:null,network:null};for(const cleanup of [...observers.current])cleanup();liveObserver.current=null;};},[]);
 useEffect(()=>{
  const announce=(event:Event)=>{
   const detail=(event as CustomEvent<{info:{uuid:string;name:string};provider:Provider}>).detail;
   if(!detail?.provider||typeof detail.provider.request!=='function'||typeof detail.info?.uuid!=='string'||typeof detail.info.name!=='string'||detail.info.uuid.length>128||detail.info.name.length>100)return;
   const id=detail.info.uuid.trim(),name=detail.info.name.trim();if(!id||!name)return;
   setOptions(list=>list.some(option=>option.id===id||option.provider===detail.provider)||list.length>=20?list:[...list,{id,name,provider:detail.provider}]);
  };
  window.addEventListener('eip6963:announceProvider',announce);
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  if(window.ethereum&&typeof window.ethereum.request==='function')setOptions(list=>list.some(option=>option.provider===window.ethereum)||list.length>=20?list:[...list,{id:'injected',name:'Browser wallet',provider:window.ethereum!}]);
  return()=>window.removeEventListener('eip6963:announceProvider',announce);
 },[]);
 const connect=async(option:WalletOption)=>{
  const current=++attempt.current,start=session.current;setConnecting(true);
  let committed=false,keepObserver=false,closed=false,accountEvent:Address|null|undefined,chainEvent:number|null|undefined;
  let cancelConnection!:(error:Error)=>void;
  const cancelled=new Promise<never>((_,reject)=>{cancelConnection=reject;});void cancelled.catch(()=>{});
  const wait=<T,>(request:Promise<T>)=>Promise.race([request,cancelled]);
  const accounts=(data:unknown)=>{
   const next=walletAccount(data);accountEvent=next;
   if(!committed||active.current.provider!==option.provider)return;
   if(next?.toLowerCase()!==active.current.address?.toLowerCase())session.current++;
   active.current={...active.current,address:next};setAddress(next);
  };
  const changed=(data:unknown)=>{
   const next=walletChain(data);chainEvent=next;
   if(!committed||active.current.provider!==option.provider)return;
   if(next!==active.current.network)session.current++;
   active.current={...active.current,network:next};setNetwork(next);
  };
  const cleanup=()=>{if(closed)return;closed=true;option.provider.removeListener?.('accountsChanged',accounts);option.provider.removeListener?.('chainChanged',changed);option.provider.removeListener?.('disconnect',disconnected);observers.current.delete(cleanup);if(!committed)cancelConnection(new WalletSessionError('Wallet connection changed. Please try again.'));};
  const disconnected=()=>{
   if(!committed){if(current===attempt.current){attempt.current++;if(mounted.current)setConnecting(false);}cancelConnection(new WalletSessionError('Wallet connection changed. Please try again.'));cleanup();return;}
   if(active.current.provider!==option.provider)return;
   session.current++;attempt.current++;active.current={provider:null,address:null,network:null};setProvider(null);setAddress(null);setNetwork(null);setConnecting(false);cleanup();if(liveObserver.current===cleanup)liveObserver.current=null;
  };
  observers.current.add(cleanup);
  try{
   option.provider.on?.('accountsChanged',accounts);option.provider.on?.('chainChanged',changed);option.provider.on?.('disconnect',disconnected);
   const requested=walletAccount(await wait(option.provider.request({method:'eth_requestAccounts'})));
   if(!requested)throw new Error('Wallet has no valid available account.');
   const [available,chainId]=await wait(Promise.all([option.provider.request({method:'eth_accounts'}),option.provider.request({method:'eth_chainId'})]));
   if(!mounted.current||closed||current!==attempt.current||start!==session.current)throw new WalletSessionError('Wallet connection changed. Please try again.');
   const account=walletAccount(available),id=walletChain(chainId);
   if(!account||id===null)throw new Error('Wallet returned an invalid account or network.');
   if((accountEvent!==undefined&&accountEvent?.toLowerCase()!==account.toLowerCase())||(chainEvent!==undefined&&chainEvent!==id))throw new WalletSessionError('Wallet connection changed. Please try again.');
   liveObserver.current?.();liveObserver.current=cleanup;
   session.current++;active.current={provider:option.provider,address:account,network:id};setProvider(option.provider);setAddress(account);setNetwork(id);
   committed=true;keepObserver=true;
  }finally{if(!keepObserver)cleanup();if(mounted.current&&current===attempt.current)setConnecting(false);}
 };
 const disconnect=()=>{session.current++;attempt.current++;active.current={provider:null,address:null,network:null};for(const cleanup of [...observers.current])cleanup();liveObserver.current=null;setProvider(null);setAddress(null);setNetwork(null);setConnecting(false);};
 const switchNetwork=async()=>{
  if(!provider)throw new Error('Connect a wallet first.');
  const currentProvider=provider,currentAttempt=attempt.current,account=active.current.address;
  const guard=()=>{if(!mounted.current||active.current.provider!==currentProvider||attempt.current!==currentAttempt||active.current.address!==account)throw new WalletSessionError('Wallet connection changed. Please try again.');};
  guard();
  try{await currentProvider.request({method:'wallet_switchEthereumChain',params:[{chainId:'0x'+chain.id.toString(16)}]});}
  catch(error){guard();if((error as {code?:number})?.code!==4902)throw error;await currentProvider.request({method:'wallet_addEthereumChain',params:[{chainId:'0x'+chain.id.toString(16),chainName:chain.name,nativeCurrency:chain.nativeCurrency,rpcUrls:chain.rpcUrls.default.http,blockExplorerUrls:[chain.blockExplorers.default.url]}]});guard();await currentProvider.request({method:'wallet_switchEthereumChain',params:[{chainId:'0x'+chain.id.toString(16)}]});}
  guard();const previousNetwork=active.current.network;
  const id=walletChain(await currentProvider.request({method:'eth_chainId'}));
  guard();if(active.current.network!==previousNetwork&&id!==active.current.network)throw new WalletSessionError('Wallet connection changed. Please try again.');
  if(id!==active.current.network)session.current++;
  active.current={...active.current,network:id};setNetwork(id);
  if(id!==chain.id)throw new Error('Your wallet did not switch to DogeOS Chikyū Testnet.');
 };
 const transact=useCallback(async(contract:Address,abi:Abi,functionName:string,args:readonly unknown[]=[],value?:bigint)=>{
  if(!provider||!address)throw new Error('Connect your wallet to continue.');
  if(busy.current)throw new Error('A transaction is already in progress.');
  const start=session.current,account=address;
  const assertSession=()=>{if(session.current!==start||active.current.provider!==provider||active.current.address?.toLowerCase()!==account.toLowerCase())throw new WalletSessionError('Wallet account or connection changed. Please try again.');};
  const check=async()=>{
   const [accounts,chainId]=await Promise.all([provider.request({method:'eth_accounts'}),provider.request({method:'eth_chainId'})]);
   assertSession();if(walletAccount(accounts)?.toLowerCase()!==account.toLowerCase())throw new WalletSessionError('Wallet account or connection changed. Please try again.');
   if(walletChain(chainId)!==chain.id)throw new WalletSessionError('Switch to DogeOS Chikyū Testnet first.');
  };
  busy.current=true;setPending(true);setStage('Checking wallet…');setLastHash(null);setFeeEstimate(null);
  try{
   await check();setStage('Checking transaction…');
   await publicClient.simulateContract({address:contract,abi,functionName,args,account,value,type:'eip1559'});
   setStage('Estimating DogeOS network fees…');
   const estimate=await estimateDogeosFees(publicClient,{account,to:contract,data:encodeFunctionData({abi,functionName,args}),value});
   setFeeEstimate(estimate.total);
   const balance=await publicClient.getBalance({address:account});
   if(balance<(value??0n)+estimate.total)throw new Error('Keep about '+formatDoge(estimate.total)+' DOGE for network fees in addition to the transaction amount.');
   await check();setStage('Confirm in your wallet');
   const guarded={request:new Proxy(provider.request,{apply:async(target,_receiver,parameters)=>{if(parameters[0].method==='eth_sendTransaction'||parameters[0].method==='eth_signTransaction'){await check();assertSession();}return Reflect.apply(target,provider,parameters);}})};
   const hash=await walletClient(guarded).writeContract({address:contract,abi,functionName,args,account,value,type:'eip1559',gas:estimate.gas,maxFeePerGas:estimate.maxFeePerGas,maxPriorityFeePerGas:estimate.maxPriorityFeePerGas});
   setLastHash(hash);setStage('Waiting for confirmation…');let replacementReason:string|null=null;
   const receipt=await publicClient.waitForTransactionReceipt({hash,timeout:180000,confirmations:2,onReplaced:event=>{replacementReason=event.reason;setLastHash(event.transactionReceipt.transactionHash);}});
   assertReceiptSuccess(receipt,replacementReason);
   if(session.current!==start||active.current.provider!==provider)throw new Error('Transaction confirmed for your previous wallet session. Refresh to view the result.');
   setStage('Confirmed');return receipt;
  }finally{busy.current=false;setPending(false);setFeeEstimate(null);}
 },[provider,address]);
 return {options,address,network,connecting,pending,stage,lastHash,feeEstimate,connect,disconnect,switchNetwork,transact};
}
export type Wallet=ReturnType<typeof useWallet>;
export const errorMessage=walletErrorMessage;
