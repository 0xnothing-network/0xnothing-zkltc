import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight,
  ArrowSquareOut,
  ArrowsLeftRight,
  BookOpenText,
  CheckCircle,
  Coins,
  GlobeHemisphereWest,
  ImageSquare,
  RocketLaunch,
  Warning,
} from "@phosphor-icons/react/dist/ssr";
import { DocsCodeBlock } from "./DocsCodeBlock";
import { deployment } from "@fi/config/deployment";
import testnet from "@fi/config/testnet.generated.json";
import { NUSD_MARKETPLACE_ADDRESS } from "@/lib/nusdMarketplaceConfig";
import {
  LITVM_RPC_FALLBACK_URL,
  PIXEL_CLASSIC_ADDRESS,
  PIXEL_NFT_ADDRESS,
  PUMP_FACTORY_ADDRESS,
  PUMP_GRADUATION_ADAPTER_ADDRESS,
  PUMP_GRADUATION_CONTROLLER_ADDRESS,
  PUMP_GRADUATION_ROUTER_ADDRESS,
  PUMP_SUBGRAPH_URL,
} from "@/lib/publicConfig";
import "./docs.css";

export const metadata: Metadata = {
  title: "Developer Documentation | 0xNothing",
  description: "Build with 0xPixel, 0xPump, NUSD, and 0xFi on LitVM Testnet. Explore 0xUniverse for the mainnet roadmap.",
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
      { href: "#nusd", label: "NUSD" },
      { href: "#0xfi", label: "0xFi" },
      { href: "#0xuniverse", label: "0xUniverse" },
    ],
  },
  {
    label: "Developers",
    items: [
      { href: "#developer-guides", label: "Developer guides" },
      { href: "#swap-integration", label: "Swap integration" },
      { href: "#pump-integration", label: "0xPump integration" },
      { href: "#nusd-integration", label: "NUSD integration" },
      { href: "#pixel-integration", label: "0xPixel integration" },
      { href: "#vibe-code", label: "Vibe-code prompts" },
      { href: "#indexed-data", label: "Indexed data" },
      { href: "#safety", label: "Testnet safety" },
    ],
  },
] as const;

const CORE_CONTRACTS = [
  { name: "0xPixel", address: PIXEL_NFT_ADDRESS, use: "Fully onchain pixel art ERC-721; new art mints here" },
  { name: "0xPixel Classic", address: PIXEL_CLASSIC_ADDRESS, use: "First collection, read-only in the app" },
  ...(NUSD_MARKETPLACE_ADDRESS ? [{ name: "0xPixel NUSD Marketplace", address: NUSD_MARKETPLACE_ADDRESS, use: "NUSD listings, escrowed offers and reusable credits" }] : []),
  { name: "NUSD (OracleNUSDv2)", address: testnet.nusd, use: "Oracle-priced stable backed by zkLTC: token, mint, redeem, and reserve" },
  { name: "LTC/USD oracle router", address: testnet.ltcOracle, use: "NUSD price, DIA source behind a fixed router address" },
  { name: "Fee Splitter", address: testnet.feeSplitter, use: "Fee inbox that feeds Earn" },
  { name: "RewardStaking", address: testnet.rewardStaking, use: "NUSD locks, NUSD fee rewards, and 0xPoints" },
  { name: "0xPump (ZeroXPumpV2)", address: PUMP_FACTORY_ADDRESS, use: "NUSD bonding-curve launchpad and ERC-20 spender" },
  { name: "0xPump Controller", address: PUMP_GRADUATION_CONTROLLER_ADDRESS, use: "Launchpad admin; anyone calls graduateReady" },
  { name: "Graduation Router", address: PUMP_GRADUATION_ROUTER_ADDRESS, use: "Graduation gate: enabled() and isAdapterAllowed(adapter)" },
  { name: "Graduation Adapter", address: PUMP_GRADUATION_ADAPTER_ADDRESS, use: "0xFi adapter used when a market graduates" },
] as const;

const FI_CONTRACTS = [
  { name: "0xFi Router (ZeroXFiRouterV2)", address: testnet.dexRouter, use: "Quotes, swaps, and liquidity" },
  { name: "0xFi Factory (ZeroXFiFactoryV2)", address: testnet.dexFactory, use: "Pair discovery and creation" },
  { name: "WzkLTC", address: testnet.wzkltc, use: "Wrapped native zkLTC inside AMM paths and lending collateral" },
  { name: "Gauge Factory", address: testnet.farmFactory, use: "One LP gauge per pair, NUSD rewards" },
  { name: "Lending Pool", address: testnet.lendingPool, use: "NUSD supply and borrowing against pooled collateral" },
  { name: "nBTC vault", address: testnet.nbtcVault, use: "Mint and repay nBTC against NUSD" },
  { name: "nETH vault", address: testnet.nethVault, use: "Mint and repay nETH against NUSD" },
  { name: "nBTC", address: testnet.nbtc, use: "DIA-priced synthetic Bitcoin" },
  { name: "nETH", address: testnet.neth, use: "DIA-priced synthetic Ether" },
] as const;

const GUIDE_BASE = "https://github.com/0xnothing-network/0xnothing-zkltc/blob/main/0xNothing-zkLTC-Testnet/docs/developers";

const DEVELOPER_GUIDES = [
  { product: "0xFi", file: "0xfi", covers: "Swap, liquidity, LP farms, NUSD lending and borrowing, nBTC and nETH synths, oracle prices" },
  { product: "0xPump", file: "0xpump", covers: "Read a market, quote, buy, sell, create a token, graduate, distribute fees" },
  { product: "NUSD", file: "nusd", covers: "Mint, redeem, oracle failure and emergency exit, stake, claim or restake, withdraw" },
  { product: "0xPixel", file: "0xpixel", covers: "Mint artwork, read tokens and metadata, list, buy, offers, credits" },
] as const;

const NETWORK_CODE = `import { createPublicClient, defineChain, fallback, http } from "viem";

export const litvmTestnet = defineChain({
  id: 4441,
  name: "LitVM LiteForge",
  nativeCurrency: { name: "zkLTC", symbol: "zkLTC", decimals: 18 },
  rpcUrls: {
    default: { http: ["${deployment.chain.rpcUrl}", "${LITVM_RPC_FALLBACK_URL}"] },
  },
  blockExplorers: {
    default: { name: "LiteForge Explorer", url: "${deployment.chain.explorerUrl}" },
  },
});

// Reads: primary endpoint, then the public fallback.
export const publicClient = createPublicClient({
  chain: litvmTestnet,
  transport: fallback(litvmTestnet.rpcUrls.default.http.map((url) => http(url, { timeout: 15_000 })), {
    retryCount: 1,
  }),
  pollingInterval: 1_000,
});

// For reading only. In code, load addresses from a copy of
// apps/web/features/fi/config/testnet.generated.json, not from this page.
export const contracts = {
  pixel: "${PIXEL_NFT_ADDRESS}",
  pixelClassic: "${PIXEL_CLASSIC_ADDRESS}",
  pixelMarketplace: "${NUSD_MARKETPLACE_ADDRESS ?? "not-configured"}",
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
  "function checkOriginalPacked(bytes pixels, uint256 grid) view returns (bool)",
  "function mintPacked(string artName, string description, uint256 grid, bytes pixels) returns (uint256)",
  "function tokenPackedData(uint256 tokenId) view returns (string artName, string description, uint256 grid, bytes pixels, address creator, uint256 mintedAt, bytes32 artworkHash)",
  "function tokenURI(uint256 tokenId) view returns (string)",
]);

// Grids: 8, 16, 32, 64, 128, 256.
// pixels: 6 bytes per horizontal run (x, y, width - 1, r, g, b), at most 4,096 runs.
const isOriginal = await publicClient.readContract({
  address: contracts.pixel,
  abi: pixelAbi,
  functionName: "checkOriginalPacked",
  args: [pixels, 32n],
});`;

