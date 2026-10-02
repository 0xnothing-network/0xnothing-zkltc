import { type Address, isHex } from "viem";
import { LITVM_NETWORK, networkIdentity, resolveNetwork, type WalletNetwork } from "../../config/networks";
import { t } from "../i18n";
import { isUnlocked, readAccounts, readSettings, WalletLockedError } from "../keyring/vault";
import { publicClientFor, walletClientFor } from "../rpc/client";
import { connectedAccounts, DAPP_REQUEST_TIMEOUT_MS, type DappRequest, listPending } from "./dapp";
import { sendRaw } from "./tx";

function quantity(value: string | undefined): bigint | undefined {
  if (value === undefined || value === "") return undefined;
  try {
    return BigInt(value);
  } catch {
    throw new Error(t("apr.badQuantity", { value }));
  }
}

/** Execute the request displayed in the separate approval window. */
export async function executeDappRequest(
  request: DappRequest,
  signer: Address,
  host: string,
  network: WalletNetwork,
  approvalClaim: string,
): Promise<string> {
  const expectedNetwork = networkIdentity(network);
  const assertReady = async (): Promise<void> => {
    const [accounts, settings, pending, granted] = await Promise.all([
      readAccounts(), readSettings(), listPending(),
      request.kind === "connect" ? Promise.resolve([signer]) : connectedAccounts(request.origin),
    ]);
    const current = pending.find((entry) => entry.id === request.id);
    const selected = resolveNetwork(settings.networkId, settings.customNetworks);
    if (!(await isUnlocked())) throw new WalletLockedError();
    if (
      (request.networkId ?? LITVM_NETWORK.id) !== network.id
      || (request.networkIdentity !== undefined && request.networkIdentity !== expectedNetwork)
      || networkIdentity(selected) !== expectedNetwork
      || (accounts.active ?? accounts.accounts[0]?.address)?.toLowerCase() !== signer.toLowerCase()
      || request.account?.toLowerCase() !== signer.toLowerCase()
      || !granted.some((address) => address.toLowerCase() === signer.toLowerCase())
      || current?.approvalClaim !== approvalClaim
      || current.at + DAPP_REQUEST_TIMEOUT_MS <= Date.now()
    ) throw new Error(t("err.quoteStale"));
  };
  await assertReady();
  if (request.kind === "connect") return signer;
  if (request.kind === "switch-network") {
    if (!request.targetNetworkId) throw new Error(t("apr.unreadable"));
    return request.targetNetworkId;
  }
  if (request.kind === "transaction") {
    const tx = request.tx ?? {};
    return sendRaw({
      from: signer,
      to: tx.to,
      value: quantity(tx.value),
      data: tx.data,
      gas: quantity(tx.gas),
      label: { key: "tx.dapp", params: { host } },
      detail: tx.to,
    }, { network, client: publicClientFor(network), assertReady });
  }
  // The client checks the claim and current permissions again after asynchronous
  // key retrieval and immediately before every actual signature.
  const client = await walletClientFor(signer, network, assertReady);
  if (request.kind === "sign") {
    const message = request.message ?? "";
    return client.signMessage({ message: isHex(message) ? { raw: message } : message });
  }
  const typed = JSON.parse(request.message ?? "{}");
  if (typed?.domain?.chainId !== undefined && BigInt(typed.domain.chainId) !== BigInt(network.chainId)) {
    throw new Error(t("apr.wrongChain", { chainId: network.chainId }));
  }
  return client.signTypedData(typed as never);
}
