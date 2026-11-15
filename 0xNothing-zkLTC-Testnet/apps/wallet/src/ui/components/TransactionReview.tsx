import { type ReactNode, useEffect, useId, useState } from "react";
import { t } from "../../core/i18n";
import { useReviewArm } from "../hooks/useReviewArm";
import { useSheetFocus } from "../hooks/useSheetFocus";
import { backdropCloseAllowed } from "../lib/armTimer";
import { Button, Icon, Note } from "./kit";

export function TransactionReview({
  title,
  busy,
  ready,
  hero,
  children,
  confirmLabel = t("swap.confirmSubmit"),
  error = null,
  armKey = "review",
  onClose,
  onConfirm,
}: {
  title: string;
  busy: boolean;
  ready: boolean;
  hero?: ReactNode;
  children: ReactNode;
  confirmLabel?: string;
  error?: string | null;
  /** Identity of the reviewed values; a new one disarms Confirm again. */
  armKey?: string;
  onClose: () => void;
  onConfirm: () => void;
}): ReactNode {
  const titleId = useId();
  const armed = useReviewArm(armKey);
  const [shownAt] = useState(() => Date.now());
  const sheetRef = useSheetFocus<HTMLDivElement>();

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
        if (!busy && backdropCloseAllowed(shownAt, Date.now())) onClose();
      }}
    >
      <div
        ref={sheetRef}
        className="w-sheet-body w-swap-review"
        role="dialog"
        tabIndex={-1}
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
            <Icon name="close" size={16} />
          </button>
        </header>
        {hero}
        <div className="w-panel-body">
          {children}
          <Note>{t("swap.reviewNotice")}</Note>
          {/* A failed signature stays on this sheet; the bar behind it is covered. */}
          {error ? (
            <div role="alert">
              <Note tone="error">{error}</Note>
            </div>
          ) : null}
          <div className="w-btn-row">
            <Button type="button" disabled={busy} onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="primary"
              disabled={busy || !ready || !armed}
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
