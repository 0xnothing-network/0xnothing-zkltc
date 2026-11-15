import { type FormEvent, Fragment, type ReactNode, useEffect, useState } from "react";
import { cleartextRpcUrl, LITVM_NETWORK, sanitizeCustomNetwork } from "../../config/networks";
import { isLocaleCode, LOCALES, t } from "../../core/i18n";
import { addCustomNetwork, removeCustomNetwork, type WalletSettings } from "../../core/keyring/vault";
import { isAndroid, isExtension, platform } from "../../core/platform/env";
import { publicClientFor } from "../../core/rpc/client";
import { Button, Icon, Note, Panel, PanelBody, Row, Rows } from "../components/kit";
import { RpcAccessPrompt, requestRpcPermission } from "../components/RpcAccessPrompt";
import { useActionGate } from "../hooks/useActionGate";
import { writeNotifyText } from "../lib/notifyText";
import { actionShortcut } from "../lib/shortcut";
import { Screen } from "../components/Screen";
import { goHome } from "../router";
import { useWallet } from "../state/WalletContext";
import { ChangePassword } from "./settings/ChangePassword";
import { DangerZone } from "./settings/DangerZone";
import { ImportAccount } from "./settings/ImportAccount";
import { ChangeNetworkRpc, LitvmRpcField } from "./settings/NetworkRpc";
import { RevealSecrets } from "./settings/RevealSecrets";
import { releaseRpcPermissionUnlessUsed } from "./settings/rpcRelease";
import { SavedRecipients } from "./settings/SavedRecipients";
import { TokenApprovals } from "./settings/TokenApprovals";
import { TokenManager } from "./settings/TokenManager";

/**
 * Settings. Preferences are written straight through to the vault's settings
 * record — there is no Save button, because a slippage the user changed but did
 * not save is the kind of gap that costs money on the next swap.
 *
 * Language comes first: it is the one setting a user who cannot read the rest of
 * the screen still has to be able to find.
 *
 * LitVM remains the built-in default. Optional custom profiles are validated,
 * saved locally and selected explicitly so a dapp or node cannot repoint the
 * wallet silently.
 */
const LOCK_CHOICES: readonly number[] = [1, 5, 15, 30, 60];
const SLIPPAGE_CHOICES: readonly number[] = [10, 50, 100, 300];

function themeValue(value: string): "dark" | "light" | "system" {
  return value === "light" || value === "system" ? value : "dark";
}