const SWAP_CODE = `// fi/swap.ts
import { parseAbi, type Address, type WalletClient } from "viem";
import { publicClient } from "../chain";
import { assertChain, ensureAllowance, minOut, send } from "../tx";
import { FI } from "./addresses";
import { fiErrorsAbi } from "./errors";

const routerAbi = [
  ...parseAbi([
    "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
    "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
    "function swapExactNativeForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)",
    "function swapExactTokensForNative(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
  ]),
  ...fiErrorsAbi,
] as const;

const eq = (x: Address, y: Address) => x.toLowerCase() === y.toLowerCase();
export const deadlineIn = (minutes = 20) => BigInt(Math.floor(Date.now() / 1000) + minutes * 60);

export type Side = Address | "native";

export async function quoteBestRoute(tokenIn: Side, tokenOut: Side, amountIn: bigint) {
  const a = tokenIn === "native" ? FI.wzkLtc : tokenIn;
  const b = tokenOut === "native" ? FI.wzkLtc : tokenOut;
  if (eq(a, b)) throw new Error("Same token: wrap or unwrap with WzkLTC deposit/withdraw instead");
  const candidates: Address[][] = [[a, b]];
  for (const base of [FI.nusd, FI.wzkLtc]) {
    if (!eq(a, base) && !eq(b, base)) candidates.push([a, base, b]);
  }
  const quotes = await Promise.all(
    candidates.map(async (path) => {
      try {
        const amounts = await publicClient.readContract({
          address: FI.router, abi: routerAbi, functionName: "getAmountsOut", args: [amountIn, path],
        });
        return { path, out: amounts[amounts.length - 1] };
      } catch {
        return undefined; // PairNotFound, InvalidPath, InsufficientLiquidity
      }
    }),
  );
  let best: { path: Address[]; out: bigint } | undefined;
  for (const q of quotes) if (q && (!best || q.out > best.out)) best = q;
  if (!best || best.out === 0n) throw new Error("No executable 0xFi route");
  return best;
}

export async function swap(
  walletClient: WalletClient,
  account: Address,
  tokenIn: Side,
  tokenOut: Side,
  amountIn: bigint,
  slippageBps = 50n,
) {
  if (amountIn <= 0n) throw new Error("Amount must be positive");
  if (slippageBps < 0n || slippageBps >= 10_000n) throw new Error("Slippage out of range");
  await assertChain(walletClient);
  if ((await publicClient.getChainId()) !== 4441) throw new Error("RPC is not chain 4441");
  const nativeNusd =
    (tokenIn === "native" && tokenOut !== "native" && eq(tokenOut, FI.nusd)) ||
    (tokenOut === "native" && tokenIn !== "native" && eq(tokenIn, FI.nusd));
  if (nativeNusd) throw new Error("Use NUSD mintAtOracle / redeemAtOracle for zkLTC <-> NUSD");

  // Fresh quote right before sending.
  const best = await quoteBestRoute(tokenIn, tokenOut, amountIn);
  const amountOutMin = minOut(best.out, slippageBps);
  if (amountOutMin === 0n) throw new Error("Minimum output rounds to zero");

  if (tokenIn === "native") {
    return send(walletClient, {
      account, address: FI.router, abi: routerAbi, functionName: "swapExactNativeForTokens",
      args: [amountOutMin, best.path, account, deadlineIn()], value: amountIn,
    });
  }
  await ensureAllowance(walletClient, account, tokenIn, FI.router, amountIn);
  return send(walletClient, {
    account, address: FI.router, abi: routerAbi,
    functionName: tokenOut === "native" ? "swapExactTokensForNative" : "swapExactTokensForTokens",
    args: [amountIn, amountOutMin, best.path, account, deadlineIn()],
  });
}`;

const PUMP_BUY_CODE = `// pump/buy.ts
import { erc20Abi, type Address, type WalletClient } from "viem";
import { publicClient } from "../chain";
import { assertChain, ensureAllowance, minOut, send } from "../tx";
import { NUSD, PUMP } from "./addresses";
import { pumpAbi } from "./abi";

const nowSec = () => BigInt(Math.floor(Date.now() / 1000));

export async function buyOnCurve(
  walletClient: WalletClient,
  account: Address,
  token: Address,
  maxNusdIn: bigint,          // parseUnits(input, 18)
  slippageBps = 100n,         // 1%; the web app offers 50 / 100 / 200
) {
  await assertChain(walletClient);
  if (maxNusdIn <= 0n) throw new Error("Enter an amount");

  const [market, paused] = await Promise.all([
    publicClient.readContract({ address: PUMP, abi: pumpAbi, functionName: "markets", args: [token] }),
    publicClient.readContract({ address: PUMP, abi: pumpAbi, functionName: "paused" }),
  ]);
  if (paused) throw new Error("0xPump is paused; buys are disabled");
  if (market[7] !== 1) throw new Error("Buys are open only while the market is TRADING");

  const [tokenOut, , userNusdAmount, feeNusd, readyAfter] = await publicClient.readContract({
    address: PUMP, abi: pumpAbi, functionName: "quoteBuy", args: [token, maxNusdIn],
  });
  if (tokenOut === 0n || userNusdAmount === 0n) throw new Error("Amount too small");
  const minTokenOut = minOut(tokenOut, slippageBps);

  const balance = await publicClient.readContract({
    address: NUSD, abi: erc20Abi, functionName: "balanceOf", args: [account],
  });
  if (balance < userNusdAmount) throw new Error("Not enough NUSD");

  await ensureAllowance(walletClient, account, NUSD, PUMP, userNusdAmount);

  const deadline = nowSec() + 20n * 60n;
  const { hash, result, receipt } = await send(walletClient, {
    account, address: PUMP, abi: pumpAbi, functionName: "buy",
    args: [token, userNusdAmount, minTokenOut, deadline],
  });
  return { hash, receipt, simulated: result, feeNusd, readyAfter };
}`;

const NUSD_MINT_CODE = `import type { Address, WalletClient } from "viem";
import { publicClient } from "./chain";
import { assertChain, confirm, minOut } from "./tx";
import { NUSD, nusdAbi, oracleRouterAbi } from "./nusd";

export async function mintNusd(
  walletClient: WalletClient,
  account: Address,
  collateralWei: bigint,     // parseEther("1") for 1 zkLTC
  slippageBps = 50n,
) {
  if (collateralWei <= 0n) throw new Error("Amount must be greater than 0");
  await assertChain(walletClient);

  const [paused, oracle, balance] = await Promise.all([
    publicClient.readContract({ address: NUSD, abi: nusdAbi, functionName: "mintPaused" }),
    publicClient.readContract({ address: NUSD, abi: nusdAbi, functionName: "oracle" }),
    publicClient.getBalance({ address: account }),
  ]);
  if (paused) throw new Error("Minting is paused");
  if (balance < collateralWei) throw new Error("Not enough zkLTC (keep some for gas)");
  const fresh = await publicClient.readContract({ address: oracle, abi: oracleRouterAbi, functionName: "isFresh" });
  if (!fresh) throw new Error("Oracle price is stale; minting is unavailable");

  const quote = await publicClient.readContract({
    address: NUSD, abi: nusdAbi, functionName: "quoteMint", args: [collateralWei],
  });
  if (quote === 0n) throw new Error("Amount too small");
  const minNusdOut = minOut(quote, slippageBps);

  const { request, result } = await publicClient.simulateContract({
    account, address: NUSD, abi: nusdAbi, functionName: "mintAtOracle",
    args: [minNusdOut, account], value: collateralWei,
  });
  await assertChain(walletClient);
  const hash = await walletClient.writeContract(request);
  const receipt = await confirm(hash); // throws unless status === "success"
  return { hash, receipt, expectedNusd: result };
}`;

const PIXEL_BUY_CODE = `import { publicClient, connectedAccount, MARKET } from "./liteforge";
import { send } from "./send";
import { marketAbi, checkMarket, ensureNusdAllowance, walletPayment } from "./market";

export async function buyListing(listingId: bigint) {
  const account = await connectedAccount();
  await checkMarket(true);
  const [, , price, seller, active] = await publicClient.readContract({
    address: MARKET, abi: marketAbi, functionName: "listings", args: [listingId],
  });
  if (!active) throw new Error("Listing is no longer active");
  if (seller.toLowerCase() === account.toLowerCase()) throw new Error("You cannot buy your own listing");

  const credit = await publicClient.readContract({ address: MARKET, abi: marketAbi, functionName: "credits", args: [account] });
  const pay = walletPayment(price, credit);
  await ensureNusdAllowance(account, pay); // also checks wallet balance

  return send({ account, address: MARKET, abi: marketAbi, functionName: "buy", args: [listingId, price, pay] });
}`;

