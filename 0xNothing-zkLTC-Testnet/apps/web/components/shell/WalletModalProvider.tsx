"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { WalletModal } from "./WalletModal";

interface WalletModalContextValue {
  openWalletModal: () => void;
  closeWalletModal: () => void;
}

const WalletModalContext = createContext<WalletModalContextValue | null>(null);

export function WalletModalProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const openWalletModal = useCallback(() => setOpen(true), []);
  const closeWalletModal = useCallback(() => setOpen(false), []);
  const value = useMemo(() => ({ openWalletModal, closeWalletModal }), [openWalletModal, closeWalletModal]);
  return (
    <WalletModalContext.Provider value={value}>
      {children}
      <WalletModal open={open} onClose={closeWalletModal} />
    </WalletModalContext.Provider>
  );
}

/** Returns null outside an AppShell so legacy callers can fall back to direct connect. */
export function useWalletModal(): WalletModalContextValue | null {
  return useContext(WalletModalContext);
}
