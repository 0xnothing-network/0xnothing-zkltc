# 0xNothing developer guide

0xNothing is a set of on-chain products on the LitVM LiteForge testnet. You can
build on all of them with contract calls over JSON-RPC, plus the public Goldsky
subgraphs for history. This guide covers the network, where the addresses and
ABIs live, a shared viem setup, and the rules every integration follows.
Each product has its own guide:

| Product | What it does | Guide |
| --- | --- | --- |
| 0xFi | DEX (`ZeroXFiFactoryV2` / `ZeroXFiRouterV2`), pooled NUSD lending and borrowing, nBTC/nETH synths, LP farms, RWA markets | [0xfi.md](./0xfi.md) |
| 0xPump | NUSD bonding-curve launchpad (`ZeroXPumpV2`); a market that reaches a 6,000 NUSD market cap graduates into a 0xFi pool | [0xpump.md](./0xpump.md) |
| NUSD | Stable priced by an oracle and backed by zkLTC (`OracleNUSDv2`): mint and redeem at the oracle price, stake for fee rewards (`RewardStaking`) | [nusd.md](./nusd.md) |
| 0xPixel | On-chain pixel-art NFTs and the NUSD NFT marketplace (`NusdNftMarketplaceV2`) | [0xpixel.md](./0xpixel.md) |

