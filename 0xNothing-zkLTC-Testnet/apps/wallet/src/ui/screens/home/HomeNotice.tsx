import { type ReactNode, useEffect, useState } from "react";
import { isLitvmNetwork } from "../../../config/networks";
import { t } from "../../../core/i18n";
import { isExtension } from "../../../core/platform/env";
import { listRecords } from "../../../core/services/history";
import type { Portfolio } from "../../../core/services/portfolio";
import { Button } from "../../components/kit";
import { firstRunDue, homeSlot } from "../../lib/homeSlot";
import { loadSeenVersion, markVersionSeen } from "../../lib/uiMemoryStore";
import { newsLines, whatsNewDue } from "../../lib/whatsNew";
import { navigate } from "../../router";
import { useWallet } from "../../state/WalletContext";

const VERSION = __WALLET_VERSION__;

/**
 * The one card slot under the balance: "What is new" once after an update,
 * otherwise the first-run pointers while the wallet is empty and has never
 * sent anything. The history read is storage only.
 */
export function HomeNotice({
  portfolio,
  failed,
}: {
  portfolio: Portfolio | null;
  failed: boolean;
}): ReactNode {
  const { address, network, tick } = useWallet();
  const [lines] = useState(() => newsLines(VERSION, isExtension));
  // Null until read: nothing shows before the store has answered.
  const [newsDue, setNewsDue] = useState<boolean | null>(null);
  const [historyCount, setHistoryCount] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    void loadSeenVersion().then((stored) => {
      if (live) setNewsDue(whatsNewDue(stored, VERSION, lines.length));
    });
    return () => {
      live = false;
    };
  }, [lines.length]);

  useEffect(() => {
    setHistoryCount(null);
  }, [address, network.id]);

  useEffect(() => {
    if (!address) return undefined;
    let live = true;
    listRecords(address, network)
      .then((records) => {
        if (live) setHistoryCount(records.length);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [address, network, tick]);

  if (newsDue === null) return null;
  const slot = homeSlot(newsDue, firstRunDue(portfolio, failed, historyCount));

  if (slot === "news") {
    return (
      <section className="w-home-card" aria-labelledby="home-news-title">
        <h2 className="w-home-card-title" id="home-news-title">{t("news.title", { version: VERSION })}</h2>
        <ul className="w-home-card-list">
          {lines.map((line) => <li key={line.key}>{t(line.key)}</li>)}
        </ul>
        <div className="w-home-card-actions">
          <Button
            size="sm"
            onClick={() => {
              setNewsDue(false);
              void markVersionSeen(VERSION);
            }}
          >
            {t("common.done")}
          </Button>
        </div>
      </section>
    );
  }

  if (slot === "first") {
    return (
      <section className="w-home-card" aria-labelledby="home-first-title">
        <h2 className="w-home-card-title" id="home-first-title">{t("home.firstTitle")}</h2>
        <p className="w-home-card-body">{t("home.firstBody")}</p>
        <div className="w-home-card-actions">
          <Button size="sm" onClick={() => navigate("#/receive")}>{t("home.receive")}</Button>
          {/* NUSD lives on LiteForge only; a custom network gets Receive alone. */}
          {isLitvmNetwork(network)
            ? <Button size="sm" onClick={() => navigate("#/mint")}>{t("home.mint")}</Button>
            : null}
        </div>
      </section>
    );
  }

  return null;
}
