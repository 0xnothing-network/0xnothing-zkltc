import { type Address, type Hex, isHex } from "viem";
import {
  LITVM_NETWORK,
  networkIdentity,
  resolveNetwork,
  sanitizeCustomNetwork,
  type WalletNetwork,
} from "../../config/networks";
import { t } from "../i18n";
import { isLoweredApprove } from "../lib/approveAmount";
import { addCustomNetwork, isUnlocked, readAccounts, readSettings, WalletLockedError } from "../keyring/vault";
import { publicClientFor, walletClientFor } from "../rpc/client";
import { connectedAccounts, DAPP_REQUEST_TIMEOUT_MS, DAPP_SIGN_RESERVE_MS, type DappRequest, listPending } from "./dapp";
import { probeChainId } from "./rpcProbe";
import { addCustomToken, type TokenMetadata } from "./tokens";
import { sendRaw } from "./tx";

function quantity(value: string | undefined): bigint | undefined {
  if (value === undefined || value === "") return undefined;
  try {
    return BigInt(value);
  } catch {
    throw new Error(t("apr.badQuantity", { value }));
  }
}

/**
 * Execute the request displayed in the separate approval window. `onSigned` is
 * told once a signature exists (for a transaction, before it is broadcast); while
 * it has not been called nothing was signed, so the window may release its claim.
 */
export async function executeDappRequest(
  request: DappRequest,
  signer: Address,
  host: string,
  network: WalletNetwork,
  approvalClaim: string,
  onSigned?: (hash: Hex) => void,
  /** watch-asset: the contract's metadata the window showed; a token that now answers otherwise is refused. */
  shownToken?: TokenMetadata,
  /** transaction: calldata the user lowered in the spending-cap editor; anything else is refused. */
  override?: { data?: Hex },
): Promise<string> {
  const expectedNetwork = networkIdentity(network);
  const assertReady = async (): Promise<void> => {
    const [accounts, settings, pending, granted] = await Promise.all([
      readAccounts(), readSettings(), listPending(),
      // Asked for the signer itself: granted only if the user connected it to this site.
      request.kind === "connect" ? Promise.resolve([signer]) : connectedAccounts(request.origin, signer),
    ]);
    const current = pending.find((entry) => entry.id === request.id);
    const selected = resolveNetwork(settings.networkId, settings.customNetworks, settings.litvmRpcUrl);
    if (!(await isUnlocked())) throw new WalletLockedError();
    if (
      (request.networkId ?? LITVM_NETWORK.id) !== network.id
      || (request.networkIdentity !== undefined && request.networkIdentity !== expectedNetwork)
      || networkIdentity(selected) !== expectedNetwork
      || (accounts.active ?? accounts.accounts[0]?.address)?.toLowerCase() !== signer.toLowerCase()
      || request.account?.toLowerCase() !== signer.toLowerCase()
      || !granted.some((address) => address.toLowerCase() === signer.toLowerCase())
      || current?.approvalClaim !== approvalClaim
      // Checked again right before signing: with less than the reserve left, the
      // broadcast could outlast the worker and its hash would reach no page.
      || current.at + DAPP_REQUEST_TIMEOUT_MS - DAPP_SIGN_RESERVE_MS <= Date.now()
    ) throw new Error(t("err.quoteStale"));
  };
  await assertReady();
  if (request.kind === "connect") return signer;
  if (request.kind === "switch-network") {
    if (!request.targetNetworkId) throw new Error(t("apr.unreadable"));
    return request.targetNetworkId;
  }
  // The answers below are what the worker reads as "approved"; it gives the page
  // true (watchAsset) or null (addEthereumChain) whatever the string says.
  if (request.kind === "watch-asset") {
    if (!request.asset) throw new Error(t("apr.unreadable"));
    try {
      await addCustomToken(request.asset.address, network, shownToken);
    } catch (cause) {
      // Saved meanwhile (another site offered it, or the user added it): done.
      if ((cause as { message?: unknown } | null)?.message !== t("err.tokenAdded")) throw cause;
    }
    return "true";
  }
  if (request.kind === "add-network") {
    const chain = request.chain;
    if (!chain) throw new Error(t("apr.unreadable"));
    // Asked again: the endpoint may answer differently from what the window showed.
    const got = await probeChainId(chain.rpcUrl);
    if (got !== BigInt(chain.chainId)) {
      throw new Error(t("apr.addNetworkMismatch", { got: got === null ? "—" : got.toString() }));
    }
    const candidate = sanitizeCustomNetwork({
      chainId: chain.chainId,
      name: chain.name,
      rpcUrl: chain.rpcUrl,
      explorerUrl: chain.explorerUrl,
      nativeCurrency: { name: chain.currencyName, symbol: chain.symbol, decimals: chain.decimals },
    });
    if (candidate === null) throw new Error(t("apr.unreadable"));
    // Saved only: the page asks to switch separately, with its own approval.
    return addCustomNetwork(candidate, { select: false });
  }
  if (request.kind === "transaction") {
    const tx = request.tx ?? {};
    // Only a lower amount of the very same approve may replace the dapp's bytes:
    // a window bug can then never sign another call, spender or a higher amount.
    let data = tx.data;
    if (override?.data !== undefined && override.data !== tx.data) {
      if (!isLoweredApprove(tx.data, override.data)) throw new Error(t("apr.unreadable"));
      data = override.data;
    }
    return sendRaw({
      from: signer,
      to: tx.to,
      value: quantity(tx.value),
      data,
      gas: quantity(tx.gas),
      label: { key: "tx.dapp", params: { host } },
      detail: tx.to,
    }, { network, client: publicClientFor(network), assertReady, onSigned });
  }
  // The client checks the claim and current permissions again after asynchronous
  // key retrieval and immediately before every actual signature.
  const client = await walletClientFor(signer, network, assertReady);
  if (request.kind === "sign") {
    const message = request.message ?? "";
    const signature = await client.signMessage({ message: isHex(message) ? { raw: message } : message });
    onSigned?.(signature);
    return signature;
  }
  const typed = JSON.parse(request.message ?? "{}");
  if (typed?.domain?.chainId !== undefined && BigInt(typed.domain.chainId) !== BigInt(network.chainId)) {
    throw new Error(t("apr.wrongChain", { chainId: network.chainId }));
  }
  const signature = await client.signTypedData(typed as never);
  onSigned?.(signature);
  return signature;
}
