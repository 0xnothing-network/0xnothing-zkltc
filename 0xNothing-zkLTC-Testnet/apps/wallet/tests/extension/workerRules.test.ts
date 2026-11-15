import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import {
  badgeText,
  canonicalQuantity,
  CONNECT_COOLDOWN_CAP,
  coolingDown,
  isAwaiting,
  isLooseQuantity,
  isUserRejection,
  isWalletUiSender,
  locksWallet,
  noteCooldown,
  parseRequestedChainId,
  rpcFailover,
  type RpcAttempt,
  tryEndpoints,
} from "../../src/extension/workerRules.ts";

const background = readFileSync(new URL("../../src/extension/background.ts", import.meta.url), "utf8");
const approve = readFileSync(new URL("../../src/ui/screens/Approve.tsx", import.meta.url), "utf8");

function body(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `${start} .. ${end}`);
  return source.slice(from, to);
}
const own = "abcdefghijklmnopabcdefghijklmnop";

test("wallet events are accepted from every wallet page, including a tab and the approval window", () => {
  assert.equal(isWalletUiSender({ id: own, url: `chrome-extension://${own}/index.html` }, own), true);
  assert.equal(isWalletUiSender({ id: own, tab: { id: 1 }, url: `chrome-extension://${own}/index.html` }, own), true);
  assert.equal(
    isWalletUiSender({ id: own, tab: { id: 2 }, url: `chrome-extension://${own}/index.html#/approve?id=x` }, own),
    true,
  );
  // A content script of this extension reports its web page's URL.
  assert.equal(isWalletUiSender({ id: own, tab: { id: 1 }, url: "https://evil.example/" }, own), false);
  assert.equal(isWalletUiSender({ id: "otherextensionidotherextensionid", url: `chrome-extension://${own}/index.html` }, own), false);
  assert.equal(isWalletUiSender({ id: own, url: "chrome-extension://otherextensionidotherextensionid/index.html" }, own), false);
  assert.equal(isWalletUiSender({ id: own }, own), false);
  assert.equal(isWalletUiSender({ id: own, url: "not a url" }, own), false);
});