export function Settings(): ReactNode {
  const { network, settings, saveSettings, lockWallet } = useWallet();
  const [saving, setSaving] = useState(false);
  const saveGate = useActionGate();
  const [networkError, setNetworkError] = useState<string | null>(null);
  // The saved network whose inline "Change RPC" form is open (extension only).
  const [changingRpc, setChangingRpc] = useState<string | null>(null);
  // The key Chrome actually bound: the suggested one can be taken by another
  // extension, and the user may have changed it.
  const [shortcut, setShortcut] = useState<string | null>(null);
  useEffect(() => {
    if (!isExtension || typeof chrome.commands?.getAll !== "function") return undefined;
    let live = true;
    chrome.commands.getAll()
      .then((commands) => {
        if (live) setShortcut(actionShortcut(commands));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  const [draft, setDraft] = useState({
    name: "",
    rpcUrl: "",
    chainId: "",
    nativeName: "",
    nativeSymbol: "",
    nativeDecimals: "18",
    explorerUrl: "",
  });

  const runSaving = async (action: () => Promise<boolean>): Promise<boolean> => {
    if (!saveGate.tryEnter()) return false;
    setSaving(true);
    try {
      return await action();
    } catch {
      // WalletContext reports storage failures through the existing toast.
      return false;
    } finally {
      setSaving(false);
      saveGate.leave();
    }
  };

  const persist = (patch: Partial<WalletSettings>): Promise<boolean> => runSaving(async () => {
    await saveSettings(patch);
    return true;
  });

  // Notifications are on only while the setting is on AND Chrome still holds the
  // optional permission (the user can take it back at chrome://extensions).
  const notificationsOffered = isExtension && typeof chrome.permissions?.request === "function";
  const [notifyGranted, setNotifyGranted] = useState<boolean | null>(null);
  const [notifyError, setNotifyError] = useState<string | null>(null);
  useEffect(() => {
    if (!notificationsOffered) return undefined;
    let live = true;
    chrome.permissions.contains({ permissions: ["notifications"] })
      .then((held) => {
        if (live) setNotifyGranted(held);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [notificationsOffered]);
  const notificationsOn = settings.notifications && notifyGranted === true;
  // The worker's text follows the language on screen, which only changes here.
  useEffect(() => {
    if (notificationsOn) void writeNotifyText().catch(() => undefined);
  }, [notificationsOn, settings.locale]);

  const enableNotifications = (): void => {
    const asked = chrome.permissions.request({ permissions: ["notifications"] });
    setNotifyError(null);
    void asked
      .then(async (granted) => {
        setNotifyGranted(granted);
        if (!granted) {
          setNotifyError(t("set.notificationsDenied"));
          return;
        }
        await writeNotifyText().catch(() => undefined);
        await persist({ notifications: true });
      })
      .catch(() => setNotifyError(t("set.notificationsDenied")));
  };

  const disableNotifications = (): void => {
    setNotifyError(null);
    void persist({ notifications: false })
      .then(async (saved) => {
        if (!saved) return;
        // Nothing left uses it, so the extension stops holding it.
        await chrome.permissions.remove({ permissions: ["notifications"] }).catch(() => false);
        setNotifyGranted(false);
      });
  };

  const selectNetwork = async (networkId: string): Promise<void> => {
    const selected = settings.customNetworks.find((entry) => entry.id === networkId);
    await runSaving(async () => {
      // A permission can be revoked from Chrome's extension settings after the
      // profile was saved. Re-check it from this user gesture before selecting
      // the RPC, rather than switching to a network that cannot be read.
      if (selected && !(await requestRpcPermission(selected.rpcUrl))) {
        setNetworkError(t("set.networkPermission"));
        return false;
      }
      setNetworkError(null);
      await saveSettings({ networkId });
      return true;
    });
  };

  const addNetwork = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const candidate = sanitizeCustomNetwork({
      name: draft.name,
      rpcUrl: draft.rpcUrl,
      chainId: draft.chainId,
      explorerUrl: draft.explorerUrl,
      nativeCurrency: {
        name: draft.nativeName || draft.name,
        symbol: draft.nativeSymbol,
        decimals: draft.nativeDecimals,
      },
    });
    if (!candidate) {
      setNetworkError(t("set.networkInvalid"));
      return;
    }
    // The Android shell blocks cleartext, loopback included: the profile would
    // save and then fail every read.
    if (isAndroid && cleartextRpcUrl(candidate.rpcUrl)) {
      setNetworkError(t("set.networkCleartext"));
      return;
    }
    if (
      candidate.chainId === LITVM_NETWORK.chainId
      || settings.customNetworks.some((entry) => entry.chainId === candidate.chainId)
    ) {
      setNetworkError(t("set.networkDuplicate"));
      return;
    }
    const saved = await runSaving(async () => {
      if (!(await requestRpcPermission(candidate.rpcUrl))) {
        setNetworkError(t("set.networkPermission"));
        return false;
      }
      // Re-reads the saved list: the approval window may have added a network
      // on the same host since this screen last read it.
      const releaseUnlessShared = (): Promise<void> => releaseRpcPermissionUnlessUsed(candidate.rpcUrl);
      // Balances come from this RPC while signing uses the typed chain ID. Saved with
      // the two disagreeing, every send fails in a way this form can no longer explain.
      const servesChain = await publicClientFor(candidate).getChainId()
        .then((chainId) => chainId === candidate.chainId, () => false);
      if (!servesChain) {
        await releaseUnlessShared();
        setNetworkError(t("set.networkInvalid"));
        return false;
      }
      setNetworkError(null);
      // The list is written under the settings lock from a fresh read, so a
      // network a dapp proposal saved meanwhile is kept; selecting it goes
      // through saveSettings, which tells connected pages about the switch.
      let outcome: "added" | "exists";
      try {
        outcome = await addCustomNetwork(candidate, { select: false });
      } catch (cause) {
        await releaseUnlessShared();
        setNetworkError(cause instanceof Error ? cause.message : t("set.networkInvalid"));
        return false;
      }
      if (outcome === "exists") {
        await releaseUnlessShared();
        setNetworkError(t("set.networkDuplicate"));
        return false;
      }
      await saveSettings({ networkId: candidate.id });
      return true;
    });
    if (!saved) return;
    setDraft({
      name: "",
      rpcUrl: "",
      chainId: "",
      nativeName: "",
      nativeSymbol: "",
      nativeDecimals: "18",
      explorerUrl: "",
    });
  };

  const removeNetwork = async (id: string): Promise<void> => {
    const removed = settings.customNetworks.find((entry) => entry.id === id);
    const saved = await runSaving(async () => {
      // Leaving the network first goes through saveSettings, which tells
      // connected pages the chain changed; the list itself is then written
      // under the settings lock from a fresh read.
      if (settings.networkId === id) await saveSettings({ networkId: LITVM_NETWORK.id });
      await removeCustomNetwork(id);
      return true;
    });
    if (!saved || !removed) return;
    await releaseRpcPermissionUnlessUsed(removed.rpcUrl);
  };

  return (
    <Screen title={t("set.title")} onBack={goHome}>
      <div className="w-stack w-settings">
        <Panel title={t("set.language")}>
          <PanelBody>
            <label className="w-field">
              <span className="w-label">{t("set.languageLabel")}</span>
              <select
                className="w-select"
                value={settings.locale}
                disabled={saving}
                aria-busy={saving}
                onChange={(event) => {
                  const next = event.target.value;
                  if (isLocaleCode(next)) void persist({ locale: next });
                }}
              >
                {LOCALES.map((info) => (
                  <option key={info.code} value={info.code} lang={info.tag}>
                    {info.label}
                  </option>
                ))}
              </select>
            </label>
            <Note>{t("set.languageNote")}</Note>
          </PanelBody>
        </Panel>

        <Panel title={t("set.appearance")}>
          <PanelBody>
            <div className="w-field w-set-row">
              <span className="w-label" id="set-background">{t("set.background")}</span>
              <div className="w-seg" role="group" aria-labelledby="set-background" aria-busy={saving}>
                {(["dark", "light", "system"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    className="w-seg-item"
                    aria-pressed={themeValue(settings.theme) === value}
                    disabled={saving}
                    onClick={() => {
                      if (themeValue(settings.theme) !== value) void persist({ theme: value });
                    }}
                  >
                    {value === "dark" ? t("set.black") : value === "light" ? t("set.white") : t("set.system")}
                  </button>
                ))}
              </div>
            </div>
            {isExtension ? (
              <Note>
                {shortcut !== null ? t("set.shortcutKey", { key: shortcut }) : t("set.shortcutNone")}
              </Note>
            ) : null}
            {notificationsOffered ? (
              <>
                <div className="w-field w-set-row">
                  <span className="w-label" id="set-notifications">{t("set.notifications")}</span>
                  <div className="w-seg" role="group" aria-labelledby="set-notifications" aria-busy={saving}>
                    {([false, true] as const).map((value) => (
                      <button
                        key={String(value)}
                        type="button"
                        className="w-seg-item"
                        aria-pressed={notificationsOn === value}
                        disabled={saving || notifyGranted === null}
                        onClick={() => {
                          if (notificationsOn === value) return;
                          if (value) enableNotifications();
                          else disableNotifications();
                        }}
                      >
                        {value ? t("set.notifOn") : t("set.notifOff")}
                      </button>
                    ))}
                  </div>
                </div>
                <Note>{t("set.notificationsHint")}</Note>
                {notifyError !== null ? (
                  <div role="alert">
                    <Note tone="error">{notifyError}</Note>
                  </div>
                ) : null}
              </>
            ) : null}
          </PanelBody>
        </Panel>

        <Panel title={t("set.security")}>
          <PanelBody>
            <label className="w-field">
              <span className="w-label">{t("set.autoLock")}</span>
              <select
                className="w-select"
                value={settings.autoLockMinutes}
                disabled={saving}
                aria-busy={saving}
                onChange={(event) => {
                  void persist({ autoLockMinutes: Number(event.target.value) });
                }}
              >
                {LOCK_CHOICES.map((minutes) => (
                  <option key={minutes} value={minutes}>
                    {t("set.lockChoice", { minutes })}
                  </option>
                ))}
              </select>
            </label>
            <Button block disabled={saving} onClick={() => void lockWallet()}>
              {t("set.lockNow")}
              <Icon name="lock" size={16} />
            </Button>
            <Note>{t("set.lockNote")}</Note>
          </PanelBody>
        </Panel>

        <ChangePassword />
        <RevealSecrets />

        <Panel title={t("set.trading")}>
          <PanelBody>
            <label className="w-field">
              <span className="w-label">{t("swap.maxSlippage")}</span>
              <select
                className="w-select"
                value={settings.slippageBps}
                disabled={saving}
                aria-busy={saving}
                onChange={(event) => {
                  void persist({ slippageBps: Number(event.target.value) });
                }}
              >
                {SLIPPAGE_CHOICES.map((bps) => (
                  <option key={bps} value={bps}>
                    {(bps / 100).toFixed(2)}%
                  </option>
                ))}
              </select>
            </label>
            <Note>{t("set.slippageNote")}</Note>
          </PanelBody>
        </Panel>

        <Panel title={t("common.network")}>
          <PanelBody>
            <Rows>
              <Row label={t("common.network")} value={network.name} />
              <Row label="Chain ID" value={network.chainId.toString()} />
              <Row label="RPC" value={new URL(network.rpcUrl).host} />
            </Rows>
            <RpcAccessPrompt rpcUrl={network.rpcUrl} />
            {isExtension ? <LitvmRpcField /> : null}
          </PanelBody>
        </Panel>

        <Panel title={t("set.customNetworks")}>
          <PanelBody>
            <label className="w-field">
              <span className="w-label">{t("set.networkChoose")}</span>
              <select
                className="w-select"
                value={settings.networkId}
                disabled={saving}
                aria-busy={saving}
                onChange={(event) => {
                  void selectNetwork(event.target.value);
                }}
              >
                <option value={LITVM_NETWORK.id}>{LITVM_NETWORK.name}</option>
                {settings.customNetworks.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name} · {entry.chainId}
                  </option>
                ))}
              </select>
            </label>
            {settings.customNetworks.map((entry) => (
              <Fragment key={entry.id}>
                <div className="w-split w-network-row">
                  <span className="w-asset-main">
                    <span className="w-asset-symbol">{entry.name}</span>
                    <span className="w-asset-sub">
                      {entry.chainId} · {new URL(entry.rpcUrl).host}
                    </span>
                  </span>
                  <span className="w-network-actions">
                    {isExtension ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={saving}
                        aria-expanded={changingRpc === entry.id}
                        onClick={() => setChangingRpc((open) => (open === entry.id ? null : entry.id))}
                      >
                        {t("set.changeRpc")}
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={saving}
                      onClick={() => void removeNetwork(entry.id)}
                    >
                      {t("common.remove")}
                    </Button>
                  </span>
                </div>
                {isExtension && changingRpc === entry.id ? (
                  <ChangeNetworkRpc entry={entry} onDone={() => setChangingRpc(null)} />
                ) : null}
              </Fragment>
            ))}
            {networkError !== null ? (
              <div role="alert">
                <Note tone="error">{networkError}</Note>
              </div>
            ) : null}
            <details className="w-disclosure">
              <summary>{t("set.addNetwork")}</summary>
              <div className="w-disclosure-body">
                <form className="w-network-form" onSubmit={(event) => void addNetwork(event)}>
                  <label className="w-field">
                    <span className="w-label">{t("set.networkName")}</span>
                    <input
                      className="w-input"
                      value={draft.name}
                      disabled={saving}
                      autoComplete="off"
                      onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                    />
                  </label>
                  <label className="w-field">
                    <span className="w-label">{t("set.rpcUrl")}</span>
                    <input
                      className="w-input"
                      value={draft.rpcUrl}
                      disabled={saving}
                      inputMode="url"
                      autoComplete="url"
                      placeholder="https://…"
                      onChange={(event) => setDraft((current) => ({ ...current, rpcUrl: event.target.value }))}
                    />
                  </label>
                  <div className="w-form-grid">
                    <label className="w-field">
                      <span className="w-label">{t("set.chainId")}</span>
                      <input
                        className="w-input"
                        value={draft.chainId}
                        disabled={saving}
                        inputMode="numeric"
                        onChange={(event) => setDraft((current) => ({ ...current, chainId: event.target.value }))}
                      />
                    </label>
                    <label className="w-field">
                      <span className="w-label">{t("set.nativeSymbol")}</span>
                      <input
                        className="w-input"
                        value={draft.nativeSymbol}
                        disabled={saving}
                        autoComplete="off"
                        onChange={(event) => setDraft((current) => ({ ...current, nativeSymbol: event.target.value }))}
                      />
                    </label>
                  </div>
                  <div className="w-form-grid">
                    <label className="w-field">
                      <span className="w-label">{t("set.nativeName")}</span>
                      <input
                        className="w-input"
                        value={draft.nativeName}
                        disabled={saving}
                        autoComplete="off"
                        onChange={(event) => setDraft((current) => ({
                          ...current,
                          nativeName: event.target.value,
                        }))}
                      />
                    </label>
                    <label className="w-field">
                      <span className="w-label">{t("tok.decimals")}</span>
                      <input
                        className="w-input"
                        value={draft.nativeDecimals}
                        disabled={saving}
                        inputMode="numeric"
                        autoComplete="off"
                        onChange={(event) => setDraft((current) => ({
                          ...current,
                          nativeDecimals: event.target.value,
                        }))}
                      />
                    </label>
                  </div>
                  <label className="w-field">
                    <span className="w-label">{t("set.explorerUrl")}</span>
                    <input
                      className="w-input"
                      value={draft.explorerUrl}
                      disabled={saving}
                      inputMode="url"
                      autoComplete="url"
                      placeholder="https://…"
                      onChange={(event) => setDraft((current) => ({ ...current, explorerUrl: event.target.value }))}
                    />
                  </label>
                  <Button type="submit" variant="primary" block disabled={saving}>
                    {saving ? t("common.working") : t("set.addNetwork")}
                  </Button>
                </form>
              </div>
            </details>
            <Note>{t("set.networkNote")}</Note>
            <Note tone="warn">{t("set.customNetworkNote")}</Note>
          </PanelBody>
        </Panel>

        <TokenManager />
        <SavedRecipients />
        {isExtension ? <TokenApprovals /> : null}
        <ImportAccount />

        <DangerZone />

        <p className="w-set-version">
          {t("set.build")} {__WALLET_VERSION__} ·{" "}
          {platform === "extension" ? "Extension" : platform === "android" ? "Android" : "Web"}
        </p>
      </div>
    </Screen>
  );
}
