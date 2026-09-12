import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Hex } from "viem";
import {
  cachedChain,
  DEFAULT_BOARD_LIMITS,
  IntentBoard,
  intentId,
  type BoardChain,
  type BoardLimits,
} from "../src/board.ts";
import { LEN, TREE_H } from "../src/policy.ts";
import type { WalletState } from "../../sdk/src/reads.ts";
import type { RelayRequest } from "../../sdk/src/relay.ts";

/**
 * Unit tests for the intent bulletin board.
 *
 * `IntentBoard` takes its chain access as an injected `BoardChain`, so every
 * property below is checked offline with a fake chain — no RPC, no relayer
 * process, no deployed contract. That was the point of the injection.
 *
 * Three of these tests pin properties that are security-relevant rather than
 * merely functional, and the comments say which: a board that evicts to admit,
 * or that lets `settle` remove a live intent, hands anyone with an HTTP client a
 * censorship primitive. Those two must never regress quietly.
 */

const CFG = {
  chainId: 4441,
  maxCallsPerOp: 4,
  maxCalldataBytesPerOp: 8192,
  validUntilMaxSkewSec: 3600,
};

// `stateTtlMs: 0` disables the per-wallet cache. `cachedChain` reads the real
// clock, which these tests cannot inject, so caching is switched off everywhere
// except the one test that is specifically about it.
const LIMITS: BoardLimits = { ...DEFAULT_BOARD_LIMITS, stateTtlMs: 0 };

const NOW = 1_800_000_000_000;
const OP_NO_EXPIRY = "4294967295";

/**
 * Decimal digits only, on purpose. `policy.ts` calls viem's `isAddress`, which
 * is checksum-strict by default — an address containing lowercase `a`-`f` would
 * be rejected as a bad checksum and these tests would fail on their fixtures
 * rather than on the board. An address with no letters has nothing to case, so
 * it is trivially checksum-valid.
 */
function wallet(n: number): Hex {
  return `0x${String(n).padStart(40, "0")}` as Hex;
}

function b32(n: number): Hex {
  return `0x${n.toString(16).padStart(64, "0")}` as Hex;
}

function sig(leafIndex: number, epoch = 0) {
  return {
    epoch,
    leafIndex,
    wots: Array.from({ length: LEN }, (_, i) => b32(0x1000 + i)),
    path: Array.from({ length: TREE_H }, (_, i) => b32(0x2000 + i)),
  };
}

function execute(w: Hex, nonce: bigint, leafIndex: number, epoch = 0): RelayRequest {
  return {
    kind: "execute",
    wallet: w,
    chainId: CFG.chainId,
    op: {
      walletNonce: nonce.toString(),
      validUntil: OP_NO_EXPIRY,
      calls: [{ to: wallet(0xbeef), value: "1", data: "0x" }],
    },
    sig: sig(leafIndex, epoch),
  } as RelayRequest;
}

function live(over: Partial<WalletState> = {}): WalletState {
  return { deployed: true, nonce: 7n, epoch: 0, merkleRoot: b32(0xaa), leafIndex: 3, ...over };
}

/** Fake chain with a mutable state map, so a test can "advance the chain". */
function fakeChain(initial: Record<string, WalletState> = {}): BoardChain & {
  states: Map<string, WalletState>;
  reads: string[];
  predicted: Map<string, Hex>;
} {
  // Built with a loop rather than `new Map(Object.entries(...).map(...))`: TS
  // infers `(string | WalletState)[][]` for a `.map()` returning array literals,
  // which is not assignable to `Iterable<readonly [string, WalletState]>`. The
  // loop sidesteps the tuple-inference question entirely.
  const states = new Map<string, WalletState>();
  for (const [key, value] of Object.entries(initial)) states.set(key.toLowerCase(), value);
  const predicted = new Map<string, Hex>();
  const reads: string[] = [];
  return {
    states,
    predicted,
    reads,
    async stateOf(w: Hex) {
      reads.push(w.toLowerCase());
      return states.get(w.toLowerCase()) ?? { deployed: false, nonce: 0n, epoch: 0, merkleRoot: b32(0), leafIndex: 0 };
    },
    async predictOf(root0: Hex) {
      return predicted.get(root0.toLowerCase()) ?? wallet(0xdead);
    },
  };
}

