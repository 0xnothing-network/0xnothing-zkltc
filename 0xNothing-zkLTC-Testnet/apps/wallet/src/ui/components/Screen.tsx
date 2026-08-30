import type { ReactNode } from "react";
import { t } from "../../core/i18n";

/**
 * Header plus scrolling body. Every screen except HOME uses the back arrow, so
 * the popup never becomes a place the user is stuck in — there is no browser
 * chrome around it to escape with.
 */
export function Screen({
  title,
  onBack,
  right,
  children,
}: {
  title: string;
  onBack?: () => void;
  right?: ReactNode;
  children: ReactNode;
}): ReactNode {
  return (
    <div className="w-screen">
      <header className="w-head">
        {onBack ? (
          <button type="button" className="w-back" onClick={onBack} aria-label={t("screen.backAria")}>
            ←
          </button>
        ) : null}
        <div className="w-head-main">
          <h1 className="w-head-title">{title}</h1>
        </div>
        {right}
      </header>
      <div className="w-body">{children}</div>
    </div>
  );
}
