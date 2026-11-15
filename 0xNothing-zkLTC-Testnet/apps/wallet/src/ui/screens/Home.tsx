import { type ReactNode, useEffect, useRef, useState } from "react";
import { formatUnits } from "viem";
import { NUSD_TOKEN } from "../../config/assets";
import { isLitvmNetwork } from "../../config/networks";
import { type MessageKey, t } from "../../core/i18n";
import { accountLabel } from "../../core/keyring/vault";
import {
  formatSignedPercent,
  formatUsdWad,
  shortenAddress,
} from "../../core/lib/format";
import { AccountSheet } from "../components/AccountSheet";
import { Identicon } from "../components/Identicon";
import { Button, Icon, type IconName, Note } from "../components/kit";
import { RpcAccessPrompt } from "../components/RpcAccessPrompt";
import { StagedSwapPrompt } from "../components/StagedSwapPrompt";
import { useCopy } from "../hooks/useCopy";
import { usePortfolio } from "../hooks/usePortfolio";
import { maskBalance } from "../lib/balanceMask";
import type { HomeTab } from "../lib/uiMemory";
import { loadHomeTab, saveHomeTab } from "../lib/uiMemoryStore";
import { navigate } from "../router";
import { useWallet } from "../state/WalletContext";
import { AssetList } from "./home/AssetList";
import { HomeNotice } from "./home/HomeNotice";
import { NftGrid } from "./home/NftGrid";
import { PendingTxs } from "./home/PendingTxs";
import { RwaList } from "./home/RwaList";

/**
 * HOME, laid out as the wireframe: the account title with its copyable address,
 * the total with its 24h move and `mint NUSD`, the four actions, then the
 * TOKEN / NFT / RWA list. There is no refresh control anywhere — the block
 * ticker reloads the panels by itself.
 */
type Tab = HomeTab;

const ACTIONS: readonly { label: MessageKey; icon: IconName; path: string }[] = [
  { label: "home.send", icon: "send", path: "#/send" },
  { label: "home.receive", icon: "receive", path: "#/receive" },
  { label: "home.history", icon: "history", path: "#/history" },
  { label: "home.stake", icon: "stake", path: "#/earn" },
];

