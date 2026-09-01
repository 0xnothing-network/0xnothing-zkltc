import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight,
  ArrowSquareOut,
  ArrowsLeftRight,
  BookOpenText,
  BracketsCurly,
  CheckCircle,
  Coins,
  Database,
  GlobeHemisphereWest,
  ImageSquare,
  RocketLaunch,
  ShieldCheck,
  Warning,
} from "@phosphor-icons/react/dist/ssr";
import { DocsCodeBlock } from "./DocsCodeBlock";
import { deployment } from "@fi/config/deployment";
import testnet from "@fi/config/testnet.generated.json";
import {
  MARKETPLACE_SUBGRAPH_URL,
  PIXEL_MARKETPLACE_ADDRESS,
  PIXEL_NFT_ADDRESS,
  PUMP_FACTORY_ADDRESS,
  PUMP_GRADUATION_CONTROLLER_ADDRESS,
  PUMP_SUBGRAPH_URL,
} from "@/lib/publicConfig";
import "./docs.css";

export const metadata: Metadata = {
  title: "Developer Documentation | 0xNothing",
  description: "Build with 0xPixel, 0xPump, and 0xFi on LitVM Testnet. Explore 0xUniverse for the mainnet roadmap.",
  alternates: { canonical: "/docs" },
};

const NAV_GROUPS = [
  {
    label: "Get started",
    items: [
      { href: "#quick-start", label: "Quick start" },
      { href: "#network", label: "Network and contracts" },
      { href: "#architecture", label: "Ecosystem architecture" },
    ],
  },
  {
    label: "Products",
    items: [
      { href: "#0xpixel", label: "0xPixel" },
      { href: "#0xpump", label: "0xPump" },
      { href: "#0xfi", label: "0xFi" },
      { href: "#0xuniverse", label: "0xUniverse" },
    ],
  },
  {
    label: "Developers",
    items: [
      { href: "#swap-integration", label: "Swap integration" },
      { href: "#vibe-code", label: "Vibe-code prompt" },
      { href: "#indexed-data", label: "Indexed data" },
      { href: "#safety", label: "Testnet safety" },
    ],
  },
] as const;

const CORE_CONTRACTS = [
  { name: "0xPixel NFT", address: PIXEL_NFT_ADDRESS, use: "Fully onchain pixel art ERC-721" },
  { name: "0xPixel Marketplace", address: PIXEL_MARKETPLACE_ADDRESS, use: "Listings and native zkLTC offers" },
  { name: "NUSD / OracleNUSD", address: testnet.nusd, use: "Oracle-priced settlement asset" },
  { name: "0xPump", address: PUMP_FACTORY_ADDRESS, use: "Bonding-curve token launchpad" },
  { name: "0xPump Controller", address: PUMP_GRADUATION_CONTROLLER_ADDRESS, use: "Fail-closed graduation coordination" },
] as const;

const FI_CONTRACTS = [
  { name: "0xFi Router", address: testnet.dexRouter, use: "Quotes, swaps, and liquidity" },
  { name: "0xFi Factory", address: testnet.dexFactory, use: "Pair discovery and creation" },
  { name: "WzkLTC", address: testnet.wzkltc, use: "Wrapped native asset inside AMM paths" },
  { name: "Gauge Factory", address: testnet.farmFactory, use: "LP farming gauges" },
  { name: "Lending Pool", address: testnet.lendingPool, use: "NUSD supply and isolated borrowing" },
  { name: "nBTC", address: testnet.nbtc, use: "DIA-priced synthetic Bitcoin" },
  { name: "nETH", address: testnet.neth, use: "DIA-priced synthetic Ether" },
] as const;