Prompts you can give an AI coding agent are in [`prompts/`](./prompts/). See
[Using an AI coding agent](#using-an-ai-coding-agent).

The live contract set is **v3**. It has been active since 2026-10-15
(`deployments/liteforge-testnet/v3.json`, `"stage": "active"`). Contracts have
no proxies, so an address never changes behaviour. A new version means new
addresses.

## Network

| Field | Value | Source |
| --- | --- | --- |
| Chain | LitVM LiteForge (testnet) | `apps/web/config/wagmi.ts` |
| Chain id | `4441` | `apps/web/features/fi/config/deployment.ts:5` |
| Native gas token | zkLTC, 18 decimals | `apps/web/config/wagmi.ts` (`nativeCurrency`) |
| RPC (primary) | `https://liteforge.rpc.caldera.xyz/infra-partner-http` | `apps/web/lib/publicConfig.ts:6` |
| RPC (fallback) | `https://liteforge.rpc.caldera.xyz/http` | `apps/web/lib/publicConfig.ts:8` |
| WebSocket (in order) | `wss://liteforge.rpc.caldera.xyz/infra-partner-ws`, then `wss://liteforge.rpc.caldera.xyz/ws` | `apps/web/lib/publicConfig.ts:10-13` |
| Explorer | `https://liteforge.explorer.caldera.xyz` | `apps/web/lib/publicConfig.ts:14` |
| Multicall3 | `0xca11bde05977b3631167028862be2a173976ca11` | `apps/web/lib/publicConfig.ts:15` |

LiteForge produces a block about every 0.25 s (`apps/web/lib/wagmi.ts:12-13`),
so receipts arrive quickly. Poll at about 1 s.

Public subgraphs (Goldsky, GraphQL over HTTPS POST). Endpoints are from
`apps/web/features/fi/config/testnet.generated.json`:

| Subgraph | Endpoint | Schema |
| --- | --- | --- |
| 0xFi `zeroxfi-testnet/1.0.0` | `https://api.goldsky.com/api/public/project_cmqmpust19i8v01t595z8hpq4/subgraphs/zeroxfi-testnet/1.0.0/gn` | `0xFi/subgraph/schema.graphql` |
| 0xPump `zeroxpump-testnet/1.0.0` | `https://api.goldsky.com/api/public/project_cmqmpust19i8v01t595z8hpq4/subgraphs/zeroxpump-testnet/1.0.0/gn` | `subgraphs/0xpump/schema.graphql` |
| NUSD marketplace `pixel-nusd-market/1.1.0` | `https://api.goldsky.com/api/public/project_cmqmpust19i8v01t595z8hpq4/subgraphs/pixel-nusd-market/1.1.0/gn` | `subgraphs/0xpixel-nusd-market/schema.graphql` |

The web app's own HTTP routes (`/api/*`, `/0xFi/api/*`) and its WebSocket
plumbing are internal. They are not a public API and can change without notice.
Do not build on them.

## Addresses

Load addresses from a manifest file. Do not copy them from a web page. Paths
are relative to `0xNothing-zkLTC-Testnet/`.

| Need | File | Keys |
| --- | --- | --- |
| Everything the web app uses, flat | `apps/web/features/fi/config/testnet.generated.json` | `nusd`, `wzkltc`, `dexFactory`, `dexRouter`, `lendingPool`, `nbtc`, `neth`, `nbtcVault`, `nethVault`, `farmFactory`, gauges and pairs, `pump`, `pumpGraduation*`, `feeSplitter`, `rewardStaking`, `treasury`, `nusdMarketplace`, oracles, subgraph endpoints, `deploymentBlock` |
| v3 record with creation blocks | `deployments/liteforge-testnet/v3.json` | `core.*`, `fi.*`, `blocks[address]` |
| Core (NUSD, oracles, fees, 0xPump, marketplace, 0xPixel) | `contracts/deployments/v3-core.json` | as above, plus `scriptBlock` |
| 0xFi | `0xFi/contracts/deployments/v3-fi.json` | DEX, lending, synth, farm, graduation adapter/controller |
| 0xPump details and graduation state | `deployments/liteforge-testnet/deployments.json` | `pump.launchpad`, `pump.configuration`, `pump.graduation` |
| NUSD marketplace | `apps/web/lib/nusdMarketplace.generated.json` | `address`, `nusd`, `burnBps`, `creatorBps`, `collections`, `deploymentBlock` |
| 0xPixel collections | `apps/web/lib/publicConfig.ts:17-23` | `PIXEL_NFT_ADDRESS` (V2, new mints), `PIXEL_CLASSIC_ADDRESS` (Classic, read-only), start blocks |
| RWA markets | `shared/rwa/markets.json` | `markets` (empty: no RWA market is deployed yet) |

`0xFi/contracts/deployments/latest.json` and the `v1`/`v2` files are older
sets. Some old contracts still accept calls, but the web app no longer uses
them.

The addresses you will use most, from `testnet.generated.json` (the v3 set):

| Contract | Address |
| --- | --- |
| NUSD (`OracleNUSDv2`) | `0x69320A82ACCeC1b8A5EF59fd02b217e7ea4aEa19` |
| WzkLTC | `0xE93d4373CE1eDA3df6c3Ab7ed3ab07A07aA5939F` |
| `ZeroXFiRouterV2` | `0x1cda4793122a223A09be54ED5f664ba222eEe042` |
| `ZeroXFiFactoryV2` | `0xc6B675d701a168789A5cc7Dd04Ef9e531886114c` |
| `PooledNUSDLendingPoolV2` | `0x6Cc96c044321b3205Ac108107Fc6d2d47e0B3E44` |
| `ZeroXPumpV2` | `0x0239baEc3c695A6EA893Ad90a7608112e0580526` |
| `RewardStaking` | `0x59589d9a5840D2CEF7A6e4A8cB55C258cc73E483` |
| `FeeSplitter` | `0xAea1Ef82Dbe800BB3683009630813457D990a9B0` |
| `NusdNftMarketplaceV2` | `0xd219EfFe076B68934e212313C8d468b994d6e52E` |
| 0xPixel V2 | `0xd83cb7aCEF921f98b6B983cBB712a583869Da9eB` |

The product guides list the rest.

## ABIs

Use the ABIs the live web app calls. They are typed `as const` or built with
`parseAbi`, so viem infers argument and return types.

| Product | File |
| --- | --- |
| 0xFi DEX, lending, synth, farm, locker, metadata, oracle, tokenomics | `apps/web/features/fi/lib/abis/{dex,lending,synth,farm,locker,metadata,dia,nusd,tokenomics,erc20}.ts` |
| 0xPump, NUSD mint/redeem, graduation | `apps/web/features/pump/abis.ts` |
| NUSD marketplace | `apps/web/lib/nusdMarketplace.ts` (`NusdMarketplaceAbi`) |
| 0xPixel V2 | `apps/web/lib/pixelNftAbi.ts` (`PixelNFTABI`) |
| 0xPixel Classic | `apps/web/lib/abi.ts` (`PixelClassicABI`) |
| RWA | `shared/rwa/abi.ts` |

The Solidity sources are in `contracts/src` (core) and `0xFi/contracts/src`. If
you need a full ABI, build it with `forge build` in that root. Each product guide
names the functions it uses.

## Shared viem setup

```ts
// chain.ts
import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  fallback,
  http,
  webSocket,
  type EIP1193Provider,
} from "viem";

export const liteforge = defineChain({
  id: 4441,
  name: "LitVM LiteForge",
  nativeCurrency: { name: "zkLTC", symbol: "zkLTC", decimals: 18 },
  rpcUrls: {
    default: {
      http: [
        "https://liteforge.rpc.caldera.xyz/infra-partner-http",
        "https://liteforge.rpc.caldera.xyz/http",
      ],
      webSocket: [
        "wss://liteforge.rpc.caldera.xyz/infra-partner-ws",
        "wss://liteforge.rpc.caldera.xyz/ws",
      ],
    },
  },
  blockExplorers: {
    default: { name: "LiteForge Explorer", url: "https://liteforge.explorer.caldera.xyz" },
  },
  contracts: {
    multicall3: { address: "0xca11bde05977b3631167028862be2a173976ca11", blockCreated: 1 },
  },
});

// Reads: primary endpoint, then the public fallback (same as apps/web/lib/rpcTransport.ts).
export const publicClient = createPublicClient({
  chain: liteforge,
  transport: fallback(liteforge.rpcUrls.default.http.map((url) => http(url, { timeout: 15_000 })), {
    retryCount: 1,
  }),
  batch: { multicall: true },
  pollingInterval: 1_000,
});

// Optional: push-based logs. Keep a polling path for when the socket drops.
export const wsClient = createPublicClient({
  chain: liteforge,
  transport: fallback(liteforge.rpcUrls.default.webSocket.map((url) => webSocket(url))),
});

// Browser wallet (EIP-1193). In Node, use privateKeyToAccount and http() instead,
// and load the key from your own secret store, never from source control.
export async function connectWallet(provider: EIP1193Provider) {
  const walletClient = createWalletClient({ chain: liteforge, transport: custom(provider) });
  const [account] = await walletClient.requestAddresses();
  if ((await walletClient.getChainId()) !== liteforge.id) {
    try {
      await walletClient.switchChain({ id: liteforge.id });
    } catch {
      await walletClient.addChain({ chain: liteforge });
      await walletClient.switchChain({ id: liteforge.id });
    }
  }
  if ((await walletClient.getChainId()) !== liteforge.id) throw new Error("Wallet is not on chain 4441");
  return { walletClient, account };
}
```

### The write pattern

Every write in the product guides follows these steps: check the chain, read
fresh state, compute a minimum with slippage, simulate with the exact account
and value, send, then check the receipt.

```ts
// tx.ts
import { erc20Abi, maxUint256, type Abi, type Address, type Hash, type WalletClient } from "viem";
import { liteforge, publicClient } from "./chain";

/** Slippage in basis points: 50 = 0.5%. Integer math only, rounds down. */
export function minOut(quoted: bigint, slippageBps: bigint): bigint {
  if (slippageBps < 0n || slippageBps > 10_000n) throw new Error("slippage out of range");
  return (quoted * (10_000n - slippageBps)) / 10_000n;
}

/** Fails if the wallet left chain 4441 since connecting. */
export async function assertChain(walletClient: WalletClient) {
  const id = await walletClient.getChainId();
  if (id !== liteforge.id) throw new Error(`Wrong chain ${id}; switch to 4441`);
}

export async function confirm(hash: Hash) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Transaction ${hash} reverted`);
  return receipt;
}