// Copied verbatim from docs/developers/prompts/*.md; tests/data/docsPrompts.test.ts keeps them in sync.
const FI_SWAP_PROMPT = `You are adding a 0xFi swap widget to my app.

STACK
- Next.js (App Router) + TypeScript (strict) + viem 2 + wagmi 2. <my wallet connector, e.g. RainbowKit / ConnectKit / injected>.
- All token amounts are bigint in base units. Never use Number, parseFloat, toFixed or \`* 10 **\` on amounts. Parse with parseUnits, format with formatUnits, and read decimals() live for any token that is not NUSD/WzkLTC (both 18).

CHAIN
- LitVM LiteForge testnet: id 4441, native currency zkLTC (18 decimals).
- RPC HTTP: https://liteforge.rpc.caldera.xyz/infra-partner-http, fallback https://liteforge.rpc.caldera.xyz/http.
- RPC WS: wss://liteforge.rpc.caldera.xyz/infra-partner-ws, fallback wss://liteforge.rpc.caldera.xyz/ws.
- Explorer: https://liteforge.explorer.caldera.xyz.
- Source: 0xNothing-zkLTC-Testnet/apps/web/lib/publicConfig.ts:6-14. Define the chain with viem defineChain and a fallback() transport.

ADDRESSES (load, do not hard-code)
- Copy 0xNothing-zkLTC-Testnet/apps/web/features/fi/config/testnet.generated.json into the project as a JSON module and pass every address through getAddress(). Keys used here:
  - dexRouter  -> ZeroXFiRouterV2
  - dexFactory -> ZeroXFiFactoryV2
  - nusd       -> NUSD (base asset, 18 decimals)
  - wzkltc     -> WzkLTC (base asset, 18 decimals; wrapped native zkLTC)
- Do NOT use 0xFi/contracts/deployments/latest.json: it is the retired v1 suite.
- On load, assert publicClient.getChainId() === 4441.

ABI (copy these fragments; they match apps/web/features/fi/lib/abis/dex.ts:13-92 and 0xFi/contracts/src/amm/ZeroXFiRouterV2.sol)
Router:
  function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)
  function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)
  function swapExactNativeForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)
  function swapExactTokensForNative(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)
  function LP_FEE_BPS() view returns (uint256)
  function DIRECT_FEE_BPS() view returns (uint256)
  function CROSS_FEE_BPS() view returns (uint256)
  error DeadlineExpired()
  error FeeOnTransferUnsupported()
  error InsufficientAmount()
  error InsufficientLiquidity()
  error InsufficientOutputAmount()
  error InvalidPath()
  error InvalidRecipient()
  error PairNotFound()
  error UnauthorizedNativeSender()
Factory:
  function swapsPaused() view returns (bool)
  error SwapsPaused()
  error Forbidden()
ERC-20:
  function decimals() view returns (uint8)
  function symbol() view returns (string)
  function balanceOf(address) view returns (uint256)
  function allowance(address owner, address spender) view returns (uint256)
  function approve(address spender, uint256 amount) returns (bool)

FACTS YOU MUST RESPECT
- Every pool contains NUSD or WzkLTC. A path has 2 to 4 entries (max 3 hops), no zero address, no duplicates; each hop's pair must exist.
- getAmountsOut(...)[last] is the amount delivered AFTER all fees. Fees: 50 bps LP per hop, plus ONE router fee per route: 10 bps if path[0] or path[last] is NUSD or WzkLTC, otherwise 30 bps. No other surcharge. (ZeroXFiRouterV2.sol:45-48,337,359-365)
- Native zkLTC in: swapExactNativeForTokens with value = amountIn, path[0] must be WzkLTC, no approval.
- Native zkLTC out: swapExactTokensForNative, path[last] must be WzkLTC, approve the ERC-20 input to the router.
- ERC-20 in: approve the ROUTER for exactly amountIn. Fee-on-transfer tokens are rejected (FeeOnTransferUnsupported).
- Never send zkLTC to the router directly (UnauthorizedNativeSender).
- WzkLTC <-> native zkLTC is wrap/unwrap (WzkLTC.deposit() payable / withdraw(uint256)), not a swap.
- Exact zkLTC <-> NUSD is NOT an AMM trade: route it to NUSD mintAtOracle / redeemAtOracle (see docs/developers/nusd.md). You may leave it out of this widget and link to the NUSD panel.

FLOW
1. Require a connected account. If the wallet chain id !== 4441, show "Switch to LiteForge" (switchChain, addChain if unknown) and disable the action.
2. Read factory.swapsPaused(); if true, show "Swaps paused" and disable.
3. Map "native" to WzkLTC for path building. Build candidates: [in, out]; [in, NUSD, out] if neither end is NUSD; [in, WzkLTC, out] if neither end is WzkLTC.
4. Debounce input (~300 ms). Quote each candidate with getAmountsOut; a revert (PairNotFound, InvalidPath, InsufficientLiquidity) just drops that candidate. Pick the largest last amount. If none: "No route".
5. minOut = quoted * (10000n - slippageBps) / 10000n. slippageBps default 50n, user-editable 1..500. Reject minOut === 0n.
6. deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60).
7. If the input is an ERC-20: read allowance(account, router). If < amountIn, simulate approve(router, amountIn), write it, wait for the receipt, require status "success", then continue.
8. Re-quote the chosen path right before sending and recompute minOut.
9. simulateContract with the exact account, args and value (value only for the native-in function). Show the decoded error name on revert and send nothing.
10. Check chain id 4441 again, writeContract(request), waitForTransactionReceipt({ hash }). Anything but receipt.status === "success" is a failure.
11. Refresh balances and the quote.

UI STATES
not connected | wrong network | swaps paused | loading quote | no route | quote ready (show route, expected out, minimum received, fee breakdown: LP 0.5% per hop + router 0.1% or 0.3%, slippage) | insufficient balance (leave gas when paying native) | needs approval | approving | awaiting signature | pending (link https://liteforge.explorer.caldera.xyz/tx/<hash>) | success | reverted / error with the decoded error name. Disable the button while a transaction is in flight (no double submit).

DO NOT
- Do not call any /api/* or /0xFi/api/* route of the 0xNothing web app.
- Do not use the subgraph to size a transaction or compute minOut.
- Do not use an unlimited approval.
- Do not add a private key, mnemonic or API key anywhere.

ACCEPTANCE CHECKLIST (verify each and list the file:line that satisfies it)
[ ] Addresses come from the copied testnet.generated.json through getAddress; nothing is hard-coded; publicClient chain id 4441 is asserted.
[ ] Candidates include [in,out], [in,NUSD,out] and [in,WzkLTC,out]; failed quotes are skipped, not fatal.
[ ] Every write: chain check, fresh quote, non-zero minOut, deadline, allowance branch with receipt wait, simulateContract with the same account/args/value, writeContract, receipt status check.
[ ] Native in uses value and no approval; native out ends the path in WzkLTC.
[ ] All amounts are bigint; a grep for Number(, parseFloat, toFixed on amounts finds nothing.
[ ] Errors show the decoded custom error name.
[ ] A unit test covers minOut math (0 and 10000 bps bounds), best-route selection with a rejected candidate, and the native/ERC-20 function choice.
Cite the source file and line for every address, function signature and fee value you used.`;