const NETWORK_CODE = `import { createPublicClient, defineChain, http } from "viem";

export const litvmTestnet = defineChain({
  id: 4441,
  name: "LitVM LiteForge",
  nativeCurrency: { name: "zkLTC", symbol: "zkLTC", decimals: 18 },
  rpcUrls: {
    default: { http: ["${deployment.chain.rpcUrl}"] },
  },
  blockExplorers: {
    default: { name: "LiteForge Explorer", url: "${deployment.chain.explorerUrl}" },
  },
});

export const publicClient = createPublicClient({
  chain: litvmTestnet,
  transport: http(),
});

export const contracts = {
  pixel: "${PIXEL_NFT_ADDRESS}",
  pixelMarketplace: "${PIXEL_MARKETPLACE_ADDRESS}",
  nusd: "${testnet.nusd}",
  pump: "${PUMP_FACTORY_ADDRESS}",
  fiRouter: "${testnet.dexRouter}",
  fiFactory: "${testnet.dexFactory}",
  wzkLtc: "${testnet.wzkltc}",
  nbtc: "${testnet.nbtc}",
  neth: "${testnet.neth}",
} as const;`;

const PIXEL_CODE = `import { parseAbi } from "viem";

export const pixelAbi = parseAbi([
  "function checkOriginal(string pixelData, uint256 grid) view returns (bool)",
  "function mint(string artName, uint256 grid, string pixelData) returns (uint256 tokenId)",
  "function tokenData(uint256 tokenId) view returns (string artName, uint256 gridSize, string pixelData, address creator, uint256 mintedAt, bytes32 artworkHash)",
  "function tokenURI(uint256 tokenId) view returns (string)",
]);

// Supported grids: 8, 16, 32, 64.
// pixelData is packed horizontal runs: x, y, count, r, g, b.
const isOriginal = await publicClient.readContract({
  address: contracts.pixel,
  abi: pixelAbi,
  functionName: "checkOriginal",
  args: [pixelData, 32n],
});`;

const SWAP_CODE = `import { parseAbi, type Address, type PublicClient, type WalletClient } from "viem";

const routerAbi = parseAbi([
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
]);

const erc20Abi = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

type Quote = { path: Address[]; amountOut: bigint };

export async function swapErc20(params: {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  slippageBps?: bigint;
}) {
  const {
    publicClient,
    walletClient,
    account,
    tokenIn,
    tokenOut,
    amountIn,
    slippageBps = 50n,
  } = params;

  if (await walletClient.getChainId() !== 4441) {
    throw new Error("Switch wallet to LitVM chain 4441");
  }
  if (amountIn <= 0n || slippageBps < 0n || slippageBps >= 10_000n) {
    throw new Error("Invalid swap parameters");
  }

  const paths: Address[][] = [[tokenIn, tokenOut]];
  const usesNusd =
    tokenIn.toLowerCase() === contracts.nusd.toLowerCase() ||
    tokenOut.toLowerCase() === contracts.nusd.toLowerCase();
  if (!usesNusd) paths.push([tokenIn, contracts.nusd, tokenOut]);

  const quotes = await Promise.all(paths.map(async (path): Promise<Quote | undefined> => {
    try {
      const amounts = await publicClient.readContract({
        address: contracts.fiRouter,
        abi: routerAbi,
        functionName: "getAmountsOut",
        args: [amountIn, path],
      });
      return { path, amountOut: amounts.at(-1)! };
    } catch {
      return undefined;
    }
  }));

  const best = quotes
    .filter((quote): quote is Quote => Boolean(quote))
    .sort((a, b) => a.amountOut === b.amountOut ? 0 : a.amountOut > b.amountOut ? -1 : 1)[0];
  if (!best) throw new Error("No executable 0xFi route");

  const amountOutMin = best.amountOut * (10_000n - slippageBps) / 10_000n;
  const allowance = await publicClient.readContract({
    address: tokenIn,
    abi: erc20Abi,
    functionName: "allowance",
    args: [account, contracts.fiRouter],
  });

  if (allowance < amountIn) {
    const approval = await publicClient.simulateContract({
      account,
      address: tokenIn,
      abi: erc20Abi,
      functionName: "approve",
      args: [contracts.fiRouter, amountIn],
    });
    const approvalHash = await walletClient.writeContract(approval.request);
    const approvalReceipt = await publicClient.waitForTransactionReceipt({ hash: approvalHash });
    if (approvalReceipt.status !== "success") throw new Error("Approval reverted");
  }

  const deadline = BigInt(Math.floor(Date.now() / 1_000) + 20 * 60);
  const simulation = await publicClient.simulateContract({
    account,
    address: contracts.fiRouter,
    abi: routerAbi,
    functionName: "swapExactTokensForTokens",
    args: [amountIn, amountOutMin, best.path, account, deadline],
  });
  const hash = await walletClient.writeContract(simulation.request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("0xFi swap reverted");

  return { hash, receipt, path: best.path, quotedOut: best.amountOut, amountOutMin };
}`;

