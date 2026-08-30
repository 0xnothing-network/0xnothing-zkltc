import { type ReactNode, useEffect, useState } from "react";
import { type MessageKey, t } from "../../core/i18n";
import { accountLabel } from "../../core/keyring/vault";
import {
  formatSignedPercent,
  formatUsdWad,
  shortenAddress,
} from "../../core/lib/format";
import { AccountSheet } from "../components/AccountSheet";
import { Button, Note } from "../components/kit";
import { useCopy } from "../hooks/useCopy";
import { usePortfolio } from "../hooks/usePortfolio";
import { navigate } from "../router";
import { useWallet } from "../state/WalletContext";
import { AssetList } from "./home/AssetList";
import { NftGrid } from "./home/NftGrid";

/**
 * HOME, laid out as the wireframe: the account title with its copyable address,
 * the total with its 24h move and `mint NUSD`, the four actions, then the
 * TOKEN / NFT / RWA list. There is no refresh control anywhere — the block
 * ticker reloads the panels by itself.
 */
type Tab = "token" | "nft" | "rwa";

const ACTIONS: readonly { label: MessageKey; glyph: string; path: string }[] = [
  { label: "home.send", glyph: "↑", path: "#/send" },
  { label: "home.receive", glyph: "↓", path: "#/receive" },
  { label: "home.history", glyph: "≡", path: "#/history" },
  { label: "home.stake", glyph: "◇", path: "#/lend" },
];

export function Home(): ReactNode {
  const { active, address, notify } = useWallet();
  const { copied, copy } = useCopy();
  const { portfolio, change, changeLoading, error, loading } = usePortfolio();
  const [tab, setTab] = useState<Tab>("token");
  const [nftOpened, setNftOpened] = useState(false);
  const [sheet, setSheet] = useState(false);

  useEffect(() => {
    setSheet(false);
  }, [address]);

  const tone = change === null || change === 0 ? undefined : change > 0 ? "up" : "down";

  return (
    <div className="w-screen">
      <header className="w-head">
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
              ▾
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
            <span aria-hidden="true">{copied ? "✓" : "⧉"}</span>
          </button>
        </div>
        <Button size="sm" aria-label={t("home.settingsAria")} onClick={() => navigate("#/settings")}>
          ⚙
        </Button>
      </header>

      <div className="w-body">
        <div className="w-total-block" aria-busy={loading}>
          <div className="w-total-row">
            <span className="w-total">
              {portfolio ? formatUsdWad(portfolio.totalWad) : loading ? "…" : "—"}
            </span>
            <span className="w-delta" data-tone={tone}>
              {t("home.delta24h")} {change === null
                ? changeLoading ? "…" : "--"
                : formatSignedPercent(change)}
            </span>
          </div>
          <div className="w-total-foot">
            <span className="w-total-note">{t("home.total")}</span>
            <Button size="sm" variant="primary" onClick={() => navigate("#/mint")}>
              {t("home.mint")}
            </Button>
          </div>
          {error !== null ? <Note tone="error">{error}</Note> : null}
        </div>

        <div className="w-actions">
          {ACTIONS.map((action) => (
            <a
              key={action.path}
              className="w-action"
              href={action.path}
            >
              <span className="w-action-glyph" aria-hidden="true">
                {action.glyph}
              </span>
              {t(action.label)}
            </a>
          ))}
        </div>
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
                setTab(name);
                if (name === "nft") setNftOpened(true);
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
          <div className="w-stack">
            <div className="w-empty">
              <span>RWA</span>
              <span>{t("home.rwaSoon")}</span>
            </div>
            <Note>{t("home.rwaNote")}</Note>
          </div>
        </div>
      </div>

      {sheet ? <AccountSheet onClose={() => setSheet(false)} /> : null}
    </div>
  );
}
