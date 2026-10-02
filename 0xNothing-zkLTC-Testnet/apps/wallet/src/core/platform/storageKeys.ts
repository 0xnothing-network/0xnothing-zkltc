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
} as const;

export type StorageKey = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS];
