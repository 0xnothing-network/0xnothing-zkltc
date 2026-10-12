"use client";

import { useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";
import { cx } from "./cx";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  /** "sheet" docks to the bottom on small screens (drag-handle look). */
  variant?: "dialog" | "sheet";
  className?: string;
}

/** Accessible dialog: focus trap, Esc to close, focus restored on close, aria-modal. */
export function Modal({ open, onClose, title, description, children, variant = "dialog", className }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel)?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const head = items[0];
      const tail = items[items.length - 1];
      if (event.shiftKey && document.activeElement === head) {
        event.preventDefault();
        tail.focus();
      } else if (!event.shiftKey && document.activeElement === tail) {
        event.preventDefault();
        head.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      previous?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  const sheet = variant === "sheet";
  return (
    <div className={cx("ui fixed inset-0 z-[90] flex justify-center bg-overlay", sheet ? "items-end sm:items-center" : "items-center p-4")}
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={cx(
          "w-full max-w-[440px] max-h-[88vh] overflow-y-auto bg-surface-1 border border-line shadow-e3 text-fg outline-none p-5",
          sheet ? "rounded-t-ui-xl sm:rounded-ui-xl" : "rounded-ui-xl",
          className,
        )}
      >
        {sheet ? <div aria-hidden="true" className="mx-auto -mt-2 mb-3 h-1 w-10 rounded-full bg-line-strong sm:hidden" /> : null}
        <div className="flex items-start justify-between gap-4">
          <h2 id={titleId} className="font-ui text-xl font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-2 -mt-1 grid size-9 place-items-center rounded-ui-sm text-fg-3 hover:bg-surface-3 hover:text-fg focus-ring"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>
        {description ? <p id={descriptionId} className="mt-1 font-ui text-sm text-fg-2">{description}</p> : null}
        <div className="mt-4">{children}</div>
      </div>
    </div>
  );
}