/** Approve `spender` for `amount` if the current allowance is lower. */
export async function ensureAllowance(
  walletClient: WalletClient,
  account: Address,
  token: Address,
  spender: Address,
  amount: bigint,
) {
  const current = await publicClient.readContract({
    address: token, abi: erc20Abi, functionName: "allowance", args: [account, spender],
  });
  if (current >= amount) return;
  await assertChain(walletClient);
  const { request } = await publicClient.simulateContract({
    account, address: token, abi: erc20Abi, functionName: "approve", args: [spender, amount],
  });
  await confirm(await walletClient.writeContract(request));
}

/** Simulate with the exact account and value, send, and require a successful receipt. */
export async function send(
  walletClient: WalletClient,
  params: { account: Address; address: Address; abi: Abi; functionName: string; args: readonly unknown[]; value?: bigint },
) {
  await assertChain(walletClient);
  const { request, result } = await publicClient.simulateContract(params as never);
  const hash = await walletClient.writeContract(request as never);
  return { hash, result, receipt: await confirm(hash) };
}

export { maxUint256 };
```

Example: mint NUSD with zkLTC. The ABI fragment matches
`apps/web/features/pump/abis.ts:80-81`.

```ts
import { parseAbi, parseEther, type Address, type WalletClient } from "viem";
import { publicClient } from "./chain";
import { minOut, send } from "./tx";

const NUSD: Address = "0x69320A82ACCeC1b8A5EF59fd02b217e7ea4aEa19";
const nusdAbi = parseAbi([
  "function quoteMint(uint256 collateralWei) view returns (uint256 amountNusd)",
  "function mintAtOracle(uint256 minNusdOut,address recipient) payable returns (uint256 amountNusd)",
]);

