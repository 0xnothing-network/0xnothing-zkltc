import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";

// Provider events are a ping and a pull: the worker's ping names the event only,
// each content script asks for its own frame's state, and the page provider emits
// only what changed. These run the real content and inpage scripts in a sandbox.
const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const transpile = (path: string) => ts.transpileModule(source(path), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const protocolCode = transpile("../../src/extension/protocol.ts");
const contentCode = transpile("../../src/extension/content.ts");
const inpageCode = transpile("../../src/extension/inpage.ts");
const background = source("../../src/extension/background.ts");
const walletContext = source("../../src/ui/state/WalletContext.tsx");
const walletEvents = source("../../src/core/services/walletEvents.ts");

const accountA = `0x${"aa".repeat(20)}`;
const accountB = `0x${"bb".repeat(20)}`;

function loadProtocol(context: object): Record<string, unknown> {
  const protocol: Record<string, unknown> = {};
  (runInContext(`(function (exports) {\n${protocolCode}\n})`, context) as (target: object) => void)(protocol);
  return protocol;
}

function contentHarness(origin = "https://app.test", throwOnSend = false) {
  const posts: unknown[] = [];
  const sent: unknown[] = [];
  const answers: Array<(value: unknown) => void> = [];
  const fails: Array<(reason: unknown) => void> = [];
  let onPage: ((event: unknown) => void) | undefined;
  let onWorker: ((message: unknown, sender: unknown, sendResponse: (value: unknown) => void) => void) | undefined;
  const window: Record<string, unknown> = {
    addEventListener: (_name: string, listener: (event: unknown) => void) => { onPage = listener; },
    postMessage: (message: unknown) => posts.push(message),
  };
  const chrome = {
    runtime: {
      sendMessage: (message: unknown) => {
        sent.push(message);
        if (throwOnSend) throw new Error("Extension context invalidated.");
        return new Promise((resolve, reject) => { answers.push(resolve); fails.push(reject); });
      },
      onMessage: { addListener: (listener: typeof onWorker) => { onWorker = listener; } },
    },
  };
  const context = createContext({ self: { origin }, window, chrome });
  const protocol = loadProtocol(context);
  Object.assign(context, { exports: {}, require: () => protocol });
  runInContext(contentCode, context);
  // Built in the page's realm: the bounds check compares prototypes.
  const page = (call: object) => onPage!({
    source: window,
    data: runInContext(`(${JSON.stringify({ channel: protocol.TO_CONTENT, id: "1", call })})`, context),
  });
  return { posts, sent, answers, fails, page, ping: (message: unknown, sendResponse: (value: unknown) => void = () => undefined) => onWorker!(message, {}, sendResponse), TO_PAGE: protocol.TO_PAGE };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
// Objects made inside the sandbox have its prototypes, so compare their JSON.
const same = (actual: unknown, expected: unknown) => assert.equal(JSON.stringify(actual), JSON.stringify(expected));

test("a ping carries nothing, and only a frame that used the provider pulls its state", async () => {
  const h = contentHarness();
  h.ping({ kind: "provider-event", name: "accountsChanged" });
  assert.equal(h.sent.length, 0);
  h.page({ method: "eth_accounts" });
  same(h.sent, [{ kind: "provider-request", call: { method: "eth_accounts" } }]);
  h.ping({ kind: "provider-event", name: "accountsChanged" });
  same(h.sent[1], { kind: "provider-state" });
  h.answers[1]!({ result: { chainId: "0x1159", accounts: [accountA] } });
  await tick();
  same(h.posts, [{ channel: h.TO_PAGE, state: { chainId: "0x1159", accounts: [accountA] } }]);
  h.ping({ kind: "other" });
  assert.equal(h.sent.length, 2);
});

test("the content script answers the worker's liveness check, and only that", () => {
  const h = contentHarness();
  const answers: unknown[] = [];
  // Before and after the page used the provider: the document is there either way.
  h.ping({ kind: "provider-alive" }, (value) => answers.push(value));
  h.page({ method: "eth_chainId" });
  h.ping({ kind: "provider-alive" }, (value) => answers.push(value));
  assert.deepEqual(answers, [true, true]);
  // It asks the worker nothing for it, and a ping still gets no reply.
  assert.equal(h.sent.length, 1);
  const late: unknown[] = [];
  h.ping({ kind: "provider-event", name: "chainChanged" }, (value) => late.push(value));
  assert.equal(late.length, 0);
});

test("an older pull answering late cannot undo a newer one", async () => {
  const h = contentHarness();
  h.page({ method: "eth_chainId" });
  h.ping({ kind: "provider-event", name: "accountsChanged" });
  h.ping({ kind: "provider-event", name: "accountsChanged" });
  h.answers[2]!({ result: { chainId: "0x1159", accounts: [accountB] } });
  await tick();
  h.answers[1]!({ result: { chainId: "0x1159", accounts: [accountA] } });
  await tick();
  same(h.posts, [{ channel: h.TO_PAGE, state: { chainId: "0x1159", accounts: [accountB] } }]);
});

test("a request whose worker died gets 4900 with the wallet's own message, never Chrome's text", async () => {
  const chromeText = "A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received";
  const stopped = { code: 4900, message: "The wallet stopped before it answered. Try the request again." };
  const h = contentHarness();
  h.page({ method: "eth_requestAccounts" });
  h.fails[0]!(new Error(chromeText));
  await tick();
  same(h.posts, [{ channel: h.TO_PAGE, id: "1", error: stopped }]);
  h.page({ method: "eth_requestAccounts" });
  h.fails[1]!("not an error");
  await tick();
  same(h.posts[1], { channel: h.TO_PAGE, id: "1", error: stopped });
  assert.doesNotMatch(JSON.stringify(h.posts), /listener|channel closed/u);
  // An orphaned script whose sendMessage throws takes the same path.
  const orphan = contentHarness("https://app.test", true);
  orphan.page({ method: "eth_chainId" });
  await tick();
  same(orphan.posts, [{ channel: orphan.TO_PAGE, id: "1", error: stopped }]);
  // An answer the worker does give still passes through as it was.
  const live = contentHarness();
  live.page({ method: "eth_chainId" });
  live.answers[0]!({ error: { code: 4100, message: "This site is not connected to the wallet" } });
  await tick();
  same(live.posts, [{ channel: live.TO_PAGE, id: "1", error: { code: 4100, message: "This site is not connected to the wallet" } }]);
});

test("a sandboxed frame never asks for state", () => {
  const h = contentHarness("null");
  h.page({ method: "eth_accounts" });
  h.ping({ kind: "provider-event", name: "accountsChanged" });
  assert.equal(h.sent.length, 1);
});

function inpageHarness() {
  let onMessage: ((event: unknown) => void) | undefined;
  const window: Record<string, unknown> = {
    location: { origin: "https://app.test" },
    addEventListener: (name: string, listener: (event: unknown) => void) => {
      if (name === "message") onMessage = listener;
    },
    dispatchEvent: () => true,
    postMessage: () => undefined,
    setTimeout: () => 1,
    clearTimeout: () => undefined,
  };
  window.top = {};
  const context = createContext({});
  const protocol = loadProtocol(context);
  Object.assign(context, {
    window, exports: {},
    CustomEvent: class { type: string; constructor(type: string) { this.type = type; } },
    require: () => protocol,
  });
  runInContext(inpageCode, context);
  const provider = Object.getOwnPropertyDescriptor(window, "zeroxnothing")!.get!() as {
    on(name: string, listener: (data: unknown) => void): void;
    chainId: string;
    selectedAddress: string | null;
  };
  const emitted: Array<[string, unknown]> = [];
  provider.on("accountsChanged", (data) => emitted.push(["accountsChanged", data]));
  provider.on("chainChanged", (data) => emitted.push(["chainChanged", data]));
  const state = (value: unknown) => onMessage!({ source: window, data: { channel: protocol.TO_PAGE, state: value } });
  return { provider, emitted, state };
}

test("the page provider emits only what differs from what it last reported", () => {
  const h = inpageHarness();
  h.state({ chainId: "0x1159", accounts: [] });
  assert.deepEqual(h.emitted, []);
  h.state({ chainId: "0x1159", accounts: [accountA] });
  assert.equal(h.provider.selectedAddress, accountA);
  h.state({ chainId: "0x1159", accounts: [accountA.toUpperCase().replace("0X", "0x")] });
  h.state({ chainId: "0x1", accounts: [accountA] });
  h.state({ chainId: "0x1", accounts: [] });
  h.state({ chainId: "nope", accounts: [accountB] });
  assert.equal(JSON.stringify(h.emitted), JSON.stringify([
    ["accountsChanged", [accountA]],
    ["chainChanged", "0x1"],
    ["accountsChanged", []],
  ]));
  assert.equal(h.provider.chainId, "0x1");
  assert.equal(h.provider.selectedAddress, null);
});

test("the worker pings without data and answers state for the browser-reported origin", () => {
  assert.match(background, /chrome\.tabs\.sendMessage\(tab\.id, \{ kind: "provider-event", name \}\)/u);
  assert.doesNotMatch(background, /origins/u);
  assert.match(background, /request\?\.kind === "provider-state"\) \{\n    const origin = providerSenderOrigin\(sender\);/u);
  assert.match(background, /const accounts = await connectedAccounts\(origin, active\);/u);
  // The chain goes only to a site holding a connection, so unrelated tabs do not reload.
  const state = background.slice(background.indexOf("async function providerState("), background.indexOf("async function handle("));
  assert.match(state, /return connections\.some\(\(entry\) => entry\.origin === origin\)\n    \? \{ chainId: networkHex\(network\.chainId\), accounts \}\n    : \{ accounts \};/u);
  assert.match(background, /if \(method === "eth_accounts"\) return \{ result: await connectedAccounts\(origin, active\) \};/u);
  assert.match(background, /return resolveActiveAccount\(await chromeGet<AccountsState>/u);
  assert.equal((background.match(/connectedAccounts\(origin\)/gu) ?? []).length, 0);
  assert.match(walletEvents, /sendMessage\(\{ kind: "wallet-event", name \}\)/u);
});

test("switching account no longer re-points every site", () => {
  assert.doesNotMatch(walletContext, /setConnectedAccount/u);
  assert.match(walletContext, /await announceToPages\("accountsChanged"\);/u);
});

test("a page whose site holds no connection gets no chainChanged when the state leaves the chain out", () => {
  const h = inpageHarness();
  h.state({ accounts: [] });
  h.state({ accounts: [] });
  assert.deepEqual(h.emitted, []);
  assert.equal(h.provider.chainId, "0x1159");
  // Once connected, the chain is in the state again and a switch is reported.
  h.state({ chainId: "0x1", accounts: [accountA] });
  assert.equal(JSON.stringify(h.emitted), JSON.stringify([
    ["chainChanged", "0x1"],
    ["accountsChanged", [accountA]],
  ]));
  // Revoked: the accounts go, the chain it knew stays, and nothing else is emitted.
  h.state({ accounts: [] });
  assert.equal(JSON.stringify(h.emitted.slice(2)), JSON.stringify([["accountsChanged", []]]));
  assert.equal(h.provider.chainId, "0x1");
});
