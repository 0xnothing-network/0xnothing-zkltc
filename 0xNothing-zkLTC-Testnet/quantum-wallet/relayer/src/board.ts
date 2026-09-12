// SPDX-License-Identifier: MIT
// Intent bulletin board — Tier 3 of docs/05-DEPIN.md §5.
//
// A stranded client posts its ALREADY-SIGNED intent here; any relayer node may
// pick it up, pay to broadcast it, and collect the hub's tip. The board holds no
// key and cannot alter an intent — the WOTS signature commits to the wallet, the
// chain, the nonce and every call — so it is not a new trust assumption for
// SAFETY, only for LIVENESS, exactly like the single sponsor it replaces.
//
// WHAT A BOARD CAN STILL DO, AND WHAT EACH COSTS
//
//  * Censor. Drop an intent instead of serving it. Not fixable at this layer;
//    the answer is Tier 1 (core/quantum/selfRelay.ts) — the client keeps the
//    exact bytes and can always broadcast them from its own account.
//
//  * Leak. Publish who is paying whom BEFORE it is on chain, to everyone rather
//    than to one sponsor. That is a real privacy regression, not a neutral
//    trade, which is why posting is opt-in and never automatic.
//
//  * Waste other people's money. This is the one the board must actively
//    prevent. An entry that can no longer land is a GAS TRAP: a node that picks
//    it up pays for a transaction the hub refuses to refund, because `relay`
//    reverts `OpFailed` and takes the refund down with it. So admission requires
//    the intent to be landable at the moment of posting, and nothing is ever
//    SERVED without re-checking.
//
//  * Be flooded until real users cannot post. Note what the landability rule
//    buys for free here: an execute is landable only while `op.walletNonce`
//    equals the wallet's current on-chain nonce, so one wallet can hold at most
//    ONE live execute intent — the chain enforces the per-wallet cap. Filling
//    the board costs one deployed wallet per slot, not one HTTP request per slot.

import { keccak256, toHex, type Hex } from "viem";

import { validateRequest } from "./policy.ts";
import type { RelayRequest } from "../../sdk/src/relay.ts";
import type { WalletState } from "../../sdk/src/reads.ts";

export interface BoardEntry {
  /** Deterministic hash of the request — the same bytes always get the same id. */
  id: string;
  wallet: Hex;
  kind: RelayRequest["kind"];
  /** Exactly what a node must forward, unmodified. */
  request: RelayRequest;
  postedAt: number;
  /** Soft, unenforceable claim window. See `list`. */
  leaseUntil: number;
  serves: number;
}

export interface BoardLimits {
  maxEntries: number;
  leaseMs: number;
  maxAgeMs: number;
  /** How many times one entry may be handed out before the board gives up. */
  maxServesPerEntry: number;
  /** How long a wallet's on-chain state may be reused across landability checks. */
  stateTtlMs: number;
}

export const DEFAULT_BOARD_LIMITS: BoardLimits = {
  maxEntries: 500,
  leaseMs: 45_000,
  maxAgeMs: 30 * 60_000,
  maxServesPerEntry: 3,
  stateTtlMs: 2_000,
};

/** The only chain access the board needs. Injected so it is testable offline. */
export interface BoardChain {
  stateOf(wallet: Hex): Promise<WalletState>;
  predictOf(root0: Hex): Promise<Hex>;
}

export interface PostResult {
  ok: boolean;
  id?: string;
  duplicate?: boolean;
  error?: string;
}

type PolicyCfg = {
  chainId: number;
  maxCallsPerOp: number;
  maxCalldataBytesPerOp: number;
  validUntilMaxSkewSec: number;
};

/// Key order in a JSON object is insertion order, so `JSON.stringify` would give
/// the same intent two different ids depending on how the client built it — and
/// two ids means two board slots for one intent, which is the duplicate the
/// dedupe exists to stop.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

export function intentId(req: RelayRequest): string {
  return keccak256(toHex(stableStringify(req)));
}