test("a requested chainId may be padded hex or a number; anything else is invalid params", () => {
  for (const raw of ["0x1159", "0x01159", "0X1159", 4441]) assert.equal(parseRequestedChainId(raw), 4441n);
  for (const raw of [{}, "abc", "1159", -1, 0, "0x0", 1.5, Number.MAX_SAFE_INTEGER + 1, `0x${"f".repeat(17)}`, undefined, null]) {
    assert.equal(parseRequestedChainId(raw), null, String(raw));
  }
  // The worker compares the parsed value; add-chain has its own branch (F11), so
  // an unsaved chain asked to switch gets 4902 and the dapp proposes it next.
  assert.match(background, /parseRequestedChainId\(isRecord\(first\) \? first\.chainId : undefined\)/u);
  assert.match(background, /BigInt\(entry\.chainId\) === requestedChainId/u);
  assert.match(background, /if \(!target\) return fail\(4902, "This network is not saved in the wallet"\);/u);
  assert.doesNotMatch(background, /fail\(4200/u);
  assert.doesNotMatch(background, /chainId\?\.toLowerCase\(\)/u);
});

test("transaction quantities with leading zeros are accepted and queued in strict form", () => {
  assert.equal(isLooseQuantity("0x0de0b6b3a7640000"), true);
  assert.equal(isLooseQuantity("0x05208"), true);
  assert.equal(isLooseQuantity(`0x${"f".repeat(64)}`), true);
  for (const value of ["0x", `0x${"f".repeat(65)}`, "de0b6b3a7640000", "0xzz", 1]) {
    assert.equal(isLooseQuantity(value), false, String(value));
  }
  assert.equal(canonicalQuantity("0x0de0b6b3a7640000"), "0xde0b6b3a7640000");
  assert.equal(canonicalQuantity("0x00"), "0x0");
  assert.equal(canonicalQuantity("0x0"), "0x0");
  assert.equal(canonicalQuantity("0xABC"), "0xabc");
  assert.match(background, /value: raw\.value === undefined \? undefined : canonicalQuantity\(raw\.value\)/u);
  assert.match(background, /gas: raw\.gas === undefined \? undefined : canonicalQuantity\(raw\.gas\)/u);
});

test("the connect cooldown is bounded and expires", () => {
  const book = new Map<string, number>();
  const now = 1_000_000;
  for (let index = 0; index < CONNECT_COOLDOWN_CAP * 2; index += 1) {
    noteCooldown(book, `origin:https://s${index}.evil.example`, now + 30_000);
    assert.ok(book.size <= CONNECT_COOLDOWN_CAP);
  }
  assert.equal(book.size, CONNECT_COOLDOWN_CAP);
  // The oldest went first; the newest are still cooling down.
  assert.equal(coolingDown(book, "origin:https://s0.evil.example", now), false);
  assert.equal(coolingDown(book, `origin:https://s${CONNECT_COOLDOWN_CAP * 2 - 1}.evil.example`, now), true);
  noteCooldown(book, "tab:4", now + 30_000);
  assert.equal(coolingDown(book, "tab:4", now + 29_999), true);
  assert.equal(coolingDown(book, "tab:4", now + 30_000), false);
  assert.equal(book.has("tab:4"), false, "a passed entry is removed");
});

test("only the user's own refusal cools a site down, not expiry or a reloaded page", () => {
  assert.equal(isUserRejection({ code: 4001, message: "User rejected the request" }), true);
  for (const message of ["Request expired", "Request timed out", "The page that asked reloaded", "The page that asked was closed"]) {
    assert.equal(isUserRejection({ code: 4001, message }), false, message);
  }
  assert.equal(isUserRejection({ code: -32002, message: "User rejected the request" }), false);
  // The worker checks the cooldown before queueing and records it only for a user refusal.
  const connect = body(background, "if (method === \"eth_requestAccounts\"", "if (method === \"wallet_revokePermissions\")");
  assert.ok(connect.indexOf("coolingDown(connectCooldown") < connect.indexOf("askUser("));
  assert.match(connect, /if \(isUserRejection\(answer\.error\)\)/u);
  assert.match(connect, /noteCooldown\(connectCooldown, tabKey, until\)/u);
});

test("the worker counts requests per tab and lets only its own pages ask whether one is live", () => {
  const awaiting = new Set(["live-id"]);
  assert.equal(isAwaiting(awaiting, "live-id"), true);
  assert.equal(isAwaiting(awaiting, "dead-id"), false);
  assert.equal(isAwaiting(awaiting, undefined), false);
  assert.equal(isAwaiting(awaiting, ["live-id"]), false);

  const ask = body(background, "async function askUser(", "async function rejectTabRequests(");
  assert.ok(ask.indexOf("awaiting.add(id)") >= 0);
  assert.ok(ask.indexOf("awaiting.add(id)") < ask.indexOf("pushPending("), "added before the row exists");
  assert.match(ask, /finally \{\n    awaiting\.delete\(id\);/u);
  assert.match(ask, /awaitResolution\(id, Math\.max\(0, at \+ DAPP_REQUEST_TIMEOUT_MS - Date\.now\(\)\)\)/u);
  assert.match(ask, /"tab-limit"/u);
  assert.match(ask, /"connect-limit"/u);
  assert.match(background, /request\?\.kind === "approval-live" && isWalletUiSender\(sender\)/u);
  assert.match(background, /sendResponse\(\{ live: isAwaiting\(awaiting, request\.id\) \}\)/u);
  // The tab comes from the browser's sender, never from the page's message.
  assert.match(background, /const tabId = sender\.tab\?\.id !== undefined/u);
  // So does the document, checked for shape before it is stored.
  assert.match(background, /const documentId = typeof sender\.documentId === "string" && DOCUMENT_ID\.test\(sender\.documentId\)/u);
  assert.match(background, /sender\.tab\?\.title : undefined, tabId, documentId\)/u);
  assert.equal((background.match(/networkIdentity: networkIdentity\(network\), tabId, documentId \}\)/gu) ?? []).length, 3);
  // switch-network, transaction, watch-asset and add-network.
  assert.equal((background.match(/\n      tabId,\n      documentId,\n/gu) ?? []).length, 4);
  assert.match(ask, /\.\.\.\(params\.documentId === undefined \? \{\} : \{ documentId: params\.documentId \}\)/u);
});

test("a closed tab gives up its unclaimed requests; a loaded one only those whose document is gone", () => {
  const removed = body(background, "chrome.tabs.onRemoved.addListener(", "chrome.tabs.onUpdated.addListener(");
  assert.match(removed, /void rejectTabRequests\(tabId, "The page that asked was closed"\)/u);
  assert.doesNotMatch(removed, /deadTabDocuments/u);
  const updated = body(background, "chrome.tabs.onUpdated.addListener(", "function chainRequested(");
  assert.match(updated, /if \(info\.status !== "loading" && info\.status !== "complete"\) return;/u);
  assert.match(updated, /void deadTabDocuments\(tabId\)\n    \.then\(\(dead\) => rejectTabRequests\(tabId, "The page that asked reloaded", dead\)\)/u);
  assert.match(body(background, "async function rejectTabRequests(", "async function deadTabDocuments("), /takeTabRequests\(tabId, deadDocuments\)/u);
  // A document is gone only when the message to it fails; content.ts answers it.
  const probe = body(background, "async function deadTabDocuments(", "chrome.tabs.onRemoved");
  assert.match(probe, /await chrome\.tabs\.sendMessage\(tabId, \{ kind: "provider-alive" \}, \{ documentId \}\);\n    \} catch \{\n      dead\.add\(documentId\);/u);
});

