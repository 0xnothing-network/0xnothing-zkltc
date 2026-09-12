// SPDX-License-Identifier: MIT
// Sponsor relayer HTTP server. Dev-sponsored gas for 0xQuantum wallets.
//
//   POST /relay   RelayRequest -> RelayResponse  (see sdk/src/relay.ts)
//   GET  /health  { ok, chainId, factory, sponsor, ... }
//
// Security posture (see docs/01-DESIGN.md):
//  * The sponsor NEVER sees secrets — requests carry only signed intents.
//  * Every request is structurally validated (policy.ts), then simulated
//    (estimateGas) BEFORE any broadcast; a reverting intent costs no gas.
//  * execute/rotate/signMessage require the wallet to be deployed first;
//    relaying an op to an empty address would "succeed" silently (no code =>
//    no-op tx) and trick the user into thinking funds moved.
//  * Broadcasts are serialized so the sponsor account never double-spends a nonce.
//  * Per-wallet rate limit (in-memory sliding window).

import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig, type RelayConfig } from "./config.ts";
import { loadDotEnvFile } from "./envfile.ts";
import { validateRequest } from "./policy.ts";
import { DEFAULT_BOARD_LIMITS, IntentBoard, type BoardChain } from "./board.ts";
import { quantumWalletFactoryAbi } from "../../sdk/src/abi.ts";
import { decodeRevert, predictWallet, readWalletState } from "../../sdk/src/reads.ts";
import {
  executeSignedCalldata,
  rotateCalldata,
  signMessageCalldata,
  type RelayRequest,
  type RelayResponse,
} from "../../sdk/src/relay.ts";
import { fromWireOp, fromWireSig } from "../../sdk/src/encode.ts";

function liteforgeChain(config: RelayConfig) {
  return {
    id: config.chainId,
    name: "zkLTC LiteForge",
    nativeCurrency: { name: "zkLTC", symbol: "zkLTC", decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
  };
}

export interface RelayDeps {
  publicClient: PublicClient;
  walletClient: WalletClient | null; // null => simulate-only mode
  sponsor: Hex | null;
  config: RelayConfig;
}

export function makeDeps(config: RelayConfig): RelayDeps {
  const transport = http(config.rpcUrl);
  const publicClient = createPublicClient({ chain: liteforgeChain(config), transport });
  let walletClient: WalletClient | null = null;
  let sponsor: Hex | null = null;
  if (config.sponsorKey) {
    const account = privateKeyToAccount(config.sponsorKey);
    sponsor = account.address;
    walletClient = createWalletClient({
      account,
      chain: liteforgeChain(config),
      transport,
    }) as WalletClient;
  }
  return { publicClient, walletClient, sponsor, config };
}

/** Serialize all broadcasts: the sponsor account must never have two txs in flight. */
export class BroadcastQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

/** Minimal sliding-window limiter keyed by wallet address. */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  private lastSweep = 0;
  private readonly max: number;
  private readonly windowMs: number;

  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
  }
  allow(key: string, now = Date.now()): boolean {
    // Pruning inside allow() only ever touches the key being requested, so an
    // entry for a wallet that asks once and never returns would live forever —
    // and a caller picks the key, so a flood of throwaway addresses grows the
    // map without bound (memory-exhaustion DoS). A full sweep once per window
    // bounds it instead: after a sweep nothing in the map is older than one
    // window, so the live set is "keys seen in the last ~2 windows".
    if (now - this.lastSweep >= this.windowMs) {
      this.sweep(now);
      this.lastSweep = now;
    }
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    // Write the pruned array back in both branches: on rejection the old array
    // is stale, and leaving it would keep this key large across windows.
    this.hits.set(key, arr);
    if (arr.length >= this.max) return false;
    arr.push(now);
    return true;
  }
  private sweep(now: number): void {
    for (const [key, arr] of this.hits) {
      const live = arr.filter((t) => now - t < this.windowMs);
      if (live.length === 0) this.hits.delete(key);
      else this.hits.set(key, live);
    }
  }
  count(key: string): number {
    return (this.hits.get(key) ?? []).length;
  }
  /** Number of tracked keys — exposed so tests can assert the sweep runs. */
  size(): number {
    return this.hits.size;
  }
}