describe("intentId", () => {
  it("is independent of key order", () => {
    const a = { kind: "deploy", wallet: wallet(1), root0: b32(9), chainId: 4441 } as RelayRequest;
    const b = { chainId: 4441, root0: b32(9), wallet: wallet(1), kind: "deploy" } as RelayRequest;
    // JSON.stringify would give these two different ids, and two ids means two
    // board slots for one intent — the duplicate the dedupe exists to stop.
    assert.equal(intentId(a), intentId(b));
  });

  it("changes when any signed field changes", () => {
    const a = execute(wallet(1), 7n, 3);
    const b = execute(wallet(1), 7n, 4);
    assert.notEqual(intentId(a), intentId(b));
  });
});

describe("IntentBoard.post", () => {
  it("rejects a policy violation before touching the chain", async () => {
    const chain = fakeChain();
    const board = new IntentBoard(chain, CFG, LIMITS);
    const out = await board.post({ kind: "execute", wallet: wallet(1), chainId: 1 }, NOW);
    assert.equal(out.ok, false);
    assert.match(out.error ?? "", /policy:/);
    assert.equal(chain.reads.length, 0, "a malformed post must not cost an RPC read");
  });

  it("rejects an intent the chain would reject anyway", async () => {
    const w = wallet(1);
    const chain = fakeChain({ [w]: live({ nonce: 9n }) });
    const board = new IntentBoard(chain, CFG, LIMITS);
    // Signed for nonce 7 while the chain is at 9: this can only ever revert, so
    // admitting it would be handing a node a gas trap.
    const out = await board.post(execute(w, 7n, 3), NOW);
    assert.equal(out.ok, false);
    assert.equal(board.stats().size, 0);
  });

  it("rejects an execute whose leaf has already been consumed", async () => {
    const w = wallet(1);
    const chain = fakeChain({ [w]: live({ leafIndex: 5 }) });
    const board = new IntentBoard(chain, CFG, LIMITS);
    const out = await board.post(execute(w, 7n, 3), NOW);
    assert.equal(out.ok, false);
  });

  it("rejects an execute for a wallet that does not exist yet", async () => {
    const board = new IntentBoard(fakeChain(), CFG, LIMITS);
    const out = await board.post(execute(wallet(1), 0n, 0), NOW);
    assert.equal(out.ok, false);
  });

  it("admits a landable execute", async () => {
    const w = wallet(1);
    const board = new IntentBoard(fakeChain({ [w]: live() }), CFG, LIMITS);
    const req = execute(w, 7n, 3);
    const out = await board.post(req, NOW);
    assert.equal(out.ok, true);
    assert.equal(out.id, intentId(req));
    assert.equal(board.stats().size, 1);
  });

  it("refreshes rather than duplicates when the same bytes are re-posted", async () => {
    const w = wallet(1);
    const board = new IntentBoard(fakeChain({ [w]: live() }), CFG, LIMITS);
    const req = execute(w, 7n, 3);
    const first = await board.post(req, NOW);
    const again = await board.post(req, NOW + 10_000);
    assert.equal(again.ok, true);
    assert.equal(again.duplicate, true);
    assert.equal(again.id, first.id);
    // One slot, not two. Re-posting is what a client does instead of re-signing,
    // so it has to be idempotent.
    assert.equal(board.stats().size, 1);
  });

  it("re-checks landability BEFORE the duplicate branch", async () => {
    const w = wallet(1);
    const chain = fakeChain({ [w]: live() });
    const board = new IntentBoard(chain, CFG, LIMITS);
    const req = execute(w, 7n, 3);
    assert.equal((await board.post(req, NOW)).ok, true);

    // The op lands; the chain moves past it.
    chain.states.set(w.toLowerCase(), live({ nonce: 8n, leafIndex: 4 }));

    // Without the check-before-duplicate ordering, this re-post would refresh
    // the dead entry's lease forever and keep a permanent gas trap on the board.
    const again = await board.post(req, NOW + 1000);
    assert.equal(again.ok, false);
  });

  it("admits a deploy only when root0 actually predicts that address", async () => {
    const chain = fakeChain();
    const root0 = b32(0x77);
    const board = new IntentBoard(chain, CFG, LIMITS);

    const wrong: RelayRequest = { kind: "deploy", wallet: wallet(0x1234), root0, chainId: CFG.chainId };
    assert.equal((await board.post(wrong, NOW)).ok, false);

    chain.predicted.set(root0.toLowerCase(), wallet(0x1234));
    assert.equal((await board.post(wrong, NOW)).ok, true);
  });

  it("rejects a deploy for a wallet that already exists", async () => {
    const w = wallet(0x1234);
    const root0 = b32(0x77);
    const chain = fakeChain({ [w]: live() });
    chain.predicted.set(root0.toLowerCase(), w);
    const board = new IntentBoard(chain, CFG, LIMITS);
    const out = await board.post({ kind: "deploy", wallet: w, root0, chainId: CFG.chainId }, NOW);
    assert.equal(out.ok, false);
  });

  it("rejects when full instead of evicting to admit", async () => {
    const limits: BoardLimits = { ...LIMITS, maxEntries: 2 };
    const chain = fakeChain({
      [wallet(1)]: live(),
      [wallet(2)]: live(),
      [wallet(3)]: live(),
    });
    const board = new IntentBoard(chain, CFG, limits);
    assert.equal((await board.post(execute(wallet(1), 7n, 3), NOW)).ok, true);
    assert.equal((await board.post(execute(wallet(2), 7n, 3), NOW)).ok, true);

    const third = await board.post(execute(wallet(3), 7n, 3), NOW);
    // SECURITY: evict-to-admit would let anyone with `curl` push other people's
    // intents off the board — a censorship primitive available to the public.
    assert.equal(third.ok, false);
    assert.equal(board.stats().size, 2);
    const ids = (await board.list(NOW, 10)).map((e) => e.id);
    assert.deepEqual(ids, [intentId(execute(wallet(1), 7n, 3)), intentId(execute(wallet(2), 7n, 3))]);
  });
});

