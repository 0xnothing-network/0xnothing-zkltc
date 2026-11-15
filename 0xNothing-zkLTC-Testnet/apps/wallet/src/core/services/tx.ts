import type { Abi, Address, Hex, TransactionReceipt } from "viem";
import { erc20Abi } from "../../abis";
import type { WalletNetwork } from "../../config/networks";
import { t } from "../i18n";
import { touchSession } from "../keyring/vault";
import { BroadcastUnknownError, describeError } from "../lib/errors";
import { withNamedLock } from "../platform/locks";
import { activeNetwork, publicClient, type SignedCall, walletClientFor } from "../rpc/client";
import { noteSignedApproval } from "./approvals";
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
  /** Optional action-specific session check, repeated after async simulation. */
  assertReady?: () => Promise<void>;
  /**
   * Told the hash once the transaction is signed, before it is broadcast. Never
   * called when the action failed earlier, so a caller that sees no call knows
   * nothing was sent; after a call the outcome may be unknown and the same intent
   * must not be signed again.
   */
  onSigned?: (hash: Hex) => void;
}

function executionContext(context?: TxExecutionContext): TxExecutionContext {
  return context ?? { network: activeNetwork, client: publicClient };
}

/** How long to wait before the second look for a transaction whose broadcast failed. */
const BROADCAST_RECHECK_MS = 1_500;

type Signed = (hash: Hex, nonce?: number, call?: SignedCall) => void;

/**
 * Runs one broadcast and returns its hash.
 *
 * A node can take a transaction and still fail to answer: the reply times out, the
 * connection drops, or a repeat is refused as already known. The send then throws
 * although the transaction is on its way. Its hash is known from the moment it was
 * signed, so it is looked up before giving up. When it is not found either, the
 * wallet does not know: it throws BroadcastUnknownError with the hash rather than
 * the send's error, which would read as a failure and invite a retry that signs a
 * second copy with the next nonce.
 */
async function broadcast(
  readClient: typeof publicClient,
  send: (onSigned: Signed) => Promise<Hex>,
  signed: Signed,
): Promise<Hex> {
  let signedHash: Hex | undefined;
  try {
    return await send((hash, nonce, call) => {
      signedHash = hash;
      signed(hash, nonce, call);
    });
  } catch (error) {
    // Nothing was signed: the failure came before any transaction existed.
    if (!signedHash) throw error;
    const hash = signedHash;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, BROADCAST_RECHECK_MS));
      if (await readClient.getTransaction({ hash }).then(() => true, () => false)) return hash;
    }
    throw new BroadcastUnknownError(hash, error);
  }
}

/**
 * The history row of one submission, written the moment its transaction is
 * signed, before the node has answered. A page closed mid-broadcast, or an
 * answer that never comes, still leaves a pending row the History screen
 * settles; the stored nonce lets it tell a transaction that can no longer be
 * mined from one that is merely slow.
 */
function submission(
  from: Address,
  kind: TxKind,
  line: TxLine,
  network: WalletNetwork,
  onSigned?: (hash: Hex) => void,
) {
  let written: Promise<void> = Promise.resolve();
  let signedNonce: number | undefined;
  const record = (hash: Hex) => addRecord({
    hash,
    account: from,
    networkId: network.id,
    kind,
    status: "pending",
    at: Date.now(),
    label: line.label,
    detail: line.detail,
    detailLabel: line.detailLabel,
    nonce: signedNonce,
  }).catch(() => {});
  const signed: Signed = (hash, nonce, call) => {
    signedNonce = nonce;
    written = record(hash);
    // Token approvals are noted from the signed bytes for the approvals list. A
    // recording fault must not turn a signed transaction into an unsent one either.
    try { void noteSignedApproval(from, network, hash, call).catch(() => {}); } catch { /* ignored */ }
    // A listener's fault must not turn a signed transaction into an unsent one.
    try { onSigned?.(hash); } catch { /* ignored */ }
  };
  return {
    signed,
    /** Waits for the early row, so the hash or the error reaches the caller after it. */
    settled: () => written,
    record,
  };
}

export async function writeCall(
  request: WriteRequest,
  context?: TxExecutionContext,
): Promise<Hex> {
  const { network, client: readClient, assertReady, onSigned: told } = executionContext(context);
  const row = submission(request.from, request.kind, request, network, told);
  const hash = await withNamedLock(`tx:${request.from.toLowerCase()}`, () => broadcast(readClient, async (onSigned) => {
    await assertReady?.();
    const client = await walletClientFor(request.from, network, assertReady, onSigned);
    const { request: simulated } = await readClient.simulateContract({
      account: client.account,
      address: request.address,
      abi: request.abi as Abi,
      functionName: request.functionName,
      args: request.args as never,
      value: request.value,
    });
    await assertReady?.();
    return client.writeContract(simulated);
  }, row.signed)).finally(row.settled);
  await afterSubmit(request.from, hash, network, readClient, row).catch(() => {});
  return hash;
}

export async function sendNative(params: TxLine & {
  from: Address;
  to: Address;
  value: bigint;
}): Promise<Hex> {
  const network = activeNetwork;
  const readClient = publicClient;
  const row = submission(params.from, "send", params, network);
  const hash = await withNamedLock(`tx:${params.from.toLowerCase()}`, () => broadcast(readClient, async (onSigned) => {
    const client = await walletClientFor(params.from, network, undefined, onSigned);
    return client.sendTransaction({
      account: client.account,
      chain: client.chain,
      to: params.to,
      value: params.value,
    });
  }, row.signed)).finally(row.settled);
  await afterSubmit(params.from, hash, network, readClient, row).catch(() => {});
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
  const readClient = publicClient;
  const fees = await readClient.estimateFeesPerGas().catch(async () => ({
    maxFeePerGas: await readClient.getGasPrice(),
    maxPriorityFeePerGas: 0n,
  }));
  const maxFeePerGas = fees.maxFeePerGas ?? 0n;

  let estimated: bigint | null = null;
  let revert: string | null = null;
  try {
    const raw = await readClient.estimateGas({
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
}, context?: TxExecutionContext): Promise<Hex> {
  const { network, client: readClient, assertReady, onSigned: told } = executionContext(context);
  const row = submission(params.from, "dapp", params, network, told);
  const hash = await withNamedLock(`tx:${params.from.toLowerCase()}`, () => broadcast(readClient, async (onSigned) => {
    const client = await walletClientFor(params.from, network, assertReady, onSigned);
    return client.sendTransaction({
      account: client.account,
      chain: client.chain,
      to: params.to,
      value: params.value,
      data: params.data,
      gas: params.gas,
    });
  }, row.signed)).finally(row.settled);
  await afterSubmit(params.from, hash, network, readClient, row).catch(() => {});
  return hash;
}

async function afterSubmit(
  from: Address,
  hash: Hex,
  network: WalletNetwork,
  client: typeof publicClient,
  row: ReturnType<typeof submission>,
): Promise<void> {
  // The hash is already accepted by the node. Metadata must never turn a
  // successful submission into a rejected call (which would make UI retries
  // submit the same intent a second time). The row is written again in case
  // the early write at signing failed; the rewrite keeps the hash and nonce.
  await Promise.all([
    touchSession().catch(() => {}),
    row.record(hash),
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
  const pinnedContext = executionContext(context);
  const { client: readClient } = pinnedContext;
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
      }, pinnedContext);
      const receipt = await readClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (receipt.status !== "success") throw new Error(t("err.txReverted"));
      return hash;
    },
  );
}