export class RelayServer {
  private queue = new BroadcastQueue();
  private limiter: RateLimiter;
  private served = 0;
  private readonly deps: RelayDeps;
  private readonly board: IntentBoard;
  /// Separate budget from /relay. A board post is cheap for the poster but costs
  /// this process an RPC read to check landability, so it needs its own bound —
  /// and it must not be able to consume the sponsored-relay allowance.
  private boardLimiter: RateLimiter;

  constructor(deps: RelayDeps) {
    this.deps = deps;
    this.limiter = new RateLimiter(deps.config.rateMax, deps.config.rateWindowMs);
    this.boardLimiter = new RateLimiter(deps.config.rateMax, deps.config.rateWindowMs);
    const chain: BoardChain = {
      stateOf: (wallet) => readWalletState(deps.publicClient, wallet),
      predictOf: (root0) => predictWallet(deps.publicClient, deps.config.factory, root0),
    };
    this.board = new IntentBoard(chain, deps.config, DEFAULT_BOARD_LIMITS);
  }

  /** Core entry: validated + simulated + broadcast. Returns wire response. */
  async handle(raw: unknown): Promise<RelayResponse> {
    const cfg = this.deps.config;
    const err = validateRequest(raw, cfg);
    if (err) return { ok: false, error: `policy: ${err}` };

    const req = raw as RelayRequest;
    if (!this.limiter.allow(req.wallet)) {
      return { ok: false, error: "rate limited: too many requests for this wallet" };
    }
    this.served += 1;

    if (!this.deps.walletClient || !this.deps.sponsor) {
      return { ok: false, error: "relayer in simulate-only mode (QW_SPONSOR_KEY not set)" };
    }

    try {
      return await this.route(req);
    } catch (e) {
      return { ok: false, error: decodeRevert(e) };
    }
  }

  private async route(req: RelayRequest): Promise<RelayResponse> {
    const { publicClient, walletClient, sponsor, config } = this.deps;

    if (req.kind === "deploy") {
      const to = config.factory;
      const data = encodeFunctionData({
        abi: quantumWalletFactoryAbi,
        functionName: "deployWallet",
        args: [req.root0],
      });
      // Sanity: the CREATE2 prediction must equal the wallet the user claims.
      const predicted = (await publicClient.readContract({
        address: config.factory,
        abi: quantumWalletFactoryAbi,
        functionName: "predictWallet",
        args: [req.root0],
      })) as Hex;
      if (predicted.toLowerCase() !== req.wallet.toLowerCase()) {
        return { ok: false, error: `deploy: root0 predicts ${predicted}, not ${req.wallet}` };
      }
      const state = await readWalletState(publicClient, req.wallet);
      if (state.deployed) return { ok: false, error: "wallet already deployed" };
      return this.broadcast(to, data);
    }

    // execute / rotate / signMessage — the wallet must already exist on-chain.
    const state = await readWalletState(publicClient, req.wallet);
    if (!state.deployed) {
      return { ok: false, error: "wallet not deployed yet — send a deploy request first" };
    }

    const sig = fromWireSig(req.sig);
    let data: Hex;
    switch (req.kind) {
      case "execute": {
        const op = fromWireOp(req.op);
        if (state.nonce !== op.walletNonce) {
          return { ok: false, error: `nonce mismatch: on-chain ${state.nonce}, op ${op.walletNonce}` };
        }
        data = executeSignedCalldata(req.wallet, op, sig).data;
        break;
      }
      case "rotate": {
        if (Number(state.epoch) + 1 !== req.nextEpoch) {
          return { ok: false, error: `epoch mismatch: on-chain ${state.epoch}, want next ${req.nextEpoch}` };
        }
        data = rotateCalldata(req.wallet, req.newRoot, req.nextEpoch, sig).data;
        break;
      }
      case "signMessage": {
        data = signMessageCalldata(req.wallet, req.messageHash, sig).data;
        break;
      }
    }

    // Simulate BEFORE spending sponsor gas. estimateGas performs the eth_call;
    // a revert here means a clean, free error for the user.
    try {
      await publicClient.estimateGas({ account: sponsor!, to: req.wallet as Hex, data });
    } catch (e) {
      return { ok: false, error: `simulation failed: ${decodeRevert(e)}` };
    }
    return this.broadcast(req.wallet as Hex, data);
  }

