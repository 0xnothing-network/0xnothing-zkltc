import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  MAX_NOTIFIED,
  MAX_WATCHED,
  notifyTitle,
  parseNotified,
  parseNotifyText,
  receiptOutcome,
  requestNotificationId,
  settledInWrite,
  txMessage,
  txNotificationId,
  UNSEEN_AFTER_MS,
  unseenRequests,
  WATCH_WINDOW_MS,
  watchedRows,
  withNotified,
} from "../../src/extension/txNotify.ts";

/**
 * Opt-in notifications (F12): which rows the worker watches, what it says, and
 * that nothing is told twice. Only public anvil addresses appear here.
 */
const NOW = 1_800_000_000_000;
const ACCOUNT = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const hash = (n: number): string => `0x${n.toString(16).padStart(64, "0")}`;
const row = (n: number, extra: Record<string, unknown> = {}) => ({
  hash: hash(n), account: ACCOUNT, networkId: "litvm-4441", kind: "send", status: "pending", at: NOW - n * 1000,
  label: { key: "tx.send", params: { amount: "5 NUSD" } }, ...extra,
});
const saved = (id: string | undefined) => id === undefined || id === "litvm-4441";
const source = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");

test("the worker watches recent pending rows on saved networks, newest first, a few at a time", () => {
  const book = {
    [ACCOUNT]: [
      row(1), row(2, { status: "success" }), row(3, { networkId: "custom-9-gone" }),
      row(4, { at: NOW - WATCH_WINDOW_MS - 1 }), row(5, { hash: "0x12" }), row(6, { networkId: undefined }),
      ...Array.from({ length: 10 }, (_, index) => row(20 + index)),
    ],
    other: "garbage",
  };
  const watched = watchedRows(book, NOW, [txNotificationId(hash(20))], saved);
  assert.equal(watched.length, MAX_WATCHED);
  assert.deepEqual(watched.map((entry) => entry.hash).slice(0, 2), [hash(1), hash(6)], "an old row without a network is on the built-in one");
  assert.ok(!watched.some((entry) => entry.hash === hash(20)), "a notified row is not read again");
  assert.ok(!watched.some((entry) => [hash(2), hash(3), hash(4)].includes(entry.hash)));
  // Nothing pending: nothing to watch, so the alarm goes and no RPC is made.
  assert.deepEqual(watchedRows({ [ACCOUNT]: [row(2, { status: "failed" })] }, NOW, [], saved), []);
  assert.deepEqual(watchedRows(null, NOW, [], saved), []);
});

test("a row a wallet page settled is told once, with its outcome", () => {
  const before = { [ACCOUNT]: [row(1), row(2), row(3)] };
  const after = { [ACCOUNT]: [row(1, { status: "success" }), row(2, { status: "failed" }), row(3, { status: "dropped" })] };
  const settled = settledInWrite(before, after, NOW, []);
  assert.deepEqual(settled.map((entry) => [entry.row.hash, entry.ok]), [[hash(1), true], [hash(2), false]]);
  assert.deepEqual(settledInWrite(before, after, NOW, [txNotificationId(hash(1)), txNotificationId(hash(2))]), []);
  // A row that was already settled before the write is not news.
  assert.deepEqual(settledInWrite(after, after, NOW, []), []);
});

test("the message is the History summary, plain and short", () => {
  const text = parseNotifyText({ "tx.send": "Gửi {amount}", "notif.confirmed": "Đã xác nhận" });
  assert.equal(txMessage(row(1), text), "Gửi 5 NUSD");
  assert.equal(notifyTitle(text, "notif.confirmed"), "Đã xác nhận");
  assert.equal(notifyTitle(text, "notif.failed"), "Transaction failed", "English when the cache lacks a title");
  // A legacy row with a finished summary, then a row with nothing: the short hash.
  assert.equal(txMessage({ hash: hash(1), summary: "Sent 1 zkLTC" }, text), "Sent 1 zkLTC");
  assert.equal(txMessage({ hash: hash(1), label: { key: "tx.unknown" } }, text), "0x000000…000001");
  // Bidi and control characters go; a long line is cut to 120 code points.
  const tricky = txMessage(row(1, { label: { key: "tx.send", params: { amount: "‮evil\u0007 ".concat("x".repeat(300)) } } }), text);
  assert.ok(!/[‮\u0007]/u.test(tricky));
  assert.equal([...tricky].length, 120);
  // Only string and number parameters are filled in; an object stays a placeholder.
  assert.equal(txMessage(row(1, { label: { key: "tx.send", params: { amount: { toString: "x" } } } }), text), "Gửi {amount}");
});

test("the text cache and the notified list are validated when read", () => {
  assert.deepEqual(parseNotifyText(null), {});
  assert.deepEqual(parseNotifyText(["x"]), {});
  const parsed = parseNotifyText(JSON.parse('{"tx.send":"ok","__proto__":"x","bad key":"x","tx.long":"' + "y".repeat(201) + '","tx.num":5}'));
  assert.deepEqual({ ...parsed }, { "tx.send": "ok" });
  assert.equal(({} as Record<string, unknown>).x, undefined);

  const id = requestNotificationId("6f1c2b8e-1d2c-4a5b-9c8d-7e6f5a4b3c2d");
  assert.deepEqual(parseNotified([id, id, "junk", 7, txNotificationId(hash(1)).toUpperCase()]), [id]);
  let list: string[] = [];
  for (let n = 0; n < MAX_NOTIFIED + 10; n += 1) list = withNotified(list, txNotificationId(hash(n)));
  assert.equal(list.length, MAX_NOTIFIED);
  assert.equal(list[0], txNotificationId(hash(10)), "the oldest go first");
  assert.deepEqual(parseNotified("x"), []);
});

