import { type ReactNode, useEffect, useState, useSyncExternalStore } from "react";
import { t } from "../../core/i18n";
import { openExternal } from "../../core/platform/env";
import { currentToast, dismissToast, subscribeToast, TOAST_MS } from "../state/toastStore";
import { Icon } from "./kit";

/**
 * One toast at a time, over the bottom of the surface. A transaction toast
 * carries its explorer link, because the wallet's own history is only what it
 * submitted itself — the chain is the record.
 *
 * It does not go away while the pointer is over it or focus is inside it (the
 * user is reading it or reaching for its link), and it has a close control.
 */
export function ToastBar(): ReactNode {
  const toast = useSyncExternalStore(subscribeToast, currentToast);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const held = hovered || focused;

  useEffect(() => {
    if (toast === null || held) return undefined;
    const timer = setTimeout(() => dismissToast(toast.id), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast, held]);

  // A toast that left while held (closed from its own button) holds nothing.
  useEffect(() => {
    if (toast !== null) return;
    setHovered(false);
    setFocused(false);
  }, [toast]);

  if (!toast) return null;

  return (
    <div
      className="w-toast"
      data-tone={toast.tone}
      // A mouse only: on Android a tap fires an emulated enter whose leave waits
      // for the next tap elsewhere, which would hold a tapped toast for good.
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") setHovered(true);
      }}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      <output className="w-toast-text" aria-live="polite">
        {toast.message}
        {toast.href ? (
          <>
            {" · "}
            <a
              href={toast.href}
              onClick={(event) => {
                event.preventDefault();
                dismissToast(toast.id);
                void openExternal(toast.href!);
              }}
            >
              {t("common.explorer")}
            </a>
          </>
        ) : null}
      </output>
      <button
        type="button"
        className="w-toast-close"
        aria-label={t("common.close")}
        onClick={() => dismissToast(toast.id)}
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}
