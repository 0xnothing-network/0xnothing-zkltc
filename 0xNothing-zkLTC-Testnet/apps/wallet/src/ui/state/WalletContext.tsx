import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Address } from "viem";
import type { WalletToken } from "../../config/assets";
import { LITVM_NETWORK, resolveNetwork, type WalletNetwork } from "../../config/networks";
import { loadLocale, setLocale, t } from "../../core/i18n";
import { describeError } from "../../core/lib/errors";
import { persistentStore, sessionStore } from "../../core/platform/storage";
import { STORAGE_KEYS } from "../../core/platform/storageKeys";
import {
  type AccountMeta,
  DEFAULT_SETTINGS,
  hasVault,
  isUnlocked,
  lock,
  readAccounts,
  readSettings,
  setActiveAccount,
  touchSession,
  type WalletSettings,
  writeSettings,
} from "../../core/keyring/vault";
import { listTokens } from "../../core/services/tokens";
import { announceToPages } from "../../core/services/walletEvents";
import { configureRpcClient } from "../../core/rpc/client";
import { resolveTheme, systemPrefersLight } from "../lib/theme";
import { markVersionSeen } from "../lib/uiMemoryStore";
import { showToast, type ToastTone } from "./toastStore";

/**
 * The only global state: which account is active, what the asset list is, and
 * whether the vault is open. Everything else is a read, and reads live in the
 * screens that show them.
 *
 * `tick` is the manual counterpart to the block ticker: an action that changed
 * state on chain bumps it so the affected panels reload at once instead of
 * waiting for the next block.
 */
export type Phase = "loading" | "onboarding" | "locked" | "ready";

export type { Toast, ToastTone } from "./toastStore";
export interface WalletValue {
  phase: Phase;
  accounts: AccountMeta[];
  active: AccountMeta | null;
  address: Address | null;
  settings: WalletSettings;
  network: WalletNetwork;
  networks: readonly WalletNetwork[];
  tokens: WalletToken[];
  /** Bumped by `refresh()`; live reads take it as a dependency. */
  tick: number;
  refresh: () => void;
  /** Re-reads accounts, settings and the token list from storage. */
  reload: () => Promise<void>;
  selectAccount: (address: Address) => Promise<void>;
  saveSettings: (patch: Partial<WalletSettings>) => Promise<void>;
  lockWallet: () => Promise<void>;
  /** Called by Onboarding and Unlock once the vault is open. */
  openWallet: () => Promise<void>;
  /** Shows a toast. The toast itself lives in toastStore, read by ToastBar alone. */
  notify: (message: string, tone?: ToastTone, href?: string) => void;
}

const WalletContext = createContext<WalletValue | null>(null);

/** How often the UI checks whether the auto-lock deadline has passed. */
const LOCK_CHECK_MS = 20_000;
/** A deliberate action pushes the deadline out at most this often. */
const TOUCH_THROTTLE_MS = 30_000;
const THEME_STORAGE_KEY = "0xn.wallet.theme";

/**
 * Keep the pre-paint theme hint and the live document theme in lock-step. The
 * mirror keeps the setting itself ("system" included, theme-boot.js resolves
 * it); the document gets the resolved dark or light.
 */
function applyTheme(theme: WalletSettings["theme"]): void {
  try {
    document.documentElement.dataset.theme = resolveTheme(theme, systemPrefersLight());
  } catch {
    // The persisted wallet setting remains authoritative if the DOM is absent.
  }
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // A blocked localStorage must never prevent the encrypted settings write.
  }
}

/**
 * A storage read rebuilds its objects every time, so a reload that changed
 * nothing still handed React new identities — recreating the context value and,
 * with it, the `tokens` array that `usePortfolio` keys its live read on. That
 * key change drops the last portfolio to `null`, so HOME fell back to its
 * loading state on every settings write and every cross-surface storage event,
 * twice for a write that then echoes back through the subscription.
 *
 * These are precisely the records the wallet persists, so they are JSON by
 * construction, and each has a single reader producing a stable key order:
 * comparing serialisations is a sound identity test here. It runs a handful of
 * times per session, not per frame.
 */
function keepIdentity<T>(previous: T, next: T): T {
  try {
    return JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
  } catch {
    return next;
  }
}

/**
 * What a change to the session record means here. Removed while open: another
 * surface or the worker's alarm locked the wallet, so stop showing balances now
 * rather than at the next 20 s check. Written while locked: it was unlocked
 * elsewhere, so this surface opens too instead of asking for the password again.
 * A write while open (reveal, import, change) changes nothing.
 */
export function sessionChange(phase: Phase, value: unknown): "lock" | "open" | null {
  if (value === undefined || value === null) return phase === "ready" ? "lock" : null;
  return phase === "locked" ? "open" : null;
}

/** Callers that overlap share the run already in flight instead of starting another. */
export function shareInFlight(run: () => Promise<void>): () => Promise<void> {
  let current: Promise<void> | null = null;
  return () => {
    current ??= run().finally(() => {
      current = null;
    });
    return current;
  };
}

