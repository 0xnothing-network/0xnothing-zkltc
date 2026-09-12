// SPDX-License-Identifier: MIT
// End-to-end: forge-deployed contracts on a LOCAL ANVIL + relayer in-process.
//
//  1. boots anvil on :8545 (or QW_ANVIL_URL), funds the sponsor EOA (anvil #0)
//  2. deploys QuantumWalletFactory from foundry artifacts
//  3. deploy -> execute (native) -> stale-nonce refusal -> signMessage/EIP-1271
//     -> rotate (SAME address, new tree) -> old-epoch refusal — every step
//     through RelayServer.handle(), the same path an HTTP POST takes
//  4. asserts balances move and the sponsor (not the user) paid the gas
//
// Skips (exit 0) when anvil is unavailable. Needs a forge build first:
//   cd quantum-wallet/contracts && forge build

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { RelayServer, makeDeps, type RelayDeps } from "../src/server.ts";
import type { RelayConfig } from "../src/config.ts";
import { QuantumAccount } from "../../sdk/src/wallet.ts";
import { generateSecret, decodeSecret } from "../../sdk/src/icons.ts";
import { rotateDigest, messageDigest } from "../../sdk/src/digest.ts";
import { readWalletState } from "../../sdk/src/reads.ts";
import { quantumWalletFactoryAbi, quantumWalletAbi } from "../../sdk/src/abi.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTIFACT = join(HERE, "..", "..", "contracts", "out", "QuantumWalletFactory.sol", "QuantumWalletFactory.json");
const ANVIL_PORT = Number(process.env.QW_ANVIL_PORT ?? 8545);
const RPC = process.env.QW_ANVIL_URL ?? `http://127.0.0.1:${ANVIL_PORT}`;
const CHAIN_ID = 31337;

const SPONSOR_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // anvil #0
const SPONSOR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

const chain = {
  id: CHAIN_ID,
  name: "anvil",
  nativeCurrency: { name: "zkLTC", symbol: "zkLTC", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
};

function bx(b: Uint8Array): Hex {
  return `0x${Buffer.from(b).toString("hex")}` as Hex;
}

async function findAnvil(): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn("anvil", ["--version"], { stdio: "ignore" });
    p.on("error", () => resolve(false));
    p.on("exit", (c) => resolve(c === 0));
  });
}

function bootAnvil(): Promise<ChildProcess> {
  const p = spawn("anvil", ["--port", String(ANVIL_PORT), "--silent", "--block-time", "1"], { stdio: "ignore" });
  return new Promise((resolve, reject) => {
    p.on("error", reject);
    p.on("exit", (c) => reject(new Error(`anvil exited early (${c})`)));
    setTimeout(() => resolve(p), 1500);
  });
}

