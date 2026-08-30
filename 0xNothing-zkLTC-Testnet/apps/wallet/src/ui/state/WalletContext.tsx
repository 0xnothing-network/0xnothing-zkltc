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
import { setLocale, t } from "../../core/i18n";
import { describeError } from "../../core/lib/errors";
import { persistentStore } from "../../core/platform/storage";
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
import { setConnectedAccount } from "../../core/services/dapp";
import { listTokens } from "../../core/services/tokens";
import { announceToPages } from "../../core/services/walletEvents";
import { configureRpcClient } from "../../core/rpc/client";

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

export type ToastTone = "info" | "ok" | "error";

export interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
  /** Explorer link shown next to the message. */
  href?: string;
}
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
  toast: Toast | null;
  notify: (message: string, tone?: ToastTone, href?: string) => void;
  dismiss: () => void;
}

const WalletContext = createContext<WalletValue | null>(null);

/** How often the UI checks whether the auto-lock deadline has passed. */
const LOCK_CHECK_MS = 20_000;
const TOAST_MS = 5_000;
/** A deliberate action pushes the deadline out at most this often. */
const TOUCH_THROTTLE_MS = 30_000;
const THEME_STORAGE_KEY = "0xn.wallet.theme";

/** Keep the pre-paint theme hint and the live document theme in lock-step. */
function applyTheme(theme: WalletSettings["theme"]): void {
  try {
    document.documentElement.dataset.theme = theme;
  } catch {
    // The persisted wallet setting remains authoritative if the DOM is absent.
  }
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // A blocked localStorage must never prevent the encrypted settings write.
  }
}

export function WalletProvider({ children }: { children: ReactNode }): ReactNode {
  const [phase, setPhase] = useState<Phase>("loading");
  const [accounts, setAccounts] = useState<AccountMeta[]>([]);
  const [address, setAddress] = useState<Address | null>(null);
  const [settings, setSettings] = useState<WalletSettings>(DEFAULT_SETTINGS);
  const [network, setNetwork] = useState<WalletNetwork>(LITVM_NETWORK);
  const [tokens, setTokens] = useState<WalletToken[]>([]);
  const [tick, setTick] = useState(0);
  const [toast, setToast] = useState<Toast | null>(null);
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
    const selected = resolveNetwork(saved.networkId, saved.customNetworks);
    const list = await listTokens(selected);
    if (
      generation !== reloadGenerationRef.current
      || revision !== settingsRevisionRef.current
    ) return;
    // A superseded reload must not repoint the process-wide RPC client after a
    // newer reload has already committed a different network to the UI.
    configureRpcClient(selected);
    setAccounts(state.accounts);
    setAddress(state.active ?? state.accounts[0]?.address ?? null);
    // Language before the first painted screen: `setSettings` below is what
    // re-renders, so the labels resolve in the stored locale straight away.
    setLocale(saved.locale);
    applyTheme(saved.theme);
    setSettings(saved);
    setNetwork(selected);
    setTokens(list);
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
        setToast({ id: Date.now(), message: describeError(failure), tone: "error" });
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
        setToast({ id: Date.now(), message: describeError(cause), tone: "error" });
      });
    }));
    return () => unwatch.forEach((stop) => stop());
  }, [reload]);

  /**
   * Auto-lock is enforced by the vault itself — the session record carries the
   * deadline — so the UI only has to notice, which it does on a timer and on
   * every return to the foreground.
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
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  const notify = useCallback((message: string, tone: ToastTone = "info", href?: string) => {
    setToast({ id: Date.now(), message, tone, href });
  }, []);

  const refresh = useCallback(() => setTick((value) => value + 1), []);

  /**
   * Switching account re-points every granted origin at the new address and
   * tells the pages, so a dapp never keeps signing for the account the user just
   * left. Only ever one address is exposed.
   */
  const selectAccount = useCallback(
    async (next: Address) => {
      const state = await setActiveAccount(next);
      setAccounts(state.accounts);
      setAddress(state.active);
      await setConnectedAccount(next);
      await announceToPages("accountsChanged", [next]);
      setTick((value) => value + 1);
    },
    [],
  );

  const saveSettings = useCallback((patch: Partial<WalletSettings>): Promise<void> => {
    const revision = ++settingsRevisionRef.current;
    const generation = ++reloadGenerationRef.current;
    const task = settingsQueueRef.current.then(async () => {
      const next = await writeSettings(patch);
      const selected = resolveNetwork(next.networkId, next.customNetworks);
      const list = await listTokens(selected);
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
        setToast({ id: Date.now(), message: describeError(cause), tone: "error" });
      }
      throw cause;
    });
  }, []);

  const lockWallet = useCallback(async () => {
    await lock();
    setPhase("locked");
  }, []);

  const openWallet = useCallback(async () => {
    await reload();
    setPhase("ready");
    setTick((value) => value + 1);
  }, [reload]);

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
      toast,
      notify,
      dismiss: () => setToast(null),
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
      toast,
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