export function WalletProvider({ children }: { children: ReactNode }): ReactNode {
  const [phase, setPhase] = useState<Phase>("loading");
  /** Read by the session subscription, which is set up once. */
  const phaseRef = useRef<Phase>("loading");
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);
  // A wallet made on this version (a fresh install, or after an erase)
  // has nothing to catch up on, so this version counts as seen.
  useEffect(() => {
    if (phase === "onboarding") void markVersionSeen(__WALLET_VERSION__);
  }, [phase]);
  const [accounts, setAccounts] = useState<AccountMeta[]>([]);
  const [address, setAddress] = useState<Address | null>(null);
  const [settings, setSettings] = useState<WalletSettings>(DEFAULT_SETTINGS);
  const [network, setNetwork] = useState<WalletNetwork>(LITVM_NETWORK);
  const [tokens, setTokens] = useState<WalletToken[]>([]);
  const [tick, setTick] = useState(0);
  const settingsQueueRef = useRef<Promise<void>>(Promise.resolve());
  const settingsRevisionRef = useRef(0);
  /** Invalidates a slower storage/RPC read when a newer reload or write wins. */
  const reloadGenerationRef = useRef(0);

  const reload = useCallback(async () => {
    const generation = ++reloadGenerationRef.current;
    const revision = settingsRevisionRef.current;
    const [state, saved] = await Promise.all([
      readAccounts(),
      settingsQueueRef.current.then(readSettings),
    ]);
    const selected = resolveNetwork(saved.networkId, saved.customNetworks, saved.litvmRpcUrl);
    // The stored language's catalog is read here, so setLocale below can apply it.
    const [list] = await Promise.all([listTokens(selected), loadLocale(saved.locale)]);
    if (
      generation !== reloadGenerationRef.current
      || revision !== settingsRevisionRef.current
    ) return;
    // A superseded reload must not repoint the process-wide RPC client after a
    // newer reload has already committed a different network to the UI.
    configureRpcClient(selected);
    setAccounts((previous) => keepIdentity(previous, state.accounts));
    setAddress(state.active ?? state.accounts[0]?.address ?? null);
    // Language before the first painted screen: `setSettings` below is what
    // re-renders, so the labels resolve in the stored locale straight away.
    setLocale(saved.locale);
    applyTheme(saved.theme);
    setSettings((previous) => keepIdentity(previous, saved));
    setNetwork((previous) => keepIdentity(previous, selected));
    setTokens((previous) => keepIdentity(previous, list));
  }, []);
  const decidePhase = useCallback(async (): Promise<Exclude<Phase, "loading">> => {
    if (!(await hasVault())) return "onboarding";
    return (await isUnlocked()) ? "ready" : "locked";
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [reloadResult, phaseResult] = await Promise.allSettled([reload(), decidePhase()]);
      if (!alive) return;
      // A token/settings read failure must not leave the shell at "loading".
      // If vault detection itself failed, locked is the non-destructive fallback.
      setPhase(phaseResult.status === "fulfilled" ? phaseResult.value : "locked");
      const failure = reloadResult.status === "rejected"
        ? reloadResult.reason
        : phaseResult.status === "rejected"
        ? phaseResult.reason
        : null;
      if (failure !== null) {
        showToast(describeError(failure), "error");
      }
    })();
    return () => {
      alive = false;
    };
  }, [decidePhase, reload]);

  // A dapp can switch networks, while another popup can select an account or
  // change the token catalog. Follow all three records so every open wallet
  // surface displays the same state it will use for reads and signing.
  useEffect(() => {
    const unwatch = [
      STORAGE_KEYS.settings,
      STORAGE_KEYS.accounts,
      STORAGE_KEYS.tokens,
    ].map((key) => persistentStore.subscribe(key, () => {
      void reload().catch((cause: unknown) => {
        showToast(describeError(cause), "error");
      });
    }));
    return () => unwatch.forEach((stop) => stop());
  }, [reload]);

  /**
   * Auto-lock is enforced by the vault itself — the session record carries the
   * deadline — so the UI only has to notice, which it does on a timer and on
   * every return to the foreground.
   *
   * The return check is what locks the Android app after time away: a hidden
   * WebView throttles or freezes the timer, but the vault compares the stored
   * wall-clock deadline with Date.now(), so a phone left in the background past
   * the auto-lock setting comes back locked. Activity cannot rescue it first,
   * because touchSession refuses a deadline that has already passed.
   */
  useEffect(() => {
    if (phase !== "ready") return;
    let alive = true;
    let checking = false;
    const check = async (): Promise<void> => {
      if (checking) return;
      checking = true;
      try {
        if (!(await isUnlocked()) && alive) setPhase("locked");
      } catch {
        // Session storage failures fail closed and never become unhandled timer
        // rejections.
        if (alive) setPhase("locked");
      } finally {
        checking = false;
      }
    };
    const timer = setInterval(() => void check(), LOCK_CHECK_MS);
    const onVisible = (): void => {
      if (!document.hidden) void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [phase]);

  /** Any deliberate interaction counts as activity for the auto-lock clock. */
  useEffect(() => {
    if (phase !== "ready") return;
    let last = 0;
    const onActivity = (): void => {
      const now = Date.now();
      if (now - last < TOUCH_THROTTLE_MS) return;
      last = now;
      void touchSession().catch(() => {});
    };
    window.addEventListener("pointerdown", onActivity, { passive: true });
    window.addEventListener("keydown", onActivity);
    return () => {
      window.removeEventListener("pointerdown", onActivity);
      window.removeEventListener("keydown", onActivity);
    };
  }, [phase]);
  const notify = useCallback((message: string, tone: ToastTone = "info", href?: string) => {
    showToast(message, tone, href);
  }, []);

  const refresh = useCallback(() => setTick((value) => value + 1), []);

  /**
   * Switching account leaves every site's connections as the user made them and
   * only pings the pages. A site connected to the new account then sees it; every
   * other site sees no account until the user connects this one to it, so a switch
   * never ties two addresses together for a site, nor signs for the one just left.
   */
  const selectAccount = useCallback(
    async (next: Address) => {
      const state = await setActiveAccount(next);
      setAccounts(state.accounts);
      setAddress(state.active);
      await announceToPages("accountsChanged");
      setTick((value) => value + 1);
    },
    [],
  );

  const saveSettings = useCallback((patch: Partial<WalletSettings>): Promise<void> => {
    const revision = ++settingsRevisionRef.current;
    const generation = ++reloadGenerationRef.current;
    const task = settingsQueueRef.current.then(async () => {
      const before = patch.networkId === undefined ? null : (await readSettings()).networkId;
      const next = await writeSettings(patch);
      const selected = resolveNetwork(next.networkId, next.customNetworks, next.litvmRpcUrl);
      // The worker announces the switches dapps ask for; a network picked here would
      // otherwise leave connected pages reading and signing for a stale chainId.
      if (before !== null && before !== next.networkId) {
        void announceToPages("chainChanged");
      }
      // A language picked in Settings shows once its catalog is read (English if it cannot be).
      const [list] = await Promise.all([listTokens(selected), loadLocale(next.locale)]);
      // Writes run in this queue, so successful results are applied in the
      // exact same order in which the controls produced them.
      if (
        generation === reloadGenerationRef.current
        && revision === settingsRevisionRef.current
      ) {
        configureRpcClient(selected);
        setLocale(next.locale);
        applyTheme(next.theme);
        setSettings(next);
        setNetwork(selected);
        setTokens(list);
      }
      // Only a changed timeout needs to rewrite the current session deadline.
      if (patch.autoLockMinutes !== undefined) await touchSession();
    });
    // A failed write must not poison future settings updates.
    settingsQueueRef.current = task.catch(() => {});
    return task.catch((cause: unknown) => {
      if (revision === settingsRevisionRef.current) {
        showToast(describeError(cause), "error");
      }
      throw cause;
    });
  }, []);

  const lockWallet = useCallback(async () => {
    await lock();
    setPhase("locked");
  }, []);

  // This surface's own Unlock and the session event below both open the wallet
  // after one unlock; they share one reload, and a late second call is a no-op.
  const openWallet = useMemo(() => shareInFlight(async () => {
    if (phaseRef.current === "ready") return;
    await reload();
    phaseRef.current = "ready";
    setPhase("ready");
    setTick((value) => value + 1);
  }), [reload]);

  useEffect(() => {
    let alive = true;
    const stop = sessionStore.subscribe(STORAGE_KEYS.session, (value) => {
      const action = sessionChange(phaseRef.current, value);
      if (action === "lock") {
        setPhase((current) => (current === "ready" ? "locked" : current));
      } else if (action === "open") {
        void decidePhase()
          .then((next) => {
            if (alive && next === "ready" && phaseRef.current === "locked") return openWallet();
          })
          .catch((cause: unknown) => {
            if (alive) showToast(describeError(cause), "error");
          });
      }
    });
    return () => {
      alive = false;
      stop();
    };
  }, [decidePhase, openWallet]);

  const active = useMemo(
    () => accounts.find((meta) => meta.address === address) ?? accounts[0] ?? null,
    [accounts, address],
  );
  const networks = useMemo<readonly WalletNetwork[]>(
    () => [LITVM_NETWORK, ...settings.customNetworks],
    [settings.customNetworks],
  );
  const value = useMemo<WalletValue>(
    () => ({
      phase,
      accounts,
      active,
      address: active?.address ?? null,
      settings,
      network,
      networks,
      tokens,
      tick,
      refresh,
      reload,
      selectAccount,
      saveSettings,
      lockWallet,
      openWallet,
      notify,
    }),
    [
      accounts,
      active,
      lockWallet,
      notify,
      openWallet,
      phase,
      refresh,
      reload,
      saveSettings,
      selectAccount,
      settings,
      tick,
      tokens,
      network,
      networks,
    ],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletValue {
  const value = useContext(WalletContext);
  if (!value) throw new Error(t("app.providerMissing"));
  return value;
}
