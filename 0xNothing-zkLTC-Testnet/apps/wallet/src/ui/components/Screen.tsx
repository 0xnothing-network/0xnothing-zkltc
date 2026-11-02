import type { ReactNode } from "react";
import { t } from "../../core/i18n";
import { Icon } from "./kit";

/**
 * Header plus scrolling body. Every screen except HOME uses the back arrow, so
 * the popup never becomes a place the user is stuck in — there is no browser
 * chrome around it to escape with.
 *
 * `step` puts a "2 / 3" counter where the aside goes; `bare` drops the header
 * for the first-run and lock screens, whose wordmark is their heading.
 */
export function Screen({
  title,
  onBack,
  right,
  step,
  bare = false,
  children,
}: {
  title: string;
  onBack?: () => void;
  right?: ReactNode;
  step?: string;
  bare?: boolean;
  children: ReactNode;
}): ReactNode {
  return (
    <div className="w-screen" data-bare={bare ? "true" : undefined}>
      {bare ? null : (
        <header className="w-head">
          {onBack ? (
            <button type="button" className="w-back" onClick={onBack} aria-label={t("screen.backAria")}>
              <Icon name="back" size={20} />
            </button>
          ) : null}
          <div className="w-head-main">
            <h1 className="w-head-title">{title}</h1>
          </div>
          {right ?? (step === undefined ? null : <span className="w-head-step">{step}</span>)}
        </header>
      )}
      <div className="w-body">{children}</div>
    </div>
  );
}
