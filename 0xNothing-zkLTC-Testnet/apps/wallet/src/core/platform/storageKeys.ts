/**
 * Storage keys shared by the UI and the service worker. Centralised so a rename
 * can never leave the two halves of the extension reading different slots.
 */
export const STORAGE_KEYS = {
  /** Encrypted keyring (AES-GCM over the mnemonic). Persistent. */
  vault: "wallet.vault.v1",
  /** Public account metadata: derived addresses, labels, active index. */
  accounts: "wallet.accounts.v1",
  /** User preferences (auto-lock minutes, slippage, …). */
  settings: "wallet.settings.v1",
  /** Imported ERC-20s. */
  tokens: "wallet.tokens.v1",
  /** Locally recorded transactions (the chain has no per-account index). */
  history: "wallet.history.v1",
  /** Timestamped portfolio-value samples that back the 24h figure. */
  snapshots: "wallet.snapshots.v1",
  /** origin -> granted addresses. */
  connections: "wallet.connections.v1",
  /** Queue of dapp requests awaiting approval. */
  pending: "wallet.pending.v1",
  /** Results the approval window writes back for the service worker. */
  resolved: "wallet.resolved.v1",
  /** Unlocked session key. Session area only — never persisted. */
  session: "wallet.session.v1",
  /** Auto-lock deadline, split from the key so an old touch cannot restore it. */
  sessionDeadline: "wallet.session.deadline.v1",
  /** Failed password attempts and when the next is allowed. Persistent, never key material. */
  unlockGuard: "wallet.unlockGuard.v1",
  /** Two-stage swaps whose first leg was signed and whose second may still be owed. */
  pendingStagedSwap: "wallet.pendingStagedSwap.v1",
  /** account -> chain -> addresses this wallet has sent to. Public, never key material. */
  recipients: "wallet.recipients.v1",
  /** The half-typed Send form (token, amount, recipient) for ten minutes. Never secret. */
  sendDraft: "wallet.sendDraft.v1",
  /** account -> chain id -> token approvals this wallet signed (token, spender, hash). Public. */
  approvals: "wallet.approvals.v1",
  /** Ids of the OS notifications already shown, so none is shown twice. */
  notified: "wallet.notified.v1",
  /** History label templates in the language on screen, for the worker's notifications. */
  notifyText: "wallet.notifyText.v1",
  /** The Home tab last picked (token, nft or rwa). Public. */
  homeTab: "wallet.homeTab.v1",
  /** The swap pair last used, with the network it belongs to. Public token ids. */
  swapPair: "wallet.swapPair.v1",
  /** The last wallet version whose "What is new" card was seen. */
  seenVersion: "wallet.seenVersion.v1",
} as const;

/** Alarm the UI sets at the auto-lock deadline so the worker can drop the session key. */
export const AUTOLOCK_ALARM = "wallet.autolock";