export function Home(): ReactNode {
  const { active, address, network, notify, settings, saveSettings } = useWallet();
  const hidden = settings.hideBalances;
  // A custom network has no protocol screens and its own gas coin: say so on
  // the chip, so a forgotten switch is seen before a send on the wrong chain.
  const custom = !isLitvmNetwork(network);
  const { copied, copy } = useCopy();
  const { portfolio, change, changeLoading, error, loading } = usePortfolio();
  const [tab, setTab] = useState<Tab>("token");
  const [nftOpened, setNftOpened] = useState(false);
  const [sheet, setSheet] = useState(false);
  // A tab picked before the stored one is read wins over it.
  const tabPickedRef = useRef(false);

  useEffect(() => {
    setSheet(false);
  }, [address]);

  // Come back to the tab last picked.
  useEffect(() => {
    let live = true;
    void loadHomeTab().then((stored) => {
      if (!live || stored === null || tabPickedRef.current) return;
      setTab(stored);
      if (stored === "nft") setNftOpened(true);
    });
    return () => {
      live = false;
    };
  }, []);

  const tone = change === null || change === 0 ? undefined : change > 0 ? "up" : "down";

  return (
    <div className="w-screen w-home">
      <header className="w-head">
        <span className="w-avatar" aria-hidden="true">
          {address
            ? <Identicon address={address} size={24} />
            : (active ? accountLabel(active) : t("account.main")).slice(0, 1).toUpperCase()}
        </span>
        <div className="w-head-main">
          <button
            type="button"
            className="w-head-title"
            aria-expanded={sheet}
            aria-haspopup="dialog"
            onClick={() => setSheet(true)}
          >
            {active ? accountLabel(active) : t("account.main")}
            <span className="w-head-caret" aria-hidden="true">
              <Icon name="caret" size={14} />
            </span>
          </button>
          <button
            type="button"
            className="w-address"
            data-copied={copied ? "true" : "false"}
            aria-label={t("home.copyAria")}
            onClick={() => {
              if (!address) return;
              void copy(address).then((ok) => {
                if (!ok) notify(t("common.copyFailed"), "error");
              });
            }}
          >
            {address ? shortenAddress(address, 8, 6) : "—"}
            <Icon name={copied ? "check" : "copy"} size={12} />
          </button>
        </div>
        <span className="w-net-chip" data-custom={custom ? "true" : undefined}>
          <i className="w-dot" aria-hidden="true" />
          {custom ? `${network.name} · ${t("home.customNet")}` : network.name}
        </span>
        <button type="button" className="w-back" aria-label={t("home.settingsAria")} onClick={() => navigate("#/settings")}>
          <Icon name="settings" size={16} />
        </button>
      </header>

      <div className="w-body">
        <div className="w-total-block" aria-busy={loading}>
          <div className="w-total-row">
            <span className="w-total-line">
              <span className="w-total">
                {portfolio ? maskBalance(hidden, formatUsdWad(portfolio.totalWad)) : loading ? "…" : "—"}
              </span>
              <button
                type="button"
                className="w-total-eye"
                aria-pressed={hidden}
                aria-label={hidden ? t("home.showBalances") : t("home.hideBalances")}
                title={hidden ? t("home.showBalances") : t("home.hideBalances")}
                onClick={() => void saveSettings({ hideBalances: !hidden }).catch(() => undefined)}
              >
                <Icon name={hidden ? "eyeOff" : "eye"} size={14} />
              </button>
            </span>
            {change !== null || changeLoading ? (
              <span className="w-delta" data-tone={tone}>
                {change === null ? "…" : formatSignedPercent(change)} {t("home.delta24h")}
              </span>
            ) : null}
          </div>
          <div className="w-total-foot">
            <span className="w-total-note">{t("home.total")}</span>
            <Button size="sm" variant="primary" onClick={() => navigate("#/mint")}>
              {t("home.mint")}
            </Button>
          </div>
          {error !== null ? <Note tone="error">{error}</Note> : null}
        </div>
        <HomeNotice portfolio={portfolio} failed={error !== null} />

        <div className="w-actions">
          {ACTIONS.map((action) => (
            <a
              key={action.path}
              className="w-action"
              href={action.path}
            >
              <span className="w-action-glyph" aria-hidden="true">
                <Icon name={action.icon} size={16} />
              </span>
              {t(action.label)}
            </a>
          ))}
        </div>
        <RpcAccessPrompt rpcUrl={network.rpcUrl} />
        <StagedSwapPrompt
          address={address}
          networkKey={`${network.id}:${network.rpcUrl}`}
          onFinish={(pending) => {
            const params = new URLSearchParams({
              finish: pending.tokenOutId,
              amount: formatUnits(pending.delivered, NUSD_TOKEN.decimals),
            });
            navigate(`#/swap?${params.toString()}`);
          }}
        />
        <PendingTxs />
        <div className="w-tabs" role="tablist" aria-label={t("home.tabsAria")}>
          {(
            [
              ["token", t("common.token")],
              ["nft", "NFT"],
              ["rwa", "RWA"],
            ] as const
          ).map(([name, label]) => (
            <button
              key={name}
              type="button"
              role="tab"
              className="w-tab"
              id={`home-tab-${name}`}
              aria-controls={`home-panel-${name}`}
              aria-selected={tab === name}
              onClick={() => {
                tabPickedRef.current = true;
                setTab(name);
                if (name === "nft") setNftOpened(true);
                saveHomeTab(name);
              }}
            >
              {label}
            </button>
          ))}
        </div>

        <div
          id="home-panel-token"
          role="tabpanel"
          aria-labelledby="home-tab-token"
          hidden={tab !== "token"}
        >
          <AssetList
            rows={portfolio?.rows ?? []}
            loading={loading}
            failed={error !== null}
            hidden={hidden}
          />
        </div>
        <div
          id="home-panel-nft"
          role="tabpanel"
          aria-labelledby="home-tab-nft"
          hidden={tab !== "nft"}
        >
          {nftOpened ? <NftGrid /> : null}
        </div>
        <div
          id="home-panel-rwa"
          role="tabpanel"
          aria-labelledby="home-tab-rwa"
          hidden={tab !== "rwa"}
        >
          {tab === "rwa" ? <RwaList hidden={hidden} /> : null}
        </div>
      </div>

      {sheet ? <AccountSheet onClose={() => setSheet(false)} /> : null}
    </div>
  );
}