describe("IntentBoard.list", () => {
  it("never serves an intent that has gone stale", async () => {
    const w = wallet(1);
    const chain = fakeChain({ [w]: live() });
    const board = new IntentBoard(chain, CFG, LIMITS);
    await board.post(execute(w, 7n, 3), NOW);

    chain.states.set(w.toLowerCase(), live({ nonce: 8n, leafIndex: 4 }));

    assert.deepEqual(await board.list(NOW + 1, 10), []);
    assert.equal(board.stats().size, 0, "a stale entry is dropped when it is noticed");
  });

  it("grants a soft lease so two nodes polling back-to-back get different work", async () => {
    const chain = fakeChain({ [wallet(1)]: live(), [wallet(2)]: live() });
    const board = new IntentBoard(chain, CFG, LIMITS);
    await board.post(execute(wallet(1), 7n, 3), NOW);
    await board.post(execute(wallet(2), 7n, 3), NOW);

    const first = await board.list(NOW, 10);
    assert.equal(first.length, 2);
    assert.ok(first[0]!.leaseUntil > NOW);

    // Immediately after, everything is leased — the second node sees nothing.
    assert.deepEqual(await board.list(NOW + 1, 10), []);
    // Once the lease lapses the work is offered again: a lease is a hint, not an
    // assignment, because the board has no authority to enforce one.
    assert.equal((await board.list(NOW + LIMITS.leaseMs + 1, 10)).length, 2);
  });

  it("gives up on an entry nobody manages to land", async () => {
    const limits: BoardLimits = { ...LIMITS, maxServesPerEntry: 2, leaseMs: 0 };
    const board = new IntentBoard(fakeChain({ [wallet(1)]: live() }), CFG, limits);
    await board.post(execute(wallet(1), 7n, 3), NOW);

    assert.equal((await board.list(NOW, 10)).length, 1);
    assert.equal((await board.list(NOW, 10)).length, 1);
    // Third ask: serves has hit the cap, so the entry is dropped rather than
    // offered to a fourth node that would also fail to land it.
    assert.equal((await board.list(NOW, 10)).length, 0);
    assert.equal(board.stats().size, 0);
  });

  it("sweeps entries older than maxAgeMs", async () => {
    const board = new IntentBoard(fakeChain({ [wallet(1)]: live() }), CFG, LIMITS);
    await board.post(execute(wallet(1), 7n, 3), NOW);
    assert.deepEqual(await board.list(NOW + LIMITS.maxAgeMs + 1, 10), []);
    assert.equal(board.stats().size, 0);
  });

  it("honours limit, and only verifies what it is about to return", async () => {
    const states: Record<string, WalletState> = {};
    for (let i = 1; i <= 5; i += 1) states[wallet(i)] = live();
    const chain = fakeChain(states);
    const board = new IntentBoard(chain, CFG, LIMITS);
    for (let i = 1; i <= 5; i += 1) await board.post(execute(wallet(i), 7n, 3), NOW);

    chain.reads.length = 0;
    const page = await board.list(NOW, 2);
    assert.equal(page.length, 2);
    // Two returned, two reads. Verifying the whole board on every poll would put
    // its RPC cost under the control of whoever posts the most.
    assert.equal(chain.reads.length, 2);
  });
});

