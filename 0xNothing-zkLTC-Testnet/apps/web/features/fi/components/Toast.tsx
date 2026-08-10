"use client";

import { X } from "@phosphor-icons/react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

type ToastKind = "info" | "success" | "warning" | "error";
interface ToastItem {
  id: string;
  title: string;
  description?: string;
  kind: ToastKind;
}
interface ToastApi {
  show: (title: string, description?: string, kind?: ToastKind) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: string) => {
    setItems((current) => current.filter((item) => item.id !== id));
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
  }, []);

  const show = useCallback(
    (title: string, description?: string, kind: ToastKind = "info") => {
      const id = typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random()}`;
      setItems((current) => [...current.slice(-3), { id, title, description, kind }]);
      timers.current.set(id, setTimeout(() => dismiss(id), 5_000));
    },
    [dismiss],
  );

  const pauseDismiss = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
  }, []);

  const resumeDismiss = useCallback((id: string) => {
    pauseDismiss(id);
    timers.current.set(id, setTimeout(() => dismiss(id), 5_000));
  }, [dismiss, pauseDismiss]);

  useEffect(() => {
    const activeTimers = timers.current;
    return () => activeTimers.forEach((timer) => clearTimeout(timer));
  }, []);

  const value = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="fi-toast-viewport">
        {items.map((item) => (
          <div
            className="fi-toast"
            data-kind={item.kind}
            role={item.kind === "error" ? "alert" : "status"}
            aria-live={item.kind === "error" ? "assertive" : "polite"}
            aria-atomic="true"
            onMouseEnter={() => pauseDismiss(item.id)}
            onMouseLeave={() => resumeDismiss(item.id)}
            onFocus={() => pauseDismiss(item.id)}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) resumeDismiss(item.id);
            }}
            key={item.id}
          >
            <div>
              <strong>{item.title}</strong>
              {item.description ? <p>{item.description}</p> : null}
            </div>
            <button type="button" onClick={() => dismiss(item.id)} aria-label="Dismiss notification">
              <X size={14} weight="bold" aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const value = useContext(ToastContext);
  if (!value) throw new Error("useToast must be used inside ToastProvider");
  return value;
}