const NUSD_CODE = `const nusdAbi = parseAbi([
  "function quoteMint(uint256 collateralWei) view returns (uint256 amountNusd)",
  "function mintAtOracle(uint256 minNusdOut, address recipient) payable returns (uint256 amountNusd)",
  "function quoteRedeem(uint256 amountNusd) view returns (uint256 collateralOutWei)",
  "function redeemAtOracle(uint256 amountNusd, uint256 minCollateralOutWei, address recipient) returns (uint256 collateralOutWei)",
]);

const minimumOut = (quote: bigint, slippageBps = 50n) =>
  quote * (10_000n - slippageBps) / 10_000n;

// Native zkLTC to NUSD
const quotedNusd = await publicClient.readContract({
  address: contracts.nusd,
  abi: nusdAbi,
  functionName: "quoteMint",
  args: [zkLtcIn],
});
const mint = await publicClient.simulateContract({
  account,
  address: contracts.nusd,
  abi: nusdAbi,
  functionName: "mintAtOracle",
  args: [minimumOut(quotedNusd), account],
  value: zkLtcIn,
});

// NUSD to native zkLTC. No ERC-20 approval is required.
const quotedZkLtc = await publicClient.readContract({
  address: contracts.nusd,
  abi: nusdAbi,
  functionName: "quoteRedeem",
  args: [nusdIn],
});
const redeem = await publicClient.simulateContract({
  account,
  address: contracts.nusd,
  abi: nusdAbi,
  functionName: "redeemAtOracle",
  args: [nusdIn, minimumOut(quotedZkLtc), account],
});`;

const VIBE_PROMPT = `Build a complete 0xFi swap integration for an existing Next.js TypeScript app.

Target network
- Network: LitVM LiteForge Testnet
- Chain ID: 4441
- Native asset: zkLTC, 18 decimals
- RPC: ${deployment.chain.rpcUrl}
- Explorer: ${deployment.chain.explorerUrl}

Pinned contracts
- NUSD / OracleNUSD: ${testnet.nusd}
- WzkLTC: ${testnet.wzkltc}
- 0xFi Factory: ${testnet.dexFactory}
- 0xFi Router: ${testnet.dexRouter}

Implementation requirements
- Use viem and the wallet layer already installed by the app. Do not add a server-side signer.
- Create typed chain config, minimal ABIs, quote service, transaction service, React hook, and accessible swap UI.
- Accept bigint amounts internally. Read token decimals, balance, and allowance over RPC.
- For ERC-20 routes, probe [tokenIn, tokenOut] and [tokenIn, NUSD, tokenOut]. Choose the successful quote with the largest final output.
- Use getAmountsOut for executable AMM quotes. It already includes LP fees, protocol fees, route surcharge, and price impact.
- Use swapExactTokensForTokens for ERC-20 pairs.
- Use swapExactNativeForTokens when input is native zkLTC. The path must start with WzkLTC and the transaction must send value.
- Use swapExactTokensForNative when output is native zkLTC. The path must end with WzkLTC.
- For the exact zkLTC/NUSD route, use quoteMint plus mintAtOracle, or quoteRedeem plus redeemAtOracle. Do not route this exact pair through the AMM.
- Request exact ERC-20 approval only when allowance is insufficient. Wait for the approval receipt before the swap.
- Apply user-controlled slippage in basis points. Never use zero minimum output.
- Use a short deadline, simulate every write, wait for the final receipt, and reject reverted receipts.
- Verify chain ID 4441 before every write. Keep enough zkLTC for gas.
- Show route, fee summary, quoted output, minimum received, price impact, recipient, pending state, transaction hash, and actionable errors.
- Requote after token, amount, account, chain, or block-relevant state changes.
- Use Goldsky only for history and charts. Never use indexed reserves for an executable quote.
- Reject unsupported fee-on-transfer tokens and repeated or zero-address paths.

Required delivery
- Return complete files with no placeholders or omitted sections.
- Include loading, empty, wrong-network, approval, signing, confirming, success, and error states.
- Include unit tests for route selection, slippage math, native path rules, allowance branching, and failed simulation.
- Mark the integration as testnet-only. Do not describe it as audited or mainnet-ready.`;

