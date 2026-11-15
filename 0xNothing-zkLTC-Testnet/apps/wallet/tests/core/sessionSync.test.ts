import assert from "node:assert/strict";
import test from "node:test";
import { evaluateModule } from "../../../web/tests/helpers/evaluateModule.ts";

type Phase = "loading" | "onboarding" | "locked" | "ready";

function load() {
  return evaluateModule<{
    sessionChange: (phase: Phase, value: unknown) => "lock" | "open" | null;
    shareInFlight: (run: () => Promise<void>) => () => Promise<void>;
  }>(new URL("../../src/ui/state/WalletContext.tsx", import.meta.url), {
    react: { createContext: () => ({}) },
    "react/jsx-runtime": { jsx: () => null },
    "../../config/networks": {},
    "../../core/i18n": {},
    "../../core/lib/errors": {},
    "../../core/platform/storage": {},
    "../../core/platform/storageKeys": {},
    "../../core/keyring/vault": {},
    "../../core/services/dapp": {},
    "../../core/services/tokens": {},
    "../../core/services/walletEvents": {},
    "../../core/rpc/client": {},
    "../lib/theme": {},
    "../lib/uiMemoryStore": {},
    "./toastStore": {},
  });
}

test("a session removed elsewhere locks an open surface; one written elsewhere opens a locked one", () => {
  const { sessionChange } = load();
  const record = { key: "AAAA" };
  assert.equal(sessionChange("ready", undefined), "lock");
  assert.equal(sessionChange("locked", record), "open");
  // A write while open (reveal, import, password change) and anything during
  // first load or onboarding is left to the flows that already handle it.
  for (const phase of ["loading", "onboarding", "locked"] as const) {
    assert.equal(sessionChange(phase, undefined), null, phase);
  }
  for (const phase of ["loading", "onboarding", "ready"] as const) {
    assert.equal(sessionChange(phase, record), null, phase);
  }
});

test("the unlock screen and the session event share one wallet open", async () => {
  const { shareInFlight } = load();
  let runs = 0;
  let finish!: () => void;
  const open = shareInFlight(() => {
    runs += 1;
    return new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  const fromEvent = open();
  const fromUnlock = open();
  assert.equal(fromEvent, fromUnlock);
  finish();
  await Promise.all([fromEvent, fromUnlock]);
  assert.equal(runs, 1);
  // Once settled, a later call starts a fresh run (the provider's own guard makes it a no-op when open).
  const later = open();
  finish();
  await later;
  assert.equal(runs, 2);
});

test("the provider follows the session record and opens behind the shared run", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../../src/ui/state/WalletContext.tsx", import.meta.url), "utf8");
  assert.match(source, /sessionStore\.subscribe\(STORAGE_KEYS\.session,/u);
  assert.match(source, /const openWallet = useMemo\(\(\) => shareInFlight\(async \(\) => \{\s*if \(phaseRef\.current === "ready"\) return;/u);
});
