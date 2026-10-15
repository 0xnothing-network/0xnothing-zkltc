import { type Address, createPublicClient, createWalletClient, fallback, http, type HttpTransportConfig } from "viem";
import { toAccount } from "viem/accounts";
import {
  LITVM_NETWORK,
  networkIdentity,
  resolveNetwork,
  type WalletNetwork,
  viemChainFor,
} from "../../config/networks";
import { t } from "../i18n";
import { isUnlocked, readAccounts, readSettings, signerFor, WalletLockedError } from "../keyring/vault";

/**
 * Signing retains the existing retry window. Live reads use a shorter budget
 * below: block polling retries them, so a stalled endpoint must not keep the
 * wallet's single-flight read queue occupied for three 15-second attempts.
 */
/**
 * The built-in LiteForge profile fails over to Caldera's public endpoint on the same
 * origin, so the wallet keeps working if the partner endpoint changes. User-added
 * networks use exactly the RPC the user entered.
 */
function rpcTransport(network: WalletNetwork, options: HttpTransportConfig) {
  const backups = network.builtin ? network.fallbackRpcUrls ?? [] : [];
  if (!backups.length) return http(network.rpcUrl, options);
  return fallback([network.rpcUrl, ...backups].map((url) => http(url, options)), { retryCount: 1 });
}

function transportFor(network: WalletNetwork) {
  return rpcTransport(network, {
    batch: { batchSize: 100, wait: 10 },
    retryCount: 2,
    retryDelay: 300,
    timeout: 15_000,
  });
}

function clientFor(network: WalletNetwork) {
  return createPublicClient({
    chain: viemChainFor(network),
    transport: rpcTransport(network, {
      batch: { batchSize: 100, wait: 10 },
      retryCount: 0,
      timeout: 5_000,
    }),
    batch: { multicall: { batchSize: 16_384 } },
  });
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

/** A signing client holds public metadata only, even while RPC preparation waits. */
export async function walletClientFor(
  address: Address,
  network: WalletNetwork = activeNetwork,
  assertReady?: () => Promise<void>,
) {
  const expectedNetwork = networkIdentity(network);
  async function signingAccount() {
    const signer = await signerFor(address);
    await assertReady?.();
    const [state, settings] = await Promise.all([readAccounts(), readSettings()]);
    if (!(await isUnlocked())) throw new WalletLockedError();
    if (networkIdentity(activeNetwork) !== expectedNetwork
      || networkIdentity(resolveNetwork(settings.networkId, settings.customNetworks)) !== expectedNetwork
      || (state.active ?? state.accounts[0]?.address)?.toLowerCase() !== address.toLowerCase()) {
      throw new Error(t("err.quoteStale"));
    }
    return signer;
  }
  // Fail early if this action is already stale, then resolve a fresh key for
  // each signature after viem has finished nonce, gas and fee preparation.
  await signingAccount();
  const account = toAccount({
    address,
    sign: async (params) => (await signingAccount()).sign(params),
    signAuthorization: async (params) => {
      const signer = await signingAccount();
      if (!signer.signAuthorization) throw new Error("Account does not support authorization signing");
      return signer.signAuthorization(params);
    },
    signMessage: async (params) => (await signingAccount()).signMessage(params),
    signTransaction: async (transaction, options) => (await signingAccount()).signTransaction(transaction, options),
    signTypedData: async (params) => (await signingAccount()).signTypedData(params),
  });
  return createWalletClient({
    account,
    chain: viemChainFor(network),
    transport: transportFor(network),
  });
}