describe("IntentBoard.settle", () => {
  it("refuses to remove an intent that is still landable", async () => {
    const board = new IntentBoard(fakeChain({ [wallet(1)]: live() }), CFG, LIMITS);
    const req = execute(wallet(1), 7n, 3);
    const { id } = await board.post(req, NOW);

    const out = await board.settle(id!);
    // SECURITY: settle is unauthenticated, so if it could remove a live intent
    // it would be a censorship primitive. Only genuinely-dead entries may go.
    assert.equal(out.ok, false);
    assert.equal(out.removed, false);
    assert.equal(board.stats().size, 1);
  });

  it("removes an intent the chain has moved past", async () => {
    const w = wallet(1);
    const chain = fakeChain({ [w]: live() });
    const board = new IntentBoard(chain, CFG, LIMITS);
    const { id } = await board.post(execute(w, 7n, 3), NOW);

    chain.states.set(w.toLowerCase(), live({ nonce: 8n, leafIndex: 4 }));
    const out = await board.settle(id!);
    assert.equal(out.ok, true);
    assert.equal(out.removed, true);
    assert.equal(board.stats().size, 0);
  });

  it("is a no-op for an unknown id", async () => {
    const board = new IntentBoard(fakeChain(), CFG, LIMITS);
    const out = await board.settle("0xdeadbeef");
    assert.equal(out.ok, true);
    assert.equal(out.removed, false);
  });
});

describe("cachedChain", () => {
  it("collapses concurrent reads of one wallet into a single round trip", async () => {
    const chain = fakeChain({ [wallet(1)]: live() });
    const cached = cachedChain(chain, 60_000);
    const [a, b] = await Promise.all([cached.stateOf(wallet(1)), cached.stateOf(wallet(1))]);
    assert.equal(chain.reads.length, 1, "the PROMISE is cached, not just the result");
    assert.deepEqual(a, b);
  });

  it("does not cache a failed read", async () => {
    let calls = 0;
    const failing: BoardChain = {
      async stateOf() {
        calls += 1;
        throw new Error("rpc down");
      },
      async predictOf() {
        return wallet(0);
      },
    };
    const cached = cachedChain(failing, 60_000);
    await assert.rejects(cached.stateOf(wallet(1)));
    await assert.rejects(cached.stateOf(wallet(1)));
    // A cached rejection would keep a wallet unreadable for the whole TTL after
    // one transient RPC blip, silently rejecting every intent for it.
    assert.equal(calls, 2);
  });
});
