import { createRoot } from "react-dom/client";
import "../styles/wallet.css";
import { applyDocumentLang, t } from "../core/i18n";
import { App } from "./App";
import { WalletProvider } from "./state/WalletContext";

/**
 * Entry point for all three surfaces: the popup, the approval window and the
 * Android WebView all load this same index.html.
 *
 * Deliberately not wrapped in StrictMode: its double-invoked effects would
 * double every block-driven read in development, which is exactly the behaviour
 * the one-wave-per-block design exists to avoid — and would make the RPC
 * traffic in the network panel a lie.
 */
const host = document.getElementById("root");
if (!host) throw new Error(t("app.noRoot"));

// `<html lang>` starts as "en"; the boot-cached locale corrects it before paint.
applyDocumentLang();

createRoot(host).render(
  <WalletProvider>
    <App />
  </WalletProvider>,
);
