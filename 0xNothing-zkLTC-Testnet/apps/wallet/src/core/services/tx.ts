import type { Abi, Address, Hex, TransactionReceipt } from "viem";
import { erc20Abi } from "../../abis";
import type { WalletNetwork } from "../../config/networks";
import { t } from "../i18n";
import { touchSession } from "../keyring/vault";
import { describeError } from "../lib/errors";
import { withNamedLock } from "../platform/locks";
import { activeNetwork, publicClient, walletClientFor } from "../rpc/client";
import { addRecord, setRecordStatus, type TxKind, type TxLabel } from "./history";

/**
 * The one path every wallet-initiated transaction takes.
 *
 * Each write is simulated first: a revert then surfaces before the user pays for
 * gas, and viem's decoded error name reaches the UI instead of a bare
 * "execution reverted". The receipt is awaited in the background so the history
 * row settles even if the user navigates away.
 */
export interface TxLine {
  /** The history line, stored as a key so it re-reads in any language. */
  label: TxLabel;
  /** Second line when it is data (an address, a route, an amount). */
  detail?: string;
  /** Second line when it is prose. */
  detailLabel?: TxLabel;
}

export interface WriteRequest extends TxLine {
  from: Address;
  address: Address;
  abi: Abi | readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
  kind: TxKind;
}

export interface TxExecutionContext {
  network: WalletNetwork;
  client: typeof publicClient;
}

function executionContext(context?: TxExecutionContext): TxExecutionContext {
  return context ?? { network: activeNetwork, client: publicClient };
}

export async function writeCall(
  request: WriteRequest,
  context?: TxExecutionContext,
): Promise<Hex> {
  const { network, client: readClient } = executionContext(context);
  const hash = await withNamedLock(`tx:${request.from.toLowerCase()}`, async () => {
    const client = await walletClientFor(request.from, network);
    const { request: simulated } = await readClient.simulateContract({
      account: client.account,
      address: request.address,
      abi: request.abi as Abi,
      functionName: request.functionName,
      args: request.args as never,
      value: request.value,
    });
    return client.writeContract(simulated);
  });
  await afterSubmit(request.from, hash, request.kind, request, network, readClient).catch(() => {});
  return hash;
}

export async function sendNative(params: TxLine & {
  from: Address;
  to: Address;
  value: bigint;
}): Promise<Hex> {
  const network = activeNetwork;
  const readClient = publicClient;
  const hash = await withNamedLock(`tx:${params.from.toLowerCase()}`, async () => {
    const client = await walletClientFor(params.from, network);
    return client.sendTransaction({
      account: client.account,
      chain: client.chain,
      to: params.to,
      value: params.value,
    });
  });
  await afterSubmit(params.from, hash, "send", params, network, readClient).catch(() => {});
  return hash;
}

/**
 * What the approval window shows before signing a dapp transaction: the gas the
 * node expects, the fee that implies, and whether the call reverts as written.
 *
 * The estimate runs even when the page supplied its own gas limit — a page that
 * hardcodes gas is exactly the case where a silent revert would otherwise cost
 * the user the whole fee. A failed estimate is reported, never thrown: some
 * calls legitimately cannot be estimated, and the decision stays the user's.
 */
export interface RawPreview {
  gas: bigint | null;
  feeWei: bigint | null;
  /** One line explaining why the estimate failed, or null when it succeeded. */
  revert: string | null;
}

export async function previewRaw(params: {
  from: Address;
  to?: Address;
  value?: bigint;
  data?: Hex;
  gas?: bigint;
}): Promise<RawPreview> {
  const fees = await publicClient.estimateFeesPerGas().catch(async () => ({
    maxFeePerGas: await publicClient.getGasPrice(),
    maxPriorityFeePerGas: 0n,
  }));
  const maxFeePerGas = fees.maxFeePerGas ?? 0n;

  let estimated: bigint | null = null;
  let revert: string | null = null;
  try {
    const raw = await publicClient.estimateGas({
      account: params.from,
      to: params.to,
      value: params.value,
      data: params.data,
    });
    estimated = (raw * 12n) / 10n;
  } catch (error) {
    revert = describeError(error);
  }
  const gas = params.gas ?? estimated;
  return { gas, feeWei: gas === null ? null : gas * maxFeePerGas, revert };
}

/** Sends a raw, already-validated dapp transaction. */
export async function sendRaw(params: TxLine & {
  from: Address;
  to?: Address;
  value?: bigint;
  data?: Hex;
  gas?: bigint;
}): Promise<Hex> {
  const network = activeNetwork;
  const readClient = publicClient;
  const hash = await withNamedLock(`tx:${params.from.toLowerCase()}`, async () => {
    const client = await walletClientFor(params.from, network);
    return client.sendTransaction({
      account: client.account,
      chain: client.chain,
      to: params.to,
      value: params.value,
      data: params.data,
      gas: params.gas,
    });
  });
  await afterSubmit(params.from, hash, "dapp", params, network, readClient).catch(() => {});
  return hash;
}

async function afterSubmit(
  from: Address,
  hash: Hex,
  kind: TxKind,
  line: TxLine,
  network: WalletNetwork,
  client: typeof publicClient,
): Promise<void> {
  // The hash is already accepted by the node. Metadata must never turn a
  // successful submission into a rejected call (which would make UI retries
  // submit the same intent a second time).
  await Promise.all([
    touchSession().catch(() => {}),
    addRecord({
      hash,
      account: from,
      networkId: network.id,
      kind,
      status: "pending",
      at: Date.now(),
      label: line.label,
      detail: line.detail,
      detailLabel: line.detailLabel,
    }).catch(() => {}),
  ]);
  void client
    .waitForTransactionReceipt({ hash, timeout: 120_000 })
    .then((receipt: TransactionReceipt) =>
      setRecordStatus(
        from,
        hash,
        receipt.status === "success" ? "success" : "failed",
        network.id,
      ).catch(() => {}),
    )
    .catch(() => {
      // Timed out or the node dropped it; the row stays "pending" and the
      // explorer link is the source of truth.
    });
}

/**
 * ERC-20 allowance top-up. Returns the approval hash when one was needed.
 * Approves the exact amount rather than an unlimited allowance — the extra
 * transaction is a fair price for not leaving a standing spend right.
 */
export async function ensureAllowance(params: {
  from: Address;
  token: Address;
  spender: Address;
  amount: bigint;
  symbol: string;
}, context?: TxExecutionContext): Promise<Hex | null> {
  const { client: readClient } = executionContext(context);
  return withNamedLock(
    `allowance:${params.from.toLowerCase()}:${params.token.toLowerCase()}:${params.spender.toLowerCase()}`,
    async () => {
      const current = await readClient.readContract({
        address: params.token,
        abi: erc20Abi,
        functionName: "allowance",
        args: [params.from, params.spender],
      });
      if (current >= params.amount) return null;
      const hash = await writeCall({
        from: params.from,
        address: params.token,
        abi: erc20Abi,
        functionName: "approve",
        args: [params.spender, params.amount],
        kind: "approve",
        label: { key: "tx.approve", params: { symbol: params.symbol } },
      }, context);
      const receipt = await readClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (receipt.status !== "success") throw new Error(t("err.txReverted"));
      return hash;
    },
  );
}