export async function mintNusd(walletClient: WalletClient, account: Address, zkLtc: string) {
  const value = parseEther(zkLtc);                                  // 18-decimal bigint
  const quoted = await publicClient.readContract({ address: NUSD, abi: nusdAbi, functionName: "quoteMint", args: [value] });
  const min = minOut(quoted, 50n);                                  // 0.5% for oracle movement
  return send(walletClient, { account, address: NUSD, abi: nusdAbi, functionName: "mintAtOracle", args: [min, account], value });
}
```

## Integration rules

1. **RPC is the source of truth.** Read balances, allowances, quotes, reserves,
   positions, listing state and market status from the contracts. Read them
   right before you act.
2. **Subgraphs are history only.** Use them for lists, trades, candles,
   activity and aggregates. They lag the chain and can be unavailable, so never
   base a transaction amount, a minimum output or an eligibility check on
   subgraph data. Use a block-range `getLogs` scan from the contract's
   deployment block as a fallback.
3. **Check the chain id.** Refuse to sign unless the wallet reports `4441`.
4. **Use bigint throughout.** Every token amount is a `bigint` in base units.
   NUSD, zkLTC, WzkLTC, nBTC, nETH and 0xPump tokens use 18 decimals. Read
   `decimals()` for any other ERC-20. Do not use `Number` or floating point for
   amounts. Parse input with `parseUnits` and format with `formatUnits`.
5. **Quote, then set a minimum.** Every value-moving call takes a minimum
   output (and often a deadline). Compute it from a fresh on-chain quote with
   integer basis-point slippage. Never pass `0` as a minimum in production code.
6. **Simulate before you write.** Call `simulateContract` with the same
   `account`, `args` and `value` you will send. If simulation reverts, show the
   decoded error and do not send.
7. **Approve first.** Before a call that pulls an ERC-20 (`transferFrom`),
   check `allowance` and wait for the approval receipt. NFT listings need
   `setApprovalForAll` (or `approve`) for the marketplace.
8. **Check the receipt.** A hash is not success. Wait for the receipt, require
   `status === "success"`, then read state again or decode events.
9. **Do not hard-code fees.** Fee terms can differ per market (0xPump) or be
   changed by an owner within limits set in code. Read them from the contract.
   The product guides list the current values and their caps.
10. **No secrets in clients.** Never ship a private key or API key in front-end
    code, and never put one in a URL.

## Live updates

The 0xNothing web app keeps views fresh with a WebSocket `eth_subscribe` for
logs from the protocol contracts. When an event arrives, it reads the chain
again. A periodic block poll (about every 10 s) covers time-based values and is
the only mechanism while the socket is down (`apps/web/components/LiveSync.tsx`).
The same design works for integrators: `watchContractEvent` over the WebSocket
client, with a polling fallback and a fresh RPC read after each event. Never use
the event payload as the new state.

## Using an AI coding agent

`prompts/` holds prompts to paste into an AI coding agent (Claude Code, Cursor
and similar tools). Each one gives the agent the network, the manifest and ABI
files to load, and the rules above, then asks for one integration.

How to use them:

1. Open the agent in your own project, with this repository (or the manifest
   and ABI files the prompt names) available to read.
2. Paste the prompt for the product you need, and fill in the placeholders
   (framework, wallet library, the flow you want).
3. Ask the agent to name the file and line it took each address, function
   signature and decimals value from. Reject anything it cannot cite.

Review generated code before you use it with real funds. Check that:

- Addresses come from a manifest file. A typo in a hard-coded address silently
  sends calls to the wrong place.
- Function names, argument order and `payable` match the web app's ABI file.
  Pay special attention to the order of minimum, recipient and deadline arguments.
- All amounts are `bigint`. Look for `Number(`, `parseFloat`, `* 10 **` and
  `toFixed` on amounts.
- Every write has a chain-id check, a fresh quote, a non-zero minimum,
  `simulateContract` with the real `account` and `value`, and a receipt status
  check.
- Approval happens before the dependent call, and the code waits for the
  approval receipt.
- Subgraph data is never used to size a transaction.
- The code does not call the web app's `/api/*` routes.
- No private key, mnemonic or API key is in the code, environment files that
  are committed, or URLs.
- Error paths show the decoded revert reason, and a failed send is not retried
  blindly.

Test on LiteForge with small amounts first. Compare each result with what the
0xNothing web app shows for the same action.
