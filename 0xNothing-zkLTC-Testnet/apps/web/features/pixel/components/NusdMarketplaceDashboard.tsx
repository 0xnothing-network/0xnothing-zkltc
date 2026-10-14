"use client";

import Link from "next/link";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowRight, ArrowUpRight, ArrowsClockwise, Clock, Coins, ImageSquare, MagnifyingGlass, Plus, ShieldCheck, Stack, Wallet } from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatUnits, parseAbi, type Address } from "viem";
import { useAccount, useConfig, useConnect, usePublicClient, useSwitchChain } from "wagmi";
import { useProtocolTransaction, type ProtocolCall, type ProtocolStage } from "@fi/lib/hooks/useProtocolTransaction";
import { getAddressExplorerUrl, getMarketplaceTxUrl, getTokenExplorerUrl, shortenAddress } from "@/lib/contract";
import { NFT_NUSD_ADDRESS, NUSD_MARKETPLACE_ADDRESS } from "@/lib/nusdMarketplaceConfig";
import { NUSD_CATALOGUE_LIMIT, NUSD_MARKET_PAGE_SIZE, NusdMarketplaceAbi, nusdFunding, nusdNftSelection, offerExpiry, parseNusdPrice, readNusdListing, readNusdMarket, readNusdOffer, requireFreshNusdMarket } from "@/lib/nusdMarketplace";
import { fetchJson } from "@/lib/http";
import { createWalletSessionGuard } from "@/lib/walletSession";
import { getPixelImageUrl } from "@/lib/pixelImage";
import { PIXEL_COLLECTIONS } from "@/lib/pixelCollections";
import { filterNusdListings, nusdArtworkKey, nusdArtworkRequests, readNusdArtwork, type NusdListingSort } from "@/lib/nusdMarketplaceView";
import styles from "./NusdMarketplaceDashboard.module.css";
import { NusdMarketplaceActivity } from "./NusdMarketplaceActivity";

const nftApprovalAbi = parseAbi([
  "function getApproved(uint256 tokenId) view returns (address)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function approve(address spender, uint256 tokenId)",
  "function ownerOf(uint256 tokenId) view returns (address)",
]);
type OwnedToken = { collection: Address; tokenId: string; name: string; listing: { listingId: string; price: string } | null };
type MarketState = Awaited<ReturnType<typeof readNusdMarket>>;
type MarketHeader = Omit<MarketState, "listings" | "offers" | "catalogueComplete">;
type Action = { call: ProtocolCall; payment?: bigint; nftApproval?: { collection: Address; tokenId: bigint }; settlement?: boolean };
const NO_OFFERS = { offers: false } as const;
const NO_LISTINGS = { listings: false } as const;
const HEADER_ONLY = { listings: false, offers: false } as const;

function amount(value: bigint) { return formatUnits(value, 18); }

function ArtworkPreview({ collection, tokenId, name, compact = false }: { collection: Address; tokenId: bigint | string; name: string; compact?: boolean }) {
  const [failed, setFailed] = useState(false);
  return <div className={compact ? styles.thumbnail : styles.artwork}>
    {failed ? <div className={styles.imageFallback}><ImageSquare size={32} aria-hidden="true" /><span>{compact ? `#${tokenId}` : "Image unavailable"}</span></div>
      : <Image src={getPixelImageUrl(tokenId, collection)} alt={name} width={512} height={512} unoptimized className={styles.artImage} onError={() => setFailed(true)} />}
  </div>;
}

