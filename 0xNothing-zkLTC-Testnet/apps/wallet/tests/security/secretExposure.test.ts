import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { evaluateModule } from "../../../web/tests/helpers/evaluateModule.ts";

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

type Timers = {
  setTimeout: (run: () => void, ms: number) => unknown;
  clearTimeout: (handle: never) => void;
};
type Page = {
  hidden: boolean;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
};

function loadReveal() {
  return evaluateModule<{
    REVEAL_MAX_MS: number;
    hideWhenAway: (page: Page, hide: () => void, timers: Timers, ms?: number) => () => void;
  }>(new URL("../../src/ui/screens/settings/RevealSecrets.tsx", import.meta.url), {
    react: {},
    "react/jsx-runtime": { jsx: () => null, jsxs: () => null, Fragment: {} },
    "../../../core/i18n": {},
    "../../../core/lib/errors": {},
    "../../../core/keyring/vault": {},
    "../../components/kit": {},
    "../../hooks/useActionGate": {},
    "../../state/WalletContext": {},
  });
}

/** A page whose visibility the test flips, and a clock the test runs by hand. */
function fakePage(hidden = false) {
  const listeners = new Set<() => void>();
  const page: Page = {
    hidden,
    addEventListener: (type, listener) => {
      if (type === "visibilitychange") listeners.add(listener);
    },
    removeEventListener: (type, listener) => {
      if (type === "visibilitychange") listeners.delete(listener);
    },
  };
  const timers = new Map<number, { run: () => void; ms: number }>();
  let next = 0;
  const clock: Timers = {
    setTimeout: (run, ms) => {
      timers.set(++next, { run, ms });
      return next;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as unknown as number);
    },
  };
  return {
    page,
    clock,
    timers,
    listeners,
    setHidden(value: boolean) {
      page.hidden = value;
      for (const listener of [...listeners]) listener();
    },
  };
}

test("a revealed secret is hidden the moment the page is hidden", () => {
  const { hideWhenAway } = loadReveal();
  const fake = fakePage();
  let hidden = 0;
  hideWhenAway(fake.page, () => (hidden += 1), fake.clock);
  fake.setHidden(false);
  assert.equal(hidden, 0, "a visible page keeps the words up");
  fake.setHidden(true);
  assert.equal(hidden, 1);
});

test("a revealed secret is hidden after 60 seconds on screen", () => {
  const { hideWhenAway, REVEAL_MAX_MS } = loadReveal();
  assert.equal(REVEAL_MAX_MS, 60_000);
  const fake = fakePage();
  let hidden = 0;
  hideWhenAway(fake.page, () => (hidden += 1), fake.clock);
  const [timer] = [...fake.timers.values()];
  assert.equal(timer?.ms, 60_000);
  timer!.run();
  assert.equal(hidden, 1);
});

test("a secret that arrives while the page is already hidden is hidden at once", () => {
  const { hideWhenAway } = loadReveal();
  const fake = fakePage(true);
  let hidden = 0;
  hideWhenAway(fake.page, () => (hidden += 1), fake.clock);
  assert.equal(hidden, 1);
});

test("closing the reveal removes the listener and the timer", () => {
  const { hideWhenAway } = loadReveal();
  const fake = fakePage();
  let hidden = 0;
  const stop = hideWhenAway(fake.page, () => (hidden += 1), fake.clock);
  stop();
  assert.equal(fake.listeners.size, 0);
  assert.equal(fake.timers.size, 0);
  fake.setHidden(true);
  assert.equal(hidden, 0);
});

test("the reveal screen wires the hide to the shown secret", () => {
  const reveal = source("../../src/ui/screens/settings/RevealSecrets.tsx");
  assert.match(reveal, /if \(secret === null\) return;\s*return hideWhenAway\(document, close,/u);
});

test("returning to the foreground re-checks the wall-clock auto-lock deadline", () => {
  // On Android the hidden WebView throttles the 20 s timer; the return check is
  // what locks a phone that stayed away past the auto-lock setting.
  const context = source("../../src/ui/state/WalletContext.tsx");
  assert.match(context, /if \(!document\.hidden\) void check\(\);/u);
  assert.match(context, /if \(!\(await isUnlocked\(\)\) && alive\) setPhase\("locked"\);/u);
});

test("the phrase field asks the keyboard not to correct, capitalise or learn it", () => {
  const onboarding = source("../../src/ui/screens/Onboarding.tsx");
  const fields = onboarding.match(/<(?:textarea|input)\b[^>]*value=\{(?:typed|answer)\}[^>]*>/gu) ?? [];
  assert.ok(fields.length >= 2, "the restore field and the backup check field");
  for (const field of fields) {
    assert.match(field, /spellCheck=\{false\}/u);
    assert.match(field, /autoCorrect="off"/u);
    assert.match(field, /autoCapitalize="none"/u);
    assert.match(field, /autoComplete="off"/u);
  }
});

test("password fields stay focused while a try runs and are selected after a miss", () => {
  const screens = {
    unlock: source("../../src/ui/screens/Unlock.tsx"),
    reveal: source("../../src/ui/screens/settings/RevealSecrets.tsx"),
    change: source("../../src/ui/screens/settings/ChangePassword.tsx"),
  };
  for (const [name, screen] of Object.entries(screens)) {
    const field = screen.match(/<input\b[^>]*autoComplete="current-password"[^>]*>/u)?.[0] ?? "";
    assert.match(field, /readOnly=\{busy\}/u, name);
    assert.doesNotMatch(field, /disabled=/u, name);
    assert.match(field, /aria-describedby=/u, name);
    assert.match(screen, /requestAnimationFrame\(\(\) => \w+Ref\.current\?\.select\(\)\)/u, name);
  }
  // Enter on a focused read-only field still submits: the reveal needs the gate too.
  assert.match(screens.reveal, /if \(!actionGate\.tryEnter\(\)\) return;/u);
});

test("create and change gate their button on the vault's own password check", () => {
  // vault-1 (VLT-04): the screens must refuse what createVault/changePassword refuse.
  const onboarding = source("../../src/ui/screens/Onboarding.tsx");
  const change = source("../../src/ui/screens/settings/ChangePassword.tsx");
  assert.match(onboarding, /const problem = passwordProblem\(password\);/u);
  assert.match(onboarding, /const passwordReady = problem === null && confirm === password;/u);
  assert.match(change, /const problem = passwordProblem\(next\);/u);
  assert.match(change, /&& problem === null\s*&& again === next;/u);
  for (const screen of [onboarding, change]) assert.doesNotMatch(screen, /\.length >= MIN_WALLET_PASSWORD_LENGTH/u);
});
