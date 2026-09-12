// SPDX-License-Identifier: MIT
// Minimal ABI fragments for QuantumWallet / QuantumWalletFactory / MockERC20-ish
// targets. These match quantum-wallet/contracts/src exactly; the full artifact
// (out/*.json) is authoritative once forge build has run, but these fragments let
// the SDK encode calldata and decode reverts with no compile step.
//
// Written as plain JSON (not parseAbi human-readable strings) on purpose: the
// nested-struct form `tuple(uint256 n, tuple(address,uint256,bytes)[] calls)`
// trips abitype's human-readable parser (abitype@1.2.3 throws InvalidParameterError).
// JSON is parser-independent and encodes byte-for-byte identically.

import { parseAbi } from "viem";

/** struct Sig { uint32 epoch; uint32 leafIndex; bytes32[] wots; bytes32[] path; } */
const SIG_COMPONENTS = [
  { name: "epoch", type: "uint32" },
  { name: "leafIndex", type: "uint32" },
  { name: "wots", type: "bytes32[]" },
  { name: "path", type: "bytes32[]" },
] as const;

/** struct Call { address to; uint256 value; bytes data; } */
const CALL_COMPONENTS = [
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "data", type: "bytes" },
] as const;

export const quantumWalletAbi = [
  {
    type: "function",
    name: "executeSigned",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "op",
        type: "tuple",
        components: [
          { name: "walletNonce", type: "uint256" },
          { name: "validUntil", type: "uint256" },
          { name: "calls", type: "tuple[]", components: CALL_COMPONENTS },
        ],
      },
      { name: "sig", type: "tuple", components: SIG_COMPONENTS },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "rotateRoot",
    stateMutability: "nonpayable",
    inputs: [
      { name: "newRoot", type: "bytes32" },
      { name: "nextEpoch", type: "uint32" },
      { name: "sig", type: "tuple", components: SIG_COMPONENTS },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "signMessage",
    stateMutability: "nonpayable",
    inputs: [
      { name: "messageHash", type: "bytes32" },
      { name: "sig", type: "tuple", components: SIG_COMPONENTS },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "nonce",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "epoch",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint32" }],
  },
  {
    type: "function",
    name: "merkleRoot",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "leafIndex",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint32" }],
  },
  {
    type: "function",
    name: "factory",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "domainSeparator",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "isValidSignature",
    stateMutability: "view",
    inputs: [
      { name: "hash", type: "bytes32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ name: "", type: "bytes4" }],
  },
  { type: "receive", stateMutability: "payable" },

  { type: "error", name: "Unauthorized", inputs: [] },
  {
    type: "error",
    name: "BadNonce",
    inputs: [
      { name: "got", type: "uint256" },
      { name: "want", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "Expired",
    inputs: [
      { name: "deadline", type: "uint256" },
      { name: "current", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "BadEpoch",
    inputs: [
      { name: "got", type: "uint32" },
      { name: "want", type: "uint32" },
    ],
  },
  {
    type: "error",
    name: "BadLeafIndex",
    inputs: [
      { name: "got", type: "uint32" },
      { name: "want", type: "uint32" },
    ],
  },
  { type: "error", name: "UnknownRoot", inputs: [] },
  { type: "error", name: "TreeExhausted", inputs: [] },
  {
    type: "error",
    name: "InvalidRotateEpoch",
    inputs: [
      { name: "nextEpoch", type: "uint32" },
      { name: "currentEpoch", type: "uint32" },
    ],
  },
  {
    type: "error",
    name: "CallFailed",
    inputs: [
      { name: "index", type: "uint256" },
      { name: "reason", type: "bytes" },
    ],
  },
  {
    type: "error",
    name: "WrongSignatureLength",
    inputs: [
      { name: "got", type: "uint256" },
      { name: "want", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "WrongPathLength",
    inputs: [
      { name: "got", type: "uint256" },
      { name: "want", type: "uint256" },
    ],
  },
] as const;

export const quantumWalletFactoryAbi = parseAbi([
  "function deployWallet(bytes32 root0) returns (address wallet)",
  "function predictWallet(bytes32 root0) view returns (address)",
  "function initCodeHash(bytes32 root0) view returns (bytes32)",
  "function saltFor(bytes32 root0) view returns (bytes32)",
  "function isWallet(address candidate) view returns (bool)",
]);

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

/// QuantumRelayHub — the permissionless, refunded submission path.
///
/// A relayer node needs `quote` before it spends anything: every revert below is
/// a transaction the node would have paid for and not been reimbursed for, so
/// they are all worth catching off-chain first. The errors are declared here so
/// `decodeRevert` can name them instead of surfacing raw selector bytes.
export const quantumRelayHubAbi = parseAbi([
  "function relay(address wallet, bytes data)",
  "function relayDeploy(bytes32 root0) returns (address wallet)",
  "function quote(address wallet) view returns (bool relayable, uint32 opsLeft, uint256 budgetLeft, uint256 balance)",
  "function sponsored(address wallet) view returns (bool)",
  "function tipWei() view returns (uint256)",
  "function maxRefundWei() view returns (uint256)",
  "function maxOpGas() view returns (uint256)",
  "function paused() view returns (bool)",
  "function factory() view returns (address)",
  "function owner() view returns (address)",
  "event Relayed(address indexed wallet, address indexed relayer, uint256 refund)",
  "event Sponsored(address indexed wallet, address indexed relayer)",
  "error NotOwner()",
  "error IsPaused()",
  "error NotSponsored(address wallet)",
  "error QuotaExhausted(address wallet)",
  "error DailyCapReached()",
  "error VaultEmpty(uint256 want, uint256 have)",
  "error OpFailed(bytes reason)",
  "error RefundFailed()",
  "error BadParam()",
  "error ReentrantCall()",
]);