export function NusdMarketplaceDashboard({ initialTokenKey = "" }: { initialTokenKey?: string } = {}) {
  const { address, chainId } = useAccount();
  const config = useConfig();
  const client = usePublicClient({ chainId: 4441 });
  const connection = useConnect();
  const switcher = useSwitchChain();
  const transaction = useProtocolTransaction();
  const queryClient = useQueryClient();
  const lock = useRef(false);
  const [preparing, setPreparing] = useState(false);
  const [message, setMessage] = useState("");
  const [page, setPage] = useState(0);
  const [tokenKey, setTokenKey] = useState(initialTokenKey);
  const [listPrice, setListPrice] = useState("");
  const [offerListing, setOfferListing] = useState("");
  const [offerPrice, setOfferPrice] = useState("");
  const [duration, setDuration] = useState("72");
  const [search, setSearch] = useState("");
  const [collection, setCollection] = useState("");
  const [ownOnly, setOwnOnly] = useState(false);
  const [sort, setSort] = useState<NusdListingSort>("newest");
  const [workflow, setWorkflow] = useState<"sell" | "offer">("sell");
  // A complete catalogue (up to 1,000 listings) is paged locally, so only a larger
  // market needs a new listing read per page; offers are always paged onchain.
  const [pagedCatalogue, setPagedCatalogue] = useState(false);
  // Offers are not limited to listed NFTs: the contract escrows an offer on any
  // existing token of an allowed collection, so the desk also accepts a token ID.
  const [offerCollection, setOfferCollection] = useState<string>(PIXEL_COLLECTIONS[PIXEL_COLLECTIONS.length - 1].address);
  const [offerTokenId, setOfferTokenId] = useState("");
  const listingPage = pagedCatalogue ? page : 0;
  const market = useQuery({
    queryKey: ["pixel-nusd-market", NUSD_MARKETPLACE_ADDRESS, address, listingPage],
    queryFn: () => {
      if (!client || !NUSD_MARKETPLACE_ADDRESS) throw new Error("NUSD marketplace not configured");
      return readNusdMarket(client, NUSD_MARKETPLACE_ADDRESS, NFT_NUSD_ADDRESS, address, listingPage, true, NO_OFFERS);
    },
    enabled: Boolean(client && NUSD_MARKETPLACE_ADDRESS), staleTime: 10_000, refetchInterval: 30_000, retry: 1,
    // Keep the current wallet's market visible while another page loads so the
    // offers, activity and trading desk stay mounted; never carry over another wallet's balances.
    placeholderData: (previous, previousQuery) => previousQuery?.queryKey[2] === address ? previous : undefined,
  });
  const offerPage = useQuery({
    queryKey: ["pixel-nusd-offers", NUSD_MARKETPLACE_ADDRESS, page],
    queryFn: () => {
      if (!client || !NUSD_MARKETPLACE_ADDRESS) throw new Error("NUSD marketplace not configured");
      return readNusdMarket(client, NUSD_MARKETPLACE_ADDRESS, NFT_NUSD_ADDRESS, undefined, page, false, NO_LISTINGS);
    },
    enabled: Boolean(client && NUSD_MARKETPLACE_ADDRESS), staleTime: 10_000, refetchInterval: 30_000, retry: 1,
    placeholderData: (previous) => previous,
  });
  const owned = useQuery({
    queryKey: ["pixel-nusd-owned", address],
    queryFn: async () => (await fetchJson<{ tokens: OwnedToken[] }>(`/api/user-nfts?address=${address}&force=1`)).tokens,
    enabled: Boolean(address && NUSD_MARKETPLACE_ADDRESS), staleTime: 15_000, retry: 1,
  });
  const state = market.data;
  const offers = offerPage.data?.offers ?? [];
  const offerClock = offerPage.data?.timestamp ?? state?.timestamp ?? 0n;
  const readFailed = market.isError || offerPage.isError;
  useEffect(() => {
    if (state && !market.isPlaceholderData) setPagedCatalogue(!state.catalogueComplete);
  }, [state, market.isPlaceholderData]);
  const artworkRequests = nusdArtworkRequests([...(state?.listings ?? []), ...offers], NUSD_CATALOGUE_LIMIT + NUSD_MARKET_PAGE_SIZE);
  const artwork = useQuery({
    queryKey: ["pixel-nusd-artwork", artworkRequests.map((request) => request.url)],
    queryFn: ({ signal }) => readNusdArtwork(artworkRequests, (url) => fetchJson(url, { signal })),
    enabled: Boolean(NUSD_MARKETPLACE_ADDRESS && artworkRequests.length), staleTime: 60_000, retry: 1,
    placeholderData: (previous) => previous,
  });
  const busy = preparing || transaction.pending;
  const ready = Boolean(state && !readFailed && !market.isPlaceholderData && !offerPage.isPlaceholderData && !busy && address && chainId === 4441);
  const paused = state?.paused ?? true;
  const selectedToken = owned.data?.find((token) => `${token.collection.toLowerCase()}:${token.tokenId}` === tokenKey);
  const selectedListing = state?.listings.find((listing) => listing.id.toString() === offerListing);
  const manualCollection = PIXEL_COLLECTIONS.find((entry) => entry.address === offerCollection)?.address;
  const manualTarget = !selectedListing && manualCollection && nusdNftSelection(manualCollection, offerTokenId.trim())
    ? { collection: manualCollection as Address, tokenId: BigInt(offerTokenId.trim()) }
    : undefined;
  const offerAsset = selectedListing ?? manualTarget;
  const listedPrice = parseNusdPrice(listPrice);
  const offeredPrice = parseNusdPrice(offerPrice);
  const filteredListings = filterNusdListings(state?.listings ?? [], artwork.data?.tokens ?? {}, { search, collection, ownOnly, address, sort });
  const listingCount = state?.catalogueComplete ? BigInt(filteredListings.length) : state?.listingCount ?? 0n;
  const offerCount = offerPage.data?.offerCount ?? state?.offerCount ?? 0n;
  const maxCount = listingCount > offerCount ? listingCount : offerCount;
  const pages = (maxCount + BigInt(NUSD_MARKET_PAGE_SIZE) - 1n) / BigInt(NUSD_MARKET_PAGE_SIZE);
  const totalPages = Math.max(1, Number(pages > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : pages));
  const safePage = Math.min(page, totalPages - 1);
  useEffect(() => {
    if (state && safePage !== page) setPage(safePage);
  }, [state, page, safePage]);
  const visibleListings = state?.catalogueComplete ? filteredListings.slice(safePage * NUSD_MARKET_PAGE_SIZE, (safePage + 1) * NUSD_MARKET_PAGE_SIZE) : filteredListings;
  const collections = Array.from(new Set([collection, ...(state?.listings.map((listing) => listing.collection.toLowerCase()) ?? [])])).filter(Boolean);
  const filtered = Boolean(search.trim() || collection || ownOnly);
  const offerFunding = state && offeredPrice ? nusdFunding(offeredPrice, state.credit) : undefined;
  const tradeAsset = workflow === "sell" ? selectedToken : offerAsset
    ? { collection: offerAsset.collection, tokenId: offerAsset.tokenId.toString(), name: nftName(offerAsset.collection, offerAsset.tokenId) }
    : undefined;
  const tradeAmount = workflow === "sell" ? listedPrice : offeredPrice;
  const tradeStep = !tradeAsset ? 0 : !tradeAmount ? 1 : 2;
  const listingBurn = state && listedPrice ? listedPrice * BigInt(state.burnBps) / 10_000n : undefined;
  const listingCreatorFee = state && listedPrice ? listedPrice * BigInt(state.creatorBps) / 10_000n : undefined;
  function nftName(collection: Address, tokenId: bigint) {
    return artwork.data?.tokens[nusdArtworkKey(collection, tokenId)]?.name || `0xPixel #${tokenId}`;
  }

  async function act(build: (current: MarketHeader) => Promise<Action> | Action) {
    if (!address || chainId === undefined || !client || !NUSD_MARKETPLACE_ADDRESS || lock.current || transaction.pending) return;
    lock.current = true;
    setPreparing(true);
    setMessage("");
    transaction.reset();
    try {
      const assertWalletUnchanged = createWalletSessionGuard(config, address, chainId);
      assertWalletUnchanged();
      // Pre-signing reads only the verified header (paused, credit, balance, block);
      // each action then re-reads exactly the listing or offer it settles.
      const current = await readNusdMarket(client, NUSD_MARKETPLACE_ADDRESS, NFT_NUSD_ADDRESS, address, 0, false, HEADER_ONLY).catch(() => {
        throw new Error("Cannot read fresh marketplace state");
      });
      assertWalletUnchanged();
      const action = await build(current);
      requireFreshNusdMarket(current, action.settlement ?? true);
      const funding = action.payment ? nusdFunding(action.payment, current.credit) : undefined;
      if (funding && current.balance < funding.walletPayment) throw new Error("Not enough NUSD. Marketplace credits are used first; zkLTC is only for gas.");
      let stages: ProtocolStage[] | undefined;
      if (action.nftApproval) {
        const { collection, tokenId } = action.nftApproval;
        const [approved, approvedForAll] = await Promise.all([
          client.readContract({ address: collection, abi: nftApprovalAbi, functionName: "getApproved", args: [tokenId] }),
          client.readContract({ address: collection, abi: nftApprovalAbi, functionName: "isApprovedForAll", args: [address, NUSD_MARKETPLACE_ADDRESS] }),
        ]);
        if (!approvedForAll && approved.toLowerCase() !== NUSD_MARKETPLACE_ADDRESS.toLowerCase()) {
          stages = [{ call: { address: collection, abi: nftApprovalAbi, functionName: "approve", args: [NUSD_MARKETPLACE_ADDRESS, tokenId] } }, { call: action.call }];
        }
      }
      assertWalletUnchanged();
      requireFreshNusdMarket(current, action.settlement ?? true);
      const hash = stages
        ? await transaction.execute({ stages })
        : await transaction.execute({ call: action.call, approval: funding ? { token: NFT_NUSD_ADDRESS, spender: NUSD_MARKETPLACE_ADDRESS, amount: funding.walletPayment } : undefined });
      if (hash) { await Promise.all([market.refetch(), offerPage.refetch(), owned.refetch(), queryClient.invalidateQueries({ queryKey: ["pixel-nusd-activity"] })]); }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Marketplace request failed. No automatic retry.");
    } finally { setPreparing(false); lock.current = false; }
  }

  function call(functionName: string, args: readonly unknown[]): ProtocolCall {
    return { address: NUSD_MARKETPLACE_ADDRESS, abi: NusdMarketplaceAbi, functionName, args };
  }

  function refresh() {
    void Promise.all([market.refetch(), offerPage.refetch(), queryClient.invalidateQueries({ queryKey: ["pixel-nusd-activity"] })]);
  }

  return <section className={styles.page} aria-labelledby="nusd-market-title" lang="en">
    <div className={styles.topline}>
      <span className={styles.eyebrow}>0xPixel / marketplace</span>
      <span className={styles.network}><span aria-hidden="true" />LiteForge · Testnet</span>
    </div>
    <header className={styles.hero}>
      <div className={styles.intro}>
        <h1 id="nusd-market-title">Marketplace<span className={styles.currencyLabel}>NUSD</span></h1>
        <p>Discover pixel art. Trade directly from your wallet on LiteForge.</p>
        <div className={styles.heroActions}>
          <a className={styles.primaryButton} href="#sell-nusd" onClick={() => setWorkflow("sell")}><Plus size={18} aria-hidden="true" />List an NFT</a>
          <Link className={styles.secondaryButton} href="/0xpixel/gallery">My NFTs<ArrowUpRight size={18} aria-hidden="true" /></Link>
        </div>
        <nav className={styles.marketNav} aria-label="Marketplace sections"><a href="#market-explore">Explore</a><a href="#market-offers">Offers</a><a href="#market-activity">Activity</a><a href="#sell-nusd" onClick={() => setWorkflow("sell")}>Sell an NFT</a></nav>
      </div>
      <aside className={styles.walletPanel} aria-label="Your NUSD balances">
        <div className={styles.walletHeading}><span><Wallet size={18} aria-hidden="true" />Trading wallet</span><span className={styles.small}>{address ? shortenAddress(address) : "Not connected"}</span></div>
        <p className={styles.balanceLabel}>Spendable NUSD</p>
        <p className={styles.totalBalance}>{address && state && !market.isError ? amount(state.balance + state.credit) : "—"}<span>NUSD</span></p>
        <dl className={styles.walletBreakdown}>
          <div><dt>In wallet</dt><dd>{address && state && !market.isError ? amount(state.balance) : "—"}</dd></div>
          <div><dt>Marketplace credits</dt><dd>{address && state && !market.isError ? amount(state.credit) : "—"}</dd></div>
        </dl>
        {NUSD_MARKETPLACE_ADDRESS && (!address
          ? <button className={styles.primaryButton} disabled={connection.isPending} onClick={() => {
              const connector = connection.connectors.find((item) => item.type === "injected") ?? connection.connectors[0];
              if (!connector) { setMessage("Install a browser wallet first."); return; }
              void connection.connectAsync({ connector }).catch(() => setMessage("Could not connect wallet. Check the request in your wallet."));
            }}>{connection.isPending ? "Connecting" : "Connect wallet"}<ArrowRight size={18} aria-hidden="true" /></button>
          : chainId !== 4441
            ? <button className={styles.primaryButton} disabled={switcher.isPending} onClick={() => switcher.switchChain({ chainId: 4441 })}>Switch to LiteForge 4441<ArrowRight size={18} aria-hidden="true" /></button>
            : <button className={styles.secondaryButton} disabled={!ready || !state?.credit} onClick={() => void act(() => ({ call: call("withdrawNusd", [address]), settlement: false }))}>Withdraw credits to wallet<ArrowDown size={17} aria-hidden="true" /></button>)}
        <div className={styles.walletFootnote}><span>Marketplace credits are used first.</span><Link href="/0xFi">Get NUSD<ArrowUpRight size={14} aria-hidden="true" /></Link></div>
      </aside>
    </header>

    {!NUSD_MARKETPLACE_ADDRESS ? <div className={styles.notice} role="status"><h2>NUSD marketplace not deployed / configured</h2><p>Transactions are disabled until a valid NUSD marketplace is configured.</p></div> : <>
      {readFailed && <div role="alert" className={styles.error}><strong>Unable to read the marketplace.</strong><p>Transactions are disabled. Check your connection and the contract address, token and implementation.</p><button className={styles.secondaryButton} disabled={busy || market.isFetching || offerPage.isFetching} onClick={() => void Promise.all([market.refetch(), offerPage.refetch()])}>Retry</button></div>}
      {paused && state && <div className={styles.notice} role="status"><strong>The marketplace is paused.</strong> You can still cancel listings, refund offers and withdraw credits.</div>}
      {(busy || message || transaction.message) && <div className={styles.transactionNotice} role={message || transaction.phase === "error" ? "alert" : "status"} aria-live="polite">
        <span className={styles.eyebrow}>NUSD transaction</span>
        <p>{message || transaction.message || "Reading fresh state and preparing your transaction…"}</p>
        {transaction.hash && <a href={getMarketplaceTxUrl(transaction.hash)} target="_blank" rel="noopener noreferrer">View transaction<ArrowUpRight size={15} aria-hidden="true" /></a>}
      </div>}

      <dl className={styles.marketStats}>
        <div><dt>Active listings</dt><dd>{state ? state.listingCount.toString() : "—"}</dd></div>
        <div><dt>Active offers</dt><dd>{state ? state.offerCount.toString() : "—"}</dd></div>
        <div><dt>Trading volume</dt><dd>{state ? amount(state.volume) : "—"}<span>NUSD</span></dd></div>
        <div><dt>Sale fee</dt><dd>{state ? `${state.feeBps / 100}%` : "—"}<span>{state ? `${state.burnBps / 100}% burned · ${state.creatorBps / 100}% creator` : ""}</span></dd></div>
      </dl>

      <section id="market-explore" className={styles.browse} aria-labelledby="nusd-listings-title" aria-busy={market.isFetching}>
        <div className={styles.sectionHeading}>
          <div><span className={styles.eyebrow}>Browse the collection</span><h2 id="nusd-listings-title">Artworks for sale<span className={styles.count}>{state?.catalogueComplete ? filteredListings.length : visibleListings.length}</span></h2></div>
          <button className={styles.iconButton} aria-label="Refresh marketplace" disabled={busy || market.isFetching} onClick={refresh}><ArrowsClockwise size={18} className={market.isFetching ? styles.spinning : undefined} aria-hidden="true" /></button>
        </div>
        <div className={styles.toolbar}>
          <label className={styles.search}><MagnifyingGlass size={18} aria-hidden="true" /><span className={styles.srOnly}>Search NFTs</span><input type="search" value={search} onChange={(event) => { setSearch(event.target.value); setPage(0); }} maxLength={120} placeholder="Artwork name, #ID, address…" /></label>
          <label className={styles.filterSelect}><span className={styles.srOnly}>Collections</span><select value={collection} onChange={(event) => { setCollection(event.target.value); setPage(0); }}><option value="">All collections</option>{collections.map((item) => <option value={item} key={item}>{shortenAddress(item)}</option>)}</select></label>
          <label className={styles.filterSelect}><span className={styles.srOnly}>Sort listings</span><select value={sort} onChange={(event) => { setSort(event.target.value as NusdListingSort); setPage(0); }}><option value="newest">Recently listed</option><option value="price-asc">Price: low to high</option><option value="price-desc">Price: high to low</option></select></label>
        </div>
        <div className={styles.browseMeta}>
          <div className={styles.toggleGroup} role="group" aria-label="Filter by seller"><button aria-pressed={!ownOnly} onClick={() => { setOwnOnly(false); setPage(0); }}>All</button><button aria-pressed={ownOnly} disabled={!address} onClick={() => { setOwnOnly(true); setPage(0); }}>Mine</button></div>
          <p>{state?.catalogueComplete ? "Search and sort all active listings" : `Showing this page · up to ${NUSD_MARKET_PAGE_SIZE} listings`}</p>
        </div>
        {(artwork.isError || Boolean(artwork.data?.failed)) && <p className={styles.small} role="status">Some NFT names are unavailable. Images and actions still use the correct collection / token ID.</p>}
        {!state && !market.isError ? <div className={styles.nftGrid} role="status" aria-label="Loading listings"><span className={styles.srOnly}>Loading listings from the contract…</span>{Array.from({ length: 4 }, (_, index) => <div className={styles.skeletonCard} key={index}><div /><span /><span /></div>)}</div>
          : state && visibleListings.length === 0 ? <div className={styles.emptyState}>
              <div className={styles.pixelMotif} aria-hidden="true">{Array.from({ length: 25 }, (_, index) => <span key={index} />)}</div>
              <span className={styles.eyebrow}>{filtered ? "No results" : "A space for your artwork"}</span>
              <h3>{filtered ? "No matching NFTs." : "No artworks listed yet."}</h3>
              <p>{filtered ? "Try another name, token ID or collection." : "List your first NFT for NUSD, or explore the artworks in your gallery."}</p>
              {filtered ? <button className={styles.secondaryButton} onClick={() => { setSearch(""); setCollection(""); setOwnOnly(false); }}>Clear filters</button>
                : <a className={styles.primaryButton} href="#sell-nusd" onClick={() => setWorkflow("sell")}>List your artwork<Plus size={17} aria-hidden="true" /></a>}
            </div>
          : <div className={styles.nftGrid}>{visibleListings.map((listing) => {
              const isSeller = listing.seller.toLowerCase() === address?.toLowerCase();
              const funding = state ? nusdFunding(listing.price, state.credit) : undefined;
              const name = nftName(listing.collection, listing.tokenId);
              return <article className={styles.nftCard} key={listing.id.toString()} aria-label={name}>
                <a className={styles.artLink} href={getTokenExplorerUrl(listing.collection, listing.tokenId)} target="_blank" rel="noopener noreferrer" aria-label={`View ${name} on explorer`}><ArtworkPreview key={nusdArtworkKey(listing.collection, listing.tokenId)} collection={listing.collection} tokenId={listing.tokenId} name={name} /><span className={styles.tokenBadge}>#{listing.tokenId.toString()}</span><span className={styles.artExternal}><ArrowUpRight size={18} aria-hidden="true" /></span></a>
                <div className={styles.cardBody}>
                  <div className={styles.cardEyebrow}><span>0xPixel NFT</span><span title={listing.collection}>{shortenAddress(listing.collection)}</span></div>
                  <h3 title={name}>{name}</h3>
                  <p className={styles.seller}>{isSeller ? "Listed by you" : `Seller · ${shortenAddress(listing.seller)}`}</p>
                  <div className={styles.priceRow}><span>Listing price</span><strong>{amount(listing.price)}<small>NUSD</small></strong></div>
                  {!isSeller && address && funding && <details className={styles.fundingDetails}><summary>Payment breakdown</summary><dl><div><dt>From marketplace credits</dt><dd>{amount(funding.creditUsed)} NUSD</dd></div><div><dt>From your wallet</dt><dd>{amount(funding.walletPayment)} NUSD</dd></div></dl><p>Approve only the NUSD needed from your wallet. zkLTC pays for gas.</p></details>}
                  {isSeller ? <button className={styles.secondaryButton} disabled={!ready} onClick={() => void act(() => ({ call: call("cancelListing", [listing.id]), settlement: false }))}>Cancel listing</button>
                    : <div className={styles.cardActions}><button className={styles.primaryButton} disabled={!ready || paused} onClick={() => void act(async (current) => {
                        const fresh = await readNusdListing(client!, NUSD_MARKETPLACE_ADDRESS!, listing.id, current.blockNumber);
                        if (!fresh.active || fresh.price !== listing.price) throw new Error("The price or listing has changed. Refresh and review it before buying.");
                        const funding = nusdFunding(fresh.price, current.credit);
                        return { call: call("buy", [fresh.id, fresh.price, funding.walletPayment]), payment: fresh.price };
                      })}>Buy with NUSD<ArrowRight size={16} aria-hidden="true" /></button><a className={styles.offerLink} href="#offer-nusd" onClick={() => { setOfferListing(listing.id.toString()); setWorkflow("offer"); }}>Make offer</a></div>}
                </div>
              </article>;
            })}</div>}
      </section>

      {state && <>
        <section id="market-offers" className={styles.offersSection} aria-labelledby="nusd-offers-title">
          <div className={styles.sectionHeading}><div><span className={styles.eyebrow}>Market / 02</span><h2 id="nusd-offers-title">Escrowed offers<span className={styles.count}>{offers.length}</span></h2></div><span className={styles.escrowLabel}><Coins size={17} aria-hidden="true" />{amount(state.escrow)} NUSD escrowed across the market</span></div>
          {offers.length === 0 ? <div className={styles.emptyOffers}><Stack size={28} aria-hidden="true" /><div><h3>No offers on this page yet.</h3><p>Choose an NFT for sale and offer your price. NUSD stays in escrow until the offer is settled or refunded.</p></div><a href="#offer-nusd" className={styles.textLink} onClick={() => setWorkflow("offer")}>Make offer<ArrowUpRight size={16} aria-hidden="true" /></a></div>
            : <div className={styles.table}><table><caption className={styles.srOnly}>NUSD offers on page {page + 1}</caption><thead><tr><th scope="col">Artwork / offerer</th><th scope="col">Offer price</th><th scope="col">Expires</th><th scope="col">Actions</th></tr></thead><tbody>{offers.map((offer) => <tr key={offer.id.toString()}>
              <td><div className={styles.offerArtwork}><ArtworkPreview key={nusdArtworkKey(offer.collection, offer.tokenId)} compact collection={offer.collection} tokenId={offer.tokenId} name={nftName(offer.collection, offer.tokenId)} /><div><a href={getTokenExplorerUrl(offer.collection, offer.tokenId)} target="_blank" rel="noopener noreferrer">{nftName(offer.collection, offer.tokenId)}</a><small>#{offer.tokenId.toString()} · {shortenAddress(offer.collection)}</small><small>{shortenAddress(offer.offerer)}</small></div></div></td>
              <td className={styles.offerPrice}>{amount(offer.price)}<small>NUSD</small></td>
              <td><span className={styles.expiry}><Clock size={14} aria-hidden="true" />{offer.expiresAt <= offerClock ? "Expired" : "Active"}</span><small>{new Date(Number(offer.expiresAt) * 1000).toLocaleString("en-US")}</small></td>
              <td>{offer.offerer.toLowerCase() === address?.toLowerCase()
                ? <button className={styles.secondaryButton} disabled={!ready} onClick={() => void act(() => ({ call: call("cancelOffer", [offer.id]), settlement: false }))}>Cancel and refund credits</button>
                : offer.expiresAt <= offerClock
                  ? <button className={styles.secondaryButton} disabled={!ready} onClick={() => void act(() => ({ call: call("expireOffer", [offer.id]), settlement: false }))}>Refund offerer</button>
                  : offer.owner?.toLowerCase() === address?.toLowerCase()
                    ? <button className={styles.primaryButton} disabled={!ready || paused} onClick={() => void act(async (current) => {
                        const fresh = await readNusdOffer(client!, NUSD_MARKETPLACE_ADDRESS!, offer.id, current.blockNumber);
                        if (!fresh.active || fresh.expiresAt <= current.timestamp) throw new Error("The offer has changed or expired");
                        const quote = await client!.readContract({ address: NUSD_MARKETPLACE_ADDRESS!, abi: NusdMarketplaceAbi, functionName: "quoteSale", args: [fresh.collection, fresh.tokenId, fresh.price], blockNumber: current.blockNumber });
                        return { call: call("acceptOffer", [fresh.id, quote[3]]), nftApproval: { collection: fresh.collection, tokenId: fresh.tokenId } };
                      })}>Accept offer</button>
                    : <span className={styles.small}>Awaiting NFT owner</span>}</td>
            </tr>)}</tbody></table></div>}
        </section>

        <nav className={styles.pagination} aria-label="NUSD marketplace pages"><span>Page {safePage + 1} / {totalPages}<small>Up to 24 artworks and 24 offers per page</small></span><div><button className={styles.secondaryButton} disabled={page === 0 || busy} onClick={() => setPage(Math.max(0, safePage - 1))}>Previous</button><button className={styles.secondaryButton} disabled={busy || safePage + 1 >= totalPages} onClick={() => setPage(safePage + 1)}>Next<ArrowRight size={16} aria-hidden="true" /></button></div></nav>

        <NusdMarketplaceActivity />

        <section className={styles.tradeSection} aria-labelledby="nusd-trade-title">
          <div className={styles.tradeHeading}>
            <div><span className={styles.eyebrow}>0xPixel / Trading desk</span><h2 id="nusd-trade-title">Art first. Your terms.</h2><p>Select your artwork, set a price, and review in your wallet.</p></div>
            <span className={styles.deskStatus} data-ready={Boolean(address && chainId === 4441 && !paused)}><span aria-hidden="true" />{paused ? "Trading paused" : !address ? "Wallet not connected" : chainId !== 4441 ? "Switch to LiteForge" : "LiteForge 4441"}</span>
          </div>
          <div className={styles.tradeWorkspace}>
            <div className={styles.deskToolbar}>
              <div className={styles.workflowSwitch} role="group" aria-label="Choose a trading action"><button aria-pressed={workflow === "sell"} aria-controls="sell-nusd" onClick={() => setWorkflow("sell")}>List an NFT<span>01 / Sell</span></button><button aria-pressed={workflow === "offer"} aria-controls="offer-nusd" onClick={() => setWorkflow("offer")}>Make a NUSD offer<span>02 / Offer</span></button></div>
              <span className={styles.deskCurrency}><Coins size={18} aria-hidden="true" />NUSD settlement</span>
            </div>
            <div className={styles.deskBody}>
              <aside className={styles.tradePreview} aria-label="Selected artwork preview" aria-busy={workflow === "sell" && owned.isFetching}>
                <div className={styles.previewHeading}><span>Artwork preview</span><span>{tradeAsset ? `#${tradeAsset.tokenId}` : "Not selected"}</span></div>
                <div className={styles.previewStage} data-selected={Boolean(tradeAsset)}>
                  {tradeAsset
                    ? <ArtworkPreview key={nusdArtworkKey(tradeAsset.collection, tradeAsset.tokenId)} collection={tradeAsset.collection} tokenId={tradeAsset.tokenId} name={tradeAsset.name || `#${tradeAsset.tokenId}`} />
                    : <div className={styles.previewPlaceholder}><ImageSquare size={54} weight="thin" aria-hidden="true" /><span>{workflow === "sell" && owned.isFetching ? "Loading your NFTs…" : "Your art goes here"}</span></div>}
                </div>
                <div className={styles.previewCaption}><span className={styles.eyebrow}>{workflow === "sell" ? "From your wallet" : "From the marketplace"}</span><strong title={tradeAsset?.name}>{tradeAsset?.name || (tradeAsset ? `0xPixel #${tradeAsset.tokenId}` : "Choose an artwork")}</strong><p>{tradeAsset ? shortenAddress(tradeAsset.collection) : workflow === "sell" ? "Select an NFT to see it here." : "Select an NFT to make an offer."}</p></div>
                <div className={styles.previewPrice}><span>{workflow === "sell" ? selectedToken?.listing ? "Current listing" : "Your asking price" : "Current listing"}</span><strong>{workflow === "sell" ? selectedToken?.listing ? amount(BigInt(selectedToken.listing.price)) : listedPrice ? amount(listedPrice) : "—" : selectedListing ? amount(selectedListing.price) : "—"}<small>NUSD</small></strong></div>
                <p className={styles.previewFootnote}><ShieldCheck size={16} aria-hidden="true" />Your NFT stays in your wallet until sold.</p>
              </aside>
              <div className={styles.tradeEditor}>
                <ol className={styles.tradeSteps} aria-label="Trade preparation">{["Artwork", "Price & terms", "Wallet review"].map((label, index) => <li key={label} data-complete={index < tradeStep} aria-current={index === tradeStep ? "step" : undefined}><span>{String(index + 1).padStart(2, "0")}</span>{label}</li>)}</ol>
            <form id="sell-nusd" hidden={workflow !== "sell"} className={styles.form} onSubmit={(event) => {
              event.preventDefault();
              if (!selectedToken || !listedPrice) return;
              void act(async (current) => {
                const allowed = await client?.readContract({ address: NUSD_MARKETPLACE_ADDRESS!, abi: NusdMarketplaceAbi, functionName: "collectionAllowed", args: [selectedToken.collection] });
                if (!allowed) throw new Error("Collection is not enabled for this NUSD market");
                if (selectedToken.listing) {
                  const id = BigInt(selectedToken.listing.listingId);
                  const [collection, tokenId, , seller, active] = await client!.readContract({ address: NUSD_MARKETPLACE_ADDRESS!, abi: NusdMarketplaceAbi, functionName: "listings", args: [id], blockNumber: current.blockNumber });
                  if (!active || collection.toLowerCase() !== selectedToken.collection.toLowerCase() || tokenId !== BigInt(selectedToken.tokenId) || seller.toLowerCase() !== address?.toLowerCase()) throw new Error("Your listing has changed. Refresh your NFTs before updating the price.");
                  return { call: call("updateListingPrice", [id, listedPrice]) };
                }
                return { call: call("list", [selectedToken.collection, BigInt(selectedToken.tokenId), listedPrice]), nftApproval: { collection: selectedToken.collection, tokenId: BigInt(selectedToken.tokenId) } };
              });
            }}>
              <div className={styles.formHeading}><h3>{selectedToken?.listing ? "Edit your listing" : "Set your asking price"}</h3><Link href="/0xpixel/gallery">My NFTs<ArrowUpRight size={14} aria-hidden="true" /></Link></div>
              <label className={styles.artworkSelect}>Your NFT<select value={tokenKey} onChange={(event) => setTokenKey(event.target.value)} disabled={!ready || paused || owned.isFetching}><option value="">{owned.isFetching ? "Loading NFTs…" : "Choose artwork from your wallet"}</option>{owned.data?.map((token) => <option key={nusdArtworkKey(token.collection, token.tokenId)} value={nusdArtworkKey(token.collection, token.tokenId)}>{token.name || `#${token.tokenId}`}{token.listing ? " (listed for NUSD)" : ""}</option>)}</select></label>
              {Boolean(owned.data?.length) && <div className={styles.artworkPicker} role="group" aria-label="Quick select wallet artwork">{owned.data?.slice(0, 6).map((token) => <button type="button" key={nusdArtworkKey(token.collection, token.tokenId)} aria-label={`Select ${token.name || `NFT #${token.tokenId}`}`} aria-pressed={tokenKey === nusdArtworkKey(token.collection, token.tokenId)} disabled={!ready || paused || owned.isFetching} onClick={() => setTokenKey(nusdArtworkKey(token.collection, token.tokenId))}><ArtworkPreview compact collection={token.collection} tokenId={token.tokenId} name={token.name || `NFT #${token.tokenId}`} /></button>)}<span>Select a thumbnail<br />or use the full list above.</span></div>}
              {address && !owned.isFetching && !owned.isError && owned.data?.length === 0 && <p className={styles.small}>Your wallet has no NFTs to sell yet. <Link href="/0xpixel">Create your first artwork<ArrowUpRight size={13} aria-hidden="true" /></Link></p>}
              <label className={styles.priceField}>Listing price<div className={styles.amountInput}><input inputMode="decimal" value={listPrice} onChange={(event) => setListPrice(event.target.value)} placeholder="0.00" disabled={busy} aria-describedby="nusd-list-price-help" /><span aria-hidden="true"><Coins size={18} />NUSD</span></div></label>
              <p id="nusd-list-price-help" className={styles.small}>Exact NUSD amount · Up to 18 decimal places</p>
              <dl className={styles.tradeBreakdown}><div><dt>NUSD burned ({state.burnBps / 100}%)</dt><dd>{listingBurn === undefined ? "—" : `${amount(listingBurn)} NUSD`}</dd></div><div><dt>To the creator ({state.creatorBps / 100}%)</dt><dd>{listingCreatorFee === undefined ? "—" : `${amount(listingCreatorFee)} NUSD`}</dd></div></dl>
              <button className={`${styles.primaryButton} ${styles.tradeSubmit}`} disabled={!ready || paused || !selectedToken || !listedPrice}>{selectedToken?.listing ? "Update NUSD price" : "Approve NFT and list"}<ArrowRight size={19} aria-hidden="true" /></button>
              {selectedToken?.listing && <button type="button" className={styles.secondaryButton} disabled={!ready} onClick={() => void act(async (current) => {
                const id = BigInt(selectedToken.listing!.listingId);
                const [listedCollection, listedTokenId, , seller, active] = await client!.readContract({ address: NUSD_MARKETPLACE_ADDRESS!, abi: NusdMarketplaceAbi, functionName: "listings", args: [id], blockNumber: current.blockNumber });
                if (!active || listedCollection.toLowerCase() !== selectedToken.collection.toLowerCase() || listedTokenId.toString() !== selectedToken.tokenId || seller.toLowerCase() !== address?.toLowerCase()) throw new Error("This NUSD listing is no longer owned by your wallet");
                return { call: call("cancelListing", [id]), settlement: false };
              })}>Cancel this NUSD listing</button>}
              <p className={styles.actionHint}>{busy ? "Review the current request in your wallet." : !address ? "Connect your wallet above to begin." : chainId !== 4441 ? "Switch to LiteForge before continuing." : paused ? "Trading is paused. Existing listings can still be cancelled." : !selectedToken ? "Choose your artwork to prepare a listing." : !listedPrice ? "Enter a positive NUSD price to continue." : selectedToken.listing ? "Review your new price in your wallet." : "You will review the approval and listing in your wallet."}</p>
              <details className={styles.tradeDisclosure}><summary>Fees & NFT approval<Plus size={14} aria-hidden="true" /></summary><p className={styles.formFootnote}>The sale fee is deducted from the price: 0.1% is burned and 0.4% goes to the artwork&apos;s creator (you keep it when you are the creator). Approve only this NFT if needed, never setApprovalForAll. Update or cancel your NUSD listing here.</p></details>
              {!address && <p className={styles.small}>Connect your wallet to choose an NFT and list it.</p>}
              {owned.isError && <p className={styles.error} role="alert">Unable to load your wallet's NFTs. <button type="button" className={styles.textButton} disabled={owned.isFetching} onClick={() => void owned.refetch()}>Retry</button></p>}
            </form>
            <form id="offer-nusd" hidden={workflow !== "offer"} className={styles.form} onSubmit={(event) => {
              event.preventDefault();
              if (!offerAsset || !offeredPrice) return;
              void act(async (current) => {
                let target: { collection: Address; tokenId: bigint };
                if (selectedListing) {
                  const selected = await readNusdListing(client!, NUSD_MARKETPLACE_ADDRESS!, selectedListing.id, current.blockNumber);
                  if (!selected.active || selected.seller.toLowerCase() === address?.toLowerCase()) throw new Error("Listing unavailable or owned by your wallet");
                  target = selected;
                } else {
                  target = manualTarget!;
                  const [allowed, owner] = await Promise.all([
                    client!.readContract({ address: NUSD_MARKETPLACE_ADDRESS!, abi: NusdMarketplaceAbi, functionName: "collectionAllowed", args: [target.collection], blockNumber: current.blockNumber }),
                    client!.readContract({ address: target.collection, abi: nftApprovalAbi, functionName: "ownerOf", args: [target.tokenId], blockNumber: current.blockNumber }).catch(() => undefined),
                  ]);
                  if (!allowed) throw new Error("Collection is not enabled for this NUSD market");
                  if (!owner) throw new Error("This NFT does not exist yet. Check the collection and token ID.");
                  if (owner.toLowerCase() === address?.toLowerCase()) throw new Error("This NFT is already in your wallet");
                }
                const funding = nusdFunding(offeredPrice, current.credit);
                return { call: call("makeOffer", [target.collection, target.tokenId, offeredPrice, offerExpiry(current.timestamp, duration), funding.walletPayment]), payment: offeredPrice };
              });
            }}>
              <div className={styles.formHeading}><h3>Name your offer</h3><span>Escrowed in NUSD</span></div>
              <label className={styles.artworkSelect}>NFT to offer on<select value={offerListing} onChange={(event) => { setOfferListing(event.target.value); if (event.target.value) setOfferTokenId(""); }} disabled={!ready || paused}><option value="">Choose the artwork you want</option>{state.listings.filter((listing) => listing.seller.toLowerCase() !== address?.toLowerCase()).map((listing) => <option key={listing.id.toString()} value={listing.id.toString()}>{nftName(listing.collection, listing.tokenId)} · {shortenAddress(listing.collection)}</option>)}</select></label>
              <div className={styles.formRow}><label className={styles.artworkSelect}>Or any 0xPixel NFT<select value={offerCollection} onChange={(event) => setOfferCollection(event.target.value)} disabled={!ready || paused}>{PIXEL_COLLECTIONS.map((entry) => <option key={entry.address} value={entry.address}>{entry.name} · {shortenAddress(entry.address)}</option>)}</select></label><label className={styles.durationField}>Token ID<input inputMode="numeric" value={offerTokenId} onChange={(event) => { setOfferTokenId(event.target.value); if (event.target.value) setOfferListing(""); }} placeholder="#" maxLength={78} disabled={!ready || paused} /></label></div>
              <div className={styles.formRow}><label className={styles.priceField}>Offer price<div className={styles.amountInput}><input inputMode="decimal" value={offerPrice} onChange={(event) => setOfferPrice(event.target.value)} placeholder="0.00" disabled={busy} aria-describedby="nusd-offer-help" /><span aria-hidden="true"><Coins size={18} />NUSD</span></div></label><label className={styles.durationField}>Duration (hours)<input inputMode="numeric" value={duration} onChange={(event) => setDuration(event.target.value)} disabled={busy} aria-describedby="nusd-offer-help" /></label></div>
              <div className={styles.durationPresets} role="group" aria-label="Offer duration presets">{[{ hours: "24", label: "24 hours" }, { hours: "72", label: "3 days" }, { hours: "168", label: "7 days" }].map((preset) => <button type="button" key={preset.hours} aria-pressed={duration === preset.hours} disabled={busy} onClick={() => setDuration(preset.hours)}><Clock size={13} aria-hidden="true" />{preset.label}</button>)}</div>
              <p id="nusd-offer-help" className={styles.small}>Valid for 1–720 hours · Funds stay in escrow until settled or refunded.</p>
              {offerFunding && <dl className={styles.offerFunding}><div><dt>Use marketplace credits</dt><dd>{amount(offerFunding.creditUsed)} NUSD</dd></div><div><dt>Wallet approval needed</dt><dd>{amount(offerFunding.walletPayment)} NUSD</dd></div></dl>}
              <button className={`${styles.primaryButton} ${styles.tradeSubmit}`} disabled={!ready || paused || !offerAsset || !offeredPrice}>Approve NUSD and make offer<ArrowRight size={19} aria-hidden="true" /></button>
              <p className={styles.actionHint}>{!address ? "Connect your wallet above to begin." : !offerAsset ? "Choose an artwork to prepare your offer." : !offeredPrice ? "Enter an offer amount to review your funding." : "Only the wallet shortfall requires NUSD approval."}</p>
              <details className={styles.tradeDisclosure}><summary>How escrow & refunds work<Plus size={14} aria-hidden="true" /></summary><p className={styles.formFootnote}>Cancelled or refunded expired offers return NUSD to your marketplace credits, ready to reuse or withdraw. Escrowed funds do not earn interest.</p></details>
              {!address && <p className={styles.small}>Connect your wallet to make an offer.</p>}
            </form>
              </div>
            </div>
            <div className={styles.deskFooter}><span><ShieldCheck size={15} aria-hidden="true" />Single-NFT approval</span><span><Wallet size={15} aria-hidden="true" />Credits first, wallet second</span><span><Coins size={15} aria-hidden="true" />{state.burnBps / 100}% burned + {state.creatorBps / 100}% to creator</span></div>
          </div>
        </section>
      </>}
    </>}

    <footer className={styles.footer}>
      <div><span className={styles.footerBrand}>0xPixel / NUSD</span><p>Prices, creator fees, burns and offer refunds are all in NUSD. Your credits are never automatically staked or used for borrowing.</p></div>
      <div className={styles.footerLinks}><a href={getTokenExplorerUrl(NFT_NUSD_ADDRESS)} target="_blank" rel="noopener noreferrer">NUSD token<ArrowUpRight size={14} aria-hidden="true" /></a>{NUSD_MARKETPLACE_ADDRESS && <a href={getAddressExplorerUrl(NUSD_MARKETPLACE_ADDRESS)} target="_blank" rel="noopener noreferrer">Market contract<ArrowUpRight size={14} aria-hidden="true" /></a>}</div>
      {state && <p className={styles.syncInfo}>Block {state.blockNumber.toString()} · Auto-refreshes every 30 seconds</p>}
    </footer>
  </section>;
}