/// Short-lived per-wallet cache. A landability check reads the same wallet once
/// per HTTP request at worst, and several entries often share a wallet.
///
/// The TTL is deliberately about one block: a cache that outlived a block could
/// re-admit an intent whose nonce had already advanced, which is precisely the
/// gas trap the check exists to prevent.
export function cachedChain(chain: BoardChain, ttlMs: number): BoardChain {
  const states = new Map<string, { at: number; value: Promise<WalletState> }>();
  return {
    stateOf(wallet: Hex) {
      const key = wallet.toLowerCase();
      const now = Date.now();
      const hit = states.get(key);
      if (hit && now - hit.at < ttlMs) return hit.value;
      // Cache the PROMISE, not the result: several entries for one wallet in a
      // single request must collapse into one RPC round trip, and they are all
      // in flight before any of them resolves.
      const value = chain.stateOf(wallet).catch((e) => {
        states.delete(key);
        throw e;
      });
      states.set(key, { at: now, value });
      return value;
    },
    predictOf: (root0: Hex) => chain.predictOf(root0),
  };
}

export class IntentBoard {
  private readonly entries = new Map<string, BoardEntry>();
  private readonly chain: BoardChain;
  private readonly cfg: PolicyCfg;
  private readonly limits: BoardLimits;
  private posted = 0;
  private servedOut = 0;
  private dropped = 0;

  constructor(chain: BoardChain, cfg: PolicyCfg, limits: BoardLimits = DEFAULT_BOARD_LIMITS) {
    this.chain = cachedChain(chain, limits.stateTtlMs);
    this.cfg = cfg;
    this.limits = limits;
  }

  async post(raw: unknown, now = Date.now()): Promise<PostResult> {
    const err = validateRequest(raw, this.cfg);
    if (err) return { ok: false, error: `policy: ${err}` };

    const req = raw as RelayRequest;
    const id = intentId(req);

    // Checked BEFORE the duplicate branch on purpose. Re-posting refreshes an
    // entry, so skipping the check here would let a client keep a dead intent
    // alive on the board forever as a trap for other people's gas.
    const verdict = await this.landable(req);
    if (!verdict.ok) return { ok: false, error: verdict.error };

    const existing = this.entries.get(id);
    if (existing) {
      // Re-posting is how a client says "still hasn't landed, try again". It has
      // to be idempotent: the client must NEVER re-sign to retry, because that
      // would reuse a one-time leaf, so the same bytes must be safe to resend.
      existing.leaseUntil = 0;
      existing.serves = 0;
      existing.postedAt = now;
      return { ok: true, id, duplicate: true };
    }

    this.sweepAge(now);
    if (this.entries.size >= this.limits.maxEntries) {
      // Reject rather than evict the oldest. Evict-to-admit would hand anyone
      // with an HTTP client a censorship primitive: post junk, push a real
      // user's intent off the board.
      return { ok: false, error: "board full — retry shortly, or broadcast it yourself" };
    }

    this.entries.set(id, {
      id,
      wallet: req.wallet as Hex,
      kind: req.kind,
      request: req,
      postedAt: now,
      leaseUntil: 0,
      serves: 0,
    });
    this.posted += 1;
    return { ok: true, id, duplicate: false };
  }

  /// Hand out work. Every entry returned is re-verified against the chain first,
  /// so a node can forward what it receives without a second round trip.
  ///
  /// The lease is a SOFT claim and cannot be enforced: a node may ignore the
  /// board entirely, and two nodes may both read before either broadcasts. It
  /// removes the avoidable collisions only — the residual loss rate is a real
  /// cost that has to be measured, not assumed away (docs/05-DEPIN.md §5.2).
  async list(now = Date.now(), limit = 20): Promise<BoardEntry[]> {
    this.sweepAge(now);
    const out: BoardEntry[] = [];

    // Insertion order: oldest intent first, so nothing starves behind a burst.
    for (const entry of [...this.entries.values()]) {
      if (out.length >= limit) break;
      if (entry.leaseUntil > now) continue;
      if (entry.serves >= this.limits.maxServesPerEntry) {
        this.entries.delete(entry.id);
        this.dropped += 1;
        continue;
      }
      const verdict = await this.landable(entry.request);
      if (!verdict.ok) {
        this.entries.delete(entry.id);
        this.dropped += 1;
        continue;
      }
      entry.leaseUntil = now + this.limits.leaseMs;
      entry.serves += 1;
      this.servedOut += 1;
      out.push(entry);
    }
    return out;
  }

