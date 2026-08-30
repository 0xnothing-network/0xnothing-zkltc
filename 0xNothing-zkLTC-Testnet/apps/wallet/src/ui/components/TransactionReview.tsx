import { type ReactNode, useEffect, useId } from "react";
import { t } from "../../core/i18n";
import { Button, Note } from "./kit";

export function TransactionReview({
  title,
  busy,
  ready,
  hero,
  children,
  confirmLabel = t("swap.confirmSubmit"),
  onClose,
  onConfirm,
}: {
  title: string;
  busy: boolean;
  ready: boolean;
  hero?: ReactNode;
  children: ReactNode;
  confirmLabel?: string;
  onClose: () => void;
  onConfirm: () => void;
}): ReactNode {
  const titleId = useId();

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  return (
    <div
      className="w-sheet"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <div
        className="w-sheet-body w-swap-review"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={busy}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="w-sheet-head">
          <span id={titleId}>{title}</span>
          <button
            type="button"
            className="w-back"
            disabled={busy}
            aria-label={t("common.close")}
            onClick={onClose}
          >
            ✕
          </button>
        </header>
        {hero}
        <div className="w-panel-body">
          {children}
          <Note tone="warn">{t("swap.reviewNotice")}</Note>
          <div className="w-btn-row">
            <Button type="button" disabled={busy} onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="primary"
              disabled={busy || !ready}
              onClick={onConfirm}
            >
              {busy ? t("common.working") : confirmLabel}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