test("a refused connect cools its tab down only until the tab closes or loads another page", () => {
  const removed = body(background, "chrome.tabs.onRemoved.addListener(", "chrome.tabs.onUpdated.addListener(");
  assert.match(removed, /connectCooldown\.delete\(`tab:\$\{tabId\}`\);/u);
  const updated = body(background, "chrome.tabs.onUpdated.addListener(", "function chainRequested(");
  assert.match(updated, /if \(info\.status === "loading"\) connectCooldown\.delete\(`tab:\$\{tabId\}`\);/u);
  // The refused site itself stays cooled down: only the tab key is dropped.
  assert.doesNotMatch(background, /connectCooldown\.delete\(`origin:/u);
});

test("expired rows a window claimed are answered as maybe sent, never as rejected", () => {
  assert.match(background, /expiryAnswer\(admission\.maybeSentIds\.includes\(expiredId\)/u);
  assert.match(body(background, "const WORKER_STARTED_AT", "openApproval(first.id)"), /expiryAnswer\(request\)/u);
  assert.doesNotMatch(background, /rejectRequest\(expiredId, "Request expired"\)/u);
  assert.match(background, /shouldForceFocus\(Date\.now\(\), lastForcedFocusAt\)/u);
});

test("the approval window never closes on a failed claim and checks the worker before claiming", () => {
  const approveFn = body(approve, "const approve = async", "const reject = async");
  const rejectFn = body(approve, "const reject = async", "if (queue === null)");
  for (const fn of [approveFn, rejectFn]) {
    assert.doesNotMatch(fn, /window\.close\(\)/u);
    assert.match(fn, /await unclaimed\(request, outcome\.reason\)/u);
  }
  assert.ok(approveFn.indexOf("workerAwaits(request.id)") >= 0);
  assert.ok(approveFn.indexOf("workerAwaits(request.id)") < approveFn.indexOf("claimPendingRequest(request.id)"));
  // A claim is released only while nothing was signed.
  assert.match(approveFn, /if \(approvalClaim !== null && !executionCompleted && !signed\)/u);
  assert.match(approveFn, /\(\) => \{ signed = true; \}/u);
  // A held, signed transaction is answered as maybe sent, not rejected.
  assert.match(rejectFn, /rejectClaimedRequest\(request\.id, held, DAPP_MAYBE_SENT_ERROR, -32603\)/u);
});

test("the approval window follows only the rows it can act on and closes when none is left", () => {
  assert.match(approve, /const ownsClaim = \(id: string\): boolean => working\.current === id \|\| heldClaims\.current\.has\(id\);/u);
  assert.match(approve, /const \{ request, actionable \} = approvalView\(queue \?\? \[\], wanted, ownsClaim\);/u);
  assert.match(approve, /queue !== null && actionableCount === 0\) window\.close\(\);\n  \}, \[queue, queueError, wanted, actionableCount\]\);/u);
  assert.match(approve, /approvalView\(rest, wanted, ownsClaim\)\.actionable\.length === 0\) window\.close\(\);/u);
  assert.match(approve, /\{actionable\.length > 1 \? \(/u);
  // The row being claimed stays shown: the mark is set before any await, cleared last.
  for (const [start, end] of [["const approve = async", "const reject = async"], ["const reject = async", "if (queue === null)"]] as const) {
    const fn = body(approve, start, end);
    assert.ok(fn.indexOf("working.current = request.id;") >= 0, start);
    assert.ok(fn.indexOf("working.current = request.id;") < fn.indexOf("await "), start);
    assert.match(fn, /working\.current = null;\n      actionGate\.leave\(\);/u);
  }
});

// The worker cannot be imported here (it touches chrome.* at load), so its idle
// listener and lockSession run on their own, against fakes of what they call.
test("locking the computer drops the session key and its deadline", async () => {
  assert.equal(locksWallet("locked"), true);
  assert.equal(locksWallet("idle"), false);
  assert.equal(locksWallet("active"), false);
  const start = background.indexOf("async function lockSession(");
  const end = background.indexOf("chrome.alarms.onAlarm.addListener(");
  assert.ok(start > 0 && end > start);
  const code = ts.transpileModule(background.slice(start, end), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const session: Record<string, unknown> = { "wallet.session": "key", "wallet.sessionDeadline": 1, other: true };
  const locks: string[] = [];
  const cleared: string[] = [];
  let listener: ((state: string) => void) | undefined;
  const context = createContext({
    STORAGE_KEYS: { session: "wallet.session", sessionDeadline: "wallet.sessionDeadline" },
    AUTOLOCK_ALARM: "wallet.autolock",
    locksWallet,
    withNamedLock: async (name: string, run: () => Promise<void>) => {
      locks.push(name);
      await run();
    },
    chromeRemove: async (area: string, key: string) => {
      assert.equal(area, "session");
      delete session[key];
    },
    chrome: {
      alarms: { clear: async (name: string) => { cleared.push(name); return true; } },
      idle: { onStateChanged: { addListener: (next: (state: string) => void) => { listener = next; } } },
    },
  });
  runInContext(code, context);
  assert.ok(listener);
  listener("idle");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session["wallet.session"], "key");
  listener("locked");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(session, { other: true });
  assert.deepEqual(locks, ["session"]);
  assert.deepEqual(cleared, ["wallet.autolock"]);
});

test("the toolbar badge shows the waiting count and nothing at zero", () => {
  assert.equal(badgeText(0), "");
  assert.equal(badgeText(-1), "");
  assert.equal(badgeText(Number.NaN), "");
  assert.equal(badgeText(Number.POSITIVE_INFINITY), "");
  assert.equal(badgeText(1), "1");
  assert.equal(badgeText(12), "12");
  assert.equal(badgeText(99), "99");
  assert.equal(badgeText(100), "99+");
});

test("the worker keeps the badge on every queue write and sets it again at start", () => {
  assert.match(background, /watchPending\(\(queue\) => showQueueCount\(queue\.length\)\)/u);
  // The startup sweep recomputes it from the stored queue once the stale rows are gone.
  const sweep = background.slice(background.indexOf("void takeExpiredPending("));
  assert.match(sweep, /const queue = await listPending\(\);\s+showQueueCount\(queue\.length\);/u);
  assert.match(background, /setBadgeText\(\{ text: badgeText\(count\) \}\)/u);
});

test("rpcFailover moves on transport, HTTP and body failures and on non-revert errors, never on a revert", () => {
  assert.equal(rpcFailover({ kind: "transport" }), true);
  assert.equal(rpcFailover({ kind: "http", status: 503 }), true);
  assert.equal(rpcFailover({ kind: "http", status: 429 }), true);
  assert.equal(rpcFailover({ kind: "body" }), true);
  assert.equal(rpcFailover({ kind: "rpc", code: -32601, message: "method not found" }), true);
  assert.equal(rpcFailover({ kind: "rpc", code: -32000, message: "header not found" }), true);
  assert.equal(rpcFailover({ kind: "rpc" }), true);
  assert.equal(rpcFailover({ kind: "rpc", code: 3, message: "execution reverted: nope" }), false);
  assert.equal(rpcFailover({ kind: "rpc", code: -32003, message: "transaction rejected" }), false);
  assert.equal(rpcFailover({ kind: "rpc", code: -32000, message: "Execution REVERTED" }), false);
});

test("forward tries the public endpoint when the user endpoint is dead, inside one slot", async () => {
  const calls: Array<[string, number]> = [];
  const answers: Record<string, RpcAttempt<string>> = {
    "https://mine.example/": { answer: "dead", failure: { kind: "transport" } },
    "https://public.example/": { answer: "0x1159" },
  };
  const attempt = async (url: string, timeoutMs: number) => {
    calls.push([url, timeoutMs]);
    return answers[url]!;
  };
  assert.equal(await tryEndpoints(["https://mine.example/", "https://public.example/"], attempt), "0x1159");
  assert.deepEqual(calls, [["https://mine.example/", 8_000], ["https://public.example/", 15_000]]);
  // A revert from the user's endpoint is the answer; nothing is asked twice.
  calls.length = 0;
  answers["https://mine.example/"] = { answer: "reverted", failure: { kind: "rpc", code: 3, message: "execution reverted" } };
  assert.equal(await tryEndpoints(["https://mine.example/", "https://public.example/"], attempt), "reverted");
  assert.equal(calls.length, 1);
  // One endpoint (no override): today's single 15 s attempt, its failure is the answer.
  calls.length = 0;
  answers["https://public.example/"] = { answer: "down", failure: { kind: "http", status: 502 } };
  assert.equal(await tryEndpoints(["https://public.example/"], attempt), "down");
  assert.deepEqual(calls, [["https://public.example/", 15_000]]);
  // The loop runs inside the one slot forwardInSlot holds, over the built-in profile's fallbacks only.
  const slot = background.slice(background.indexOf("async function forwardInSlot"), background.indexOf("let approvalWindowId"));
  assert.match(slot, /rpcSlots\.acquire\(\)[\s\S]*tryEndpoints<Answer>\(urls,[\s\S]*rpcSlots\.release\(\)/u);
  assert.match(slot, /\.\.\.\(network\.builtin \? network\.fallbackRpcUrls \?\? \[\] : \[\]\)/u);
  assert.match(slot, /signal: AbortSignal\.timeout\(timeoutMs\)/u);
});
