import { encodeFunctionData, type Hex } from "viem";
import { publicClient, walletClientFor } from "../rpc/client";
import { persistentStore } from "../platform/storage";
import { STORAGE_KEYS } from "../platform/storageKeys";
import { QUANTUM_CHAIN_ID, QUANTUM_RELAY_HUB, QUANTUM_RELAYER_URL } from "./config";
import { walletCalldataFor } from "./selfRelay";
import { quantumRelayHubAbi } from "../../../../../quantum-wallet/sdk/src/abi.ts";
import { decodeRevert } from "../../../../../quantum-wallet/sdk/src/reads.ts";

/**
 * DePIN relayer node — Tier 3 of quantum-wallet/docs/05-DEPIN.md.
 *
 * This turns the extension into one of the machines that keeps 0xQuantum alive.
 * It polls a bulletin board for intents other people signed but cannot get on
 * chain, submits them through `QuantumRelayHub`, and collects the hub's tip.
 * Nothing about it is required for this wallet to work; it exists so that the
 * set of parties able to broadcast is open instead of being one dev server.
 *
 * WHAT IT CANNOT DO, STRUCTURALLY
 *
 *  * Touch the quantum secret. Every intent it handles is already signed, and no
 *    signing primitive is reachable from this module. `walletCalldataFor` is
 *    shared with the self-broadcast path precisely so the same refusals apply.
 *  * Alter an intent. The WOTS signature commits to the wallet, the chain, the
 *    nonce and every call. A node that tampers produces bytes the wallet
 *    rejects, at the node's own expense.
 *  * Forge, replay, or reorder. Leaves are consumed strictly in order on chain.
 *
 * WHAT IT RISKS: real money, in one specific way. The node pays for its own
 * transaction and is reimbursed by the hub only if `relay` SUCCEEDS. Lose a race
 * to another node and the transaction reverts — the node still paid the gas and
 * gets nothing. That is why every tick simulates before it broadcasts, checks
 * the vault can actually cover the refund, and keeps a signed ledger that
 * switches the node off once cumulative losses reach the user's budget.
 *
 * REQUIRES AN UNLOCKED WALLET. Gas is paid from an HD account whose key lives in
 * the encrypted vault, so a tick fired while the wallet is locked cannot sign and
 * returns a clean `locked` outcome instead of an error. Relaying therefore only
 * happens while the user is actually using the extension — a real limitation,
 * and the honest alternative (holding a hot key outside the vault) is worse.
 */

const ADDRESS = /^0x[0-9a-fA-F]{40}$/u;
const HEX32 = /^0x[0-9a-fA-F]{64}$/u;

export interface RelayNodeSettings {
  /** Off by default. Nothing here runs until the user opts in. */
  enabled: boolean;
  /** Bulletin board to poll. Same origin as the sponsor relayer by default. */
  boardUrl: string;
  hub: Hex | null;
  /**
   * Cumulative NET loss, in wei, the user is willing to absorb before the node
   * switches itself off.
   *
   * A loss cap rather than a spend cap: gross spend is meaningless here because
   * the hub reimburses almost all of it. What the user is actually exposed to is
   * the residue — lost races and gas the hub's arithmetic cannot see (an L2's L1
   * data-availability fee is invisible to `gasleft()` and is never refunded).
   */
  budgetWei: string;
  /** Signed running total; positive means the node is up on tips. Decimal string. */
  netWei: string;
  maxPerTick: number;
  /**
   * Relay wallet CREATION for strangers. Off by default, and not an oversight:
   * `relayDeploy` pays NO tip, because a tip there would make manufacturing
   * sybil wallets directly profitable. Turning this on is charity, priced
   * honestly.
   */
  relayDeploys: boolean;
  lastTickAt: number;
  relayed: number;
  /** Transactions paid for that reverted — races lost, mostly. */
  lost: number;
}

export const RELAY_NODE_DEFAULTS: RelayNodeSettings = {
  enabled: false,
  boardUrl: QUANTUM_RELAYER_URL,
  hub: QUANTUM_RELAY_HUB,
  // 0.002 zkLTC. Roughly a handful of lost races on LiteForge — enough to be
  // useful, small enough that a misconfigured node is an annoyance not a loss.
  budgetWei: "2000000000000000",
  netWei: "0",
  maxPerTick: 3,
  relayDeploys: false,
  lastTickAt: 0,
  relayed: 0,
  lost: 0,
};

function decimal(value: unknown, fallback: string): string {
  return typeof value === "string" && /^-?\d+$/u.test(value) ? value : fallback;
}

