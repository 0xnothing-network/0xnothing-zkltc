// SPDX-License-Identifier: MIT
// Signed-intent digest construction. Mirrors QuantumWallet.sol exactly:
//   domainSeparator = keccak( "0xQ-zkLTC-wallet-v1" || chainId(u256) || address )
//   digest          = keccak( "\x19\x01" || domainSeparator || keccak(tag-specific inner) )
// where the inner payload is:
//   WalletOp    => keccak( "WalletOp"    || 0x00 || walletNonce(u256) || validUntil(u256) || callsHash )
//   RotateRoot  => keccak( "RotateRoot"  || 0x00 || newRoot || nextEpoch(u32) )
//   SignMessage => keccak( "SignMessage" || 0x00 || messageHash )
// callsHash is keccak of the concatenation of per-call
// keccak( 0xCC || to || value(u256) || dataLen(u256) || data ).

import {
  CALL_TAG,
  DOMAIN_PREFIX,
  MESSAGE_TAG,
  M_SIGNATURE,
  OP_TAG,
  ROTATE_TAG,
} from "./constants.ts";
import { addrBytes, cat, hexBytes, keccak, u256, u8, utf8 } from "./crypto.ts";
import type { Bytes, Hex } from "./crypto.ts";
import type { QWalletOp } from "./encode.ts";

export interface QDomain {
  chainId: bigint;
  wallet: Hex;
}

export function domainSeparator(d: QDomain): Bytes {
  return keccak(utf8(DOMAIN_PREFIX), u256(d.chainId), addrBytes(d.wallet));
}

export function callHash(c: QWalletOp["calls"][number]): Bytes {
  const data = hexBytes(c.data);
  return keccak(u8(CALL_TAG), addrBytes(c.to), u256(c.value), u256(BigInt(data.length)), data);
}

export function callsHash(calls: ReadonlyArray<QWalletOp["calls"][number]>): Bytes {
  const parts: Bytes[] = [];
  for (const c of calls) parts.push(callHash(c));
  return keccak(cat(...parts));
}

/** Wrap an inner digest with the EIP-191-style prefix + domain. */
function digest(domain: Bytes, inner: Bytes): Bytes {
  return keccak(u8(0x19), u8(0x01), domain, inner);
}

export function opDigest(op: QWalletOp, d: QDomain): Bytes {
  const domain = domainSeparator(d);
  const inner = keccak(
    utf8(OP_TAG),
    u8(M_SIGNATURE),
    u256(op.walletNonce),
    u256(op.validUntil),
    callsHash(op.calls),
  );
  return digest(domain, inner);
}

export function rotateDigest(newRoot: Bytes, nextEpoch: number, d: QDomain): Bytes {
  if (newRoot.length !== 32) throw new Error("newRoot must be 32 bytes");
  const epoch = new Uint8Array(4);
  epoch[0] = (nextEpoch >>> 24) & 0xff;
  epoch[1] = (nextEpoch >>> 16) & 0xff;
  epoch[2] = (nextEpoch >>> 8) & 0xff;
  epoch[3] = nextEpoch & 0xff;
  const inner = keccak(utf8(ROTATE_TAG), u8(M_SIGNATURE), newRoot, epoch);
  return digest(domainSeparator(d), inner);
}

export function messageDigest(messageHash: Bytes, d: QDomain): Bytes {
  if (messageHash.length !== 32) throw new Error("messageHash must be 32 bytes");
  const inner = keccak(utf8(MESSAGE_TAG), u8(M_SIGNATURE), messageHash);
  return digest(domainSeparator(d), inner);
}

/** bytes32 as 0x-hex (for signatures/roots). */
export function bytesToHex32(b: Bytes): Hex {
  if (b.length !== 32) throw new Error("expected 32 bytes");
  return `0x${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}` as Hex;
}
