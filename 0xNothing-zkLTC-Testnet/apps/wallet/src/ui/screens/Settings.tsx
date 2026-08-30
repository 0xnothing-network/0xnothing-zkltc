import { type FormEvent, type ReactNode, useState } from "react";
import { LITVM_NETWORK, sanitizeCustomNetwork } from "../../config/networks";
import { isLocaleCode, LOCALES, t } from "../../core/i18n";
import type { WalletSettings } from "../../core/keyring/vault";
import { isExtension, platform } from "../../core/platform/env";
import { Button, Note, Panel, PanelBody, Row, Rows } from "../components/kit";
import { useActionGate } from "../hooks/useActionGate";
import { Screen } from "../components/Screen";
import { goHome } from "../router";
import { useWallet } from "../state/WalletContext";
import { ChangePassword } from "./settings/ChangePassword";
import { DangerZone } from "./settings/DangerZone";
import { ImportAccount } from "./settings/ImportAccount";
import { RevealSecrets } from "./settings/RevealSecrets";
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

function themeValue(value: string): "dark" | "light" {
  return value === "light" ? "light" : "dark";
}

async function requestRpcPermission(rpcUrl: string): Promise<boolean> {
  if (!isExtension || typeof chrome === "undefined" || !chrome.permissions?.request) return true;
  try {
    const origin = new URL(rpcUrl).origin;
    return await chrome.permissions.request({ origins: [`${origin}/*`] });
  } catch {
    return false;
  }
}

export function Settings(): ReactNode {
  const { network, settings, saveSettings, lockWallet } = useWallet();
  const [saving, setSaving] = useState(false);
  const saveGate = useActionGate();
  const [networkError, setNetworkError] = useState<string | null>(null);
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
      setNetworkError(null);
      await saveSettings({
        customNetworks: [...settings.customNetworks, candidate],
        networkId: candidate.id,
      });
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
    const next = settings.customNetworks.filter((entry) => entry.id !== id);
    await persist({
      customNetworks: next,
      networkId: settings.networkId === id ? LITVM_NETWORK.id : settings.networkId,
    });
  };

  return (
    <Screen title={t("set.title")} onBack={goHome}>
      <div className="w-stack">
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
            <label className="w-field">
              <span className="w-label">{t("set.background")}</span>
              <select
                className="w-select"
                value={settings.theme}
                disabled={saving}
                aria-busy={saving}
                onChange={(event) => {
                  void persist({ theme: themeValue(event.target.value) });
                }}
              >
                <option value="dark">{t("set.black")}</option>
                <option value="light">{t("set.white")}</option>
              </select>
            </label>
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
            </Button>
            <Note>{t("set.lockNote")}</Note>
          </PanelBody>
        </Panel>

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
                  setNetworkError(null);
                  void persist({ networkId: event.target.value });
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
            <Note>{t("set.networkNote")}</Note>
            <Note tone="warn">{t("set.customNetworkNote")}</Note>
            {settings.customNetworks.map((entry) => (
              <div key={entry.id} className="w-split w-network-row">
                <span className="w-asset-main">
                  <span className="w-asset-symbol">{entry.name}</span>
                  <span className="w-asset-sub">
                    {entry.chainId} · {new URL(entry.rpcUrl).host}
                  </span>
                </span>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={saving}
                  onClick={() => void removeNetwork(entry.id)}
                >
                  {t("common.remove")}
                </Button>
              </div>
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
                  <label className="w-field">
                    <span className="w-label">{t("set.nativeName")}</span>
                    <input
                      className="w-input"
                      value={draft.nativeName}
                      disabled={saving}
                      autoComplete="off"
                      onChange={(event) => setDraft((current) => ({ ...current, nativeName: event.target.value }))}
                    />
                  </label>
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
          </PanelBody>
        </Panel>

        <ImportAccount />
        <TokenManager />
        <RevealSecrets />
        <ChangePassword />

        <Panel title={t("common.network")}>
          <PanelBody>
            <Rows>
              <Row label={t("common.network")} value={network.name} />
              <Row label="Chain ID" value={network.chainId.toString()} />
              <Row label="RPC" value={new URL(network.rpcUrl).host} />
              <Row
                label={t("set.build")}
                value={`${__WALLET_VERSION__} · ${
                  platform === "extension" ? "Extension" : platform === "android" ? "Android" : "Web"
                }`}
              />
            </Rows>
          </PanelBody>
        </Panel>

        <DangerZone />
      </div>
    </Screen>
  );
}
