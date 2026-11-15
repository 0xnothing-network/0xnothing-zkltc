import type { Hex } from "viem";
import { erc165Abi } from "../../abis";
import type { WalletNetwork } from "../../config/networks";
import { APPROVE_SELECTOR, ERC721_INTERFACE_ID, parseApproveCallLenient } from "../lib/approveAmount";
import { withNamedLock } from "../platform/locks";
import { persistentStore } from "../platform/storage";
import { STORAGE_KEYS } from "../platform/storageKeys";
import { publicClientFor, type SignedCall } from "../rpc/client";

/**
 * Token approvals this wallet signed, for the Token approvals list in Settings.
 * A record is made from the transaction as it was signed (target, calldata and
 * chain id from the signer), never from a request, the queue, a permit or the
 * logs: the wallet lists what it really signed and does not scan the chain.
 * Approvals signed before 1.0.10 are not known.
 *
 * Stored shape (`wallet.approvals.v1`):
 *   { [accountLower]: { [chainId]: Array<{ token, spender: lowercase, hash, at: ms }> } }
 * Newest first, one row per token and spender. Public data only; everything read
 * back is validated and a bad row is dropped.
 */
export const MAX_APPROVALS = 64;
const MAX_ACCOUNTS = 16;
const MAX_CHAINS = 16;
const LOCK = "approvals";

export interface ApprovalRecord {
  /** Lowercase 0x + 40 hex. */
  token: string;
  /** Lowercase 0x + 40 hex. */
  spender: string;
  /** The approve transaction's hash. */
  hash: string;
  at: number;
}

type Book = Record<string, Record<string, ApprovalRecord[]>>;

const HEX_ADDRESS = /^0x[0-9a-f]{40}$/u;
const HEX_HASH = /^0x[0-9a-f]{64}$/u;
const CHAIN_KEY = /^[1-9]\d{0,15}$/u;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseList(value: unknown): ApprovalRecord[] {
  if (!Array.isArray(value)) return [];
  const rows: ApprovalRecord[] = [];
  for (const item of value) {
    const row = record(item);
    if (row === null) continue;
    const { token, spender, hash, at } = row;
    if (typeof token !== "string" || !HEX_ADDRESS.test(token)) continue;
    if (typeof spender !== "string" || !HEX_ADDRESS.test(spender)) continue;
    if (typeof hash !== "string" || !HEX_HASH.test(hash)) continue;
    if (typeof at !== "number" || !Number.isSafeInteger(at) || at <= 0) continue;
    rows.push({ token, spender, hash, at });
  }
  // Stable sort, so of two rows for one token and spender the newer one stays.
  rows.sort((a, b) => b.at - a.at);
  const seen = new Set<string>();
  return rows
    .filter((row) => !seen.has(`${row.token}:${row.spender}`) && seen.add(`${row.token}:${row.spender}`))
    .slice(0, MAX_APPROVALS);
}

/** A stored book as the wallet may use it. Never throws; anything else reads as {}. */
export function parseApprovals(value: unknown): Book {
  const outer = record(value);
  if (outer === null) return {};
  // fromEntries defines own properties, so a "__proto__" key cannot reach a prototype.
  return Object.fromEntries(
    Object.entries(outer)
      .filter(([account]) => HEX_ADDRESS.test(account))
      .slice(0, MAX_ACCOUNTS)
      .map(([account, chains]) => [
        account,
        Object.fromEntries(
          Object.entries(record(chains) ?? {})
            .filter(([chain]) => CHAIN_KEY.test(chain))
            .map(([chain, list]) => [chain, parseList(list)] as const)
            // Chain ids are integer-like keys, which always enumerate in ascending
            // order whatever order they were written in: the chains kept are the
            // ones with the newest record, not the smallest ids.
            .sort(([, a], [, b]) => (b[0]?.at ?? 0) - (a[0]?.at ?? 0))
            .slice(0, MAX_CHAINS),
        ),
      ]),
  );
}

async function readBook(): Promise<Book> {
  return parseApprovals(await persistentStore.get<unknown>(STORAGE_KEYS.approvals).catch(() => null));
}