test("receipts and waiting requests are read strictly", () => {
  assert.equal(receiptOutcome({ status: "0x1" }), true);
  assert.equal(receiptOutcome({ status: "0x0" }), false);
  assert.equal(receiptOutcome(null), null);
  assert.equal(receiptOutcome({ status: "0x2" }), null);
  const queue = [
    { id: "6f1c2b8e-1d2c-4a5b-9c8d-7e6f5a4b3c2d", at: NOW - UNSEEN_AFTER_MS, origin: "https://app.example" },
    { id: "7f1c2b8e-1d2c-4a5b-9c8d-7e6f5a4b3c2d", at: NOW - 1000, origin: "https://app.example" },
  ];
  assert.deepEqual(unseenRequests(queue, NOW, []).map((entry) => entry.id), [queue[0]!.id]);
  assert.deepEqual(unseenRequests(queue, NOW, [requestNotificationId(queue[0]!.id)]), []);
});

test("the worker reads nothing while notifications are off or nothing is pending, and shows each id once", () => {
  const worker = source("../../src/extension/background.ts");
  assert.match(worker, /const watched = \(await notificationsEnabled\(\)\) \? await watchedTxs\(\) : \[\];\n\s+if \(watched\.length === 0\) \{\n\s+await chrome\.alarms\.clear\(TX_WATCH_ALARM\);/u);
  assert.match(worker, /if \(shown\.includes\(id\)\) return;\n\s+await chromeSet\("local", STORAGE_KEYS\.notified, withNotified\(shown, id\)\);\n\s+await chrome\.notifications\.create\(id,/u);
  assert.match(worker, /return saved\?\.notifications === true;/u);
  // The worker never writes the history.
  assert.doesNotMatch(worker, /chromeSet(?:Many)?\("local", STORAGE_KEYS\.history/u);
  // Extension only: the Settings switch is gated, and Android has no worker.
  assert.match(source("../../src/ui/screens/Settings.tsx"), /const notificationsOffered = isExtension && typeof chrome\.permissions\?\.request === "function";/u);
});

test("the wallet page hands the worker every History label and title, all within the read limits", async () => {
  const { EN } = await import("../../src/core/i18n/catalog.ts");
  const { vi } = await import("../../src/core/i18n/locales/vi.ts");
  const { evaluateModule } = await import("../../../web/tests/helpers/evaluateModule.ts");
  const store = new Map<string, unknown>();
  const catalog = { ...EN, ...vi } as Record<string, string>;
  const module = evaluateModule<typeof import("../../src/ui/lib/notifyText.ts")>(
    new URL("../../src/ui/lib/notifyText.ts", import.meta.url), {
      "../../core/i18n": { t: (key: string) => catalog[key] },
      "../../core/i18n/catalog": { EN },
      "../../core/platform/storage": { persistentStore: { set: async (key: string, value: unknown) => { store.set(key, value); } } },
      "../../core/platform/storageKeys": { STORAGE_KEYS: { notifyText: "wallet.notifyText.v1" } },
    },
  );
  await module.writeNotifyText();
  const written = JSON.parse(JSON.stringify(store.get("wallet.notifyText.v1"))) as Record<string, string>;
  // Everything written survives the worker's own validation.
  assert.deepEqual({ ...parseNotifyText(written) }, written);
  for (const key of ["tx.send", "tx.revoke", "tx.dapp", "notif.confirmed", "notif.failed", "notif.waiting"]) {
    assert.equal(written[key], catalog[key], key);
  }
  assert.ok(!Object.keys(written).some((key) => !key.startsWith("tx.") && !key.startsWith("notif.")));
});

test("the receipt watcher reads LiteForge through the user's RPC and finds a row whose custom network got a new RPC", async () => {
  const networks = await import("../../src/config/networks.ts");
  const worker = source("../../src/extension/background.ts");
  const flat = worker.replace(/\s+/gu, " ");
  assert.ok(flat.includes("const networks = [resolveNetwork(LITVM_NETWORK.id, customs, settings?.litvmRpcUrl), ...customs];"));
  assert.ok(flat.includes("return networks.find((entry) => entry.id === key) ?? networks.find((entry) => onNetworkChain(key, entry.id));"));
  // The pieces it is built from: the user's own LiteForge RPC wins, and a
  // custom network's id before and after an RPC change name the same chain.
  const own = networks.resolveNetwork(networks.LITVM_NETWORK.id, [], "https://my-node.example");
  assert.equal(own.id, networks.LITVM_NETWORK.id);
  assert.equal(own.rpcUrl, "https://my-node.example/");
  const before = networks.customNetworkId(8453, "https://a.example");
  const after = networks.customNetworkId(8453, "https://b.example");
  assert.notEqual(before, after);
  assert.equal(networks.onNetworkChain(before, after), true);
  assert.equal(networks.onNetworkChain(before, networks.customNetworkId(10, "https://a.example")), false);
});

test("a waiting-request notification names no site", () => {
  const worker = source("../../src/extension/background.ts");
  const start = worker.indexOf("async function noticeUnseenRequests");
  const body = worker.slice(start, worker.indexOf("\n}\n", start));
  assert.ok(body.includes(`showNotification(requestNotificationId(request.id), chrome.runtime.getManifest().name, notifyTitle(text, "notif.waiting"));`));
  assert.doesNotMatch(body, /request\.(?:origin|title)/u);
});
