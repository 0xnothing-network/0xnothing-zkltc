import { useEffect, useState, type ReactNode } from "react";
import { addressUrl } from "../../config/chain";
import { t } from "../../core/i18n";
import { openExternal } from "../../core/platform/env";
import { Button, Empty, Note } from "../components/kit";
import { Screen } from "../components/Screen";
import { useCopy } from "../hooks/useCopy";
import { goHome } from "../router";
import { useWallet } from "../state/WalletContext";

/** Three readable rows keep the whole address visible without a cramped grid. */
function groups(address: string): string[] {
  return [address.slice(0, 14), address.slice(14, 28), address.slice(28)].filter(Boolean);
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
  const { address, network, notify } = useWallet();
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
      <div className="w-receive" aria-busy={qrLoading}>
        <section className="w-receive-card">
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
          <span className="w-receive-network">{network.name}</span>
          <div className="w-addr-block">
            {groups(address).map((chunk, index) => (
              <span key={`${chunk}-${index}`}>{chunk}</span>
            ))}
          </div>
        </section>
        <Button
          variant="primary"
          block
          onClick={() => void copy(address).then((ok) => {
            if (!ok) notify(t("common.copyFailed"), "error");
          })}
        >
          {copied ? `${t("common.copied")} ✓` : t("recv.copyAddress")}
        </Button>
        {qrDataUrl || network.explorerUrl ? (
          <div className="w-btn-row">
            {qrDataUrl ? (
              <Button onClick={() => saveQr(qrDataUrl, address)}>
                {t("common.save")} QR
              </Button>
            ) : null}
            {network.explorerUrl ? (
              <Button onClick={() => void openExternal(addressUrl(address, network))}>
                {t("recv.viewExplorer")}
              </Button>
            ) : null}
          </div>
        ) : null}
        <Note>{t("recv.warning", { network: network.name })}</Note>
      </div>
    </Screen>
  );
}
