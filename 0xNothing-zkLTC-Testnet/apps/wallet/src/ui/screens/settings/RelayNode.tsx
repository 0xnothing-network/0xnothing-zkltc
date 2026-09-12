import { type ReactNode, useEffect, useState } from "react";
import { t } from "../../../core/i18n";
import { formatAmount, formatBalance, formatTimeAgo, parseAmount } from "../../../core/lib/format";
import { LITVM_NETWORK } from "../../../config/networks";
import {
  readRelayNode,
  type RelayNodeSettings,
  updateRelayNode,
} from "../../../core/quantum/relayNode";
import { Button, Note, Panel, PanelBody, Row, Rows } from "../../components/kit";
import { useWallet } from "../../state/WalletContext";

/**
 * Configuration and ledger for the opt-in DePIN relayer node.
 *
 * This panel spends the user's money if they let it, so it states the trade in
 * full rather than hiding it behind a toggle: the node pays gas up front for
 * strangers' transactions and is reimbursed by the hub only when the transaction
 * SUCCEEDS. Lose a race to another node and that gas is gone. The loss budget is
 * the real control — everything else is tuning.
 *
 * The node itself runs from `useRelayNode` at the App root, so closing this
 * screen does not stop it, and locking the wallet does.
 */
export function RelayNode(): ReactNode {
  const { notify } = useWallet();
  const [settings, setSettings] = useState<RelayNodeSettings | null>(null);
  const [budgetInput, setBudgetInput] = useState("");
  const symbol = LITVM_NETWORK.nativeCurrency.symbol;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const loaded = await readRelayNode();
      if (cancelled) return;
      setSettings(loaded);
      // Full precision on purpose: seeding the field with a rounded value would
      // silently rewrite the user's budget the first time the field blurs.
      setBudgetInput(formatAmount(BigInt(loaded.budgetWei), 18, 18));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Re-read while the node is running so the ledger reflects what it actually
  // spent. Polling storage rather than subscribing keeps the node free of any
  // dependency on a mounted UI.
  useEffect(() => {
    if (settings?.enabled !== true) return undefined;
    const timer = setInterval(() => {
      void readRelayNode().then(setSettings);
    }, 5_000);
    return () => {
      clearInterval(timer);
    };
  }, [settings?.enabled]);

  const patch = async (next: Partial<RelayNodeSettings>): Promise<void> => {
    setSettings(await updateRelayNode(next));
  };

  if (settings === null) return null;

  const net = BigInt(settings.netWei);
  const budget = BigInt(settings.budgetWei);
  const hub = settings.hub;

  const saveBudget = async (): Promise<void> => {
    const wei = parseAmount(budgetInput.trim(), 18);
    if (wei === null || wei <= 0n) {
      notify(t("relay.budgetInvalid"), "error");
      return;
    }
    // Blur fires on every focus change, including ones that did not edit
    // anything. Only report a save that actually happened.
    if (wei === budget) return;
    await patch({ budgetWei: wei.toString() });
    notify(t("relay.budgetSaved"), "ok");
  };

  const toggle = async (): Promise<void> => {
    if (settings.enabled) {
      await patch({ enabled: false });
      return;
    }
    // Refusing to start without a hub is not pedantry: `relay` is the only call
    // that pays anything back, so a node pointed at nothing would pay gas for
    // strangers and be reimbursed for none of it.
    if (hub === null) {
      notify(t("relay.noHub"), "error");
      return;
    }
    // A node that already burned its budget must not be restartable without the
    // user raising it — otherwise "on" silently means "lose more".
    if (net <= -budget) {
      notify(t("relay.budgetSpent"), "error");
      return;
    }
    await patch({ enabled: true });
  };

  return (
    <Panel title={t("relay.panel")}>
      <PanelBody>
        <Note>{t("relay.intro")}</Note>
        <Note tone="warn">{t("relay.risk")}</Note>

        <Button
          block
          variant={settings.enabled ? "default" : "primary"}
          onClick={() => void toggle()}
        >
          {settings.enabled ? t("relay.stop") : t("relay.start")}
        </Button>

        <Rows>
          <Row
            label={t("relay.net")}
            value={`${net > 0n ? "+" : ""}${formatBalance(net, 18)} ${symbol}`}
            tone={net > 0n ? "green" : net < 0n ? "red" : "dim"}
          />
          <Row label={t("relay.relayed")} value={String(settings.relayed)} />
          <Row label={t("relay.lost")} value={String(settings.lost)} tone={settings.lost > 0 ? "red" : "dim"} />
          <Row
            label={t("relay.lastTick")}
            value={settings.lastTickAt === 0 ? t("relay.never") : formatTimeAgo(settings.lastTickAt)}
            tone="dim"
          />
          <Row label={t("relay.hub")} value={hub ?? t("relay.hubUnset")} tone="dim" />
        </Rows>

        <label className="w-field">
          <span className="w-label">{t("relay.budget", { symbol })}</span>
          <input
            className="w-input"
            inputMode="decimal"
            value={budgetInput}
            onChange={(event) => setBudgetInput(event.target.value)}
            onBlur={() => void saveBudget()}
          />
        </label>
        <Note>{t("relay.budgetNote")}</Note>

        <label className="w-field">
          <span className="w-label">{t("relay.maxPerTick")}</span>
          <select
            className="w-select"
            value={settings.maxPerTick}
            onChange={(event) => void patch({ maxPerTick: Number(event.target.value) })}
          >
            {[1, 2, 3, 5, 10].map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </label>

        <label className="w-check">
          <input
            type="checkbox"
            checked={settings.relayDeploys}
            onChange={(event) => void patch({ relayDeploys: event.target.checked })}
          />
          <span>{t("relay.deploys")}</span>
        </label>
        <Note>{t("relay.deploysNote")}</Note>
      </PanelBody>
    </Panel>
  );
}
