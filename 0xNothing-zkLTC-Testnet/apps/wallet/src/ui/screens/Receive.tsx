import { useEffect, useState, type ReactNode } from "react";
import { addressUrl } from "../../config/chain";
import { t } from "../../core/i18n";
import { accountLabel } from "../../core/keyring/vault";
import { openExternal } from "../../core/platform/env";
import { Button, Empty, Note } from "../components/kit";
import { Screen } from "../components/Screen";
import { useCopy } from "../hooks/useCopy";
import { goHome } from "../router";
import { useWallet } from "../state/WalletContext";

/**
 * Three readable rows keep the whole address visible without a cramped grid:
 * two 8-character groups a row, spaced by the stylesheet rather than a typed
 * space, so a selected address still copies as one unbroken string.
 */
function groups(address: string): string[][] {
  const rows: string[][] = [];
  for (let at = 0; at < address.length; at += 16) {
    const row = address.slice(at, at + 16);
    rows.push([row.slice(0, 8), row.slice(8)].filter(Boolean));
  }
  return rows;
}

function saveQr(dataUrl: string, address: string): void {
  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = `0xwallet-${address.slice(2, 10).toLowerCase()}.png`;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export function Receive(): ReactNode {
  const { active, address, network, notify } = useWallet();
  const { copied, copy } = useCopy();
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrLoading, setQrLoading] = useState(address !== null);

  useEffect(() => {
    let cancelled = false;
    setQrDataUrl(null);
    setQrLoading(address !== null);
    if (!address) {
      return () => {
        cancelled = true;
      };
    }
    // QR is only needed on this screen. Keeping it out of the startup graph
    // makes the popup's common path smaller while preserving the same output.
    void import("qrcode")
      .then(({ default: QRCode }) =>
        QRCode.toDataURL(address, {
          errorCorrectionLevel: "M",
          margin: 1,
          width: 208,
        }),
      )
      .then((dataUrl) => {
        if (!cancelled) {
          setQrDataUrl(dataUrl);
          setQrLoading(false);
        }
      })
      .catch(() => {
        // The address remains available for copying if QR generation ever fails.
        if (!cancelled) setQrLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [address]);

  if (!address) {
    return (
      <Screen title={t("recv.title")} onBack={goHome}>
        <Empty>{t("recv.noWallet")}</Empty>
      </Screen>
    );
  }

  return (
    <Screen title={t("recv.title")} onBack={goHome}>
      <div className="w-receive w-recv" aria-busy={qrLoading}>
        <section className="w-receive-card">
          <span className="w-receive-account">
            {active ? accountLabel(active) : t("account.main")}
            <span className="w-receive-network"> · {network.name}</span>
          </span>
          {qrDataUrl ? (
            <div className="w-receive-qr">
              <img
                src={qrDataUrl}
                width={208}
                height={208}
                alt={`${t("recv.title")} QR`}
              />
            </div>
          ) : qrLoading ? (
            <div className="w-receive-loading">
              <Note>{t("common.working")}</Note>
            </div>
          ) : null}
          <div className="w-addr-block">
            {groups(address).map((row, index) => (
              <span key={`${row.join("")}-${index}`} className="w-addr-row">
                {row.map((chunk, part) => (
                  <span key={part}>{chunk}</span>
                ))}
              </span>
            ))}
          </div>
        </section>
        <div className="w-btn-row">
          <Button
            onClick={() => void copy(address).then((ok) => {
              if (!ok) notify(t("common.copyFailed"), "error");
            })}
          >
            {copied ? `${t("common.copied")} ✓` : t("recv.copyAddress")}
          </Button>
          {qrDataUrl ? (
            <Button onClick={() => saveQr(qrDataUrl, address)}>
              {t("common.save")} QR
            </Button>
          ) : null}
        </div>
        {network.explorerUrl ? (
          <Button variant="ghost" size="sm" onClick={() => void openExternal(addressUrl(address, network))}>
            {t("recv.viewExplorer")} ↗
          </Button>
        ) : null}
        <Note tone="warn">{t("recv.warning", { network: network.name })}</Note>
      </div>
    </Screen>
  );
}
