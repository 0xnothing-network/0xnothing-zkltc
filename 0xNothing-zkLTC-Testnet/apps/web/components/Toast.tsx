"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { normalizeError, type ToastKind } from "@/lib/errors";

export interface ToastInput {
  title: string;
  description?: string;
  kind?: ToastKind;
  /** Auto-dismiss timeout in ms. Default 5000. Pass 0 to disable. */
  duration?: number;
  /** Optional click-through link, e.g. an explorer tx URL. */
  href?: string;
  hrefLabel?: string;
}

interface ActiveToast extends Required<Omit<ToastInput, "description" | "href" | "hrefLabel" | "duration">> {
  id: string;
  description?: string;
  href?: string;
  hrefLabel?: string;
  duration: number;
}

interface ToastContextValue {
  show: (toast: ToastInput) => string;
  dismiss: (id: string) => void;
  success: (title: string, description?: string) => string;
  error: (title: string, description?: string) => string;
  info: (title: string, description?: string) => string;
  warning: (title: string, description?: string) => string;
  /** Convenience: normalize a thrown error then show it. */
  handleError: (err: unknown, fallbackTitle?: string) => string;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const MAX_VISIBLE = 5;
const DEFAULT_DURATION = 5000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ActiveToast[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((t) => t.id !== id));
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const show = useCallback(
    (input: ToastInput): string => {
      const id =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const duration = input.duration ?? DEFAULT_DURATION;
      const next: ActiveToast = {
        id,
        title: input.title,
        description: input.description,
        kind: input.kind ?? "info",
        duration,
        href: input.href,
        hrefLabel: input.hrefLabel,
      };

      setToasts((current) => {
        const merged = [...current, next];
        // Cap visible toasts — oldest get dropped first.
        if (merged.length > MAX_VISIBLE) {
          return merged.slice(merged.length - MAX_VISIBLE);
        }
        return merged;
      });

      if (duration > 0) {
        const timer = setTimeout(() => dismiss(id), duration);
        timersRef.current.set(id, timer);
      }

      return id;
    },
    [dismiss]
  );

  // Cleanup all timers on unmount.
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  const value = useMemo<ToastContextValue>(
    () => ({
      show,
      dismiss,
      success: (title, description) => show({ title, description, kind: "success" }),
      error: (title, description) => show({ title, description, kind: "error" }),
      info: (title, description) => show({ title, description, kind: "info" }),
      warning: (title, description) => show({ title, description, kind: "warning" }),
      handleError: (err, fallbackTitle) => {
        const normalized = normalizeError(err);
        return show({
          title: fallbackTitle ?? normalized.title,
          description: normalized.description,
          kind: normalized.kind,
        });
      },
    }),
    [show, dismiss]
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used inside <ToastProvider>");
  }
  return ctx;
}

function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: ActiveToast[];
  onDismiss: (id: string) => void;
}) {
  return (
    <div
      aria-live="polite"
      aria-atomic="true"
      className="pointer-events-none fixed z-[100] top-4 left-4 w-[calc(100dvw-2rem)] max-w-[calc(100dvw-2rem)] sm:left-auto sm:right-4 sm:w-full sm:max-w-sm flex flex-col gap-2"
    >
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

const KIND_STYLES: Record<ToastKind, { ring: string; icon: string; iconColor: string }> = {
  success: {
    ring: "ring-emerald-500/40 bg-[#0F1F1A]/95 border-emerald-500/30",
    icon: "M5 13l4 4L19 7",
    iconColor: "text-emerald-300",
  },
  error: {
    ring: "ring-red-500/40 bg-[#1F0F14]/95 border-red-500/30",
    icon: "M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
    iconColor: "text-red-300",
  },
  warning: {
    ring: "ring-amber-500/40 bg-[#1F1A0F]/95 border-amber-500/30",
    icon: "M12 9v3m0 4h.01M5.07 19h13.86a2 2 0 001.74-3L13.74 4a2 2 0 00-3.48 0L3.33 16a2 2 0 001.74 3z",
    iconColor: "text-amber-300",
  },
  info: {
    ring: "ring-indigo-500/40 bg-[#13133A]/95 border-indigo-500/30",
    icon: "M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
    iconColor: "text-indigo-300",
  },
};

function ToastCard({
  toast,
  onDismiss,
}: {
  toast: ActiveToast;
  onDismiss: (id: string) => void;
}) {
  const styles = KIND_STYLES[toast.kind];

  return (
    <div
      role="status"
      data-toast-kind={toast.kind}
      className={[
        "toast-card pointer-events-auto",
        "border backdrop-blur-md shadow-[6px_6px_0_0_var(--pixel-shadow),0_24px_70px_rgba(0,0,0,0.42)]",
        "ring-1 px-3.5 py-3 min-w-0",
        styles.ring,
      ].join(" ")}
      style={{ animation: "toast-in 220ms cubic-bezier(0.16, 1, 0.3, 1)" }}
    >
      <div className="flex items-start gap-3 min-w-0">
        <div className={`flex-shrink-0 mt-0.5 ${styles.iconColor}`}>
          <svg
            className="w-4 h-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d={styles.icon}
            />
          </svg>
        </div>

        <div className="flex-1 min-w-0">
          <p
            className="text-white text-xs font-semibold leading-snug break-words"
            style={{ fontFamily: "var(--font-departure)" }}
          >
            {toast.title}
          </p>
          {toast.description ? (
            <p className="mt-1 text-[#94A3B8] text-[11px] leading-relaxed break-words">
              {toast.description}
            </p>
          ) : null}
          {toast.href ? (
            <a
              href={toast.href}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium text-indigo-300 hover:text-indigo-200"
              style={{ fontFamily: "var(--font-departure)" }}
            >
              {toast.hrefLabel ?? "View"}
              <svg
                width="9"
                height="9"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                viewBox="0 0 24 24"
              >
                <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
                <path d="M15 3h6v6" />
                <path d="M10 14L21 3" />
              </svg>
            </a>
          ) : null}
        </div>

        <button
          type="button"
          onClick={() => onDismiss(toast.id)}
          aria-label="Dismiss notification"
          className="flex-shrink-0 -mr-1 -mt-1 flex h-6 w-6 items-center justify-center border border-white/[0.08] text-[#64748B] transition-colors hover:bg-white/10 hover:text-white"
        >
          <svg width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.4" viewBox="0 0 24 24">
            <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
    </div>
  );
}