  private broadcast(to: Hex, data: Hex): Promise<RelayResponse> {
    const { publicClient, walletClient, sponsor, config } = this.deps;
    return this.queue.run(async () => {
      const nonce = await publicClient.getTransactionCount({ address: sponsor!, blockTag: "pending" });
      const gas = await publicClient.estimateGas({ account: sponsor!, to, data });
      const gasPrice = await publicClient.getGasPrice().catch(() => undefined);
      const txHash = await walletClient!.sendTransaction({
        // Both are required because walletClient is the generic WalletClient
        // (chain/account unparameterized). These pass exactly what the client
        // was built with in makeDeps, so broadcast behaviour is unchanged: the
        // sponsor Account object keeps viem signing locally.
        account: walletClient!.account!,
        chain: walletClient!.chain ?? null,
        to,
        data,
        nonce,
        gas: (gas * 130n) / 100n, // +30% headroom over the estimate
        ...(gasPrice ? { gasPrice } : {}),
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 90_000 });
      if (receipt.status !== "success") {
        return { ok: false, txHash, error: "broadcast tx reverted on chain" };
      }
      return { ok: true, txHash };
    });
  }

  httpHandler() {
    return (req: IncomingMessage, res: ServerResponse) => {
      void this.dispatch(req, res);
    };
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse) {
    const cfg = this.deps.config;
    res.setHeader("content-type", "application/json");
    res.setHeader("access-control-allow-origin", "*"); // browser extension origins vary
    res.setHeader("access-control-allow-methods", "POST, GET, OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type");
    // Private Network Access. A client whose own origin is not loopback (a web
    // page, or an extension without a host permission for this origin) has to be
    // told the local target consents, or Chrome rejects the request before the
    // response is ever readable — which surfaces to the user as the opaque
    // "Failed to fetch", indistinguishable from the relayer not running at all.
    res.setHeader("access-control-allow-private-network", "true");

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }
    const url = (req.url ?? "/").split("?")[0];

    if (req.method === "GET" && url === "/health") {
      const body: Record<string, unknown> = {
        ok: true,
        chainId: cfg.chainId,
        factory: cfg.factory,
        // How a third-party relayer node discovers where to get paid. null means
        // "no hub here" — a node must then treat relaying as unpaid volunteering.
        relayHub: cfg.relayHub,
        sponsor: this.deps.sponsor,
        simulateOnly: !this.deps.sponsor,
        rateMax: cfg.rateMax,
        served: this.served,
        board: this.board.stats(),
      };
      res.statusCode = 200;
      res.end(JSON.stringify(body));
      return;
    }

    // --- bulletin board (docs/05-DEPIN.md §5) --------------------------------
    // Nothing here broadcasts anything or spends sponsor funds. Posting is a
    // client saying "I am stranded, someone please pay for this"; listing is a
    // node asking for work it can profit from.