function parseSettings(raw: unknown): RelayNodeSettings {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return RELAY_NODE_DEFAULTS;
  const v = raw as Record<string, unknown>;
  const hub = typeof v.hub === "string" && ADDRESS.test(v.hub) ? (v.hub as Hex) : QUANTUM_RELAY_HUB;
  const maxPerTick = Number(v.maxPerTick);
  return {
    // `=== true`, not truthiness: a corrupted or partially-written record must
    // fall back to OFF. Any other default would spend the user's money on the
    // strength of a bad read.
    enabled: v.enabled === true,
    boardUrl: typeof v.boardUrl === "string" && /^https?:\/\//u.test(v.boardUrl)
      ? v.boardUrl
      : RELAY_NODE_DEFAULTS.boardUrl,
    hub,
    budgetWei: decimal(v.budgetWei, RELAY_NODE_DEFAULTS.budgetWei),
    netWei: decimal(v.netWei, "0"),
    maxPerTick: Number.isInteger(maxPerTick) && maxPerTick > 0 ? Math.min(10, maxPerTick) : 3,
    relayDeploys: v.relayDeploys === true,
    lastTickAt: Number.isFinite(Number(v.lastTickAt)) ? Number(v.lastTickAt) : 0,
    relayed: Number.isInteger(Number(v.relayed)) ? Number(v.relayed) : 0,
    lost: Number.isInteger(Number(v.lost)) ? Number(v.lost) : 0,
  };
}

export async function readRelayNode(): Promise<RelayNodeSettings> {
  return parseSettings(await persistentStore.get<unknown>(STORAGE_KEYS.relayNode));
}

export async function writeRelayNode(settings: RelayNodeSettings): Promise<void> {
  await persistentStore.set(STORAGE_KEYS.relayNode, settings);
}

export async function updateRelayNode(patch: Partial<RelayNodeSettings>): Promise<RelayNodeSettings> {
  const next = parseSettings({ ...(await readRelayNode()), ...patch });
  await writeRelayNode(next);
  return next;
}

// --- board client --------------------------------------------------------------

interface BoardIntent {
  id: string;
  wallet: Hex;
  kind: string;
  request: Record<string, unknown>;
}

function parseIntent(raw: unknown): BoardIntent | null {
  if (raw === null || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.id !== "string" || v.id.length === 0 || v.id.length > 130) return null;
  if (typeof v.wallet !== "string" || !ADDRESS.test(v.wallet)) return null;
  if (typeof v.kind !== "string") return null;
  if (v.request === null || typeof v.request !== "object" || Array.isArray(v.request)) return null;
  return { id: v.id, wallet: v.wallet as Hex, kind: v.kind, request: v.request as Record<string, unknown> };
}

async function fetchBoard(
  boardUrl: string,
  limit: number,
): Promise<{ ok: true; hub: Hex | null; intents: BoardIntent[] } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await fetch(`${boardUrl.replace(/\/$/u, "")}/intents?limit=${limit}`);
  } catch (cause) {
    return { ok: false, error: `board unreachable: ${(cause as Error).message}` };
  }
  if (!res.ok) return { ok: false, error: `board returned ${res.status}` };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, error: "board returned invalid JSON" };
  }
  if (body === null || typeof body !== "object") return { ok: false, error: "board returned no object" };
  const v = body as Record<string, unknown>;
  // A board on the wrong chain would hand out intents that can only revert.
  if (v.chainId !== undefined && Number(v.chainId) !== QUANTUM_CHAIN_ID) {
    return { ok: false, error: `board is on chain ${String(v.chainId)}, not ${QUANTUM_CHAIN_ID}` };
  }
  const hub = typeof v.relayHub === "string" && ADDRESS.test(v.relayHub) ? (v.relayHub as Hex) : null;
  const list = Array.isArray(v.intents) ? v.intents : [];
  const intents: BoardIntent[] = [];
  for (const item of list) {
    const parsed = parseIntent(item);
    if (parsed !== null) intents.push(parsed);
  }
  return { ok: true, hub, intents };
}

