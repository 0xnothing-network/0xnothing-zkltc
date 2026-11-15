import {
  type Account,
  type Address,
  type Chain,
  type Client,
  createClient,
  fallback,
  type Hex,
  http,
  type HttpTransportConfig,
  keccak256,
  type PublicActions,
  type Transport,
  type WalletActions,
} from "viem";
import { toAccount } from "viem/accounts";
import {
  estimateContractGas,
  estimateFeesPerGas,
  estimateGas,
  getBalance,
  getBlock,
  getBlockNumber,
  getChainId,
  getGasPrice,
  getTransaction,
  getTransactionCount,
  getTransactionReceipt,
  multicall,
  readContract,
  sendTransaction,
  signMessage,
  simulateContract,
  signTypedData,
  waitForTransactionReceipt,
  writeContract,
} from "viem/actions";
import {
  LITVM_NETWORK,
  networkIdentity,
  resolveNetwork,
  type WalletNetwork,
  viemChainFor,
} from "../../config/networks";
import { t } from "../i18n";
import { isUnlocked, readAccounts, readSettings, signerFor, WalletLockedError } from "../keyring/vault";
import { probeChainId } from "../services/rpcProbe";

/**
 * Signing retains the existing retry window. Live reads use a shorter budget
 * below: block polling retries them, so a stalled endpoint must not keep the
 * wallet's single-flight read queue occupied for three 15-second attempts.
 */
/**
 * A built-in profile may list backup endpoints to fail over to (LiteForge lists
 * the public endpoint behind the user's own RPC when one is set). User-added
 * networks use exactly the RPC the user entered. Reads only: signing pins one
 * endpoint (writeEndpoint), because a fallback would re-send a broadcast that
 * timed out to the next node.
 */
function rpcTransport(network: WalletNetwork, options: HttpTransportConfig) {
  const backups = network.builtin ? network.fallbackRpcUrls ?? [] : [];
  if (!backups.length) return http(network.rpcUrl, options);
  return fallback([network.rpcUrl, ...backups].map((url) => http(url, options)), { retryCount: 1 });
}

function transportFor(rpcUrl: string) {
  return http(rpcUrl, {
    batch: { batchSize: 100, wait: 10 },
    retryCount: 2,
    retryDelay: 300,
    timeout: 15_000,
  });
}

/**
 * The client methods the wallet calls, bound exactly as viem's own publicActions
 * and walletActions bind them. createPublicClient and createWalletClient attach
 * every viem action (ENS, filters, watchers, EIP-5792 calls, contract deploys...)
 * and the bundle carried all of them; viem's internal getAction still finds
 * these by name, and falls back to the same function for any it does not.
 */
type ReadAction =
  | "estimateContractGas" | "estimateFeesPerGas" | "estimateGas" | "getBalance" | "getBlock"
  | "getBlockNumber" | "getChainId" | "getGasPrice" | "getTransaction" | "getTransactionCount"
  | "getTransactionReceipt" | "multicall" | "readContract" | "simulateContract" | "waitForTransactionReceipt";
type SignAction = "sendTransaction" | "signMessage" | "signTypedData" | "writeContract";

function readActions<transport extends Transport, chain extends Chain | undefined>(
  client: Client<transport, chain, undefined>,
): Pick<PublicActions<transport, chain, undefined>, ReadAction> {
  return {
    // Cast as viem's publicActions casts it: its generics do not line up here.
    estimateContractGas: (args) => estimateContractGas(client, args as any),
    estimateFeesPerGas: (args) => estimateFeesPerGas(client, args),
    estimateGas: (args) => estimateGas(client, args),
    getBalance: (args) => getBalance(client, args),
    getBlock: (args) => getBlock(client, args),
    getBlockNumber: (args) => getBlockNumber(client, args),
    getChainId: () => getChainId(client),
    getGasPrice: () => getGasPrice(client),
    getTransaction: (args) => getTransaction(client, args),
    getTransactionCount: (args) => getTransactionCount(client, args),
    getTransactionReceipt: (args) => getTransactionReceipt(client, args),
    multicall: (args) => multicall(client, args),
    readContract: (args) => readContract(client, args),
    simulateContract: (args) => simulateContract(client, args),
    waitForTransactionReceipt: (args) => waitForTransactionReceipt(client, args),
  };
}

function signActions<transport extends Transport, chain extends Chain | undefined, account extends Account | undefined>(
  client: Client<transport, chain, account>,
): Pick<WalletActions<chain, account>, SignAction> {
  return {
    sendTransaction: (args) => sendTransaction(client, args),
    signMessage: (args) => signMessage(client, args),
    signTypedData: (args) => signTypedData(client, args),
    writeContract: (args) => writeContract(client, args),
  };
}