const PUMP_TRADE_PROMPT = `You are building a 0xPump buy/sell panel in a Next.js + TypeScript app with viem and wagmi. 0xPump (ZeroXPumpV2) sells a token along a NUSD bonding curve on the LitVM LiteForge testnet.

Network: viem defineChain with id 4441, name "LitVM LiteForge", native currency zkLTC (18 decimals), HTTP RPC https://liteforge.rpc.caldera.xyz/infra-partner-http then https://liteforge.rpc.caldera.xyz/http (apps/web/lib/publicConfig.ts:6-8), explorer https://liteforge.explorer.caldera.xyz.

Addresses: copy apps/web/features/fi/config/testnet.generated.json and read \`pump\` (the launchpad and the ERC-20 spender) and \`nusd\` (NUSD, 18 decimals). Use getAddress. No other hard-coded addresses.

ABI: copy from docs/developers/0xpump.md section "ABI": markets, marketParams, paused, quoteBuy, quoteSell, buy, sell, the TokenTraded/TokenReadyForGraduation/TokenCurveReopened events, all ZeroXPumpV2 custom errors (ContractPaused, DeadlineExpired, MarketNotFound, MarketNotTrading, InvalidAmount, SlippageExceeded, AssetTransferMismatch, ...), and pumpTokenAbi (balanceOf, allowance, approve, decimals, plus ERC20InsufficientBalance/ERC20InsufficientAllowance/ERC20InvalidAddress). For NUSD use viem's erc20Abi. Exact signatures:
- quoteBuy(address token,uint256 maxNusdIn) view returns (uint256 tokenOut,uint256 curveNusdAmount,uint256 userNusdAmount,uint256 feeNusd,bool readyAfter)
- quoteSell(address token,uint256 tokenIn) view returns (uint256 curveNusdAmount,uint256 userNusdAmount,uint256 feeNusd)
- buy(address token,uint256 maxNusdIn,uint256 minTokenOut,uint256 deadline) returns (uint256 tokenOut,uint256 userNusdAmount)
- sell(address token,uint256 tokenIn,uint256 minNusdOut,uint256 deadline) returns (uint256 userNusdAmount)
Neither function is payable.

Rules for BUY (NUSD -> token):
1. Require the wallet chain id to be 4441; offer switchChain (and addChain if unknown) otherwise. Re-check right before every write.
2. Read markets(token) (lifecycle at index 7) and paused(). Buy only when lifecycle === 1 (TRADING) and not paused.
3. Parse the input with parseUnits(input, 18). Read quoteBuy(token, amount) fresh (debounce ~300 ms while typing, and again right before sending). Reject tokenOut == 0.
4. Show: tokens out (tokenOut), NUSD actually spent (userNusdAmount, which can be less than the input near the graduation target: say so), fee (feeNusd), and a "this buy completes the curve" note when readyAfter is true.
5. minTokenOut = tokenOut * (10000 - slippageBps) / 10000 with bigint math. Slippage choices 50 / 100 / 200 bps, default 100.
6. Check NUSD balanceOf >= userNusdAmount. If NUSD allowance(account, pump) < userNusdAmount: simulate and send approve(pump, userNusdAmount) (exact amount, not unlimited), wait for the receipt, require status "success".
7. deadline = BigInt(Math.floor(Date.now()/1000)) + 1200n (20 minutes).
8. simulateContract buy(token, userNusdAmount, minTokenOut, deadline) with the connected account, then writeContract(request), then waitForTransactionReceipt and require status "success".
Rules for SELL (token -> NUSD):
1. Same chain check. Sell when lifecycle is 1 (TRADING) or 2 (READY). Selling works while paused. A sell from READY reopens the curve: tell the user.
2. quoteSell(token, tokenIn) fresh; output = userNusdAmount, fee = feeNusd; reject userNusdAmount == 0.
3. minNusdOut from userNusdAmount with the same slippage math.
4. Check token balanceOf >= tokenIn; if token allowance(account, pump) < tokenIn approve exactly tokenIn to pump and wait for a successful receipt.
5. simulate sell(token, tokenIn, minNusdOut, deadline), write, wait, check status.
After any confirmed trade: re-read market, balances and allowance over RPC. Never use subgraph data or event payloads to size a trade.
Per-market fee: read marketParams(token).tradeFeeBps; do not hard-code 10 bps.
Errors: decode viem ContractFunctionRevertedError and map names to messages: ContractPaused, DeadlineExpired (re-quote), MarketNotTrading (refresh status; market became READY or GRADUATED), InvalidAmount, SlippageExceeded (re-quote, show the new price), AssetTransferMismatch, ERC-20 balance/allowance errors, user rejection (UserRejectedRequestError: return to idle, no error banner).

UI states: disconnected, wrong network, market not tradable (READY: only sell; GRADUATED: link to 0xFi pool markets(token).pool), quoting, insufficient balance, needs approval, approving (pending hash with explorer link), ready to submit, simulating, awaiting signature, pending, confirmed (hash + amounts), failed (decoded reason). Disable the submit button while any step is in flight; block double submits.

Acceptance checklist (report file:line for each):
- [ ] Chain id 4441 checked before approve and before buy/sell.
- [ ] Addresses only from the copied manifest via getAddress.
- [ ] Quote is re-read right before sending; minimum output is never 0.
- [ ] Buy passes the quoted userNusdAmount as maxNusdIn and approves exactly that.
- [ ] Deadline argument present on both buy and sell.
- [ ] Approval receipt awaited before the dependent call.
- [ ] simulateContract uses the same account and args as writeContract.
- [ ] Receipt status checked; failures show the decoded error name.
- [ ] All amounts bigint; no Number/parseFloat/toFixed on amounts.
- [ ] No /api/* calls, no secrets.
- [ ] Unit test for the minOut function (0, 50, 100, 200, 10000 bps) and a build that passes.`;

const NUSD_MINT_PROMPT = `You are adding an NUSD mint and redeem panel to my app.

STACK
- Next.js (App Router) + TypeScript (strict) + viem 2 + wagmi 2. <my wallet connector, e.g. RainbowKit / ConnectKit / injected>.
- All token amounts are bigint in base units (18 decimals). Never use Number, parseFloat, toFixed or \`* 10 **\` on amounts. Parse with parseUnits/parseEther, format with formatUnits.

CHAIN
- LitVM LiteForge testnet: id 4441, native currency zkLTC (18 decimals).
- RPC HTTP: https://liteforge.rpc.caldera.xyz/infra-partner-http, fallback https://liteforge.rpc.caldera.xyz/http.
- RPC WS: wss://liteforge.rpc.caldera.xyz/infra-partner-ws, fallback wss://liteforge.rpc.caldera.xyz/ws.
- Source: 0xNothing-zkLTC-Testnet/apps/web/lib/publicConfig.ts:6-12. Define the chain with viem defineChain and a fallback() transport.

ADDRESSES (load, do not hard-code)
- Read 0xNothing-zkLTC-Testnet/contracts/deployments/v3-core.json at build time (copy it into the project as a JSON module). Assert chainId === 4441. Use keys:
  - nusd       -> NUSD token and mint/redeem contract (OracleNUSDv2)
  - ltcOracle  -> LTC/USD OracleRouter
- On load, read nusd.oracle() and fail closed if it differs from ltcOracle.

ABI (copy these fragments; they match apps/web/features/pump/abis.ts:68-96 and the Solidity in contracts/src/nusd/OracleNUSDv2.sol and contracts/src/nusd/DIAOracleAdapter.sol)
NUSD:
  function balanceOf(address account) view returns (uint256)
  function totalSupply() view returns (uint256)
  function oracle() view returns (address)
  function mintPaused() view returns (bool)
  function backingRatioWad() view returns (uint256)
  function supplyCeilingNusd() view returns (uint256)
  function quoteMint(uint256 collateralWei) view returns (uint256 amountNusd)
  function mintAtOracle(uint256 minNusdOut, address recipient) payable returns (uint256 amountNusd)
  function quoteRedeem(uint256 amountNusd) view returns (uint256 collateralOutWei)
  function redeemAtOracle(uint256 amountNusd, uint256 minCollateralOutWei, address recipient) returns (uint256 collateralOutWei)
  event MintedAtOracle(address indexed payer, address indexed recipient, uint256 collateralInWei, uint256 amountNusd)
  event RedeemedAtOracle(address indexed account, address indexed recipient, uint256 amountNusd, uint256 collateralOutWei)
  error MintPaused()
  error InvalidAmount()
  error InvalidRecipient()
  error SlippageExceeded(uint256 minimumAmount, uint256 actualAmount)
  error SupplyCeilingExceeded(uint256 requestedAmountNusd, uint256 availableAmountNusd)
  error ERC20InsufficientBalance(address account, uint256 balance, uint256 requiredAmount)
  error StaleOraclePrice(uint256 updatedAt, uint256 currentTimestamp)
  error InvalidOracleAnswer()
  error IncompleteOracleRound()
  error FutureOracleTimestamp()
OracleRouter:
  function readPriceWad() view returns (uint256 priceWad, uint256 updatedAt, uint80 roundId)
  function isFresh() view returns (bool)

FACTS YOU MUST RESPECT
- Mint pays native zkLTC as \`value\` to mintAtOracle. No ERC-20 approval. NEVER send a plain zkLTC transfer to the NUSD address: receive() books it as a reserve donation and mints nothing.
- Redeem needs NO approval: redeemAtOracle burns from msg.sender.
- Redeem pays min(oracle price, pro-rata share of the reserve). Backing can be below 1 (it was ~0.91 on 2026-11-05 and moves with the LTC price), so show the quoted zkLTC, never "1 NUSD = 1 USD guaranteed".
- Admins cannot pause redeem, but quoteRedeem and redeemAtOracle REVERT while the DIA price is stale (older than 90 minutes). Catch that revert (StaleOraclePrice or the other oracle errors) and show "Price feed is stale - use the emergency exit" with a link to the emergency panel.
- Mint can be paused (mintPaused()). Mint also reverts on a stale price and above the supply ceiling.
- Prices are WAD (1e18 = 1 USD). Fees are 0 today but read them from the quote, do not assume.

FLOW: MINT
1. Require a connected account. If chainId !== 4441, show a "Switch to LiteForge" button (switchChain, then addChain if unknown) and disable the action.
2. Read mintPaused(), oracle(), router.isFresh(), the account's zkLTC balance. Block with a clear message if paused or not fresh, or if amount > balance (leave gas).
3. Debounce input (~300 ms), then read quoteMint(amountWei). Re-read the quote right before sending.
4. minNusdOut = quote * (10000n - slippageBps) / 10000n, slippageBps default 50n (0.5%), user-editable 1..500. Never 0.
5. simulateContract({ account, address: nusd, abi, functionName: "mintAtOracle", args: [minNusdOut, account], value: amountWei }).
6. Check the chain id again, writeContract(request), then waitForTransactionReceipt({ hash }). Treat anything but receipt.status === "success" as failure.
7. Decode MintedAtOracle from the receipt, show the minted amount, refresh balances.

FLOW: REDEEM
1. Same chain guard. Read NUSD balanceOf(account); block if amount > balance.
2. Read quoteRedeem(amountNusd). If it reverts with an oracle error, switch to the stale-price state. If it returns 0, show "amount too small".
3. minCollateralOutWei = quote * (10000n - slippageBps) / 10000n.
4. simulateContract redeemAtOracle(amountNusd, minCollateralOutWei, account) with the exact account. No value, no approval.
5. writeContract, waitForTransactionReceipt, require status "success", decode RedeemedAtOracle, refresh.

UI STATES
not connected | wrong network | loading quote | quote ready (show rate, min received, slippage, backing ratio) | mint paused | price stale | insufficient balance | above supply ceiling (show available from SupplyCeilingExceeded) | awaiting signature | pending (link https://liteforge.explorer.caldera.xyz/tx/<hash>) | success | reverted / error with the decoded error name. Disable the button while a transaction is in flight (no double submit).

DO NOT
- Do not call any /api/* or /0xFi/api/* route of the 0xNothing web app.
- Do not use a subgraph to size a transaction.
- Do not add a private key, mnemonic or API key anywhere.

ACCEPTANCE CHECKLIST (verify each and list the file:line that satisfies it)
[ ] Addresses come from v3-core.json; chainId and nusd.oracle() === ltcOracle are asserted.
[ ] Every write is preceded by a chain-id 4441 check, a fresh quote, a non-zero min-out, and simulateContract with the same account/args/value.
[ ] Mint uses mintAtOracle with value; there is no plain zkLTC transfer anywhere.
[ ] Redeem has no approve call.
[ ] Stale-oracle revert on redeem is caught and routed to the emergency exit.
[ ] receipt.status === "success" is required before showing success.
[ ] All amounts are bigint; a grep for Number(, parseFloat, toFixed on amounts finds nothing.
[ ] Errors show the decoded custom error name.
[ ] A unit test covers minOut math (including 0 and 10000 bps bounds) and the stale-oracle branch with a mocked revert.
Cite the source file and line for every address, function signature and decimals value you used.`;