/** Best-effort: tell the board an intent is dead so no other node pays for it. */
async function settleOnBoard(boardUrl: string, id: string): Promise<void> {
  try {
    await fetch(`${boardUrl.replace(/\/$/u, "")}/intents/settle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
  } catch {
    // A board that refuses the hint costs nothing here — it re-checks on every
    // read anyway. Never let this failure abort a tick.
  }
}

// --- the tick ------------------------------------------------------------------

export interface RelayAttempt {
  id: string;
  wallet: Hex;
  ok: boolean;
  txHash?: Hex;
  /** Signed net effect on the node's balance, in wei. Negative is a loss. */
  netWei?: string;
  skipped?: string;
  error?: string;
}

export interface RelayTickResult {
  ran: boolean;
  reason?: string;
  attempts: RelayAttempt[];
  netWei: string;
  disabled?: boolean;
}

/**
 * Build the hub call for one board intent.
 *
 * `walletCalldataFor` does the real validation; the extra check here is that the
 * board's envelope agrees with the signed payload. A board that says
 * `wallet: A` while the request targets `B` is either broken or trying to get a
 * node to pay for a call the hub will reject — either way, refuse it for free.
 */
function hubCallFor(
  intent: BoardIntent,
  hub: Hex,
  relayDeploys: boolean,
): { to: Hex; data: Hex } | { error: string } {
  if (intent.kind === "deploy") {
    if (!relayDeploys) return { error: "deploy intents pay no tip (relayDeploys is off)" };
    const root0 = intent.request.root0;
    if (typeof root0 !== "string" || !HEX32.test(root0)) return { error: "deploy intent has no root0" };
    return {
      to: hub,
      data: encodeFunctionData({
        abi: quantumRelayHubAbi,
        functionName: "relayDeploy",
        args: [root0 as Hex],
      }),
    };
  }

  const built = walletCalldataFor(intent.request);
  if ("error" in built) return { error: built.error };
  if (built.tx.to.toLowerCase() !== intent.wallet.toLowerCase()) {
    return { error: `board envelope names ${intent.wallet}, payload targets ${built.tx.to}` };
  }
  return {
    to: hub,
    data: encodeFunctionData({
      abi: quantumRelayHubAbi,
      functionName: "relay",
      args: [intent.wallet, built.tx.data],
    }),
  };
}

/**
 * One pass: poll the board, relay what is worth relaying, book the result.
 *
 * @param from  an unlocked HD account that pays gas. This account has NO
 *              authority over any quantum wallet — it is a funded courier.
 * @param skipWallets addresses to leave alone, normally this device's own
 *              quantum wallet: the local pending-retry path already covers it,
 *              and paying your own gas through the hub is strictly worse than
 *              letting the sponsor do it.
 */
export async function runRelayNodeTick(
  from: Hex | null,
  skipWallets: Hex[] = [],
): Promise<RelayTickResult> {
  const settings = await readRelayNode();
  const attempts: RelayAttempt[] = [];

  if (!settings.enabled) return { ran: false, reason: "relayer node is off", attempts, netWei: settings.netWei };
  if (from === null) return { ran: false, reason: "locked", attempts, netWei: settings.netWei };

  let net = BigInt(settings.netWei);
  const budget = BigInt(settings.budgetWei);
  if (net <= -budget) {
    await updateRelayNode({ enabled: false });
    return { ran: false, reason: "loss budget reached — node switched off", attempts, netWei: settings.netWei, disabled: true };
  }

  const board = await fetchBoard(settings.boardUrl, settings.maxPerTick);
  if (!board.ok) return { ran: false, reason: board.error, attempts, netWei: settings.netWei };

  // The board's own advertised hub wins over a possibly-stale build constant,
  // but only when the local setting has none: silently following a remote
  // server's choice of where to send transactions would be worse than a stale
  // address the user can see and fix.
  const hub = settings.hub ?? board.hub;
  if (hub === null) {
    return { ran: false, reason: "no relay hub configured", attempts, netWei: settings.netWei };
  }

  let walletClient;
  try {
    walletClient = await walletClientFor(from);
  } catch (cause) {
    return { ran: false, reason: `cannot sign from ${from}: ${(cause as Error).message}`, attempts, netWei: settings.netWei };
  }

  const skip = new Set(skipWallets.map((a) => a.toLowerCase()));
  let relayed = settings.relayed;
  let lost = settings.lost;

  for (const intent of board.intents) {
    if (attempts.length >= settings.maxPerTick) break;
    if (net <= -budget) {
      attempts.push({ id: intent.id, wallet: intent.wallet, ok: false, skipped: "loss budget reached" });
      break;
    }
    if (skip.has(intent.wallet.toLowerCase())) {
      attempts.push({ id: intent.id, wallet: intent.wallet, ok: false, skipped: "own wallet" });
      continue;
    }

    const call = hubCallFor(intent, hub, settings.relayDeploys);
    if ("error" in call) {
      attempts.push({ id: intent.id, wallet: intent.wallet, ok: false, skipped: call.error });
      continue;
    }

    // Is the hub still willing and able to pay? `quote` answers all of
    // "sponsored", "quota left", "budget left" and "vault funded" in one read.
    // Skipping this check does not make the relay fail — it makes it fail AFTER
    // the node has paid for it.
    let gas: bigint;
    let gasPrice: bigint;
    try {
      if (intent.kind !== "deploy") {
        const [relayable, , , vault] = (await publicClient.readContract({
          address: hub,
          abi: quantumRelayHubAbi,
          functionName: "quote",
          args: [intent.wallet],
        })) as [boolean, number, bigint, bigint];
        if (!relayable) {
          attempts.push({ id: intent.id, wallet: intent.wallet, ok: false, skipped: "hub will not pay for this wallet" });
          continue;
        }
        if (vault === 0n) {
          attempts.push({ id: intent.id, wallet: intent.wallet, ok: false, skipped: "hub vault is empty" });
          continue;
        }
      }

      // The free race check. If another node already landed this intent the
      // wallet's leaf has moved, the hub reverts `OpFailed`, and estimateGas
      // says so at no cost.
      gas = await publicClient.estimateGas({ account: from, to: call.to, data: call.data });
      gasPrice = await publicClient.getGasPrice();
    } catch (cause) {
      const reason = decodeRevert(cause);
      attempts.push({ id: intent.id, wallet: intent.wallet, ok: false, skipped: `would revert: ${reason}` });
      // A revert here means it cannot land now. Tell the board so the next node
      // is not sent into the same wall.
      void settleOnBoard(settings.boardUrl, intent.id);
      continue;
    }

    // Balance delta is the ground truth for profit and loss. The receipt's
    // `gasUsed` misses an L2's L1 data-availability fee, which the hub cannot
    // refund either — so measuring the fee would understate the real cost, and
    // the whole point of the ledger is to know what the node is actually losing.
    let before: bigint;
    try {
      before = await publicClient.getBalance({ address: from });
    } catch (cause) {
      attempts.push({ id: intent.id, wallet: intent.wallet, ok: false, error: (cause as Error).message });
      continue;
    }

    let txHash: Hex;
    try {
      txHash = await walletClient.sendTransaction({
        account: walletClient.account!,
        chain: walletClient.chain ?? null,
        to: call.to,
        data: call.data,
        gas: (gas * 130n) / 100n,
        gasPrice,
      });
    } catch (cause) {
      attempts.push({ id: intent.id, wallet: intent.wallet, ok: false, error: decodeRevert(cause) });
      continue;
    }

    try {
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 90_000 });
      const after = await publicClient.getBalance({ address: from });
      const delta = after - before;
      net += delta;
      if (receipt.status === "success") {
        relayed += 1;
        attempts.push({ id: intent.id, wallet: intent.wallet, ok: true, txHash, netWei: delta.toString() });
        void settleOnBoard(settings.boardUrl, intent.id);
      } else {
        // Paid for, reverted, unreimbursed. This is the cost of losing a race,
        // and it is why the ledger exists rather than being assumed away.
        lost += 1;
        attempts.push({ id: intent.id, wallet: intent.wallet, ok: false, txHash, netWei: delta.toString(), error: "reverted on chain" });
      }
    } catch (cause) {
      // Broadcast succeeded, confirmation did not arrive. The money is already
      // committed, so record the attempt without a net figure rather than
      // pretending nothing happened.
      attempts.push({ id: intent.id, wallet: intent.wallet, ok: false, txHash, error: `no receipt: ${(cause as Error).message}` });
    }
  }

  const exhausted = net <= -budget;
  await updateRelayNode({
    netWei: net.toString(),
    relayed,
    lost,
    lastTickAt: Date.now(),
    ...(exhausted ? { enabled: false } : {}),
  });

  return { ran: true, attempts, netWei: net.toString(), ...(exhausted ? { disabled: true } : {}) };
}

// --- scheduling ----------------------------------------------------------------

/**
 * Drive `runRelayNodeTick` on an interval for as long as the caller keeps the
 * returned stop function alive.
 *
 * Deliberately NOT a `chrome.alarms` job in the service worker. The node can
 * only sign while the vault is unlocked, so a background alarm would spend most
 * of its wake-ups discovering it cannot work — and the version that could work
 * in the background is the version that keeps a spending key outside the vault.
 * Tying the node's lifetime to an open, unlocked wallet is the honest shape:
 * the user can see it running, and it stops when they walk away.
 */
export function startRelayNode(
  accountFor: () => Hex | null,
  skipWallets: () => Hex[],
  onTick?: (result: RelayTickResult) => void,
  periodMs = 45_000,
): () => void {
  let stopped = false;
  let running = false;

  const tick = async () => {
    // Ticks must never overlap: two in flight would both read the same board
    // page and race each other onto the same intent, which is exactly the
    // collision the node is trying to avoid paying for.
    if (stopped || running) return;
    running = true;
    try {
      const result = await runRelayNodeTick(accountFor(), skipWallets());
      if (!stopped) onTick?.(result);
    } catch {
      // A tick that throws must not kill the interval — the next one may well
      // succeed (a transient RPC failure is the common case).
    } finally {
      running = false;
    }
  };

  void tick();
  const handle = setInterval(() => void tick(), periodMs);
  return () => {
    stopped = true;
    clearInterval(handle);
  };
}
