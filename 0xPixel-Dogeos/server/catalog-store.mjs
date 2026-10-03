import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { parseEventLogs } from 'viem';
import { queryParams, tokenId } from './validation.mjs';
import { readLimitedJsonResponse } from '../../scripts/lib/http-json.mjs';

const CACHE_VERSION = 2;
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export async function createCatalogStore({ dep, nft, market, client, cacheFile, syncInterval = 3000, graphEndpoint = () => process.env.SUBGRAPH_URL, decode = log => parseEventLogs({ abi: same(log.address, dep.DogeosPixel.address) ? nft : market, logs: [log], strict: true })[0] }) {
  const start = Math.min(dep.DogeosPixel.startBlock, dep.PixelMarket.startBlock);
  const identity = `${dep.chainId}:${dep.DogeosPixel.address.toLowerCase()}:${dep.PixelMarket.address.toLowerCase()}:${start}`;
  const fresh = () => ({ version: CACHE_VERSION, identity, block: start - 1, eventBlock: start - 1, hash: null, tokens: {}, collections: {}, offers: {}, approvals: {}, activity: [] });
  let state = fresh(), flight = null, lastSync = 0, artGeneration = 0;
  const arts = new Map(), artFlights = new Map();
  try {
    const saved = JSON.parse(await readFile(cacheFile, 'utf8'));
    if (saved.version === CACHE_VERSION && saved.identity === identity && Number.isSafeInteger(saved.block) && saved.block >= start - 1 && saved.tokens && saved.collections && saved.offers && saved.approvals && Array.isArray(saved.activity)) state = saved;
  } catch {}

  function apply(next, log) {
    const parsed = decode(log);
    if (!parsed) return;
    next.eventBlock = Number(log.blockNumber);
    const a = parsed.args, event = parsed.eventName, id = String(a.tokenId ?? '');
    if (event === 'Transfer') {
      next.tokens[id] ??= { id, name: '', creator: a.to, owner: a.to, collectionId: '0', listing: null, nonce: '0', tokenApproved: false };
      const token = next.tokens[id];
      token.owner = a.to;
      token.tokenApproved = false;
      if (!same(a.from, a.to)) { token.nonce = String(BigInt(token.nonce) + 1n); token.listing = null; }
    }
    if (event === 'Minted') Object.assign(next.tokens[id] ??= { id, owner: a.creator, collectionId: '0', listing: null, nonce: '1', tokenApproved: false }, { name: a.name, creator: a.creator, minted: true });
    if (event === 'Approval' && next.tokens[id]) next.tokens[id].tokenApproved = same(a.approved, dep.PixelMarket.address);
    if (event === 'ApprovalForAll' && same(a.operator, dep.PixelMarket.address)) next.approvals[a.owner.toLowerCase()] = a.approved;
    if (event === 'CollectionCreated') next.collections[String(a.collectionId)] = { id: String(a.collectionId), owner: a.owner, name: a.name, description: a.description };
    if (event === 'CollectionUpdated' && next.collections[String(a.collectionId)]) Object.assign(next.collections[String(a.collectionId)], { name: a.name, description: a.description });
    if (event === 'TokenCollectionChanged' && next.tokens[id]) next.tokens[id].collectionId = String(a.collectionId);
    if (event === 'Listed' && next.tokens[id]) next.tokens[id].listing = { id: String(a.listingId), seller: a.seller, price: String(a.price), expiry: Number(a.expiry), nonce: String(a.nonce) };
    if (['ListingCancelled', 'Sold'].includes(event) && next.tokens[id] && next.tokens[id].listing?.id === String(a.listingId)) next.tokens[id].listing = null;
    if (event === 'OfferMade') next.offers[String(a.offerId)] = { id: String(a.offerId), tokenId: id, bidder: a.bidder, amount: String(a.amount), expiry: Number(a.expiry) };
    if (['OfferCancelled', 'OfferAccepted'].includes(event)) delete next.offers[String(a.offerId)];
    if (['Minted', 'Sold', 'Listed', 'OfferMade', 'OfferAccepted', 'CollectionCreated', 'CollectionUpdated', 'Withdrawn', 'TokenCollectionChanged', 'ListingCancelled', 'OfferCancelled', 'Transfer'].includes(event)) {
      const eventId = `${log.transactionHash}:${log.logIndex}`;
      next.activity.unshift({ id: eventId, type: event, tokenId: id, account: a.creator ?? a.seller ?? a.bidder ?? a.owner ?? a.account ?? a.to ?? null, amount: String(a.price ?? a.amount ?? 0), block: Number(log.blockNumber), hash: log.transactionHash });
      next.activity = next.activity.slice(0, 300);
    }
  }

  async function persist(next) {
    await mkdir(path.dirname(cacheFile), { recursive: true });
    const temporary = `${cacheFile}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(next));
    await rename(temporary, cacheFile);
  }

  async function sync(force = false) {
    if (flight) return flight;
    if (!force && Date.now() - lastSync < syncInterval) return;
    flight = (async () => {
      const head = await client.getBlockNumber({ cacheTime: 0 });
      let reset = BigInt(state.block) > head;
      if (state.hash && !reset) reset = (await client.getBlock({ blockNumber: BigInt(state.block) })).hash !== state.hash;
      let next = reset ? fresh() : structuredClone(state);
      for (let from = BigInt(next.block + 1); from <= head; from += 1000n) {
        const to = from + 999n < head ? from + 999n : head;
        const anchor = (await client.getBlock({ blockNumber: to })).hash;
        const logs = await client.getLogs({ address: [dep.DogeosPixel.address, dep.PixelMarket.address], fromBlock: from, toBlock: to });
        logs.sort((a, b) => compare(a.blockNumber, b.blockNumber) || a.logIndex - b.logIndex);
        const chunk = structuredClone(next);
        for (const log of logs) apply(chunk, log);
        chunk.block = Number(to);
        chunk.hash = (await client.getBlock({ blockNumber: to })).hash;
        if (!same(chunk.hash, anchor)) throw new Error('Chain changed while indexing; retry the canonical range.');
        await persist(chunk);
        next = chunk;
        state = chunk;
        if (reset) { artGeneration++; arts.clear(); artFlights.clear(); reset = false; }
      }
      if (reset) { await persist(next); state = next; artGeneration++; arts.clear(); artFlights.clear(); }
      lastSync = Date.now();
    })().finally(() => { flight = null; });
    return flight;
  }

  const readNFT = (functionName, args = [], blockNumber) => client.readContract({ address: dep.DogeosPixel.address, abi: nft, functionName, args, blockNumber });
  const readMarket = (functionName, args = [], blockNumber) => client.readContract({ address: dep.PixelMarket.address, abi: market, functionName, args, blockNumber });
  async function artwork(id, block) {
    const key = tokenId(String(id));
    const generation = artGeneration;
    try {
    let art = arts.get(key);
    if (!art) {
      const flightKey = `${key}:${block}`;
      let pending = artFlights.get(flightKey);
      if (!pending) {
        pending = readNFT('tokenPackedData', [BigInt(key)], block).then(a => ({ id: key, name: a[0], description: a[1], grid: Number(a[2]), pixels: a[3], creator: a[4], mintedAt: Number(a[5]), artworkHash: a[6] }));
        artFlights.set(flightKey, pending);
      }
      try { art = await pending; if(generation===artGeneration){arts.set(key, art); if (arts.size > 1000) arts.delete(arts.keys().next().value);} }
      finally { if(artFlights.get(flightKey)===pending)artFlights.delete(flightKey); }
    }
    if(generation!==artGeneration)throw new Error('Chain changed while reading token; retry.');
    return art;
    } catch(error) {
      const seen=new Set();for(let cause=error;cause&&!seen.has(cause);cause=cause.cause){seen.add(cause);if(cause.data?.errorName==='ERC721NonexistentToken')throw Object.assign(new Error('Pixel not found.'),{status:404});}
      throw error;
    }
  }
  async function token(id, blockNumber) {
    const key=tokenId(String(id));
    // Public token requests verify the canonical checkpoint even during the sync
    // cooldown. Catalogue calls pass their existing snapshot and share its reads.
    if(blockNumber===undefined){await sync(true);blockNumber=BigInt(state.block);}
    const generation=artGeneration,block=blockNumber;
    const art=await artwork(key,block);
    const [owner,collectionId,listing,active]=await Promise.all([readNFT('ownerOf',[BigInt(key)],block),readNFT('tokenCollection',[BigInt(key)],block),readMarket('listings',[BigInt(key)],block),readMarket('isListingActive',[BigInt(key)],block)]);
    if(generation!==artGeneration)throw new Error('Chain changed while reading token; retry.');
    return {...art,owner,collectionId:String(collectionId),listing:active?{seller:listing[0],price:String(listing[1]),expiry:Number(listing[2]),id:String(listing[4])}:null};
  }

  const active = (item, snapshot, now) => item.listing && item.listing.expiry > now && same(item.owner, item.listing.seller) && item.listing.nonce === item.nonce && (item.tokenApproved || snapshot.approvals[item.owner.toLowerCase()]);
  function candidates(query, snapshot, now) {
    const items = Object.values(snapshot.tokens).filter(item => item.minted && (!query.owner || same(item.owner, query.owner)) && (!query.collection || item.collectionId === query.collection) && (!query.search || item.name.toLowerCase().includes(query.search.toLowerCase())) && (query.listed !== 'true' || active(item, snapshot, now)));
    return items.sort((a, b) => query.sort === 'price' ? compare(Boolean(active(b, snapshot, now)), Boolean(active(a, snapshot, now))) || (active(a,snapshot,now)&&active(b,snapshot,now)?compare(BigInt(a.listing.price),BigInt(b.listing.price)):0) || compare(BigInt(b.id), BigInt(a.id)) : compare(BigInt(b.id), BigInt(a.id)));
  }
  async function mapLimit(items, fn) {
    let next = 0;
    const result = new Array(items.length);
    await Promise.all(Array.from({ length: Math.min(6, items.length) }, async () => { while (next < items.length) { const index = next++; result[index] = await fn(items[index]); } }));
    return result;
  }
  function collections(snapshot) {
    const counts = new Map();
    for (const item of Object.values(snapshot.tokens)) if (item.minted) counts.set(item.collectionId, (counts.get(item.collectionId) || 0) + 1);
    return Object.values(snapshot.collections).map(collection => ({ ...collection, count: counts.get(collection.id) || 0 }));
  }

  async function graphDiscovery(query, snapshot, selected, now) {
    if (!graphEndpoint() || query.sort === 'price' || query.collection === '0') return false;
    let where = {};
    if (query.owner) where.owner = query.owner.toLowerCase();
    if (query.collection) where.collection = query.collection;
    if (query.search) where.name_contains_nocase = query.search;
    if (query.listed === 'true') {
      const common = { ...where, listing_: { status: 'ACTIVE', expiry_gt: String(now) } };
      where = { or: [{ ...common, tokenApproved: true }, { ...common, ownerApproval_: { approved: true } }] };
    }
    const response = await fetch(graphEndpoint(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: `query Catalog($where: Pixel_filter!, $first: Int!, $skip: Int!) { _meta { block { number hash } hasIndexingErrors } pixels(first:$first,skip:$skip,where:$where,orderBy:tokenId,orderDirection:desc){ id } stats(id:"global"){minted} }`, variables: { where, first: query.limit + 1, skip: query.offset } }), signal: AbortSignal.timeout(6000) });
    if (!response.ok) return false;
    const { data, errors } = await readLimitedJsonResponse(response, { label: 'DogeOS subgraph' });
    const meta = data?._meta;
    if (errors?.length || !meta || meta.hasIndexingErrors || meta.block.number < snapshot.block - 15 || meta.block.number < snapshot.eventBlock || !Array.isArray(data.pixels) || BigInt(data.stats?.minted ?? -1) !== BigInt(Object.values(snapshot.tokens).filter(item => item.minted).length)) return false;
    if (meta.block.hash) {
      const canonical = meta.block.number === snapshot.block ? snapshot.hash : (await client.getBlock({ blockNumber: BigInt(meta.block.number) })).hash;
      if (!same(canonical, meta.block.hash)) return false;
    }
    if (JSON.stringify(data.pixels.map(item => item.id)) !== JSON.stringify(selected.map(item => item.id))) return false;
    return meta.block.number;
  }

  async function catalog(raw = {}) {
    const query = queryParams(raw);
    await sync();
    const snapshot = state, generation = artGeneration, now = Math.floor(Date.now() / 1000), items = candidates(query, snapshot, now);
    const selected = items.slice(query.offset, query.offset + query.limit + 1);
    let graphBlock = false;
    try { graphBlock = await graphDiscovery(query, snapshot, selected, now); } catch {}
    if (generation !== artGeneration) throw new Error('Chain changed while reading catalogue; retry.');
    const tokens = await mapLimit(selected.slice(0, query.limit), item => token(item.id, BigInt(snapshot.block)));
    if (generation !== artGeneration) throw new Error('Chain changed while reading catalogue; retry.');
    return { tokens: query.listed === 'true' ? tokens.filter(item => item.listing) : tokens, total: items.length, next: selected.length > query.limit ? query.offset + query.limit : null, collections: collections(snapshot), activity: snapshot.activity.slice(0, 40), indexedBlock: graphBlock || snapshot.block, source: graphBlock ? 'subgraph' : 'rpc', supply: Object.values(snapshot.tokens).filter(item => item.minted).length };
  }
  async function offerList(raw = {}) {
    const query = queryParams(raw, 'offers');
    await sync();
    const snapshot = state, now = Math.floor(Date.now() / 1000);
    const items=Object.values(snapshot.offers).filter(offer => (!query.tokenId || offer.tokenId === query.tokenId) && (!query.account || same(offer.bidder, query.account) || same(snapshot.tokens[offer.tokenId]?.owner, query.account))).sort((a, b) => compare(BigInt(b.id), BigInt(a.id)));
    const offers=items.slice(query.offset,query.offset+query.limit).map(offer=>({...offer,expired:offer.expiry<=now}));
    return query.format==='page'?{offers,total:items.length,next:query.offset+query.limit<items.length?query.offset+query.limit:null}:offers;
  }
  async function collectionPage(raw={}) {
    const query=queryParams(raw,'collections');await sync();const snapshot=state,generation=artGeneration;
    const items=collections(snapshot).filter(collection=>(!query.owner||same(collection.owner,query.owner))&&(!query.search||collection.name.toLowerCase().includes(query.search.toLowerCase()))).sort((a,b)=>compare(BigInt(b.id),BigInt(a.id)));
    const selected=items.slice(query.offset,query.offset+query.limit),members=new Map(selected.map(collection=>[collection.id,[]]));
    for(const item of Object.values(snapshot.tokens).filter(item=>item.minted).sort((a,b)=>compare(BigInt(b.id),BigInt(a.id)))){const group=members.get(item.collectionId);if(group&&group.length<3)group.push(item.id);}
    const previews=await mapLimit([...members.values()].flat(),async id=>{const {name,grid,pixels}=await artwork(id,BigInt(snapshot.block));return {id,name,grid,pixels};});
    if(generation!==artGeneration)throw new Error('Chain changed while reading collections; retry.');
    const byId=new Map(previews.map(preview=>[preview.id,preview]));
    return {collections:selected.map(collection=>({...collection,previews:members.get(collection.id).map(id=>byId.get(id))})),total:items.length,next:query.offset+query.limit<items.length?query.offset+query.limit:null,indexedBlock:snapshot.block};
  }
  async function status() {
    await sync();
    return { chainId: dep.chainId, indexedBlock: state.block, supply: Object.values(state.tokens).filter(item => item.minted).length, collectionCount: Object.keys(state.collections).length, source: 'rpc', subgraphConfigured: Boolean(graphEndpoint()) };
  }
  return { sync, token, catalog, offerList, collectionPage, status, readNFT, readMarket };
}
