import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { encodeFunctionData, isAddress, type Address, type Hex } from "viem";
import { erc20Abi } from "../../abis";
import { nativeTokenFor, type WalletToken } from "../../config/assets";
import { t } from "../../core/i18n";
import { formatAmount, formatBalance, formatUsdWad, parseAmount, shortenAddress } from "../../core/lib/format";
import { publicClient } from "../../core/rpc/client";
import { loadPortfolio, visibleRows, type AssetRow } from "../../core/services/portfolio";
import {
  accountFromEntropyHex,
  activateWire,
  claimSignedIntent,
  createQuantum,
  decodeIcons,
  entropyHex,
  executeIntent,
  executeLeavesLeft,
  iconsFor,
  LeafClaimError,
  livePending,
  mustRotate,
  newSecret,
  recoverQuantum,
  relayDeploy,
  relayIntent,
  resumeQuantum,
  rotateIntent,
} from "../../core/quantum/account";
import { QUANTUM_FACTORY } from "../../core/quantum/config";
import { selfRelay } from "../../core/quantum/selfRelay";
import { postIntent } from "../../core/quantum/boardClient";
import {
  clearPending,
  clearQuantum,
  readQuantum,
  writeQuantum,
  type QuantumPending,
} from "../../core/quantum/storage";
import { AmountField } from "../components/AmountField";
import { Button, Empty, Note, Panel, PanelBody, Rows, Row } from "../components/kit";
import { Screen } from "../components/Screen";
import { TokenLogo } from "../components/TokenLogo";
import { TokenSelect } from "../components/TokenSelect";
import { TransactionReview } from "../components/TransactionReview";
import { VerifiedMark } from "../components/VerifiedMark";
import { useActionGate } from "../hooks/useActionGate";
import { useCopy } from "../hooks/useCopy";
import { useLiveRead } from "../hooks/useLiveRead";
import { useWallet } from "../state/WalletContext";
import { goHome } from "../router";
import { hexBytes } from "../../../../../quantum-wallet/sdk/src/crypto.ts";
import type { QuantumAccount } from "../../../../../quantum-wallet/sdk/src/wallet.ts";
import type { QCall } from "../../../../../quantum-wallet/sdk/src/encode.ts";
import { readWalletState, type WalletState } from "../../../../../quantum-wallet/sdk/src/reads.ts";

/**
 * 0xQuantum post-quantum wallet. A contract-held wallet on LiteForge: every
 * operation (activate, send, rotate) is signed locally with a one-time WOTS
 * signature and sponsored by the dev relayer, so the user pays ZERO gas for
 * everything — the exact property the project was built for.
 *
 * The user's secret is a 24-icon string (re-derivable on demand, and the only
 * backup); rotating it re-derives the signing tree WITHOUT changing the wallet
 * address.
 *
 * The screen is an ordinary wallet — total value, asset list, token picker,
 * amount field — over a contract-held balance. A send is either the gas coin or
 * an ERC-20 `transfer`, and both are the same inner-call mechanism, so nothing
 * here is special-cased by asset type.
 *
 * One-time keys make retrying a signed-but-unmined operation a correctness
 * problem, not a UX preference: the leaf is burned when the signature exists,
 * so a retry that re-signs would put two signatures on one leaf and leak the
 * key. Every intent is therefore persisted before it leaves this device and
 * replayed byte-for-byte until the chain moves past its leaf.
 */

interface CreatedSecret {
  entropy: Uint8Array;
  icons: string;
  account: QuantumAccount;
  address: Hex;
}

const PENDING_POLL_MS = 4000;

/**
 * Leaves left below which the screen starts nagging to rotate. Rotation is free
 * and keeps the address, so warning early costs the user nothing — whereas
 * arriving at zero with funds to move means one mandatory extra step first.
 */
const LOW_LEAF_WARNING = 32;

/** Why a signing attempt refused to burn a leaf, in the user's language. */
function leafClaimMessage(error: LeafClaimError): string {
  switch (error.reason) {
    case "exhausted":
      return t("quantum.leafExhausted");
    case "diverged":
      return t("quantum.leafDiverged");
    default:
      return t("quantum.leafBusy");
  }
}

function iconGrid(icons: string): string[] {
  const chars = Array.from(icons.normalize("NFKC"));
  const rows: string[] = [];
  for (let i = 0; i < chars.length; i += 4) {
    rows.push(chars.slice(i, i + 4).join(" "));
  }
  return rows;
}

/**
 * The inner call an asset transfer becomes. The wallet executes a batch of
 * these, so a token send is the same mechanism as the gas coin — only the
 * calldata differs. Nothing here needs the user's gas: the sponsor pays the
 * outer transaction, and an inner call consumes no gas of its own.
 */
function transferCall(token: WalletToken, recipient: Address, amount: bigint): QCall[] {
  if (token.address === undefined) {
    return [{ to: recipient, value: amount, data: "0x" }];
  }
  return [
    {
      to: token.address,
      value: 0n,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [recipient, amount],
      }),
    },
  ];
}

