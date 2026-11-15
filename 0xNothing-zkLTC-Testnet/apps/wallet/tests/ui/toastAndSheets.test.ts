import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { enterSheet, type FocusTarget } from "../../src/ui/lib/sheetFocus.ts";
import { currentToast, dismissToast, showToast, subscribeToast } from "../../src/ui/state/toastStore.ts";

// O5: toasts get a close control and stay while held; sheets take focus and
// give it back; the toast no longer lives in the WalletContext value.

const read = (path: string) => readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8");

test("a toast replaces the last one, and an older toast's timer cannot dismiss the new one", () => {
  let heard = 0;
  const stop = subscribeToast(() => { heard += 1; });
  const first = showToast("Sent", "ok", "https://explorer.example/tx/0x1");
  assert.deepEqual(currentToast(), { id: first, message: "Sent", tone: "ok", href: "https://explorer.example/tx/0x1" });
  const second = showToast("Failed", "error");
  assert.notEqual(second, first, "two toasts in the same millisecond still differ");
  dismissToast(first);
  assert.equal(currentToast()?.id, second, "the old timer leaves the new toast");
  dismissToast(second);
  assert.equal(currentToast(), null);
  dismissToast();
  assert.equal(heard, 3, "a dismiss with nothing on screen tells nobody");
  stop();
  showToast("After");
  assert.equal(heard, 3);
  assert.equal(currentToast()?.tone, "info");
  dismissToast();
});

test("the toast has a close control and no timer runs while it is hovered or focused", () => {
  const bar = read("ui/components/ToastBar.tsx");
  assert.match(bar, /useSyncExternalStore\(subscribeToast, currentToast\)/u);
  assert.match(bar, /if \(toast === null \|\| held\) return undefined;\n\s+const timer = setTimeout\(\(\) => dismissToast\(toast\.id\), TOAST_MS\);/u);
  assert.match(bar, /const held = hovered \|\| focused;/u);
  for (const handler of ["onPointerEnter", "onPointerLeave", "onFocus", "onBlur"]) assert.match(bar, new RegExp(`${handler}=`, "u"));
  // Hover holds for a mouse only: a tap on Android emulates an enter with no leave.
  assert.ok(bar.includes(`if (event.pointerType === "mouse") setHovered(true);`));
  assert.doesNotMatch(bar, /onMouseEnter|onMouseLeave/u);
  assert.match(bar, /className="w-toast-close"\n\s+aria-label=\{t\("common\.close"\)\}\n\s+onClick=\{\(\) => dismissToast\(toast\.id\)\}/u);
  assert.match(bar, /<output className="w-toast-text" aria-live="polite">/u);
});

test("showing a toast no longer re-renders every screen: it left the WalletContext value", () => {
  const context = read("ui/state/WalletContext.tsx");
  assert.doesNotMatch(context, /useState<Toast/u);
  assert.doesNotMatch(context, /setToast|dismiss:|^\s+toast,$/mu);
  assert.doesNotMatch(context, /^\s+toast: Toast \| null;$/mu);
  assert.match(context, /showToast\(message, tone, href\);/u);
  // Nothing else reads a toast from the context.
  for (const path of ["ui/App.tsx", "ui/components/ToastBar.tsx"]) assert.doesNotMatch(read(path), /\{ toast[,} ]/u);
});

function element(name: string, log: string[], inside: unknown[] = []) {
  const node: FocusTarget & { contains(node: unknown): boolean; isConnected: boolean } = {
    isConnected: true,
    focus: () => { log.push(name); },
    contains: (other: unknown) => other === node || inside.includes(other),
  };
  return node;
}

test("a sheet takes focus when it opens and gives it back to its opener when it closes", () => {
  const log: string[] = [];
  const opener = element("opener", log);
  const sheet = element("sheet", log);
  const restore = enterSheet(sheet, opener, opener);
  assert.deepEqual(log, ["sheet"]);
  restore();
  assert.deepEqual(log, ["sheet", "opener"]);
});

test("an autoFocus field keeps its focus, and a gone opener is left alone", () => {
  const log: string[] = [];
  const field = element("field", log);
  const sheet = element("sheet", log, [field]);
  const opener = element("opener", log);
  const restore = enterSheet(sheet, opener, field);
  assert.deepEqual(log, [], "focus already inside the sheet");
  opener.isConnected = false;
  restore();
  assert.deepEqual(log, [], "the screen that opened it went away");
  enterSheet(sheet, null, null)();
  assert.deepEqual(log, ["sheet"]);
});

test("every sheet uses the focus hook and none adds inert or a trap", () => {
  // Every file under src/ui with a sheet dialog, not a fixed list: a new sheet
  // without the hook fails here.
  const root = new URL("../../src/", import.meta.url);
  const sheets = readdirSync(new URL("ui/", root), { recursive: true })
    .map((entry) => `ui/${String(entry).replaceAll("\\", "/")}`)
    .filter((path) => path.endsWith(".tsx") && /className="w-sheet-body[^"]*"\n\s+role="dialog"/u.test(read(path)));
  for (const path of ["ui/components/AccountSheet.tsx", "ui/components/SwapTokenPicker.tsx", "ui/components/TransactionReview.tsx", "ui/screens/Swap.tsx", "ui/screens/Lend.tsx"]) {
    assert.ok(sheets.includes(path), path);
  }
  for (const path of sheets) {
    const source = read(path);
    assert.match(source, /const sheetRef = useSheetFocus<HTMLDivElement>\(/u, path);
    assert.equal(source.match(/className="w-sheet-body[^"]*"\n\s+role="dialog"/gu)?.length, 1, path);
    assert.match(source, /ref=\{sheetRef\}\n\s+className="w-sheet-body[^"]*"\n\s+role="dialog"\n\s+tabIndex=\{-1\}/u, path);
    assert.doesNotMatch(source, /\binert\b/u, path);
  }
  const hook = read("ui/hooks/useSheetFocus.ts");
  assert.doesNotMatch(hook, /keydown|inert/u);
});