/**
 * Writes one account's list on one chain. The account written last goes first,
 * and the chain holds the newest record, so the read caps drop the ones least
 * recently used, never this one.
 */
async function writeList(owner: string, chain: string, edit: (list: ApprovalRecord[]) => ApprovalRecord[]): Promise<void> {
  await withNamedLock(LOCK, async () => {
    const book = await readBook();
    const chains = book[owner] ?? {};
    const list = edit(chains[chain] ?? []).slice(0, MAX_APPROVALS);
    const restChains = Object.entries(chains).filter(([key]) => key !== chain);
    const restAccounts = Object.entries(book).filter(([key]) => key !== owner);
    await persistentStore.set(STORAGE_KEYS.approvals, Object.fromEntries([
      [owner, Object.fromEntries([[chain, list], ...restChains])],
      ...restAccounts,
    ]));
  });
}

async function isNft(network: WalletNetwork, token: string): Promise<boolean> {
  return publicClientFor(network)
    .readContract({
      address: token as `0x${string}`,
      abi: erc165Abi,
      functionName: "supportsInterface",
      args: [ERC721_INTERFACE_ID],
    })
    .then((answer) => answer === true, () => false);
}

/**
 * Called by tx.ts with each signed transaction. Records it when its calldata is an
 * ERC-20 approve or increaseAllowance and its signed chain id is the network's.
 * Lenient on trailing bytes, because a token's decoder ignores them and the call
 * is then an approval on chain all the same.
 */
export async function noteSignedApproval(
  account: string,
  network: WalletNetwork,
  hash: Hex,
  signed?: SignedCall,
): Promise<void> {
  const call = parseApproveCallLenient(signed?.data);
  if (call === null || signed === undefined) return;
  const owner = account.toLowerCase();
  const token = typeof signed.to === "string" ? signed.to.toLowerCase() : "";
  const chainId = signed.chainId;
  if (!HEX_ADDRESS.test(owner) || !HEX_ADDRESS.test(token)) return;
  if (typeof chainId !== "number" || !Number.isSafeInteger(chainId) || chainId !== network.chainId) return;
  const chain = String(chainId);
  if (!CHAIN_KEY.test(chain) || typeof hash !== "string" || !HEX_HASH.test(hash.toLowerCase())) return;
  // ERC-721 approve(to, tokenId) has the same selector. It is not a token
  // allowance, and approve(spender, 0) on it would approve token id 0 instead of
  // revoking, so an NFT is never listed. A target that does not answer is
  // recorded; the list offers Revoke only where an ERC-20 allowance reads.
  if (signed.data?.slice(0, 10).toLowerCase() === APPROVE_SELECTOR && await isNft(network, token)) return;
  const row: ApprovalRecord = {
    token,
    spender: call.spender.toLowerCase(),
    hash: hash.toLowerCase(),
    at: Date.now(),
  };
  await writeList(owner, chain, (list) => [
    row,
    ...list.filter((entry) => entry.token !== row.token || entry.spender !== row.spender),
  ]);
}

/** Every chain's approvals of `account`, newest first per chain. */
export async function listApprovalBook(account: string): Promise<Record<string, ApprovalRecord[]>> {
  return (await readBook())[account.toLowerCase()] ?? {};
}

/** The approvals of `account` on `chainId`, newest first. */
export async function listApprovals(account: string, chainId: number): Promise<ApprovalRecord[]> {
  return (await listApprovalBook(account))[String(chainId)] ?? [];
}

/** Drops one row from the list. The approval on chain is not touched. */
export async function forgetApproval(account: string, chainId: number, token: string, spender: string): Promise<void> {
  const owner = account.toLowerCase();
  const chain = String(chainId);
  if (!HEX_ADDRESS.test(owner) || !CHAIN_KEY.test(chain)) return;
  await writeList(owner, chain, (list) => list.filter((entry) => (
    entry.token !== token.toLowerCase() || entry.spender !== spender.toLowerCase()
  )));
}
