// SPDX-License-Identifier: MIT
// Public API of the post-quantum wallet SDK.
//
// The extension consumes these sources directly under `verbatimModuleSyntax`,
// so every type-only name must leave through `export type` — a plain `export {}`
// of an interface survives into emitted JS as a binding that does not exist.
// Values and types are therefore listed in separate statements per module.

export * from "./constants.ts";
export * from "./crypto.ts";

export {
  chainStep,
  chain,
  publicElement,
  signElement,
  messageDigits,
  checksumDigits,
  digitsOf,
  leafFromSignature,
  leafSecret,
  publicLeaf,
} from "./wots.ts";

export { buildLevels, authPath, computeRoot } from "./merkle.ts";
export type { MerkleLevels } from "./merkle.ts";

export { QuantumSigner } from "./signer.ts";
export type { WotsSignature } from "./signer.ts";

export {
  domainSeparator,
  callHash,
  callsHash,
  opDigest,
  rotateDigest,
  messageDigest,
  bytesToHex32,
} from "./digest.ts";
export type { QDomain } from "./digest.ts";

export {
  alphabet,
  encodeSecret,
  decodeSecret,
  generateSecret,
  randomEntropy,
  ENTROPY_BYTES,
  SYMBOL_BITS,
  SYMBOL_COUNT,
  ALPHABET_SIZE,
} from "./icons.ts";
export type { DecodeResult } from "./icons.ts";

export { treeSeedFromSecret, wrapVault, unwrapVault } from "./derive.ts";

export {
  encodeSigAndOpArgs,
  toWireOp,
  fromWireOp,
  toWireSig,
  fromWireSig,
} from "./encode.ts";
export type {
  QCall,
  QSig,
  QWalletOp,
  WireOp,
  WireSig,
  WalletSnapshot,
} from "./encode.ts";

export { QuantumAccount } from "./wallet.ts";

export { quantumWalletAbi, quantumWalletFactoryAbi, erc20Abi } from "./abi.ts";

export {
  readWalletState,
  predictWallet,
  simulateExecuteSigned,
  decodeRevert,
} from "./reads.ts";
export type { WalletState, SimulationResult } from "./reads.ts";

export {
  SponsorRelay,
  executeSignedCalldata,
  rotateCalldata,
  signMessageCalldata,
  manualBroadcast,
} from "./relay.ts";
export type { RelayRequest, RelayResponse, ExecuteCalldata } from "./relay.ts";