export function QuantumWallet(): ReactNode {
  // `address` below is the QUANTUM wallet. `hdAddress` is the ordinary HD
  // account, and it is only used to pay gas when self-broadcasting a stranded
  // intent — it has no authority over the quantum wallet whatsoever.
  const { notify, tokens, tick, network, refresh: bumpTick, address: hdAddress } = useWallet();
  const { copy } = useCopy();
  const nativeToken = nativeTokenFor(network);

  const [stage, setStage] = useState<"loading" | "none" | "created" | "ready">("loading");
  const [created, setCreated] = useState<CreatedSecret | null>(null);
  const [account, setAccount] = useState<QuantumAccount | null>(null);
  const [address, setAddress] = useState<Hex | null>(null);
  const [state, setState] = useState<WalletState | null>(null);
  const [pending, setPending] = useState<QuantumPending | null>(null);
  /** Separate from `busy`: publishing to the board sends no transaction, so it
   *  must not be blocked by — or block — the sponsor-retry poll. */
  const [posting, setPosting] = useState(false);

  const [busy, setBusy] = useState(false);
  const [tokenId, setTokenId] = useState<string>("native");
  const [sendTo, setSendTo] = useState("");
  const [sendAmount, setSendAmount] = useState("");
  const [recoverText, setRecoverText] = useState("");
  const [recoverAddress, setRecoverAddress] = useState("");
  const [rotateSecret, setRotateSecret] = useState<CreatedSecret | null>(null);
  /** The live secret, so the backup icons can be re-derived on demand. */
  const [secretHex, setSecretHex] = useState<Hex | null>(null);
  const [backupIcons, setBackupIcons] = useState<string | null>(null);
  /** Guards one confirm against a double-submit landing inside the same tick. */
  const confirmGate = useActionGate();
  /** Snapshot of the send under review; null = review sheet closed. */
  const [review, setReview] = useState<{ to: Address; amount: bigint; token: WalletToken } | null>(null);
  /** Guards the retry poll from overlapping a user-driven retry. */
  const retrying = useRef(false);

  // The asset list reads the QUANTUM address, not the HD account's: this wallet
  // holds its own funds, and the whole point is that they sit at the contract.
  const read = useLiveRead(
    address !== null ? () => loadPortfolio(address as Address, tokens) : null,
    [address, tokens, tick],
    { identity: [address, tokens] },
  );
  const rows: readonly AssetRow[] = read.data?.rows ?? [];
  const listed = visibleRows(rows);
  const token = tokens.find((entry) => entry.id === tokenId) ?? nativeToken;
  const balance = rows.find((row) => row.token.id === token.id)?.balance ?? null;

  /**
   * Re-read the chain and reconcile everything that depends on it: adopt a
   * rotation that confirmed while the popup was closed, retire an intent the
   * chain has moved past, and re-align the leaf cursor (in BOTH directions —
   * the chain is authoritative).
   *
   * Takes the intent explicitly rather than reading `pending` from the closure:
   * callers invoke it in the same tick they set that state, so the variable
   * would still hold the previous value.
   */
  async function settle(intent: QuantumPending | null): Promise<void> {
    if (address === null || account === null) return;
    const nextState = await readWalletState(publicClient, address).catch(() => null);
    if (nextState === null) return;

    if (
      intent?.kind === "rotate" &&
      intent.successorEntropyHex !== undefined &&
      nextState.epoch === intent.epoch + 1
    ) {
      // The rotation landed. Adopt the successor secret parked for this case —
      // without it the wallet would keep signing with the retired tree.
      const successor = accountFromEntropyHex(intent.successorEntropyHex, nextState.epoch);
      successor.syncLeaf(nextState.leafIndex);
      // The rotate intent itself is dead the instant its epoch retires, but a
      // pending another window armed on the NEW tree (same epoch, next leaf) is
      // still live and must survive the switch — overwriting it would orphan a
      // signature nothing on disk can replay.
      const stored = await readQuantum();
      const stillLive = stored?.pending !== undefined
        ? livePending(stored.pending, nextState)
        : null;
      await writeQuantum({
        entropyHex: intent.successorEntropyHex,
        epoch: nextState.epoch,
        address,
        pending: stillLive,
      });
      setAccount(successor);
      setPending(stillLive);
      setState(nextState);
      // The successor is now the only secret that controls the wallet, so the
      // revealed backup (if any) belongs to a retired tree — drop it.
      setSecretHex(intent.successorEntropyHex);
      setBackupIcons(null);
      bumpTick();
      return;
    }

    if (intent !== null && livePending(intent, nextState) === null) {
      // Either it landed, or a rotation retired its epoch. Both mean the bytes
      // can never be consumed again — safe, and necessary, to forget them.
      // Scoped to this exact leaf so a newer intent another window armed is not
      // erased alongside it.
      await clearPending({ epoch: intent.epoch, leafIndex: intent.leafIndex });
      setPending(null);
    }
    account.syncLeaf(nextState.leafIndex);
    setState(nextState);
    bumpTick();
  }

  /**
   * Re-read chain and disk and adopt whatever they currently say.
   *
   * Used after a signing claim is refused: the chain may have moved (another
   * window's op landed), a rotation may have confirmed, or an intent may be in
   * flight that this window never knew about. Local React state is stale in all
   * three cases, and the next operation must see the truth rather than a
   * snapshot from mount.
   */
  async function resync(): Promise<QuantumPending | null> {
    if (address === null || account === null) return null;
    const stored = await readQuantum();
    const fresh = await readWalletState(publicClient, address).catch(() => null);
    if (fresh === null) return stored?.pending ?? null;
    account.syncLeaf(fresh.leafIndex);
    setState(fresh);
    const live = livePending(stored?.pending ?? null, fresh);
    setPending(live);
    if (live === null) bumpTick();
    return live;
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stored = await readQuantum();
      if (cancelled) return;
      if (stored === null) {
        setStage("none");
        return;
      }
      try {
        const resumed = await resumeQuantum(publicClient, stored);
        if (cancelled) return;
        setAccount(resumed.account);
        setAddress(resumed.address);
        setState(resumed.state);
        setPending(resumed.pending);
        // Recovery of the account adopts the successor secret if a rotation
        // confirmed while the popup was closed, so read it back from the record
        // the resume settled on rather than the one we loaded.
        setSecretHex(resumed.stored.entropyHex);
        setStage("ready");
        // Anything left in flight is re-offered by the poll effect below, which
        // runs after the state set here has actually been applied.
      } catch {
        if (!cancelled) setStage("none");
      }
    })();
    return () => {
      cancelled = true;
    };
    // Runs once on mount. Anything left in flight is re-offered by the poll
    // effect below, not from here — this closure predates the state it needs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Re-submit an already-signed intent, verbatim. The ONLY safe retry: the
   * bytes carry a one-time signature bound to one leaf, so re-signing to "fix"
   * a failed send would spend a second signature on that same leaf — which is
   * precisely the break WOTS forbids.
   */
  async function retryPending(intent: QuantumPending | null, quiet = false): Promise<void> {
    if (intent === null || address === null || account === null) return;
    if (retrying.current) return;
    retrying.current = true;
    setBusy(true);
    try {
      const out = await relayIntent(intent.request);
      if (out.ok) {
        // The relayer waits for the receipt, so the chain has moved by now and
        // settle() below will retire the intent (adopting a rotation's
        // successor secret in the process).
        notify(
          intent.kind === "rotate"
            ? t("quantum.rotated")
            : t("quantum.sent", { tx: shortenAddress(out.txHash ?? "0x", 6, 4) }),
          "ok",
        );
      } else if (!quiet) {
        // A refusal is NOT necessarily permanent (rate limit, simulate-only
        // mode, transient upstream error) and these bytes are not malleable, so
        // the intent stays armed either way — settle() retires it only once the
        // chain itself has moved. Poll-driven retries stay silent so a refused
        // intent cannot spam a toast every few seconds.
        notify(t("quantum.txError", { error: out.error ?? "?" }), "error");
      }
      await settle(intent);
    } catch {
      // Transport failure, not a refusal — leave it queued and let the poll
      // below offer it again.
    } finally {
      retrying.current = false;
      setBusy(false);
    }
  }

  /**
   * Escape hatch: broadcast the pending intent from the user's own HD account
   * instead of the sponsor.
   *
   * `executeSigned` ignores `msg.sender` — the signature already binds the
   * wallet, chain, nonce and every call — so this is the same operation with a
   * different payer, not a different authority. It sends the SAME stored bytes
   * for the same reason `retryPending` does: re-signing would burn a second
   * signature on a one-time leaf.
   *
   * Shares `retrying` with the poll so a self-broadcast and a sponsor retry can
   * never race each other onto the same leaf.
   */
  async function selfBroadcast(intent: QuantumPending | null): Promise<void> {
    if (intent === null || address === null || account === null) return;
    if (hdAddress === null) {
      notify(t("quantum.selfRelayNoAccount"), "error");
      return;
    }
    if (retrying.current) return;
    retrying.current = true;
    setBusy(true);
    try {
      const out = await selfRelay(intent.request, hdAddress);
      if (out.ok) {
        notify(
          t("quantum.selfRelaySent", { tx: shortenAddress(out.txHash ?? "0x", 6, 4) }),
          "ok",
        );
      } else {
        notify(t("quantum.txError", { error: out.error ?? "?" }), "error");
      }
      // Retire the intent only if the chain actually moved; settle() re-reads
      // on-chain state rather than trusting the broadcast result.
      await settle(intent);
    } catch (cause) {
      notify(t("quantum.txError", { error: (cause as Error).message }), "error");
    } finally {
      retrying.current = false;
      setBusy(false);
    }
  }

  /**
   * Publish the pending intent so a stranger's relayer node can pay for it.
   *
   * The middle rung of the ladder: cheaper for the user than self-broadcasting
   * (someone else's gas) and more likely to work than retrying a sponsor that is
   * down. The cost is privacy — the board is public, so the intent is visible a
   * few seconds before the chain would have shown it anyway. That is why this is
   * a button and never automatic.
   *
   * Does NOT take the `retrying` lock: posting broadcasts nothing and touches no
   * leaf, so it cannot race a sponsor retry. It also does not retire the intent —
   * the existing poll notices when the chain moves, whoever ended up paying.
   */
  async function postToBoard(intent: QuantumPending | null): Promise<void> {
    if (intent === null || posting) return;
    setPosting(true);
    try {
      const out = await postIntent(intent.request);
      if (out.ok) {
        notify(t(out.duplicate === true ? "quantum.boardAlready" : "quantum.boardPosted"), "ok");
      } else {
        notify(t("quantum.boardError", { error: out.error ?? "?" }), "error");
      }
    } catch (cause) {
      notify(t("quantum.boardError", { error: (cause as Error).message }), "error");
    } finally {
      setPosting(false);
    }
  }

  // Keep offering a live intent until it lands. A popup torn down mid-flight is
  // the normal case for an extension, not an edge case.
  useEffect(() => {
    if (pending === null || address === null || account === null) return undefined;
    // Offer once immediately — this effect runs after the render that set
    // `pending`, so the closure here is fresh — then keep offering until the
    // chain moves past the leaf and settle() retires it.
    void retryPending(pending, true);
    const timer = setInterval(() => {
      void retryPending(pending, true);
    }, PENDING_POLL_MS);
    return () => {
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, address]);

  // The review sheet shows a snapshot of the send; any edit invalidates it.
  useEffect(() => {
    setReview(null);
  }, [sendTo, sendAmount, tokenId]);

  const startCreate = async (): Promise<void> => {
    setBusy(true);
    try {
      const { entropy, icons } = await newSecret();
      const { account: acc, address: addr } = await createQuantum(publicClient, entropy);
      // Persist the moment the address exists, NOT at activation. This screen
      // hands the user an address and tells them to fund it, and the wallet is
      // usable before it is deployed — so a popup that dies before activation
      // would strand every coin already sent here. The icons are re-derivable
      // from this record, so persisting early costs nothing.
      await writeQuantum({
        entropyHex: entropyHex(entropy),
        epoch: 0,
        address: addr,
        pending: null,
      });
      setSecretHex(entropyHex(entropy));
      setCreated({ entropy, icons, account: acc, address: addr });
      setStage("created");
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : String(cause), "error");
    } finally {
      setBusy(false);
    }
  };

  const startRecover = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    // The alphabet never contains whitespace, so a pasted backup may carry
    // spaces/newlines from the copy source — strip them before decoding.
    const decoded = await decodeIcons(recoverText.replace(/\s+/gu, ""));
    if (!decoded.valid) {
      notify(t("quantum.recoverInvalid"), "error");
      return;
    }
    setBusy(true);
    try {
      const raw = recoverAddress.trim();
      if (raw !== "") {
        // Address given: restoring a wallet that has been rotated at least
        // once. Rotation replaces the secret, and the new tree root is not the
        // factory salt, so the icons no longer derive the address — only the
        // chain can say which tree the wallet is on now.
        if (!isAddress(raw)) {
          notify(t("quantum.badAddress"), "error");
          return;
        }
        const found = await recoverQuantum(publicClient, decoded.entropy, raw as Hex);
        if (!found.ok) {
          notify(
            found.reason === "not-deployed"
              ? t("quantum.recoverNotDeployed")
              : t("quantum.recoverMismatch"),
            "error",
          );
          return;
        }
        const secret = entropyHex(decoded.entropy);
        await writeQuantum({
          entropyHex: secret,
          epoch: found.state.epoch,
          address: found.address,
          pending: null,
        });
        setSecretHex(secret);
        setAccount(found.account);
        setAddress(found.address);
        setState(found.state);
        setPending(null);
        setStage("ready");
        bumpTick();
        notify(t("quantum.recovered"), "ok");
        return;
      }
      const { account: acc, address: addr } = await createQuantum(publicClient, decoded.entropy);
      // Same as a fresh creation: the address is live from here on, so the
      // secret must outlive this popup even if activation never happens.
      await writeQuantum({
        entropyHex: entropyHex(decoded.entropy),
        epoch: 0,
        address: addr,
        pending: null,
      });
      setSecretHex(entropyHex(decoded.entropy));
      setCreated({
        entropy: decoded.entropy,
        icons: await iconsFor(decoded.entropy),
        account: acc,
        address: addr,
      });
      setStage("created");
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : String(cause), "error");
    } finally {
      setBusy(false);
    }
  };

  const activate = async (): Promise<void> => {
    if (created === null) return;
    setBusy(true);
    try {
      const out = await relayDeploy(activateWire(created.account, created.address));
      if (!out.ok && !/already deployed/iu.test(out.error ?? "")) {
        notify(t("quantum.txError", { error: out.error ?? "?" }), "error");
        return;
      }
      // Already persisted when the address was first derived, so nothing to
      // write here — activation only flips the on-chain `deployed` bit.
      setAccount(created.account);
      setAddress(created.address);
      setState({
        deployed: true,
        nonce: 0n,
        epoch: 0,
        merkleRoot: created.account.root0Hex,
        leafIndex: 0,
      });
      setPending(null);
      setStage("ready");
      bumpTick();
      notify(t("quantum.activated"), "ok");
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : String(cause), "error");
    } finally {
      setBusy(false);
    }
  };

  /**
   * Activate a wallet resumed from disk that was created but never deployed.
   * The secret already exists locally, so this is only the sponsored deploy —
   * the shape `activate` has when there is no freshly-created secret in hand.
   */
  const deploy = async (): Promise<void> => {
    if (account === null || address === null) return;
    setBusy(true);
    try {
      const out = await relayDeploy(activateWire(account, address));
      if (!out.ok && !/already deployed/iu.test(out.error ?? "")) {
        notify(t("quantum.txError", { error: out.error ?? "?" }), "error");
        return;
      }
      await settle(null);
      notify(t("quantum.activated"), "ok");
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : String(cause), "error");
    } finally {
      setBusy(false);
    }
  };

  /** Re-derive the backup icons from the stored secret. Deterministic, so the
   *  icons shown later are always the same ones that control the wallet. */
  const revealBackup = async (): Promise<void> => {
    if (secretHex === null) return;
    setBusy(true);
    try {
      setBackupIcons(await iconsFor(hexBytes(secretHex)));
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : String(cause), "error");
    } finally {
      setBusy(false);
    }
  };

  const fillMax = (): void => {
    if (balance === null) return;
    // No gas reserve to leave behind: the sponsor pays for the outer
    // transaction, so the whole balance is genuinely spendable.
    setSendAmount(formatBalance(balance, token.decimals));
  };

  /**
   * Form submit: validate the send and open the review sheet. No signature is
   * made here — main-wallet parity means a human-confirmable step before
   * anything one-time is consumed.
   */
  const reviewSend = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (account === null || address === null || state === null) return;
    if (pending !== null) {
      // An intent is already holding the next leaf. Signing now would burn a
      // second signature on it — offer the outstanding one instead.
      void retryPending(pending);
      return;
    }
    // Submitting with Enter skips the disabled button, so re-check here: the
    // last leaf belongs to rotateRoot and an execute signed on it could never
    // land, leaving the rotation that frees the wallet as a second signature
    // over the same one-time key.
    if (mustRotate(state)) {
      notify(t("quantum.leafExhausted"), "error");
      return;
    }
    const to = sendTo.trim();
    // The zero address is burnable: coins sent there can never be moved, and no
    // one controls it. Reject it up front like any other invalid recipient.
    if (!isAddress(to) || /^0x0{40}$/iu.test(to)) {
      notify(t("quantum.badAddress"), "error");
      return;
    }
    const amount = parseAmount(sendAmount.trim(), token.decimals);
    if (amount === null || amount <= 0n) {
      notify(t("quantum.badAmount"), "error");
      return;
    }
    setReview({ to: to as Address, amount, token });
  };

  /**
   * Review confirm: the ONLY point where a new signature can exist. Runs inside
   * the cross-context signing lock and re-derives nonce/leaf/epoch from the
   * chain and from disk at this instant, so a stale screen can never sign over
   * a leaf another window already used.
   */
  const confirmSend = async (): Promise<void> => {
    if (account === null || address === null || review === null) return;
    if (!confirmGate.tryEnter()) return;
    setBusy(true);
    let claimed = false;
    try {
      const { pending: armed, state: fresh } = await claimSignedIntent(
        publicClient,
        address,
        account,
        "execute",
        (chain) =>
          executeIntent(account, address, chain.nonce, transferCall(review.token, review.to, review.amount)),
      );
      setState(fresh);
      setReview(null);
      // Claim the in-flight slot BEFORE arming the state: the poll effect below
      // fires the moment `pending` is set, and a concurrent second submission
      // of the same bytes would only revert BadNonce once the first one lands.
      retrying.current = true;
      claimed = true;
      setPending(armed);
      const out = await relayIntent(armed.request);
      if (!out.ok) {
        // Keep the intent armed — a failed relay is retryable now instead of
        // desyncing the cursor as it used to. The poll retries it.
        notify(t("quantum.txError", { error: out.error ?? "?" }), "error");
        return;
      }
      notify(t("quantum.sent", { tx: shortenAddress(out.txHash ?? "0x", 6, 4) }), "ok");
      setSendTo("");
      setSendAmount("");
      await settle(armed);
    } catch (cause) {
      if (cause instanceof LeafClaimError) {
        // Another window holds the leaf, local state diverged, or the tree is
        // spent. Adopt the on-disk truth; the poll takes over retrying any live
        // intent.
        notify(leafClaimMessage(cause), "error");
        await resync();
      } else {
        notify(cause instanceof Error ? cause.message : String(cause), "error");
      }
    } finally {
      if (claimed) retrying.current = false;
      confirmGate.leave();
      setBusy(false);
    }
  };

  const startRotate = async (): Promise<void> => {
    setBusy(true);
    try {
      const { entropy, icons } = await newSecret();
      const { account: acc, address: addr } = await createQuantum(publicClient, entropy);
      setRotateSecret({ entropy, icons, account: acc, address: addr });
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : String(cause), "error");
    } finally {
      setBusy(false);
    }
  };

  const rotate = async (): Promise<void> => {
    if (account === null || address === null || rotateSecret === null) return;
    if (!confirmGate.tryEnter()) return;
    setBusy(true);
    let claimed = false;
    try {
      // Park the successor secret WITH the intent: if this rotation confirms
      // while the popup is closed, that is the only copy of the secret the
      // wallet will run on next — losing it strands the wallet until the user
      // digs out the icon backup. Epoch and leaf come from claimSignedIntent,
      // not from this window's possibly-stale React state.
      const { pending: armed, state: fresh } = await claimSignedIntent(
        publicClient,
        address,
        account,
        "rotate",
        (chain) => {
          const intent = rotateIntent(account, rotateSecret.account.root0Hex, chain.epoch + 1, address);
          return { ...intent, successorEntropyHex: entropyHex(rotateSecret.entropy) };
        },
      );
      setState(fresh);
      // Same guard as send: the poll effect fires the instant `pending` is set.
      retrying.current = true;
      claimed = true;
      setPending(armed);
      const out = await relayIntent(armed.request);
      if (!out.ok) {
        notify(t("quantum.txError", { error: out.error ?? "?" }), "error");
        return;
      }
      setRotateSecret(null);
      await settle(armed);
      notify(t("quantum.rotated"), "ok");
    } catch (cause) {
      if (cause instanceof LeafClaimError) {
        notify(leafClaimMessage(cause), "error");
        await resync();
      } else {
        notify(cause instanceof Error ? cause.message : String(cause), "error");
      }
    } finally {
      if (claimed) retrying.current = false;
      confirmGate.leave();
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    await clearQuantum();
    setStage("none");
    setAccount(null);
    setAddress(null);
    setState(null);
    setCreated(null);
    setPending(null);
    setRotateSecret(null);
    setSecretHex(null);
    setBackupIcons(null);
  };

  if (stage === "loading") {
    return (
      <Screen title={t("quantum.title")} onBack={goHome}>
        <div className="w-empty" role="status">
          <span className="w-spin" aria-hidden="true">▚</span>
          <span>{t("app.opening")}</span>
        </div>
      </Screen>
    );
  }

  if (QUANTUM_FACTORY === "0x0000000000000000000000000000000000000000") {
    return (
      <Screen title={t("quantum.title")} onBack={goHome}>
        <div className="w-stack">
          <Note tone="warn">{t("quantum.notConfigured")}</Note>
        </div>
      </Screen>
    );
  }

  if (stage === "created" && created !== null) {
    return (
      <Screen title={t("quantum.title")} onBack={goHome}>
        <div className="w-stack">
          <Panel title={t("quantum.backup")}>
            <PanelBody>
              <Note tone="warn">{t("quantum.backupNote")}</Note>
              {iconGrid(created.icons).map((row) => (
                <div key={row} className="w-q-icons">{row}</div>
              ))}
              <Button size="sm" disabled={busy} onClick={() => { void copy(created.icons); }}>
                {t("common.copy")}
              </Button>
            </PanelBody>
          </Panel>

          <Panel title={t("quantum.address")}>
            <PanelBody>
              <Rows>
                <Row label={t("quantum.address")} value={shortenAddress(created.address, 10, 8)} />
              </Rows>
              <Note>{t("quantum.fundNote")}</Note>
            </PanelBody>
          </Panel>

          <Button variant="primary" block disabled={busy} onClick={() => void activate()}>
            {busy ? t("common.working") : t("quantum.activate")}
          </Button>
          {/* Not "cancel": the secret was persisted the moment the address
              existed, so there is nothing to discard here. Backing out just
              leaves an undeployed wallet that the next open resumes into —
              better than restarting the flow and orphaning a funded address. */}
          <Button block disabled={busy} onClick={goHome}>
            {t("common.close")}
          </Button>
        </div>
      </Screen>
    );
  }

  if (stage === "none") {
    return (
      <Screen title={t("quantum.title")} onBack={goHome}>
        <div className="w-stack">
          <Panel title={t("quantum.what")}>
            <PanelBody>
              <Note>{t("quantum.whatNote")}</Note>
            </PanelBody>
          </Panel>
          <Button variant="primary" block disabled={busy} onClick={() => void startCreate()}>
            {busy ? t("common.working") : t("quantum.create")}
          </Button>
          <details className="w-disclosure">
            <summary>{t("quantum.recover")}</summary>
            <div className="w-disclosure-body">
              <form className="w-network-form" onSubmit={(event) => void startRecover(event)}>
                <label className="w-field">
                  <span className="w-label">{t("quantum.recoverPlaceholder")}</span>
                  <textarea
                    className="w-input"
                    value={recoverText}
                    rows={2}
                    autoComplete="off"
                    onChange={(event) => setRecoverText(event.target.value)}
                  />
                </label>
                <label className="w-field">
                  <span className="w-label">{t("quantum.recoverAddress")}</span>
                  <input
                    className="w-input"
                    value={recoverAddress}
                    autoComplete="off"
                    placeholder="0x…"
                    onChange={(event) => setRecoverAddress(event.target.value)}
                  />
                </label>
                <Note>{t("quantum.recoverAddressNote")}</Note>
                <Button type="submit" variant="primary" block disabled={busy}>
                  {busy ? t("common.working") : t("common.continue")}
                </Button>
              </form>
            </div>
          </details>
        </div>
      </Screen>
    );
  }

  const amountText = sendAmount.trim();
  const parsed = parseAmount(amountText, token.decimals);
  const over = parsed !== null && balance !== null && parsed > balance;
  const self = isAddress(sendTo.trim())
    && address !== null
    && sendTo.trim().toLowerCase() === address.toLowerCase();
  // The contract reserves the last leaf of every tree for rotateRoot, so a spent
  // tree can still rotate but can no longer send. These are therefore two
  // different notions of "usable" and must not be collapsed into one flag:
  // gating rotation on the send-readiness flag would disable the one action that
  // recovers a spent wallet, exactly when the screen is telling the user to
  // press it.
  const spent = state !== null && state.deployed && mustRotate(state);
  const leavesLeft = state !== null && state.deployed ? executeLeavesLeft(state) : null;
  /** Deployed and holding no outstanding intent — a new signature may be made. */
  const canSign = state?.deployed === true && pending === null;
  /** ...and the tree still has a leaf that an execute is allowed to consume. */
  const ready = canSign && !spent;
  const canSend = ready
    && isAddress(sendTo.trim())
    && parsed !== null
    && parsed > 0n
    && !over;

  return (
    <Screen title={t("quantum.title")} onBack={goHome}>
      <div className="w-stack">
        <div className="w-total-block" aria-busy={read.loading}>
          <div className="w-total-row">
            <span className="w-total">
              {read.data ? formatUsdWad(read.data.totalWad) : read.loading ? "…" : "—"}
            </span>
          </div>
          <div className="w-total-foot">
            <span className="w-total-note">{t("quantum.totalValue")}</span>
            <Button
              size="sm"
              disabled={address === null}
              onClick={() => { if (address !== null) void copy(address); }}
            >
              {address !== null ? shortenAddress(address, 6, 4) : "—"}
            </Button>
          </div>
          {read.error !== null ? <Note tone="error">{read.error}</Note> : null}
        </div>

        {state !== null && !state.deployed ? (
          <Panel title={t("quantum.activate")}>
            <PanelBody>
              <Note tone="warn">{t("quantum.fundNote")}</Note>
              <Button variant="primary" block disabled={busy} onClick={() => void deploy()}>
                {busy ? t("common.working") : t("quantum.activate")}
              </Button>
            </PanelBody>
          </Panel>
        ) : null}

        <Panel title={t("quantum.status")}>
          <PanelBody>
            <Rows>
              <Row
                label={t("quantum.state")}
                value={state === null ? "—" : state.deployed ? "active" : t("quantum.notDeployed")}
                tone={state === null ? undefined : state.deployed ? "green" : "red"}
              />
              {state !== null && state.deployed ? (
                <>
                  <Row label={t("quantum.epoch")} value={state.epoch} />
                  <Row label={t("quantum.leaf")} value={`${state.leafIndex} / 1023`} />
                </>
              ) : null}
              <Row
                label={t("quantum.balance")}
                value={balance === null
                  ? "—"
                  : `${formatBalance(balance, token.decimals)} ${token.symbol}`}
              />
            </Rows>
          </PanelBody>
        </Panel>

        {pending !== null ? (
          <Panel title={t("quantum.pending")}>
            <PanelBody>
              <Button variant="primary" block disabled={busy} onClick={() => void retryPending(pending)}>
                {busy ? t("common.working") : t("quantum.retry")}
              </Button>
              {/* Cheapest escape first: someone else's gas, at the cost of
                  publishing the intent a few seconds early. */}
              <Note>{t("quantum.boardNote")}</Note>
              <Button block disabled={posting} onClick={() => void postToBoard(pending)}>
                {posting ? t("common.working") : t("quantum.board")}
              </Button>
              {hdAddress !== null ? (
                <>
                  <Note>{t("quantum.selfRelayNote", { from: shortenAddress(hdAddress, 6, 4) })}</Note>
                  <Button block disabled={busy} onClick={() => void selfBroadcast(pending)}>
                    {busy ? t("common.working") : t("quantum.selfRelay")}
                  </Button>
                </>
              ) : null}
            </PanelBody>
          </Panel>
        ) : null}

        <Panel title={t("quantum.assets")}>
          {listed.length === 0 ? (
            <Empty>{read.loading ? t("quantum.assetsLoading") : t("quantum.assetsEmpty")}</Empty>
          ) : (
            <div className="w-list" aria-busy={read.loading}>
              {listed.map((row) => (
                <button
                  key={row.token.id}
                  type="button"
                  className="w-asset"
                  onClick={() => {
                    setTokenId(row.token.id);
                    setSendAmount("");
                  }}
                >
                  <TokenLogo token={row.token} />
                  <span className="w-asset-main">
                    <span className="w-asset-symbol w-token-symbol">
                      {row.token.symbol}
                      <VerifiedMark verified={row.token.verified} />
                    </span>
                    <span className="w-asset-sub">{row.token.name}</span>
                  </span>
                  <span className="w-asset-side">
                    <span className="w-asset-amount">
                      {formatBalance(row.balance, row.token.decimals)}
                    </span>
                    <span className="w-asset-usd">
                      {row.priceWad === 0n
                        ? "--"
                        : `${row.stale ? "~" : ""}${formatUsdWad(row.valueWad)}`}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </Panel>

        <Panel title={t("quantum.send")}>
          <PanelBody>
            <form
              className="w-network-form"
              aria-busy={busy}
              onSubmit={reviewSend}
            >
              <TokenSelect
                label={t("quantum.asset")}
                tokens={tokens}
                value={token}
                disabled={busy || !ready}
                onChange={(next) => {
                  setTokenId(next.id);
                  setSendAmount("");
                }}
              />
              <AmountField
                label={t("common.amount")}
                value={sendAmount}
                invalid={over}
                disabled={busy || !ready}
                symbol={token.symbol}
                onMax={balance === null ? undefined : fillMax}
                hint={balance === null
                  ? t("quantum.readingBalance")
                  : t("quantum.balanceHint", {
                      amount: formatBalance(balance, token.decimals),
                      symbol: token.symbol,
                    })}
                onChange={setSendAmount}
              />
              {over ? <Note tone="error">{t("quantum.overBalance")}</Note> : null}
              <label className="w-field">
                <span className="w-label">{t("quantum.sendTo")}</span>
                <input
                  className="w-input"
                  value={sendTo}
                  disabled={busy || !ready}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="0x…"
                  aria-invalid={sendTo.length > 0 && !isAddress(sendTo.trim())}
                  onChange={(event) => setSendTo(event.target.value)}
                />
              </label>
              {sendTo.length > 0 && !isAddress(sendTo.trim())
                ? <Note tone="error">{t("quantum.badAddress")}</Note>
                : null}
              {self ? <Note tone="warn">{t("quantum.selfAddress")}</Note> : null}
              {spent ? <Note tone="error">{t("quantum.leafExhausted")}</Note> : null}
              {!spent && leavesLeft !== null && leavesLeft <= LOW_LEAF_WARNING
                ? <Note tone="warn">{t("quantum.leafLow", { left: leavesLeft })}</Note>
                : null}
              <Button type="submit" variant="primary" block disabled={busy || (!canSend && pending === null)}>
                {busy ? t("common.working") : pending !== null ? t("quantum.retry") : t("quantum.send")}
              </Button>
              <Note>{t("quantum.gasNote")}</Note>
            </form>
            {review !== null ? (
              <TransactionReview
                title={t("quantum.send")}
                busy={busy}
                ready={ready}
                confirmLabel={t("quantum.send")}
                onClose={() => setReview(null)}
                onConfirm={() => void confirmSend()}
              >
                <div className="w-summary">
                  <span className="w-summary-label">{t("quantum.asset")}</span>
                  <span className="w-summary-value">
                    {formatAmount(review.amount, review.token.decimals, 6)} {review.token.symbol}
                  </span>
                </div>
                <Panel>
                  <Rows>
                    <Row label={t("quantum.sendTo")} value={shortenAddress(review.to, 10, 6)} />
                    <Row label={t("common.network")} value={network.name} />
                  </Rows>
                </Panel>
              </TransactionReview>
            ) : null}
          </PanelBody>
        </Panel>

        <Panel title={t("quantum.receive")}>
          <PanelBody>
            <Note>{t("quantum.fundNote")}</Note>
            <Button block disabled={busy || address === null} onClick={() => {
              if (address !== null) void copy(address);
            }}>
              {t("common.copy")}
            </Button>
          </PanelBody>
        </Panel>

        <Panel title={t("quantum.backup")}>
          <PanelBody>
            <Note>{t("quantum.backupNote")}</Note>
            {backupIcons === null ? (
              <Button block disabled={busy || secretHex === null} onClick={() => void revealBackup()}>
                {t("quantum.showBackup")}
              </Button>
            ) : (
              <>
                {iconGrid(backupIcons).map((row) => (
                  <div key={row} className="w-q-icons">{row}</div>
                ))}
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => { if (backupIcons !== null) void copy(backupIcons); }}
                >
                  {t("common.copy")}
                </Button>
                <Button block onClick={() => setBackupIcons(null)}>{t("common.cancel")}</Button>
              </>
            )}
          </PanelBody>
        </Panel>

        <Panel title={t("quantum.rotate")}>
          <PanelBody>
            <Note>{t("quantum.rotateNote")}</Note>
            {rotateSecret === null ? (
              // `canSign`, NOT `ready`: rotation is precisely what rescues a
              // wallet whose tree is spent, so the reserved final leaf must not
              // disable it.
              <Button block disabled={busy || !canSign} onClick={() => void startRotate()}>
                {t("quantum.rotateStart")}
              </Button>
            ) : (
              <>
                <Note tone="warn">{t("quantum.backupNote")}</Note>
                {iconGrid(rotateSecret.icons).map((row) => (
                  <div key={row} className="w-q-icons">{row}</div>
                ))}
                <Button variant="primary" block disabled={busy} onClick={() => void rotate()}>
                  {busy ? t("common.working") : t("quantum.rotateConfirm")}
                </Button>
                <Button block disabled={busy} onClick={() => setRotateSecret(null)}>
                  {t("common.cancel")}
                </Button>
              </>
            )}
          </PanelBody>
        </Panel>

        <Panel title={t("quantum.danger")}>
          <PanelBody>
            <Button variant="danger" block disabled={busy} onClick={() => void remove()}>
              {t("quantum.remove")}
            </Button>
            <Note>{t("quantum.removeNote")}</Note>
          </PanelBody>
        </Panel>
      </div>
    </Screen>
  );
}
