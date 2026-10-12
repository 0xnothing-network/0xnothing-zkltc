"use client";

import { useEffect, useState } from "react";
import { useAccount, useConnect, useConnectors, type Connector } from "wagmi";
import { Modal } from "@/components/ui/Modal";
import { cx } from "@/components/ui/cx";

const LAST_CONNECTOR_KEY = "0xn-last-connector";

function readLastConnector(): string | null {
  try {
    return window.localStorage.getItem(LAST_CONNECTOR_KEY);
  } catch {
    return null;
  }
}

function friendlyConnectError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/reject|denied|cancel/i.test(message)) return "Request cancelled.";
  if (/already pending/i.test(message)) return "A request is already open in your wallet.";
  return "Couldn't connect. Unlock your wallet and try again.";
}

/**
 * EIP-6963 wallet picker. The generic `injected` connector is hidden when real
 * discovered wallets exist, so users see "MetaMask" / "Rabby" instead of "Injected".
 */
export function selectableConnectors(connectors: ReadonlyArray<Connector>): Connector[] {
  const discovered = connectors.filter((connector) => connector.type === "injected" && connector.id !== "injected");
  if (discovered.length > 0) return [...discovered, ...connectors.filter((connector) => connector.type !== "injected")];
  return [...connectors];
}

export function WalletModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const connectors = useConnectors();
  const { connectAsync, isPending, variables } = useConnect();
  const { isConnected } = useAccount();
  const [error, setError] = useState<string | null>(null);
  const [lastUsed, setLastUsed] = useState<string | null>(null);
  const [hasProvider, setHasProvider] = useState(true);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setLastUsed(readLastConnector());
    setHasProvider(typeof window !== "undefined" && "ethereum" in window);
  }, [open]);

  useEffect(() => {
    if (open && isConnected) onClose();
  }, [isConnected, onClose, open]);

  const options = selectableConnectors(connectors);
  const onlyGeneric = options.length === 1 && options[0].id === "injected";
  const noWallet = onlyGeneric && !hasProvider;

  const connect = async (connector: Connector) => {
    setError(null);
    try {
      await connectAsync({ connector });
      try {
        window.localStorage.setItem(LAST_CONNECTOR_KEY, connector.id);
      } catch {
        /* storage unavailable: last-used hint is optional */
      }
    } catch (caught) {
      setError(friendlyConnectError(caught));
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Connect wallet" description="Choose a wallet to use on LitVM LiteForge." variant="sheet">
      {noWallet ? (
        <div className="grid gap-3 font-ui text-sm text-fg-2">
          <p>No browser wallet detected. Install one, then refresh this page.</p>
          <div className="flex flex-wrap gap-2">
            <a className="text-accent-text underline-offset-2 hover:underline focus-ring" href="https://metamask.io/download/" target="_blank" rel="noreferrer">Get MetaMask</a>
            <a className="text-accent-text underline-offset-2 hover:underline focus-ring" href="https://rabby.io/" target="_blank" rel="noreferrer">Get Rabby</a>
          </div>
        </div>
      ) : (
        <ul className="grid gap-2">
          {options.map((connector) => {
            const pending = isPending && variables?.connector && "id" in variables.connector && variables.connector.id === connector.id;
            const detected = connector.id !== "injected";
            return (
              <li key={connector.uid}>
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() => void connect(connector)}
                  className={cx(
                    "flex w-full items-center gap-3 rounded-ui-md border border-line bg-surface-2 px-3.5 py-3 text-left",
                    "font-ui text-sm text-fg hover:border-line-strong hover:bg-surface-3 focus-ring disabled:opacity-60",
                  )}
                >
                  {connector.icon ? (
                    // eslint-disable-next-line @next/next/no-img-element -- EIP-6963 data: URI icons
                    <img src={connector.icon} alt="" width={28} height={28} className="size-7 rounded-ui-sm" />
                  ) : (
                    <span aria-hidden="true" className="grid size-7 place-items-center rounded-ui-sm bg-surface-3 font-brand text-xs text-fg-2">0x</span>
                  )}
                  <span className="flex-1 font-medium">{connector.id === "injected" ? "Browser wallet" : connector.name}</span>
                  <span className="text-xs text-fg-3">
                    {pending ? "Check wallet…" : lastUsed === connector.id ? "Last used" : detected ? "Detected" : ""}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {error ? <p role="alert" className="mt-3 font-ui text-sm text-negative">{error}</p> : null}
      <p className="mt-4 font-ui text-xs text-fg-3">
        Need gas? Get testnet zkLTC from the{" "}
        <a className="text-accent-text underline-offset-2 hover:underline focus-ring" href="https://docs.litvm.com/get-started-on-testnet/add-to-wallet" target="_blank" rel="noreferrer">LitVM docs</a>.
      </p>
    </Modal>
  );
}
