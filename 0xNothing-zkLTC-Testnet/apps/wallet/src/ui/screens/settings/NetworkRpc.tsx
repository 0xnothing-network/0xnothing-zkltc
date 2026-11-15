import { type FormEvent, type ReactNode, useState } from "react";
import { LITVM_RPC_URL } from "../../../config/chain";
import {
  litvmRpcOverride,
  LITVM_NETWORK,
  normalizeRpcUrl,
  sanitizeCustomNetwork,
  type WalletNetwork,
} from "../../../config/networks";
import { t } from "../../../core/i18n";
import { describeError } from "../../../core/lib/errors";
import { replaceCustomNetworkRpc } from "../../../core/keyring/vault";
import { probeChainId } from "../../../core/services/rpcProbe";
import { Button, Note, Row, Rows } from "../../components/kit";
import { requestRpcPermission } from "../../components/RpcAccessPrompt";
import { useActionGate } from "../../hooks/useActionGate";
import { useWallet } from "../../state/WalletContext";
import { releaseRpcPermissionUnlessUsed } from "./rpcRelease";

function hostOf(rpcUrl: string): string {
  try {
    return new URL(rpcUrl).host;
  } catch {
    return rpcUrl;
  }
}

/**
 * The user's own RPC for LiteForge (extension only). The public endpoint is a
 * single point of failure, so a user can put one of their own in front of it;
 * the public one stays behind it as the automatic fallback, so a bad endpoint
 * here never leaves the wallet without a working RPC. Saved only after the
 * candidate itself (never through the fallback) answered chain 4441.
 */
export function LitvmRpcField(): ReactNode {
  const { settings, saveSettings } = useWallet();
  const gate = useActionGate();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saved = litvmRpcOverride(settings.litvmRpcUrl);

  const run = (action: () => Promise<void>): void => {
    setBusy(true);
    void action()
      .catch((cause: unknown) => setError(describeError(cause)))
      .finally(() => {
        setBusy(false);
        gate.leave();
      });
  };

  const reset = (): void => {
    if (!gate.tryEnter()) return;
    setError(null);
    run(async () => {
      await saveSettings({ litvmRpcUrl: "" });
      setDraft("");
      if (saved !== null) await releaseRpcPermissionUnlessUsed(saved);
    });
  };

  const save = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const typed = normalizeRpcUrl(draft);
    if (typed !== null && typed === normalizeRpcUrl(LITVM_RPC_URL)) {
      // The default typed in: the same as going back to it.
      if (saved !== null) reset();
      else setDraft("");
      return;
    }
    const candidate = litvmRpcOverride(draft);
    if (candidate === null) {
      setError(t("set.litvmRpcInvalid"));
      return;
    }
    if (!gate.tryEnter()) return;
    // Chrome shows its prompt only inside the click, so this is asked first.
    const granted = requestRpcPermission(candidate);
    setError(null);
    run(async () => {
      if (!(await granted)) {
        setError(t("set.networkPermission"));
        return;
      }
      const got = await probeChainId(candidate);
      if (got !== BigInt(LITVM_NETWORK.chainId)) {
        await releaseRpcPermissionUnlessUsed(candidate);
        setError(got === null
          ? t("set.litvmRpcUnreachable")
          : t("set.litvmRpcWrongChain", { got: got.toString() }));
        return;
      }
      await saveSettings({ litvmRpcUrl: candidate });
      setDraft("");
      if (saved !== null && saved !== candidate) await releaseRpcPermissionUnlessUsed(saved);
    });
  };

  return (
    <>
      <details className="w-disclosure">
        <summary>{t("set.litvmRpc")}</summary>
        <div className="w-disclosure-body">
          {saved !== null ? (
            <Rows>
              <Row label="RPC" value={hostOf(saved)} />
            </Rows>
          ) : null}
          <form className="w-network-form" onSubmit={save}>
            <label className="w-field">
              <span className="w-label">{t("set.rpcUrl")}</span>
              <input
                className="w-input"
                value={draft}
                disabled={busy}
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                placeholder={LITVM_RPC_URL}
                onChange={(event) => setDraft(event.target.value)}
              />
            </label>
            <Button type="submit" variant="primary" block disabled={busy || draft.trim() === ""}>
              {busy ? t("common.working") : t("set.litvmRpcSave")}
            </Button>
            {saved !== null ? (
              <Button block disabled={busy} onClick={reset}>
                {t("set.litvmRpcReset")}
              </Button>
            ) : null}
          </form>
          <Note>{t("set.litvmRpcHint")}</Note>
          {error !== null ? (
            <div role="alert">
              <Note tone="error">{error}</Note>
            </div>
          ) : null}
        </div>
      </details>
      {saved !== null ? <Note tone="warn">{t("set.customNetworkNote")}</Note> : null}
    </>
  );
}

/**
 * Points a saved custom network at another RPC in place (extension only). The
 * new endpoint passes the same validator as adding one and must answer the
 * same chain id; the profile keeps its place, its selection, and its tokens and
 * history, which are keyed by chain.
 */
export function ChangeNetworkRpc({ entry, onDone }: { entry: WalletNetwork; onDone: () => void }): ReactNode {
  const gate = useActionGate();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const candidate = sanitizeCustomNetwork({ ...entry, rpcUrl: draft });
    if (candidate === null) {
      setError(t("set.networkInvalid"));
      return;
    }
    if (candidate.id === entry.id) {
      onDone();
      return;
    }
    if (!gate.tryEnter()) return;
    // Chrome shows its prompt only inside the click, so this is asked first.
    const granted = requestRpcPermission(candidate.rpcUrl);
    setError(null);
    setBusy(true);
    void (async () => {
      if (!(await granted)) {
        setError(t("set.networkPermission"));
        return;
      }
      const got = await probeChainId(candidate.rpcUrl);
      if (got !== BigInt(entry.chainId)) {
        await releaseRpcPermissionUnlessUsed(candidate.rpcUrl);
        setError(got === null
          ? t("set.litvmRpcUnreachable")
          : t("set.rpcWrongChain", { got: got.toString(), chainId: entry.chainId }));
        return;
      }
      try {
        await replaceCustomNetworkRpc(entry.id, candidate);
      } catch (cause) {
        await releaseRpcPermissionUnlessUsed(candidate.rpcUrl);
        throw cause;
      }
      await releaseRpcPermissionUnlessUsed(entry.rpcUrl);
      onDone();
    })()
      .catch((cause: unknown) => setError(describeError(cause)))
      .finally(() => {
        setBusy(false);
        gate.leave();
      });
  };

  return (
    <form className="w-set-form" onSubmit={save}>
      <label className="w-field">
        <span className="w-label">{t("set.rpcUrl")}</span>
        <input
          className="w-input"
          value={draft}
          disabled={busy}
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder={entry.rpcUrl}
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
      <Button type="submit" variant="primary" block disabled={busy || draft.trim() === ""}>
        {busy ? t("common.working") : t("set.changeRpc")}
      </Button>
      {error !== null ? (
        <div role="alert">
          <Note tone="error">{error}</Note>
        </div>
      ) : null}
    </form>
  );
}
