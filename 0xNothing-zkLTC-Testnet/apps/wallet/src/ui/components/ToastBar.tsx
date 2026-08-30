import type { ReactNode } from "react";
import { t } from "../../core/i18n";
import { openExternal } from "../../core/platform/env";
import { useWallet } from "../state/WalletContext";

/**
 * One toast at a time, over the bottom of the surface. A transaction toast
 * carries its explorer link, because the wallet's own history is only what it
 * submitted itself — the chain is the record.
 */
export function ToastBar(): ReactNode {
  const { toast, dismiss } = useWallet();
  if (!toast) return null;

  return (
    <output className="w-toast" data-tone={toast.tone} aria-live="polite">
      {toast.message}
      {toast.href ? (
        <>
          {" · "}
          <a
            href={toast.href}
            onClick={(event) => {
              event.preventDefault();
              dismiss();
              void openExternal(toast.href!);
            }}
          >
            {t("common.explorer")}
          </a>
        </>
      ) : null}
    </output>
  );
}