  /// Drop an entry, but only if the chain agrees it is dead.
  ///
  /// An unconditional delete would be a censorship primitive available to every
  /// anonymous caller: claim you landed someone's intent, and it leaves the
  /// board. Verifying instead means "settle" can only ever remove something that
  /// was already unusable.
  async settle(id: string): Promise<{ ok: boolean; removed: boolean; error?: string }> {
    const entry = this.entries.get(id);
    if (!entry) return { ok: true, removed: false };
    const verdict = await this.landable(entry.request);
    if (verdict.ok) {
      return { ok: false, removed: false, error: "intent is still landable — not removing" };
    }
    this.entries.delete(id);
    this.dropped += 1;
    return { ok: true, removed: true };
  }

  stats() {
    return {
      size: this.entries.size,
      posted: this.posted,
      servedOut: this.servedOut,
      dropped: this.dropped,
      maxEntries: this.limits.maxEntries,
    };
  }

  private sweepAge(now: number): void {
    for (const [id, entry] of this.entries) {
      if (now - entry.postedAt > this.limits.maxAgeMs) {
        this.entries.delete(id);
        this.dropped += 1;
      }
    }
  }

  /// Would this intent succeed if broadcast right now?
  ///
  /// Every condition below is one the CONTRACT also enforces. Duplicating them
  /// here is not belt-and-braces: on chain they cost the relayer a reverted
  /// transaction, and the whole point of the board is that it must not hand out
  /// work that loses money.
  private async landable(req: RelayRequest): Promise<{ ok: true } | { ok: false; error: string }> {
    let state: WalletState;
    try {
      state = await this.chain.stateOf(req.wallet as Hex);
    } catch (e) {
      return { ok: false, error: `cannot read wallet state: ${(e as Error).message}` };
    }

    if (req.kind === "deploy") {
      if (state.deployed) return { ok: false, error: "wallet already deployed" };
      let predicted: Hex;
      try {
        predicted = await this.chain.predictOf(req.root0);
      } catch (e) {
        return { ok: false, error: `cannot predict address: ${(e as Error).message}` };
      }
      if (predicted.toLowerCase() !== req.wallet.toLowerCase()) {
        return { ok: false, error: `root0 predicts ${predicted}, not ${req.wallet}` };
      }
      return { ok: true };
    }

    if (!state.deployed) return { ok: false, error: "wallet not deployed yet" };
    if (req.sig.epoch !== state.epoch) {
      return { ok: false, error: `epoch mismatch: on-chain ${state.epoch}, intent ${req.sig.epoch}` };
    }
    // Leaves are consumed strictly in order, so an intent signed at any other
    // index cannot land — now or ever. This is also why the board can never
    // hold two competing intents for one wallet.
    if (req.sig.leafIndex !== state.leafIndex) {
      return { ok: false, error: `leaf mismatch: on-chain ${state.leafIndex}, intent ${req.sig.leafIndex}` };
    }

    if (req.kind === "execute") {
      if (BigInt(req.op.walletNonce) !== state.nonce) {
        return { ok: false, error: `nonce mismatch: on-chain ${state.nonce}, intent ${req.op.walletNonce}` };
      }
      return { ok: true };
    }

    if (req.kind === "rotate") {
      if (req.nextEpoch !== state.epoch + 1) {
        return { ok: false, error: `rotate must target epoch ${state.epoch + 1}, got ${req.nextEpoch}` };
      }
      return { ok: true };
    }

    // signMessage: epoch + leaf were checked above, and there is nothing else the
    // chain would reject it for.
    return { ok: true };
  }
}