const INDEXER_CODE = `const INDEXERS = {
  pixelMarketplace: "${MARKETPLACE_SUBGRAPH_URL}",
  pump: "${PUMP_SUBGRAPH_URL}",
  fi: "${testnet.goldskyEndpoint}",
} as const;

export async function queryIndexer<T>(endpoint: string, query: string, variables = {}) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error("Indexer HTTP " + response.status);
  const payload = await response.json();
  if (payload.errors?.length) throw new Error(payload.errors[0].message);
  return payload.data as T;
}`;

function ContractLink({ address }: { address: string }) {
  return (
    <a href={`${deployment.chain.explorerUrl}/address/${address}`} target="_blank" rel="noopener noreferrer">
      <code>{address}</code><ArrowSquareOut size={12} aria-hidden="true" />
    </a>
  );
}

function SectionHeading({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="ox-docs-section-heading">
      <span className="ox-docs-section-icon">{icon}</span>
      <div><h2>{title}</h2><p>{description}</p></div>
    </div>
  );
}

function ProductLink({ href, children }: { href: string; children: React.ReactNode }) {
  return <Link className="ox-docs-product-link" href={href}>{children}<ArrowRight size={13} aria-hidden="true" /></Link>;
}

export default function DocsPage() {
  return (
    <div className="ox-docs-root">
      <header className="ox-docs-topbar">
        <div className="ox-docs-topbar-inner">
          <Link href="/" className="ox-docs-brand" aria-label="0xNothing home">
            <Image src="/0xNothing.jpg" alt="" width={30} height={30} priority />
            <span>0xNothing</span><strong>Docs</strong>
          </Link>
          <nav aria-label="Documentation actions">
            <span className="ox-docs-network-label">LitVM Testnet</span>
            <Link href="/0xFi">Open 0xFi <ArrowRight size={13} aria-hidden="true" /></Link>
          </nav>
        </div>
      </header>

      <div className="ox-docs-shell">
        <aside className="ox-docs-sidebar">
          <nav aria-label="Documentation navigation">
            {NAV_GROUPS.map((group) => (
              <div className="ox-docs-nav-group" key={group.label}>
                <strong>{group.label}</strong>
                {group.items.map((item) => <a href={item.href} key={item.href}>{item.label}</a>)}
              </div>
            ))}
          </nav>
          <div className="ox-docs-sidebar-meta">
            <span>Network</span><strong>Chain 4441</strong><small>Testnet only</small>
          </div>
        </aside>

        <main className="ox-docs-main">
          <details className="ox-docs-mobile-nav">
            <summary>Browse documentation</summary>
            <nav aria-label="Mobile documentation navigation">
              {NAV_GROUPS.map((group) => group.items.map((item) => (
                <a href={item.href} key={item.href}>{item.label}</a>
              )))}
            </nav>
          </details>

          <section className="ox-docs-hero">
            <div>
              <span className="ox-docs-eyebrow"><BookOpenText size={15} aria-hidden="true" /> Developer documentation</span>
              <h1>Build across 0xNothing.</h1>
              <p>One testnet stack for onchain art, token markets, DeFi, and the world arriving with mainnet.</p>
              <div className="ox-docs-hero-actions">
                <a href="#quick-start">Quick start <ArrowRight size={14} aria-hidden="true" /></a>
                <a href="#vibe-code" className="secondary">Copy build prompt</a>
              </div>
            </div>
            <dl aria-label="Network summary">
              <div><dt>Network</dt><dd>LitVM LiteForge</dd></div>
              <div><dt>Chain ID</dt><dd>4441</dd></div>
              <div><dt>Native asset</dt><dd>zkLTC</dd></div>
              <div><dt>Environment</dt><dd>Public testnet</dd></div>
            </dl>
          </section>

          <div className="ox-docs-warning" role="note">
            <Warning size={18} weight="bold" aria-hidden="true" />
            <div><strong>Testnet documentation</strong><span>Addresses and protocol state can change. Pin a release manifest and verify live chain state before every write.</span></div>
          </div>

          <article className="ox-docs-article">
            <section id="quick-start" className="ox-docs-section">
              <SectionHeading
                icon={<BracketsCurly size={21} aria-hidden="true" />}
                title="Quick start"
                description="Connect to LitVM, pin the deployment, and keep all transaction decisions grounded in live RPC state."
              />
              <div className="ox-docs-flow" aria-label="Integration flow">
                {[
                  ["Connect", "Require chain 4441"],
                  ["Read", "Balances, decimals, state"],
                  ["Quote", "Latest RPC block"],
                  ["Simulate", "Exact account and value"],
                  ["Confirm", "Receipt status and refresh"],
                ].map(([title, detail]) => <div key={title}><strong>{title}</strong><span>{detail}</span></div>)}
              </div>
              <DocsCodeBlock code="npm install viem" label="Install viem" language="shell" />
              <DocsCodeBlock code={NETWORK_CODE} label="network.ts" />
            </section>

            <section id="network" className="ox-docs-section">
              <SectionHeading
                icon={<Database size={21} aria-hidden="true" />}
                title="Network and contracts"
                description="These public addresses are the checked LitVM testnet deployment used by the current web application."
              />
              <div className="ox-docs-contract-columns">
                <div>
                  <h3>Core ecosystem</h3>
                  {CORE_CONTRACTS.map((contract) => (
                    <div className="ox-docs-contract" key={contract.name}>
                      <div><strong>{contract.name}</strong><span>{contract.use}</span></div>
                      <ContractLink address={contract.address} />
                    </div>
                  ))}
                </div>
                <div>
                  <h3>0xFi</h3>
                  {FI_CONTRACTS.map((contract) => (
                    <div className="ox-docs-contract" key={contract.name}>
                      <div><strong>{contract.name}</strong><span>{contract.use}</span></div>
                      <ContractLink address={contract.address} />
                    </div>
                  ))}
                </div>
              </div>
              <details className="ox-docs-disclosure">
                <summary>Canonical 0xFi pools</summary>
                <div className="ox-docs-pool-addresses">
                  <div><span>WzkLTC / NUSD</span><ContractLink address={testnet.wzkLtcNusdPair} /></div>
                  <div><span>nBTC / NUSD</span><ContractLink address={testnet.nbtcNusdPair} /></div>
                  <div><span>nETH / NUSD</span><ContractLink address={testnet.nethNusdPair} /></div>
                </div>
              </details>
            </section>

            <section id="architecture" className="ox-docs-section">
              <SectionHeading
                icon={<GlobeHemisphereWest size={21} aria-hidden="true" />}
                title="Ecosystem architecture"
                description="Each product is useful on its own. Together they form a path from creation to markets, liquidity, and persistent digital ownership."
              />
              <div className="ox-docs-ecosystem-map">
                <div><ImageSquare size={20} aria-hidden="true" /><strong>0xPixel</strong><span>Create and trade fully onchain visual assets.</span></div>
                <div><RocketLaunch size={20} aria-hidden="true" /><strong>0xPump</strong><span>Launch community tokens through a transparent curve.</span></div>
                <div><ArrowsLeftRight size={20} aria-hidden="true" /><strong>0xFi</strong><span>Settle, swap, lend, borrow, and route liquidity.</span></div>
                <div><GlobeHemisphereWest size={20} aria-hidden="true" /><strong>0xUniverse</strong><span>Bring assets and finance into a persistent game world.</span></div>
              </div>
            </section>

            <section id="0xpixel" className="ox-docs-section ox-docs-product-section">
              <SectionHeading
                icon={<ImageSquare size={21} aria-hidden="true" />}
                title="0xPixel"
                description="A fully onchain pixel-art studio, ERC-721 collection, provenance registry, gallery, and native zkLTC marketplace."
              />
              <div className="ox-docs-mechanism-grid">
                <div><strong>Onchain art</strong><p>Pixel runs, artwork name, grid size, creator, mint time, and artwork hash live in contract storage.</p></div>
                <div><strong>Deterministic media</strong><p>The contract generates SVG and base64 JSON metadata. The collectible does not depend on an offchain image host.</p></div>
                <div><strong>Originality</strong><p>The registry hashes packed pixel data with the grid size and rejects an artwork that was already registered.</p></div>
                <div><strong>Native marketplace</strong><p>Fixed-price listings and escrowed offers settle in zkLTC. Sales apply a 0.4% platform fee and a 1% creator royalty.</p></div>
              </div>
              <div className="ox-docs-spec-line">
                <span>Supported grids</span><strong>8 x 8, 16 x 16, 32 x 32, 64 x 64</strong>
              </div>
              <DocsCodeBlock code={PIXEL_CODE} label="pixel-read.ts" />
              <ProductLink href="/0xpixel">Open 0xPixel studio</ProductLink>
            </section>

            <section id="0xpump" className="ox-docs-section ox-docs-product-section">
              <SectionHeading
                icon={<RocketLaunch size={21} aria-hidden="true" />}
                title="0xPump"
                description="A NUSD launchpad with reserved metadata, virtual constant-product pricing, explicit lifecycle states, and protected graduation."
              />
              <div className="ox-docs-lifecycle" aria-label="0xPump market lifecycle">
                <div><strong>Trading</strong><span>Users buy and sell against virtual reserves.</span></div>
                <ArrowRight size={18} aria-hidden="true" />
                <div><strong>Ready</strong><span>Buys stop at the 6,000 NUSD market-cap target.</span></div>
                <ArrowRight size={18} aria-hidden="true" />
                <div><strong>Graduated</strong><span>Terminal liquidity moves into a protected 0xFi pool.</span></div>
              </div>
              <div className="ox-docs-facts">
                <div><span>Market reservation</span><strong>1 NUSD</strong><small>Committed content hash before hosted IPFS upload</small></div>
                <div><span>Buy and sell fee</span><strong>0.1%</strong><small>10 basis points on each curve trade</small></div>
                <div><span>Ready target</span><strong>6,000 NUSD</strong><small>Fully diluted market cap, not real reserve size</small></div>
              </div>
              <div className="ox-docs-note">
                <strong>Lifecycle safety</strong>
                <span>A holder can sell from READY and reopen the curve. Graduation is available only when the pinned controller, adapter, router, and admin handovers all pass live checks.</span>
              </div>
              <div className="ox-docs-method-list">
                <div><code>reserveMarket(contentHash)</code><span>Pay the nonrefundable creation reservation.</span></div>
                <div><code>createMarket(...)</code><span>Create the fixed-supply token and curve.</span></div>
                <div><code>quoteBuy / buy</code><span>Quote and execute NUSD input.</span></div>
                <div><code>quoteSell / sell</code><span>Quote and execute token input.</span></div>
              </div>
              <ProductLink href="/0xPump">Open 0xPump markets</ProductLink>
            </section>

            <section id="0xfi" className="ox-docs-section ox-docs-product-section">
              <SectionHeading
                icon={<Coins size={21} aria-hidden="true" />}
                title="0xFi"
                description="The liquidity and risk layer for swaps, pools, NUSD staking, LP gauges, fixed-rate NUSD lending, borrowing, and DIA-priced synthetic assets."
              />
              <div className="ox-docs-fi-surfaces">
                <div><strong>Swap and pools</strong><span>Constant-product pairs, one LP token per unordered pair, and router-protected liquidity operations.</span></div>
                <div><strong>NUSD</strong><span>Oracle-priced mint and redeem against native zkLTC. Stale or invalid DIA data blocks value-changing actions.</span></div>
                <div><strong>Earn</strong><span>Lock NUSD for on-chain xPoints; nBTC/NUSD and nETH/NUSD LP gauges continue as separate programs.</span></div>
                <div><strong>Lend and borrow</strong><span>Fixed 4.5% borrower rate, 4% lender rate, and 0.5% protocol spread on the active testnet pool.</span></div>
                <div><strong>Synths</strong><span>nBTC and nETH use DIA prices, isolated collateral accounting, reserve support rules, and stale-feed guards.</span></div>
              </div>
              <div className="ox-docs-fee-table-wrap">
                <table>
                  <thead><tr><th>AMM path</th><th>LP fee</th><th>Router charge</th><th>Nominal total</th></tr></thead>
                  <tbody>
                    <tr><td>1 pool</td><td>0.5%</td><td>0.1%</td><td>0.6%</td></tr>
                    <tr><td>2 pools</td><td>1.0%</td><td>0.2%</td><td>1.2%</td></tr>
                    <tr><td>3 pools</td><td>1.5%</td><td>0.2%</td><td>1.7%</td></tr>
                  </tbody>
                </table>
              </div>
              <p className="ox-docs-copy"><code>getAmountsOut</code> already includes LP fees, router charges, and price impact. Do not subtract them twice.</p>
              <ProductLink href="/0xFi">Open 0xFi</ProductLink>
            </section>

            <section id="0xuniverse" className="ox-docs-section ox-docs-universe">
              <div className="ox-docs-universe-status">Coming with mainnet</div>
              <SectionHeading
                icon={<GlobeHemisphereWest size={21} aria-hidden="true" />}
                title="0xUniverse"
                description="A persistent game world where Web3 finance and GameFi connect virtual property, creator economies, and compliant RWA representations."
              />
              <div className="ox-docs-universe-grid">
                <div><strong>Persistent ownership</strong><p>Characters, land, items, art, permissions, and provenance remain portable assets controlled by users.</p></div>
                <div><strong>GameFi economy</strong><p>Markets, crafting, quests, resource sinks, liquidity, lending, and settlement become parts of one world economy.</p></div>
                <div><strong>Virtual assets and RWA</strong><p>Digital assets can connect to compliant real-world representations through attestations, oracles, custody, and jurisdiction-aware access.</p></div>
                <div><strong>Ecosystem composition</strong><p>0xPixel supplies culture, 0xPump forms communities, and 0xFi supplies settlement and financial rails.</p></div>
              </div>
              <div className="ox-docs-note ox-docs-note-strong">
                <strong>Mainnet boundary</strong>
                <span>0xUniverse has no public testnet contracts, SDK, asset sale, or integration endpoint in this release. This section documents product direction, not a deployed promise.</span>
              </div>
            </section>

            <section id="swap-integration" className="ox-docs-section">
              <SectionHeading
                icon={<ArrowsLeftRight size={21} aria-hidden="true" />}
                title="Integrate 0xFi swaps"
                description="Choose the correct execution surface, quote against current state, simulate the exact request, then ask the wallet to sign."
              />
              <div className="ox-docs-fee-table-wrap">
                <table>
                  <thead><tr><th>User action</th><th>Contract</th><th>Method</th></tr></thead>
                  <tbody>
                    <tr><td>zkLTC to NUSD</td><td>NUSD</td><td><code>quoteMint + mintAtOracle</code></td></tr>
                    <tr><td>NUSD to zkLTC</td><td>NUSD</td><td><code>quoteRedeem + redeemAtOracle</code></td></tr>
                    <tr><td>ERC-20 to ERC-20</td><td>Router</td><td><code>swapExactTokensForTokens</code></td></tr>
                    <tr><td>zkLTC to ERC-20</td><td>Router</td><td><code>swapExactNativeForTokens</code></td></tr>
                    <tr><td>ERC-20 to zkLTC</td><td>Router</td><td><code>swapExactTokensForNative</code></td></tr>
                  </tbody>
                </table>
              </div>
              <div className="ox-docs-native-rules">
                <div><strong>Native input</strong><code>Path begins with WzkLTC</code><span>Send the exact input as transaction value. No ERC-20 approval.</span></div>
                <div><strong>Native output</strong><code>Path ends with WzkLTC</code><span>Approve the ERC-20 input. The router unwraps before transfer.</span></div>
              </div>
              <DocsCodeBlock code={SWAP_CODE} label="swap.ts" />
              <h3 className="ox-docs-subheading">Native zkLTC and NUSD</h3>
              <p className="ox-docs-copy">The exact zkLTC/NUSD route uses OracleNUSD. It does not use an AMM pool and still requires minimum-output protection.</p>
              <DocsCodeBlock code={NUSD_CODE} label="nusd-conversion.ts" />
            </section>

            <section id="vibe-code" className="ox-docs-section">
              <SectionHeading
                icon={<BracketsCurly size={21} aria-hidden="true" />}
                title="Vibe-code command"
                description="Paste this specification into a coding agent to generate a complete testnet swap integration without losing protocol constraints."
              />
              <DocsCodeBlock code={VIBE_PROMPT} label="0xFi integration prompt" language="prompt" />
              <div className="ox-docs-note">
                <strong>Review generated code</strong>
                <span>Confirm every address, ABI, allowance branch, native value, slippage calculation, simulation, and receipt check before using the result.</span>
              </div>
            </section>

            <section id="indexed-data" className="ox-docs-section">
              <SectionHeading
                icon={<Database size={21} aria-hidden="true" />}
                title="Indexed data"
                description="Goldsky powers discovery, history, charts, and activity. RPC remains authoritative for balances, quotes, allowances, and transaction preflight."
              />
              <div className="ox-docs-indexers">
                <div><strong>0xPixel marketplace</strong><code>{MARKETPLACE_SUBGRAPH_URL}</code></div>
                <div><strong>0xPump</strong><code>{PUMP_SUBGRAPH_URL}</code></div>
                <div><strong>0xFi</strong><code>{testnet.goldskyEndpoint}</code></div>
              </div>
              <DocsCodeBlock code={INDEXER_CODE} label="indexers.ts" />
            </section>

            <section id="safety" className="ox-docs-section">
              <SectionHeading
                icon={<ShieldCheck size={21} aria-hidden="true" />}
                title="Testnet safety"
                description="This deployment is for integration testing. A successful transaction or build does not represent a security audit."
              />
              <div className="ox-docs-checklist">
                {[
                  "Verify chain ID 4441 before every write.",
                  "Load addresses from a pinned deployment manifest.",
                  "Read decimals, balances, and allowances with bigint-safe code.",
                  "Use a fresh RPC quote, nonzero minimum output, and short deadline.",
                  "Simulate the exact account, calldata, path, recipient, and native value.",
                  "Wait for approval receipts before dependent transactions.",
                  "Reject fee-on-transfer tokens and invalid paths.",
                  "Treat indexers as historical views, not executable price sources.",
                  "Keep enough native zkLTC for gas and show receipt status.",
                  "Do not present testnet code as audited or mainnet-ready.",
                ].map((item) => <div key={item}><CheckCircle size={16} weight="fill" aria-hidden="true" /><span>{item}</span></div>)}
              </div>
              <div className="ox-docs-footer-actions">
                <Link href="/0xFi">Test the swap UI <ArrowRight size={14} aria-hidden="true" /></Link>
                <a href={`${deployment.chain.explorerUrl}/address/${testnet.dexRouter}`} target="_blank" rel="noopener noreferrer" className="secondary">
                  Inspect router <ArrowSquareOut size={14} aria-hidden="true" />
                </a>
              </div>
            </section>
          </article>

          <footer className="ox-docs-footer">
            <span>0xNothing developer documentation</span>
            <span>LitVM Testnet, chain 4441</span>
          </footer>
        </main>
      </div>
    </div>
  );
}
