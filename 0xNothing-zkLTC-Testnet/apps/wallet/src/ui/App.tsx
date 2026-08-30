import { lazy, Suspense, type ReactNode } from "react";
import { t } from "../core/i18n";
import { isLitvmNetwork, LITVM_NETWORK } from "../config/networks";
import { isPopupSurface } from "../core/platform/env";
import { BottomNav } from "./components/BottomNav";
import { Note } from "./components/kit";
import { Screen } from "./components/Screen";
import { ToastBar } from "./components/ToastBar";
import { goHome, type RouteName, useRoute } from "./router";
import { Home } from "./screens/Home";
import { Onboarding } from "./screens/Onboarding";
import { Unlock } from "./screens/Unlock";
import { useWallet } from "./state/WalletContext";

function ProtocolOnly({ title, children }: { title: string; children: ReactNode }): ReactNode {
  const { network } = useWallet();
  if (isLitvmNetwork(network)) return children;
  return (
    <Screen title={title} onBack={goHome}>
      <div className="w-stack">
        <Note tone="warn">{t("network.protocolOnly", { network: LITVM_NETWORK.name })}</Note>
      </div>
    </Screen>
  );
}

const Approve = lazy(() => import("./screens/Approve").then((module) => ({ default: module.Approve })));
const Dapps = lazy(() => import("./screens/Dapps").then((module) => ({ default: module.Dapps })));
const History = lazy(() => import("./screens/History").then((module) => ({ default: module.History })));
const Lend = lazy(() => import("./screens/Lend").then((module) => ({ default: module.Lend })));
const MintNusd = lazy(() => import("./screens/MintNusd").then((module) => ({ default: module.MintNusd })));
const Receive = lazy(() => import("./screens/Receive").then((module) => ({ default: module.Receive })));
const Send = lazy(() => import("./screens/Send").then((module) => ({ default: module.Send })));
const Settings = lazy(() => import("./screens/Settings").then((module) => ({ default: module.Settings })));
const Swap = lazy(() => import("./screens/Swap").then((module) => ({ default: module.Swap })));

/**
 * The whole app is one surface with a hash route inside it. There is no router
 * library. HOME and the vault gates stay in the startup chunk so the popup
 * paints immediately; secondary screens load from small local extension chunks
 * only when opened, avoiding their parse cost on every launch.
 *
 * The phase gate comes first, so a locked or empty vault can never be behind a
 * screen that reads balances — including the approval window, which lands on
 * Unlock and continues to the request once the vault is open.
 */
function screenFor(name: RouteName): ReactNode {
  switch (name) {
    case "send":
      return <Send />;
    case "receive":
      return <Receive />;
    case "history":
      return <History />;
    case "mint":
      return <ProtocolOnly title={t("mint.title")}><MintNusd /></ProtocolOnly>;
    case "lend":
      return <ProtocolOnly title={t("lend.title")}><Lend /></ProtocolOnly>;
    case "swap":
      return <ProtocolOnly title={t("swap.title")}><Swap /></ProtocolOnly>;
    case "dapps":
      return <Dapps />;
    case "settings":
      return <Settings />;
    case "approve":
      return <Approve />;
    default:
      return <Home />;
  }
}

function Opening(): ReactNode {
  return (
    <div className="w-body">
      <div className="w-empty w-center" role="status" aria-live="polite">
        <span className="w-spin" aria-hidden="true">
          ▚
        </span>
        <span>{t("app.opening")}</span>
      </div>
    </div>
  );
}

export function App(): ReactNode {
  const { phase, settings } = useWallet();
  const route = useRoute();
  const surface = isPopupSurface() ? "popup" : "full";

  const body = phase === "loading"
    ? <Opening />
    : phase === "onboarding"
      ? <Onboarding />
      : phase === "locked"
        ? <Unlock />
        : <Suspense fallback={<Opening />}>{screenFor(route.name)}</Suspense>;

  // The nav belongs to the wallet itself: an approval window is not a place to
  // wander off from, and there is nothing to navigate to before the vault opens.
  const nav = phase === "ready" && route.name !== "approve";

  return (
    <div className="w-root" data-surface={surface} data-theme={settings.theme}>
      <main className="w-shell">{body}</main>
      {nav ? <BottomNav current={route.name} /> : null}
      <ToastBar />
    </div>
  );
}
