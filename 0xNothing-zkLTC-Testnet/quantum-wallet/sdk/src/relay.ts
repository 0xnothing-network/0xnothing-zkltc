// SPDX-License-Identifier: MIT
// Client side of the sponsored-relay protocol + a manual-broadcast fallback.
// The sponsor NEVER sees the secret: it receives the already-signed intent (the
// WOTS sig is useless without possession of future leaves; the op digest is bound
// to this wallet+chain+nonce) and only pays gas. If the sponsor is down or
// malicious the same payload can be broadcast manually via any funded EOA.

import { encodeFunctionData, type Hex, type PublicClient, type WalletClient } from "viem";
import { quantumWalletAbi } from "./abi.ts";
import { decodeRevert } from "./reads.ts";
import { fromWireOp, fromWireSig, toWireOp, toWireSig } from "./encode.ts";
import type { QSig, QWalletOp, WireOp, WireSig } from "./encode.ts";

export type RelayRequest =
  | { kind: "deploy"; wallet: Hex; root0: Hex; chainId: number }
  | { kind: "execute"; wallet: Hex; chainId: number; op: WireOp; sig: WireSig }
  | { kind: "rotate"; wallet: Hex; chainId: number; newRoot: Hex; nextEpoch: number; sig: WireSig }
  | { kind: "signMessage"; wallet: Hex; chainId: number; messageHash: Hex; sig: WireSig };

export interface RelayResponse {
  ok: boolean;
  /** Sponsor tx hash when broadcast. */
  txHash?: Hex;
  /** Human-readable error when not ok. */
  error?: string;
}

export class SponsorRelay {
  readonly url: string;
  private readonly fetchFn: typeof fetch;

  constructor(url: string, fetchFn: typeof fetch = fetch) {
    this.url = url;
    this.fetchFn = fetchFn;
  }

  /** POST a signed request; decodes sponsor errors into revert messages. */
  async send(req: RelayRequest): Promise<RelayResponse> {
    let res: Response;
    try {
      res = await this.fetchFn(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req),
      });
    } catch (e) {
      return { ok: false, error: `relay unreachable: ${(e as Error).message}` };
    }
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, error: text || `relay error ${res.status}` };
    }
    try {
      const j = JSON.parse(text) as RelayResponse;
      return j;
    } catch {
      return { ok: true, txHash: (text as Hex) || undefined };
    }
  }
}

export interface ExecuteCalldata {
  to: Hex;
  data: Hex;
}

/** Calldata for executeSigned — used by both relay fallback and the relayer. */
export function executeSignedCalldata(wallet: Hex, op: QWalletOp, sig: QSig): ExecuteCalldata {
  return {
    to: wallet,
    data: encodeFunctionData({
      abi: quantumWalletAbi,
      functionName: "executeSigned",
      args: [op, sig],
    }),
  };
}

export function rotateCalldata(wallet: Hex, newRoot: Hex, nextEpoch: number, sig: QSig) {
  return {
    to: wallet,
    data: encodeFunctionData({
      abi: quantumWalletAbi,
      functionName: "rotateRoot",
      args: [newRoot, nextEpoch, sig],
    }),
  };
}

export function signMessageCalldata(wallet: Hex, messageHash: Hex, sig: QSig) {
  return {
    to: wallet,
    data: encodeFunctionData({
      abi: quantumWalletAbi,
      functionName: "signMessage",
      args: [messageHash, sig],
    }),
  };
}

/** Manual fallback: broadcast executeSigned from an EOA that pays its own gas.
 * Pre-flight simulates first so failures return clean messages instead of wasting
 * the user's gas. */
export async function manualBroadcast(
  publicClient: PublicClient,
  walletClient: WalletClient,
  calldata: ExecuteCalldata,
): Promise<{ ok: boolean; txHash?: Hex; error?: string }> {
  try {
    const gas = await publicClient.estimateGas({
      account: walletClient.account!.address as Hex,
      to: calldata.to,
      data: calldata.data,
    });
    const txHash = await walletClient.sendTransaction({
      // The Account OBJECT, not its address: viem turns a bare address into a
      // json-rpc account and would call eth_sendTransaction, which fails for a
      // local-key EOA on a plain HTTP transport. Passing the object lets viem
      // sign locally when it is a local account and still routes a browser
      // wallet's json-rpc account exactly as before.
      account: walletClient.account!,
      to: calldata.to,
      data: calldata.data,
      gas,
      // Generic WalletClient: viem needs `chain` stated. null = use whatever the
      // client is already connected to, no extra chain-id assertion.
      chain: walletClient.chain ?? null,
    });
    return { ok: true, txHash };
  } catch (e) {
    return { ok: false, error: decodeRevert(e) };
  }
}