async function waitRpc(url: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(url, {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (r.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("anvil RPC never came up");
}

/** A friend that owns no anvil pre-funding. */
function friendAddress(): Hex {
  return bx(crypto.getRandomValues(new Uint8Array(20)));
}

async function main() {
  if (!existsSync(ARTIFACT)) {
    console.log("SKIP e2e: forge artifacts missing — run `cd contracts && forge build` first");
    return;
  }
  const haveAnvil = await findAnvil().catch(() => false);
  if (!haveAnvil) {
    console.log("SKIP e2e: `anvil` not on PATH (install foundry)");
    return;
  }

  const cfg: RelayConfig = {
    port: 0,
    rpcUrl: RPC,
    chainId: CHAIN_ID,
    factory: "0x" + "00".repeat(20) as Hex, // set after deploy below
    sponsorKey: SPONSOR_PK as Hex,
    rateMax: 1000,
    rateWindowMs: 60_000,
    maxBodyBytes: 262_144,
    maxCallsPerOp: 16,
    maxCalldataBytesPerOp: 100_000,
    validUntilMaxSkewSec: 3_600,
  };

  const anvil = await bootAnvil();
  try {
    await waitRpc(RPC);
    const publicClient = createPublicClient({ chain, transport: http(RPC) });
    const sponsor = privateKeyToAccount(SPONSOR_PK);
    const walletClient = createWalletClient({ account: sponsor, chain, transport: http(RPC) });

    // 1. Deploy the factory from the foundry artifact. Foundry already prefixes
    //    `bytecode.object` with 0x, so prepending unconditionally yields
    //    "0x0x6080…" and viem rejects it as invalid hex.
    const artifact = JSON.parse(readFileSync(ARTIFACT, "utf8")) as {
      bytecode: { object: string };
      abi: unknown[];
    };
    const rawBytecode = artifact.bytecode.object;
    const factoryHash = await walletClient.deployContract({
      abi: artifact.abi as never,
      bytecode: (rawBytecode.startsWith("0x") ? rawBytecode : `0x${rawBytecode}`) as Hex,
    });
    const factoryReceipt = await publicClient.waitForTransactionReceipt({ hash: factoryHash });
    cfg.factory = factoryReceipt.contractAddress!;
    console.log(`factory @ ${cfg.factory}`);

    const deps: RelayDeps = makeDeps(cfg);
    const relayer = new RelayServer(deps);
    const sponsorBalanceBefore = await publicClient.getBalance({ address: SPONSOR as Hex });

    // 2. Real UX path: secret is 24 random icons; decode back to entropy.
    const { entropy, icons } = await generateSecret();
    const decoded = await decodeSecret(icons);
    assert.equal(decoded.valid, true);
    assert.deepEqual(Buffer.from(decoded.entropy!), Buffer.from(entropy));
    const account = QuantumAccount.fromSecret(entropy);

    // Deploy: server rejects a wallet claim that mismatches the CREATE2 prediction.
    const wrongClaim = (await relayer.handle({
      kind: "deploy",
      wallet: "0x" + "00".repeat(20) as Hex,
      chainId: CHAIN_ID,
      root0: account.root0Hex,
    })) as { ok: boolean; error?: string };
    assert.equal(wrongClaim.ok, false);
    assert.match(wrongClaim.error!, /predicts 0x/);

    const predicted = (await publicClient.readContract({
      address: cfg.factory,
      abi: quantumWalletFactoryAbi,
      functionName: "predictWallet",
      args: [account.root0Hex],
    })) as Hex;
    console.log(`wallet @ ${predicted}`);

    const dep = (await relayer.handle({
      kind: "deploy",
      wallet: predicted,
      chainId: CHAIN_ID,
      root0: account.root0Hex,
    })) as { ok: boolean; txHash?: Hex; error?: string };
    assert.equal(dep.ok, true, dep.error);
    const afterDeploy = await readWalletState(publicClient, predicted);
    assert.equal(afterDeploy.deployed, true);
    assert.equal(afterDeploy.epoch, 0);
    assert.equal(afterDeploy.merkleRoot.toLowerCase(), account.root0Hex.toLowerCase());

    // Wallet is deployed -> a second deploy is refused.
    const dep2 = (await relayer.handle({
      kind: "deploy",
      wallet: predicted,
      chainId: CHAIN_ID,
      root0: account.root0Hex,
    })) as { ok: boolean; error?: string };
    assert.equal(dep2.ok, false);
    assert.match(dep2.error!, /already deployed/);

    // Fund the wallet contract (the user keeps zkLTC inside the wallet).
    const fund = await walletClient.sendTransaction({ to: predicted, value: 10n * 10n ** 18n });
    await publicClient.waitForTransactionReceipt({ hash: fund });

    // 3. Execute: send 1 zkLTC to a friend (leaf 0 consumed).
    const friend = friendAddress();
    const { op, sig } = account.buildExecuteOp(BigInt(CHAIN_ID), predicted, afterDeploy.nonce, [
      { to: friend, value: 1n * 10n ** 18n, data: "0x" },
    ]);
    const toWire = (o: typeof op) => ({
      walletNonce: o.walletNonce.toString(),
      validUntil: o.validUntil.toString(),
      calls: o.calls.map((c) => ({ to: c.to, value: c.value.toString(), data: c.data })),
    });
    const ex = (await relayer.handle({
      kind: "execute",
      wallet: predicted,
      chainId: CHAIN_ID,
      op: toWire(op),
      sig,
    })) as { ok: boolean; txHash?: Hex; error?: string };
    assert.equal(ex.ok, true, ex.error);
    const afterExec = await readWalletState(publicClient, predicted);
    assert.equal(afterExec.nonce, 1n);
    assert.equal(afterExec.leafIndex, 1);
    assert.equal(await publicClient.getBalance({ address: friend }), 1n * 10n ** 18n);

    // Stale nonce is refused before any sponsor gas is spent.
    const stale = (await relayer.handle({
      kind: "execute",
      wallet: predicted,
      chainId: CHAIN_ID,
      op: { ...toWire(op), walletNonce: "0" },
      sig,
    })) as { ok: boolean; error?: string };
    assert.equal(stale.ok, false);
    assert.match(stale.error!, /nonce mismatch/);

    // 4. signMessage + EIP-1271 (leaf 1 consumed).
    const msgBytes = crypto.getRandomValues(new Uint8Array(32));
    const msgHash = bx(msgBytes);
    // The wallet verifies the DOMAIN-BOUND digest (keccak("\x19\x01"||domain||
    // keccak("SignMessage"||0x00||messageHash))), not the bare message hash —
    // signing msgBytes directly would open the wrong leaf and be rejected.
    const smSig = account.signer.signNext(
      messageDigest(msgBytes, { chainId: BigInt(CHAIN_ID), wallet: predicted }),
    );
    const sm = (await relayer.handle({
      kind: "signMessage",
      wallet: predicted,
      chainId: CHAIN_ID,
      messageHash: msgHash,
      sig: { epoch: 0, leafIndex: smSig.leafIndex, wots: smSig.wots.map(bx), path: smSig.path.map(bx) },
    })) as { ok: boolean; txHash?: Hex; error?: string };
    assert.equal(sm.ok, true, sm.error);
    const magic = (await publicClient.readContract({
      address: predicted,
      abi: quantumWalletAbi,
      functionName: "isValidSignature",
      args: [msgHash, "0x"],
    })) as string;
    assert.equal(magic.toLowerCase(), "0x1626ba7e");

    // 5. Rotate: user picks a NEW icon secret -> new tree -> SAME wallet address (leaf 2).
    // The successor account signs for epoch 1 (QuantumAccount stamps sig.epoch).
    const account2 = QuantumAccount.fromSecret((await generateSecret()).entropy, 1);
    const rotDigest = rotateDigest(account2.signer.root, 1, { chainId: BigInt(CHAIN_ID), wallet: predicted });
    const rotSig = account.signer.signNext(rotDigest); // old epoch-0 tree, next free leaf
    const rot = (await relayer.handle({
      kind: "rotate",
      wallet: predicted,
      chainId: CHAIN_ID,
      newRoot: account2.root0Hex,
      nextEpoch: 1,
      sig: { epoch: 0, leafIndex: rotSig.leafIndex, wots: rotSig.wots.map(bx), path: rotSig.path.map(bx) },
    })) as { ok: boolean; txHash?: Hex; error?: string };
    assert.equal(rot.ok, true, rot.error);
    const afterRot = await readWalletState(publicClient, predicted);
    assert.equal(afterRot.epoch, 1);
    assert.equal(afterRot.leafIndex, 0); // fresh tree, fresh leaf counter
    assert.equal(afterRot.merkleRoot.toLowerCase(), account2.root0Hex.toLowerCase());

    // 6. The old (epoch-0) tree is dead: a fresh leaf-3 signature is refused on-chain.
    const oldOp = account.buildExecuteOp(BigInt(CHAIN_ID), predicted, afterRot.nonce, [
      { to: friendAddress(), value: 1n, data: "0x" },
    ]);
    const refused = (await relayer.handle({
      kind: "execute",
      wallet: predicted,
      chainId: CHAIN_ID,
      op: toWire(oldOp.op),
      sig: oldOp.sig, // epoch 0
    })) as { ok: boolean; error?: string };
    assert.equal(refused.ok, false);
    assert.match(refused.error!, /simulation failed/);

    // 7. The new epoch-0 equivalent signs fine (leaf 0 of the new tree).
    const { op: op2, sig: sig2 } = account2.buildExecuteOp(BigInt(CHAIN_ID), predicted, afterRot.nonce, [
      { to: friendAddress(), value: 2n, data: "0x" },
    ]);
    const ok2 = (await relayer.handle({
      kind: "execute",
      wallet: predicted,
      chainId: CHAIN_ID,
      op: toWire(op2),
      sig: sig2,
    })) as { ok: boolean; txHash?: Hex; error?: string };
    assert.equal(ok2.ok, true, ok2.error);

    // 8. Sponsor paid the gas; wallet still holds most of its zkLTC.
    const sponsorBalanceAfter = await publicClient.getBalance({ address: SPONSOR as Hex });
    assert.ok(sponsorBalanceAfter < sponsorBalanceBefore, "sponsor should have paid gas");
    const walletHeld = await publicClient.getBalance({ address: predicted });
    assert.ok(walletHeld > 8n * 10n ** 18n, `wallet should keep ~9 zkLTC, holds ${walletHeld}`);

    console.log("E2E OK: deploy -> execute -> stale-nonce refusal -> EIP-1271 -> rotate -> old-epoch death");
  } finally {
    anvil.kill();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