const PIXEL_MINT_PROMPT = `Build a "0xPixel mint studio" page in my Next.js (App Router) + TypeScript app using viem and wagmi. Users draw pixel art and mint it to the 0xPixel V2 NFT contract on LitVM LiteForge testnet.

CHAIN
- Define the chain with viem defineChain: id 4441, name "LitVM LiteForge", native currency zkLTC (18 decimals).
- RPC http: "https://liteforge.rpc.caldera.xyz/infra-partner-http", fallback "https://liteforge.rpc.caldera.xyz/http". WebSocket: "wss://liteforge.rpc.caldera.xyz/infra-partner-ws". Explorer: "https://liteforge.explorer.caldera.xyz". Multicall3: 0xca11bde05977b3631167028862be2a173976ca11. These come from 0xNothing-zkLTC-Testnet/apps/web/lib/publicConfig.ts.

ADDRESSES
- Load the collection address from 0xNothing-zkLTC-Testnet/contracts/deployments/v3-core.json key "pixelV2" (check "chainId" is 4441). Copy that JSON into my repo as config/0xnothing/v3-core.json and import it. Do not hard-code the address in components.

ABI (copy exactly; source 0xNothing-zkLTC-Testnet/contracts/src/0xpixel/ZeroXPixelV2.sol)
- function mintPacked(string artName, string description, uint256 grid, bytes pixels) returns (uint256)
- function checkOriginalPacked(bytes pixels, uint256 grid) view returns (bool)
- event Minted(address indexed creator, uint256 indexed tokenId, string name)
- errors: InvalidName(), InvalidDescription(), InvalidUTF8(), InvalidGrid(), InvalidPixels(), PixelOutOfBounds(), NonCanonicalPixels(), ArtworkAlreadyExists(), ReentrantCall()

ENCODING (the contract rejects anything else)
- Grid sizes: 8, 16, 32, 64, 128, 256. Cells are "#rrggbb" or transparent.
- pixels = raw bytes, 6 per horizontal run: [x, y, countMinusOne, r, g, b]. Width = countMinusOne + 1.
- Row-major: rows by y ascending, runs by x ascending, no overlap. Adjacent cells of the same colour in a row MUST be merged into one run. Transparent cells produce no bytes.
- At least 1 run, at most 4,096 runs (24,576 bytes). Count runs live and block minting above the limit.
- Write packPixels(rows, grid): Hex as a pure function with unit tests: merging, transparency gaps, a full 256-wide row (countMinusOne = 255), empty canvas throws, 4,097 runs throws.

FLOW for "Mint"
1. Require a connected wallet. If chainId !== 4441, show "Switch to LiteForge" and call switchChain; do not continue until it is 4441.
2. Validate with TextEncoder: trimmed name 1-64 bytes, description 0-1,024 bytes.
3. Pack. Read checkOriginalPacked(pixels, BigInt(grid)) fresh (debounce while drawing, and again right before signing). false => "Already minted". A revert => encoding bug, show it.
4. simulateContract mintPacked with the connected account and no value field (mintPacked is nonpayable, so the mint sends 0 zkLTC; viem's types reject \`value\` on nonpayable functions). No token approvals exist for this flow.
5. estimateContractGas, gas = est + est/5n + 100_000n; read latest block and refuse if gas > 90% of block.gasLimit ("Too detailed for one block").
6. writeContract with the simulated request and that gas. waitForTransactionReceipt. Require receipt.status === "success". Parse the Minted log for tokenId (bigint) and link to the explorer tx.
7. Decode reverts with viem's ContractFunctionRevertedError and map each error name to a plain message.

UI STATES
- Canvas editor with grid-size picker, colour picker, eraser (transparent), clear; live run counter "N / 4,096".
- Checking originality, original, already minted, encoding error.
- Wrong network, not connected, simulating, waiting for wallet signature, pending (tx hash link), success (token id + link), failed (decoded error), user rejected.
- Disable the Mint button while any request is in flight; prevent double submit.

ACCEPTANCE CHECKLIST
- [ ] No address literal in components; it comes from the copied v3-core.json.
- [ ] Every amount, grid argument and token id is a bigint at the contract boundary.
- [ ] packPixels unit tests pass, including merge and 256-wide-row cases.
- [ ] Chain id 4441 is checked before simulate and before write.
- [ ] Originality is re-read right before signing; simulate runs with the exact account and no value field (0 zkLTC).
- [ ] Receipt status is checked; success is only shown after status === "success".
- [ ] All 9 contract errors decode to readable messages.
- [ ] No private keys, API keys or .env secrets anywhere; typecheck and lint pass.`;

const VIBE_PROMPTS = [
  { id: "0xfi", title: "0xFi: swap widget", source: "prompts/0xfi.md, 1. Swap widget", label: "0xFi swap widget prompt", prompt: FI_SWAP_PROMPT },
  { id: "0xpump", title: "0xPump: buy and sell widget", source: "prompts/0xpump.md, 2. Buy and sell widget", label: "0xPump buy and sell prompt", prompt: PUMP_TRADE_PROMPT },
  { id: "nusd", title: "NUSD: mint and redeem panel", source: "prompts/nusd.md, 1. Mint and redeem panel", label: "NUSD mint and redeem prompt", prompt: NUSD_MINT_PROMPT },
  { id: "0xpixel", title: "0xPixel: mint studio", source: "prompts/0xpixel.md, 1. Mint studio", label: "0xPixel mint studio prompt", prompt: PIXEL_MINT_PROMPT },
] as const;