function clientFor(network: WalletNetwork) {
  return createClient({
    key: "public",
    name: "Public Client",
    type: "publicClient",
    chain: viemChainFor(network),
    transport: rpcTransport(network, {
      batch: { batchSize: 100, wait: 10 },
      retryCount: 0,
      timeout: 5_000,
    }),
    batch: { multicall: { batchSize: 16_384 } },
    // No offchain lookups: nothing here resolves ENS or CCIP data, and with it on
    // any contract (or RPC) could make the wallet fetch a URL of its choosing.
    ccipRead: false,
  }).extend(readActions);
}

/** The selected profile is changed only after it has passed config validation. */
export let activeNetwork: WalletNetwork = LITVM_NETWORK;
export let publicClient = clientFor(LITVM_NETWORK);

export function configureRpcClient(network: WalletNetwork): void {
  if (networkIdentity(activeNetwork) === networkIdentity(network)) return;
  activeNetwork = network;
  publicClient = clientFor(network);
}

/** Resolve a profile's read client without changing the selected network. */
export function publicClientFor(network: WalletNetwork) {
  return networkIdentity(activeNetwork) === networkIdentity(network)
    ? publicClient
    : clientFor(network);
}

/**
 * The one endpoint a signing operation uses for nonce, gas, fees, viem's chain
 * check and the broadcast. Without a fallback list it is the profile's RPC, as
 * before. With one, the first endpoint that answers this profile's chain id
 * wins, and when none does nothing is signed.
 */
export async function writeEndpoint(
  network: WalletNetwork,
  probe: typeof probeChainId = probeChainId,
): Promise<string> {
  const backups = network.builtin ? network.fallbackRpcUrls ?? [] : [];
  if (!backups.length) return network.rpcUrl;
  for (const url of [network.rpcUrl, ...backups]) {
    if ((await probe(url, 5_000)) === BigInt(network.chainId)) return url;
  }
  throw new Error(t("err.rpcUnavailable"));
}

/** A transaction as it was signed: what `onSigned` hears besides the hash and nonce. */
export interface SignedCall {
  to?: Address;
  data?: Hex;
  chainId?: number;
}

/**
 * A signing client holds public metadata only, even while RPC preparation waits.
 * `onSigned` is told the hash of each transaction as it is signed, before the node
 * has answered, so the caller can still find it if that answer never arrives, and
 * the nonce it was signed with, so a copy that can never be mined is recognised.
 * It also gets the call as signed (target, calldata, chain), so a record of what
 * the wallet signed is made from those bytes and not from what was asked for.
 */
export async function walletClientFor(
  address: Address,
  network: WalletNetwork = activeNetwork,
  assertReady?: () => Promise<void>,
  onSigned?: (hash: Hex, nonce?: number, signed?: SignedCall) => void,
) {
  const expectedNetwork = networkIdentity(network);
  async function signingAccount() {
    const signer = await signerFor(address);
    await assertReady?.();
    const [state, settings] = await Promise.all([readAccounts(), readSettings()]);
    if (!(await isUnlocked())) throw new WalletLockedError();
    if (networkIdentity(activeNetwork) !== expectedNetwork
      || networkIdentity(resolveNetwork(settings.networkId, settings.customNetworks, settings.litvmRpcUrl)) !== expectedNetwork
      || (state.active ?? state.accounts[0]?.address)?.toLowerCase() !== address.toLowerCase()) {
      throw new Error(t("err.quoteStale"));
    }
    return signer;
  }
  // Fail early if this action is already stale, then resolve a fresh key for
  // each signature after viem has finished nonce, gas and fee preparation.
  await signingAccount();
  const rpcUrl = await writeEndpoint(network);
  const account = toAccount({
    address,
    sign: async (params) => (await signingAccount()).sign(params),
    signAuthorization: async (params) => {
      const signer = await signingAccount();
      if (!signer.signAuthorization) throw new Error("Account does not support authorization signing");
      return signer.signAuthorization(params);
    },
    signMessage: async (params) => (await signingAccount()).signMessage(params),
    signTransaction: async (transaction, options) => {
      const serialized = await (await signingAccount()).signTransaction(transaction, options);
      onSigned?.(keccak256(serialized), transaction.nonce, {
        to: transaction.to ?? undefined,
        data: transaction.data,
        chainId: transaction.chainId,
      });
      return serialized;
    },
    signTypedData: async (params) => (await signingAccount()).signTypedData(params),
  });
  return createClient({
    key: "wallet",
    name: "Wallet Client",
    type: "walletClient",
    account,
    chain: viemChainFor(network),
    transport: transportFor(rpcUrl),
    ccipRead: false,
  }).extend(signActions);
}