    if (req.method === "GET" && url === "/intents") {
      const query = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
      const asked = Number(query.get("limit"));
      const limit = Number.isFinite(asked) && asked > 0 ? Math.min(50, Math.floor(asked)) : 20;
      const intents = await this.board.list(Date.now(), limit);
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          ok: true,
          chainId: cfg.chainId,
          relayHub: cfg.relayHub,
          intents: intents.map((e) => ({
            id: e.id,
            wallet: e.wallet,
            kind: e.kind,
            request: e.request,
            postedAt: e.postedAt,
            leaseUntil: e.leaseUntil,
            serves: e.serves,
          })),
        }),
      );
      return;
    }

    if (req.method === "POST" && url === "/intents") {
      const parsed = await this.readJson(req, res, cfg.maxBodyBytes);
      if (parsed === undefined) return;
      // Keyed on the caller-supplied wallet, which an attacker can vary at will —
      // that is what RateLimiter's periodic sweep is for. The real bound on
      // flooding is the board's landability rule, not this limiter.
      const wallet = (parsed as { wallet?: unknown }).wallet;
      if (typeof wallet === "string" && !this.boardLimiter.allow(wallet.toLowerCase())) {
        res.statusCode = 429;
        res.end(JSON.stringify({ ok: false, error: "rate limited: too many posts for this wallet" }));
        return;
      }
      const out = await this.board.post(parsed);
      res.statusCode = out.ok ? 200 : 422;
      res.end(JSON.stringify(out));
      return;
    }

    if (req.method === "POST" && url === "/intents/settle") {
      const parsed = await this.readJson(req, res, cfg.maxBodyBytes);
      if (parsed === undefined) return;
      const id = (parsed as { id?: unknown }).id;
      if (typeof id !== "string") {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, error: "id: string expected" }));
        return;
      }
      const out = await this.board.settle(id);
      res.statusCode = out.ok ? 200 : 409;
      res.end(JSON.stringify(out));
      return;
    }

    if ((req.method === "POST") && (url === "/relay" || url === "/")) {
      const parsed = await this.readJson(req, res, cfg.maxBodyBytes);
      if (parsed === undefined) return;
      const out = await this.handle(parsed);
      res.statusCode = out.ok ? 200 : 422;
      res.end(JSON.stringify(out));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, error: `no route: ${req.method} ${url}` }));
  }

  /// Read + parse a JSON body, answering the request itself on failure.
  ///
  /// Returns `undefined` to mean "already responded, stop". That is not
  /// ambiguous with a valid body: `JSON.parse` throws on an empty or malformed
  /// body and returns `null` — never `undefined` — for `"null"`.
  private async readJson(
    req: IncomingMessage,
    res: ServerResponse,
    maxBytes: number,
  ): Promise<unknown> {
    const raw = await readBody(req, maxBytes);
    if (typeof raw !== "string") {
      res.statusCode = 413;
      res.end(JSON.stringify({ ok: false, error: "body too large" }));
      return undefined;
    }
    try {
      return JSON.parse(raw);
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: "invalid JSON" }));
      return undefined;
    }
  }
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(null));
  });
}

// --- entrypoint ----------------------------------------------------------------

function main() {
  // Load quantum-wallet/.env.local (QW_FACTORY, QW_SPONSOR_KEY, …) if present.
  // Real environment variables always win. See relayer/.env.example.
  const here = dirname(fileURLToPath(import.meta.url));
  loadDotEnvFile(join(here, "..", "..", ".env.local"));
  const cfg = loadConfig();
  const server = new RelayServer(makeDeps(cfg));
  const srv = createServer(server.httpHandler());
  srv.listen(cfg.port, () => {
    const who = cfg.sponsorKey ? `sponsor ${server["deps"].sponsor}` : "SIMULATE-ONLY (no QW_SPONSOR_KEY)";
    console.log(`[qwallet-relayer] listening :${cfg.port} chain ${cfg.chainId} factory ${cfg.factory} as ${who}`);
  });
}

if (process.argv[1] && process.argv[1].endsWith("server.ts")) {
  main();
}

export type { RelayConfig };
export { loadConfig };