const INDEXER_CODE = `const INDEXERS = {
  pixelMarket: "${testnet.nusdMarketGoldskyEndpoint}",
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
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="ox-docs-section-heading">
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
              <p>One testnet stack for onchain art, token markets, a zkLTC-backed dollar, DeFi, and the world arriving with mainnet.</p>
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
                title="Ecosystem architecture"
                description="Each product is useful on its own. Together they form a path from creation to markets, liquidity, and persistent digital ownership."
              />
              <div className="ox-docs-ecosystem-map">
                <div><ImageSquare size={20} aria-hidden="true" /><strong>0xPixel</strong><span>Create and trade fully onchain visual assets.</span></div>
                <div><RocketLaunch size={20} aria-hidden="true" /><strong>0xPump</strong><span>Launch community tokens through a transparent curve.</span></div>
                <div><Coins size={20} aria-hidden="true" /><strong>NUSD</strong><span>Mint a zkLTC-backed dollar and stake it for protocol fees.</span></div>
                <div><ArrowsLeftRight size={20} aria-hidden="true" /><strong>0xFi</strong><span>Settle, swap, lend, borrow, and route liquidity.</span></div>
                <div><GlobeHemisphereWest size={20} aria-hidden="true" /><strong>0xUniverse</strong><span>Bring assets and finance into a persistent game world.</span></div>
              </div>
            </section>

            <section id="0xpixel" className="ox-docs-section ox-docs-product-section">
              <SectionHeading
                title="0xPixel"
                description="A fully onchain pixel-art studio, ERC-721 collection, provenance registry, gallery, and NUSD NFT marketplace."
              />
              <div className="ox-docs-mechanism-grid">
                <div><strong>Onchain art</strong><p>Packed pixel runs, artwork name, description, grid size, creator, mint time, and artwork hash live in contract storage.</p></div>
                <div><strong>Deterministic media</strong><p>The contract generates SVG and base64 JSON metadata. The collectible does not depend on an offchain image host.</p></div>
                <div><strong>Originality</strong><p>The registry hashes packed pixel data with the grid size and rejects an artwork that was already registered.</p></div>
                <div><strong>NUSD marketplace</strong><p>Listings and escrowed offers settle in NUSD. Each sale burns 0.1% of the price and pays 0.4% to the artwork&apos;s creator; there is no platform fee. Sale proceeds and refunds are reusable credits. zkLTC only pays gas. Other marketplaces read a 1% creator royalty through ERC-2981.</p></div>
              </div>
              <div className="ox-docs-spec-line">
                <span>Supported grids</span><strong>8 x 8 up to 256 x 256, at most 4,096 colour runs</strong>
              </div>
              <DocsCodeBlock code={PIXEL_CODE} label="pixel-read.ts" />
              <ProductLink href="/0xpixel">Open 0xPixel studio</ProductLink>
              <ProductLink href="/0xpixel/marketplace">Open NUSD marketplace</ProductLink>
            </section>

            <section id="0xpump" className="ox-docs-section ox-docs-product-section">
              <SectionHeading
                title="0xPump"
                description="A NUSD launchpad with reserved metadata, virtual constant-product pricing, explicit lifecycle states, and protected graduation."
              />
              <div className="ox-docs-lifecycle" aria-label="0xPump market lifecycle">
                <div><strong>Trading</strong><span>Users buy and sell against virtual reserves.</span></div>
                <ArrowRight size={18} aria-hidden="true" />
                <div><strong>Ready</strong><span>Buys stop when the real NUSD reserve reaches the market&apos;s target.</span></div>
                <ArrowRight size={18} aria-hidden="true" />
                <div><strong>Graduated</strong><span>The real NUSD and matching tokens seed a new 0xFi pool. The LP goes to the locker.</span></div>
              </div>
              <div className="ox-docs-facts">
                <div><span>Creation fee</span><strong>1 NUSD</strong><small>Paid in reserveMarket, before the metadata upload. Not refundable.</small></div>
                <div><span>Trade fee</span><strong>0.1%</strong><small>10 bps for new markets today. Each market keeps its own terms.</small></div>
                <div><span>Graduation target</span><strong>6,000 NUSD</strong><small>Market cap. The on-chain gate is a 1,500 NUSD real reserve.</small></div>
              </div>
              <div className="ox-docs-note">
                <strong>Lifecycle safety</strong>
                <span>A sell from READY reopens the curve. Anyone can graduate a READY market through the controller&apos;s graduateReady while graduations are not paused, the router is enabled, and the adapter is allowed.</span>
              </div>
              <div className="ox-docs-method-list">
                <div><code>reserveMarket(contentHash)</code><span>Pay the nonrefundable creation fee.</span></div>
                <div><code>createMarket(...)</code><span>Create the fixed-supply token and curve.</span></div>
                <div><code>quoteBuy / buy</code><span>Quote and execute NUSD input.</span></div>
                <div><code>quoteSell / sell</code><span>Quote and execute token input.</span></div>
              </div>
              <ProductLink href="/0xPump">Open 0xPump markets</ProductLink>
            </section>

            <section id="nusd" className="ox-docs-section ox-docs-product-section">
              <SectionHeading
                title="NUSD"
                description="The dollar every 0xNothing product settles in: minted against native zkLTC at the DIA price, and staked for a share of protocol fees."
              />
              <div className="ox-docs-fi-surfaces">
                <div><strong>Mint and redeem</strong><span>Mint against native zkLTC at the DIA price. Redeem pays the DIA value but never more than a holder&apos;s share of the reserve, so a short reserve cannot be drained by the first to leave. Admins cannot pause redeem, but redeem reverts while the DIA price is older than 90 minutes. Mint can be paused. Mint and redeem fees are 0% today and capped at 0.5% by the contract.</span></div>
                <div><strong>Oracle failure</strong><span>Anyone can report a DIA failure on chain. If the price is still unusable 7 days later, every holder can exit through emergency redeem for a pro-rata share of the reserve, with no price and no fee.</span></div>
                <div><strong>Earn</strong><span>Lock NUSD for 30 to 365 days for 0xPoints and NUSD rewards. Every NUSD fee is split 70% to stakers, streamed over 7 days by lock weight, 20% burned and 10% to the treasury. Fees paid in zkLTC go 90% to the NUSD reserve and 10% to the treasury.</span></div>
                <div><strong>Surplus</strong><span>When the zkLTC reserve reaches 3.3x the NUSD supply, anyone can mint the excess down to 3.0x, at most once a week and within the supply-ceiling headroom: 80% to stakers, 20% to the treasury.</span></div>
              </div>
              <div className="ox-docs-method-list">
                <div><code>quoteMint / mintAtOracle</code><span>Native zkLTC in, NUSD out.</span></div>
                <div><code>quoteRedeem / redeemAtOracle</code><span>NUSD in, native zkLTC out. No approval needed.</span></div>
              </div>
              <ProductLink href="/nusd">Open NUSD</ProductLink>
            </section>

            <section id="0xfi" className="ox-docs-section ox-docs-product-section">
              <SectionHeading
                title="0xFi"
                description="The liquidity and risk layer for swaps, pools, LP farms, pooled NUSD lending and borrowing, DIA-priced synthetic assets, and a planned RWA market."
              />
              <div className="ox-docs-fi-surfaces">
                <div><strong>Swap and pools</strong><span>Constant-product pairs, one LP token per unordered pair, and router-protected liquidity operations. Every pool contains NUSD or WzkLTC.</span></div>
                <div><strong>Farm</strong><span>Stake a pair&apos;s LP tokens in its gauge to earn NUSD. Rewards exist only while a funded schedule runs.</span></div>
                <div><strong>Lend and borrow</strong><span>Borrowers pay a fixed 4.5% APR. Lenders earn 4% on the share of the pool that is borrowed, and 0.5% is the protocol spread. WzkLTC, nBTC, and nETH collateral is pooled across the account&apos;s assets.</span></div>
                <div><strong>Synths</strong><span>Lock NUSD and mint nBTC or nETH at the DIA price. Users supply 150% collateral, or 100% when the safety reserve qualifies. The mint fee is 0.1%.</span></div>
                <div><strong>RWA</strong><span>The RWA market contract charges a 1% fee. No RWA market is deployed or listed on testnet yet.</span></div>
              </div>
              <div className="ox-docs-fee-table-wrap" tabIndex={0}>
                <table>
                  <thead><tr><th>Swap</th><th>LP fee</th><th>Router fee</th><th>Nominal total</th></tr></thead>
                  <tbody>
                    <tr><td>1 hop, TOKEN ↔ NUSD or WzkLTC</td><td>0.5%</td><td>0.1%</td><td>0.6%</td></tr>
                    <tr><td>2 hops, one end NUSD or WzkLTC</td><td>1.0%</td><td>0.1%</td><td>1.1%</td></tr>
                    <tr><td>TOKEN → NUSD or WzkLTC → TOKEN</td><td>1.0%</td><td>0.3%</td><td>1.3%</td></tr>
                    <tr><td>3 hops (maximum)</td><td>1.5%</td><td>0.1% or 0.3%</td><td>1.6% or 1.8%</td></tr>
                  </tbody>
                </table>
              </div>
              <p className="ox-docs-copy"><code>getAmountsOut</code> already returns the net amount after LP fees, the router fee, and price impact. Do not subtract them twice. The router fee is charged once per route: 10 bps when the first or last token is NUSD or WzkLTC, otherwise 30 bps.</p>
              <ProductLink href="/0xFi">Open 0xFi</ProductLink>
            </section>

            <section id="0xuniverse" className="ox-docs-section ox-docs-universe">
              <div className="ox-docs-universe-status">Coming with mainnet</div>
              <SectionHeading
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

            <section id="developer-guides" className="ox-docs-section">
              <SectionHeading
                title="Developer guides"
                description="One guide per product in the repository, checked against the deployed manifests and ABIs. Each pairs with a prompts file for coding agents."
              />
              <div className="ox-docs-fee-table-wrap" tabIndex={0}>
                <table>
                  <thead><tr><th>Product</th><th>Flows covered</th><th>Guide</th><th>Agent prompts</th></tr></thead>
                  <tbody>
                    {DEVELOPER_GUIDES.map((guide) => (
                      <tr key={guide.file}>
                        <td>{guide.product}</td>
                        <td>{guide.covers}</td>
                        <td><a href={`${GUIDE_BASE}/${guide.file}.md`} target="_blank" rel="noopener noreferrer">{guide.file}.md<ArrowSquareOut size={12} aria-hidden="true" /></a></td>
                        <td><a href={`${GUIDE_BASE}/prompts/${guide.file}.md`} target="_blank" rel="noopener noreferrer">prompts/{guide.file}.md<ArrowSquareOut size={12} aria-hidden="true" /></a></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="ox-docs-copy">Start with the README: network, manifest and ABI files, a shared viem setup, the write pattern, and the rules every integration follows. Integrate with the contracts over JSON-RPC and the public Goldsky subgraphs. The web app&apos;s own HTTP routes and WebSocket plumbing are internal and are not a public API.</p>
              <a className="ox-docs-product-link" href={`${GUIDE_BASE}/README.md`} target="_blank" rel="noopener noreferrer">Read the developer guide README<ArrowSquareOut size={13} aria-hidden="true" /></a>
              <div className="ox-docs-note">
                <strong>Load addresses from a manifest</strong>
                <span>Import a copy of apps/web/features/fi/config/testnet.generated.json and pass each address through getAddress. Do not copy addresses from a web page. The live set is v3, active since 2026-10-15. Contracts have no proxies, so a new version means new addresses.</span>
              </div>
            </section>

            <section id="swap-integration" className="ox-docs-section">
              <SectionHeading
                title="Integrate 0xFi swaps"
                description="Choose the correct execution surface, quote against current state, simulate the exact request, then ask the wallet to sign."
              />
              <div className="ox-docs-fee-table-wrap" tabIndex={0}>
                <table>
                  <thead><tr><th>User action</th><th>Contract</th><th>Method</th></tr></thead>
                  <tbody>
                    <tr><td>Quote any route</td><td>ZeroXFiRouterV2</td><td><code>getAmountsOut(amountIn, path)</code></td></tr>
                    <tr><td>ERC-20 to ERC-20</td><td>ZeroXFiRouterV2</td><td><code>swapExactTokensForTokens</code></td></tr>
                    <tr><td>zkLTC to ERC-20</td><td>ZeroXFiRouterV2</td><td><code>swapExactNativeForTokens</code></td></tr>
                    <tr><td>ERC-20 to zkLTC</td><td>ZeroXFiRouterV2</td><td><code>swapExactTokensForNative</code></td></tr>
                    <tr><td>zkLTC to NUSD</td><td>OracleNUSDv2</td><td><code>quoteMint + mintAtOracle</code></td></tr>
                    <tr><td>NUSD to zkLTC</td><td>OracleNUSDv2</td><td><code>quoteRedeem + redeemAtOracle</code></td></tr>
                  </tbody>
                </table>
              </div>
              <div className="ox-docs-native-rules">
                <div><strong>Native input</strong><code>Path begins with WzkLTC</code><span>Send the exact input as transaction value. No ERC-20 approval.</span></div>
                <div><strong>Native output</strong><code>Path ends with WzkLTC</code><span>Approve the ERC-20 input. The router unwraps before transfer.</span></div>
              </div>
              <h3 className="ox-docs-subheading">Key rules</h3>
              <div className="ox-docs-checklist">
                {[
                  "Quote [in, out], [in, NUSD, out], and [in, WzkLTC, out]. Drop candidates that revert and keep the largest output.",
                  "A path has 2 to 4 entries, no zero address, and no duplicates. Every hop's pair must exist.",
                  "getAmountsOut returns the amount after all fees. Do not compute output from the fee table.",
                  "Approve the router for exactly amountIn and wait for the approval receipt.",
                  "Never send zkLTC to the router directly. Fee-on-transfer tokens are rejected.",
                  "Exact zkLTC to NUSD is not an AMM trade. Use NUSD mintAtOracle or redeemAtOracle.",
                  "WzkLTC to native zkLTC is wrap or unwrap with deposit() and withdraw(uint256), not a swap.",
                  "Read factory.swapsPaused() and disable swapping when it is true.",
                ].map((item) => <div key={item}><CheckCircle size={16} weight="fill" aria-hidden="true" /><span>{item}</span></div>)}
              </div>
              <DocsCodeBlock code={SWAP_CODE} label="fi/swap.ts" />
              <p className="ox-docs-copy">The snippet uses <code>chain.ts</code> and <code>tx.ts</code> from the README and <code>fi/addresses.ts</code> from the 0xFi guide. For exact zkLTC and NUSD conversion, see <a href="#nusd-integration">NUSD integration</a>.</p>
              <a className="ox-docs-product-link" href={`${GUIDE_BASE}/0xfi.md`} target="_blank" rel="noopener noreferrer">Read the 0xFi guide<ArrowSquareOut size={13} aria-hidden="true" /></a>
            </section>

            <section id="pump-integration" className="ox-docs-section">
              <SectionHeading
                title="Integrate 0xPump"
                description="Read the market over RPC, quote on the curve, then buy or sell with a minimum output and a deadline."
              />
              <div className="ox-docs-fee-table-wrap" tabIndex={0}>
                <table>
                  <thead><tr><th>User action</th><th>Contract</th><th>Method</th></tr></thead>
                  <tbody>
                    <tr><td>Read a market</td><td>ZeroXPumpV2</td><td><code>markets, marketParams, status, curveProgressBps</code></td></tr>
                    <tr><td>Quote</td><td>ZeroXPumpV2</td><td><code>quoteBuy / quoteSell</code></td></tr>
                    <tr><td>Buy, NUSD to token</td><td>ZeroXPumpV2</td><td><code>buy(token, maxNusdIn, minTokenOut, deadline)</code></td></tr>
                    <tr><td>Sell, token to NUSD</td><td>ZeroXPumpV2</td><td><code>sell(token, tokenIn, minNusdOut, deadline)</code></td></tr>
                    <tr><td>Create a token</td><td>ZeroXPumpV2</td><td><code>reserveMarket(contentHash), then createMarket(...)</code></td></tr>
                    <tr><td>Graduate a READY market</td><td>PumpGraduationController</td><td><code>graduateReady(token)</code></td></tr>
                    <tr><td>Distribute protocol fees</td><td>ZeroXPumpV2</td><td><code>distributeFees()</code></td></tr>
                  </tbody>
                </table>
              </div>
              <h3 className="ox-docs-subheading">Key rules</h3>
              <div className="ox-docs-checklist">
                {[
                  "Buy only in TRADING (1). Sell in TRADING or READY (1 or 2). Graduate only in READY (2).",
                  "Read the fee and targets per market from marketParams(token), not from tradeFeeBps() or a constant.",
                  "Pass the quoted userNusdAmount as maxNusdIn and approve exactly that. Near the target a buy pulls less than the typed amount.",
                  "Approve NUSD to the launchpad before buy and reserveMarket. Approve the token before sell.",
                  "Pausing blocks reserveMarket, createMarket, and buy. Sell stays open.",
                  "Use the same account for both create steps. Check createdTokenByContentHash and creationReservations before paying.",
                  "Metadata and image URIs start with ipfs:// and are 8 to 200 bytes.",
                  "ZeroXPumpV2.graduate is admin-only. Integrators call the controller's graduateReady.",
                ].map((item) => <div key={item}><CheckCircle size={16} weight="fill" aria-hidden="true" /><span>{item}</span></div>)}
              </div>
              <DocsCodeBlock code={PUMP_BUY_CODE} label="pump/buy.ts" />
              <a className="ox-docs-product-link" href={`${GUIDE_BASE}/0xpump.md`} target="_blank" rel="noopener noreferrer">Read the 0xPump guide<ArrowSquareOut size={13} aria-hidden="true" /></a>
            </section>

            <section id="nusd-integration" className="ox-docs-section">
              <SectionHeading
                title="Integrate NUSD"
                description="One contract, OracleNUSDv2, is the ERC-20, the mint and redeem desk, and the zkLTC reserve. RewardStaking runs Earn."
              />
              <div className="ox-docs-fee-table-wrap" tabIndex={0}>
                <table>
                  <thead><tr><th>User action</th><th>Contract</th><th>Method</th></tr></thead>
                  <tbody>
                    <tr><td>Mint, zkLTC to NUSD</td><td>OracleNUSDv2</td><td><code>quoteMint + mintAtOracle</code> with value</td></tr>
                    <tr><td>Redeem, NUSD to zkLTC</td><td>OracleNUSDv2</td><td><code>quoteRedeem + redeemAtOracle</code></td></tr>
                    <tr><td>Report an oracle failure</td><td>OracleNUSDv2</td><td><code>reportOracleFailure()</code></td></tr>
                    <tr><td>Emergency exit</td><td>OracleNUSDv2</td><td><code>emergencyRedeem(amountNusd, minCollateralOutWei, recipient)</code></td></tr>
                    <tr><td>Stake</td><td>RewardStaking</td><td><code>stake(amount, lockDuration)</code></td></tr>
                    <tr><td>Claim or restake</td><td>RewardStaking</td><td><code>claim(recipient) / claimAndStake(lockDuration)</code></td></tr>
                    <tr><td>Withdraw a matured position</td><td>RewardStaking</td><td><code>withdraw(positionId)</code></td></tr>
                  </tbody>
                </table>
              </div>
              <h3 className="ox-docs-subheading">Key rules</h3>
              <div className="ox-docs-checklist">
                {[
                  "Mint sends native zkLTC as value to mintAtOracle. A plain zkLTC transfer to the NUSD address is a reserve donation and mints nothing.",
                  "Redeem and emergency redeem need no approval.",
                  "Redeem pays the lower of the oracle price and the pro-rata reserve share. Show the quoted zkLTC, not a fixed 1 USD.",
                  "Redeem reverts while the DIA price is stale. Catch that revert and point to the emergency exit.",
                  "Before minting, check mintPaused() and isFresh() on the oracle router.",
                  "Check nusd.oracle() equals the ltcOracle manifest value before you sign.",
                  "lockDuration is exactly 2592000, 7776000, 15552000, or 31536000 seconds. Approve exactly amount to RewardStaking first.",
                  "No public subgraph indexes NUSD or RewardStaking. Build history with getLogs from block 61141328.",
                ].map((item) => <div key={item}><CheckCircle size={16} weight="fill" aria-hidden="true" /><span>{item}</span></div>)}
              </div>
              <DocsCodeBlock code={NUSD_MINT_CODE} label="nusd-mint.ts" />
              <a className="ox-docs-product-link" href={`${GUIDE_BASE}/nusd.md`} target="_blank" rel="noopener noreferrer">Read the NUSD guide<ArrowSquareOut size={13} aria-hidden="true" /></a>
            </section>

            <section id="pixel-integration" className="ox-docs-section">
              <SectionHeading
                title="Integrate 0xPixel"
                description="Mint original artwork to 0xPixel V2, read it back from the contract, and trade it on the NUSD NFT marketplace."
              />
              <div className="ox-docs-fee-table-wrap" tabIndex={0}>
                <table>
                  <thead><tr><th>User action</th><th>Contract</th><th>Method</th></tr></thead>
                  <tbody>
                    <tr><td>Mint an artwork</td><td>ZeroXPixelV2</td><td><code>checkOriginalPacked, then mintPacked</code></td></tr>
                    <tr><td>Read tokens</td><td>ZeroXPixelV2</td><td><code>tokenPackedData, tokenURI, tokensOfOwner, royaltyInfo</code></td></tr>
                    <tr><td>List or change a price</td><td>NusdNftMarketplaceV2</td><td><code>list / updateListingPrice</code></td></tr>
                    <tr><td>Buy a listing</td><td>NusdNftMarketplaceV2</td><td><code>buy(listingId, expectedPrice, maxWalletPayment)</code></td></tr>
                    <tr><td>Make an offer</td><td>NusdNftMarketplaceV2</td><td><code>makeOffer(collection, tokenId, price, expiresAt, maxWalletPayment)</code></td></tr>
                    <tr><td>Accept an offer</td><td>NusdNftMarketplaceV2</td><td><code>acceptOffer(offerId, minimumSellerProceeds)</code></td></tr>
                    <tr><td>Cancel, expire, withdraw</td><td>NusdNftMarketplaceV2</td><td><code>cancelListing, cancelOffer, expireOffer, withdrawNusd</code></td></tr>
                  </tbody>
                </table>
              </div>
              <h3 className="ox-docs-subheading">Key rules</h3>
              <div className="ox-docs-checklist">
                {[
                  "Minting is free. mintPacked is nonpayable, so send no value. No approvals are needed.",
                  "Encode pixels canonically: 6 bytes per run, row-major, equal neighbours merged, 1 to 4,096 runs.",
                  "A revert from checkOriginalPacked means the encoding is wrong. false means the art is already minted.",
                  "Name is 1 to 64 bytes and description at most 1,024 bytes of UTF-8. Add gas headroom for large grids.",
                  "Before trading, check nusd(), IMPLEMENTATION_ID(), collectionAllowed(collection), and paused().",
                  "Sellers approve the market for the one token before list and acceptOffer.",
                  "buy and makeOffer spend credits first. Approve NUSD only for the wallet shortfall.",
                  "Proceeds, creator fees, and refunds become market credits. Withdraw them with withdrawNusd.",
                ].map((item) => <div key={item}><CheckCircle size={16} weight="fill" aria-hidden="true" /><span>{item}</span></div>)}
              </div>
              <DocsCodeBlock code={PIXEL_BUY_CODE} label="pixel-buy.ts" />
              <a className="ox-docs-product-link" href={`${GUIDE_BASE}/0xpixel.md`} target="_blank" rel="noopener noreferrer">Read the 0xPixel guide<ArrowSquareOut size={13} aria-hidden="true" /></a>
            </section>

            <section id="vibe-code" className="ox-docs-section">
              <SectionHeading
                title="Vibe-code prompts"
                description="Paste one prompt into a coding agent such as Claude Code, Cursor, or Codex, in your own project with this repository available to read. Each prompt names the network, the manifest and ABI files to load, and the rules to follow."
              />
              <div className="ox-docs-flow" aria-label="Prompt workflow">
                {[
                  ["Open", "Your project, with this repository readable"],
                  ["Paste", "The prompt for the flow you need"],
                  ["Fill in", "Framework, wallet library, placeholders"],
                  ["Cite", "File and line for every address and signature"],
                  ["Test", "Small amounts on LiteForge first"],
                ].map(([title, detail]) => <div key={title}><strong>{title}</strong><span>{detail}</span></div>)}
              </div>
              {VIBE_PROMPTS.map((entry) => (
                <div key={entry.id}>
                  <h3 className="ox-docs-subheading">{entry.title}</h3>
                  <p className="ox-docs-copy">Copied from <a href={`${GUIDE_BASE}/prompts/${entry.id}.md`} target="_blank" rel="noopener noreferrer">{entry.source}</a>. The same file has prompts for the other flows.</p>
                  <DocsCodeBlock code={entry.prompt} label={entry.label} language="prompt" />
                </div>
              ))}
              <div className="ox-docs-note">
                <strong>Review generated code</strong>
                <span>Confirm every address, ABI, allowance branch, native value, slippage calculation, simulation, and receipt check before using the result.</span>
              </div>
            </section>

            <section id="indexed-data" className="ox-docs-section">
              <SectionHeading
                title="Indexed data"
                description="Goldsky powers discovery, history, charts, and activity. RPC remains authoritative for balances, quotes, allowances, and transaction preflight."
              />
              <div className="ox-docs-indexers">
                <div><strong>0xPixel marketplace</strong><code>{testnet.nusdMarketGoldskyEndpoint}</code><p>Listings, offers, activity, and market totals, plus mints from both collections from block 61141428. Re-read a listing over RPC before buying.</p></div>
                <div><strong>0xPump</strong><code>{PUMP_SUBGRAPH_URL}</code><p>Markets, trades, candles, holders, and totals. Check _meta.block.number for lag.</p></div>
                <div><strong>0xFi</strong><code>{testnet.goldskyEndpoint}</code><p>Pools, swaps, liquidity events, candles, and gauge and lending activity. The mappings match NUSD against the retired v1 address, so check NUSD-denominated volume fields against RPC; if they read 0, derive volume from the token amounts.</p></div>
                <div><strong>NUSD</strong><code>No public subgraph</code><p>Read mint, redeem, and RewardStaking events with getLogs from block 61141328, in bounded block ranges.</p></div>
              </div>
              <DocsCodeBlock code={INDEXER_CODE} label="indexers.ts" />
            </section>

            <section id="safety" className="ox-docs-section">
              <SectionHeading
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
