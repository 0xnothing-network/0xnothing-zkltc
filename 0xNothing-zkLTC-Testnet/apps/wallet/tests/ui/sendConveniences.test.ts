import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { createServer, type ViteDevServer } from "vite";
import { evaluateModule } from "../../../web/tests/helpers/evaluateModule.ts";
import * as format from "../../src/core/lib/format.ts";
import { STORAGE_KEYS } from "../../src/core/platform/storageKeys.ts";

/**
 * The owner's convenience set for Send and Home: recent recipients with the
 * never-used / look-alike warnings (P1), the review Total (P2), the custom
 * network chip (P4), hide balances (P6) and the Send draft (P7). Only public
 * anvil addresses appear here.
 */

/** A JSON-only store, like the real backends: nothing keeps an object identity. */
function fakeStore() {
  const map = new Map<string, string>();
  return {
    map,
    async get<T>(key: string): Promise<T | null> {
      return map.has(key) ? JSON.parse(map.get(key)!) as T : null;
    },
    async set(key: string, value: unknown): Promise<void> {
      map.set(key, JSON.stringify(value));
    },
    async remove(key: string): Promise<void> {
      map.delete(key);
    },
  };
}

const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const source = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");

function loadRecipients() {
  const store = fakeStore();
  const module = evaluateModule<typeof import("../../src/ui/lib/recipients.ts")>(
    new URL("../../src/ui/lib/recipients.ts", import.meta.url),
    {
      "../../core/platform/locks": { withNamedLock: (_name: string, task: () => Promise<unknown>) => task() },
      "../../core/platform/storage": { persistentStore: store },
      "../../core/platform/storageKeys": { STORAGE_KEYS },
    },
  );
  return { store, ...module };
}

function loadDraft() {
  const store = fakeStore();
  const module = evaluateModule<typeof import("../../src/ui/lib/sendDraft.ts")>(
    new URL("../../src/ui/lib/sendDraft.ts", import.meta.url),
    {
      "../../core/platform/storage": { persistentStore: store },
      "../../core/platform/storageKeys": { STORAGE_KEYS },
    },
  );
  return { store, ...module };
}

// Public anvil accounts 0 and 1, and a look-alike of account 1 (same first and
// last four hex characters, different middle).
const ACCOUNT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const KNOWN = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const LOOKALIKE = "0x70990000000000000000000000000000000079c8";
const FRESH = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

test("a recipient sent to before is known, compared as full lowercase addresses", () => {
  const { recipientRisk } = loadRecipients();
  assert.equal(recipientRisk(KNOWN.toLowerCase(), [KNOWN]), "known");
  assert.equal(recipientRisk(KNOWN, [KNOWN.toLowerCase()]), "known");
  assert.equal(recipientRisk(FRESH, [KNOWN]), "new");
  assert.equal(recipientRisk(FRESH, []), "new");
});

test("a different address sharing the head and tail of a known one is a look-alike", () => {
  const { recipientRisk } = loadRecipients();
  assert.equal(recipientRisk(LOOKALIKE, [KNOWN]), "lookalike");
  // The wallet's own accounts are passed in as known, so their look-alikes are caught too.
  assert.equal(recipientRisk("0xf39f000000000000000000000000000000002266", [ACCOUNT]), "lookalike");
  // Same head, different tail: only new.
  assert.equal(recipientRisk("0x7099000000000000000000000000000000001111", [KNOWN]), "new");
  // An exact repeat is never flagged even when a look-alike is also in the list.
  assert.equal(recipientRisk(KNOWN, [LOOKALIKE, KNOWN]), "known");
});

test("recent recipients are kept per account and chain, newest first, deduplicated, capped at 12", async () => {
  const { rememberRecipient, recentRecipients, MAX_RECENT_RECIPIENTS } = loadRecipients();
  assert.equal(MAX_RECENT_RECIPIENTS, 12);
  await rememberRecipient(ACCOUNT, "4441", KNOWN, 1_000);
  await rememberRecipient(ACCOUNT, "4441", FRESH, 2_000);
  await rememberRecipient(ACCOUNT, "4441", KNOWN.toLowerCase(), 3_000);
  assert.deepEqual(plain(await recentRecipients(ACCOUNT.toLowerCase(), "4441")), [
    { address: KNOWN.toLowerCase(), at: 3_000 },
    { address: FRESH.toLowerCase(), at: 2_000 },
  ]);
  assert.deepEqual(plain(await recentRecipients(ACCOUNT, "31337")), []);
  assert.deepEqual(plain(await recentRecipients(KNOWN, "4441")), []);
  for (let i = 0; i < 20; i += 1) {
    await rememberRecipient(ACCOUNT, "4441", `0x${i.toString(16).padStart(40, "0")}`, 10_000 + i);
  }
  const list = await recentRecipients(ACCOUNT, "4441");
  assert.equal(list.length, 12);
  assert.equal(list[0]?.address, `0x${(19).toString(16).padStart(40, "0")}`);
});

test("a damaged recipients record is read as far as it is valid and never throws", async () => {
  const { store, rememberRecipient, recentRecipients } = loadRecipients();
  store.map.set(STORAGE_KEYS.recipients, JSON.stringify({
    [ACCOUNT.toLowerCase()]: {
      "4441": [
        { address: "not an address", at: 5 },
        { address: KNOWN, at: "yesterday" },
        { address: FRESH, at: 7 },
        null,
      ],
      "31337": "garbage",
    },
    ["__proto__"]: { "4441": [{ address: KNOWN, at: 1 }] },
    "0xnot": { "4441": [{ address: KNOWN, at: 1 }] },
  }));
  assert.deepEqual(plain(await recentRecipients(ACCOUNT, "4441")), [{ address: FRESH.toLowerCase(), at: 7 }]);
  assert.deepEqual(plain(await recentRecipients(ACCOUNT, "31337")), []);
  store.map.set(STORAGE_KEYS.recipients, JSON.stringify(["array", "instead"]));
  assert.deepEqual(plain(await recentRecipients(ACCOUNT, "4441")), []);
  await rememberRecipient(ACCOUNT, "4441", KNOWN, 9);
  assert.deepEqual(plain(await recentRecipients(ACCOUNT, "4441")), [{ address: KNOWN.toLowerCase(), at: 9 }]);
  // A bad account or address is not written at all.
  await rememberRecipient("nobody", "4441", KNOWN, 10);
  await rememberRecipient(ACCOUNT, "4441", "0x1234", 11);
  assert.deepEqual(Object.keys(JSON.parse(store.map.get(STORAGE_KEYS.recipients)!)), [ACCOUNT.toLowerCase()]);
});

test("Send and SendNft remember the recipient only after the transfer succeeded and warn, never block", () => {
  for (const path of ["../../src/ui/screens/Send.tsx", "../../src/ui/screens/send/SendNft.tsx"]) {
    const text = source(path);
    // The success path is one function, run on the transfer's hash and, through
    // the broadcast hold, only once History has a lost broadcast mined.
    const success = text.indexOf("const sent = (hash: Hex): void => {");
    const sent = text.indexOf(path.endsWith("Send.tsx") ? "sent(await sendToken(" : "sent(await transferPixelNft(");
    const remembered = text.indexOf("rememberRecipient(");
    assert.ok(success > 0 && remembered > success && remembered < sent, `${path}: remembers on the success path`);
    assert.ok(sent < text.indexOf("} catch (cause)", sent), `${path}: not on the failure path`);
    assert.match(text, /broadcast\.hold\(cause\.hash, sent\);/u, `${path}: failure reaches it only via the hold`);
    assert.match(text, /<RecipientWarning risk=\{risk\} \/>[\s\S]*<TransactionReview[\s\S]*<RecipientWarning risk=\{risk\} \/>/u);
    assert.doesNotMatch(text, /risk\s*(?:===|!==)\s*"(?:new|lookalike)"/u, `${path}: the risk does not gate Confirm`);
  }
});

test("the review Total adds the fee to a gas-coin send and never across assets", () => {
  const { sendTotalLines } = evaluateModule<typeof import("../../src/ui/lib/sendTotal.ts")>(
    new URL("../../src/ui/lib/sendTotal.ts", import.meta.url),
    { "../../core/lib/format": format },
  );
  const base = { feeWei: 302_400_000_000n, nativeDecimals: 18, nativeSymbol: "zkLTC" };
  assert.deepEqual(
    plain(sendTotalLines({ ...base, native: true, amount: 10n ** 17n, decimals: 18, symbol: "zkLTC" })),
    ["0.1000003 zkLTC"],
  );
  assert.deepEqual(
    plain(sendTotalLines({ ...base, native: false, amount: 25n * 10n ** 17n, decimals: 18, symbol: "NUSD" })),
    ["2.5 NUSD", "+ 0.0000003 zkLTC"],
  );
  assert.match(source("../../src/ui/screens/Send.tsx"), /label=\{t\("send\.total"\)\}[\s\S]*sendTotalLines\(/u);
});

test("the Home chip marks a network that is not built in", () => {
  const home = source("../../src/ui/screens/Home.tsx");
  assert.match(home, /const custom = !isLitvmNetwork\(network\);/u);
  assert.match(home, /data-custom=\{custom \? "true" : undefined\}/u);
  assert.match(home, /t\("home\.customNet"\)/u);
  assert.match(source("../../src/styles/suite/home.css"), /\.w-net-chip\[data-custom="true"\][^}]*var\(--warning\)/u);
});

test("hide balances masks Home only; review and confirmation screens never mask", () => {
  const { maskBalance, MASKED_BALANCE } = evaluateModule<typeof import("../../src/ui/lib/balanceMask.ts")>(
    new URL("../../src/ui/lib/balanceMask.ts", import.meta.url),
    {},
  );
  assert.equal(maskBalance(false, "$1.00"), "$1.00");
  assert.equal(maskBalance(true, "$1.00"), MASKED_BALANCE);
  const home = source("../../src/ui/screens/Home.tsx");
  assert.match(home, /maskBalance\(hidden, formatUsdWad\(portfolio\.totalWad\)\)/u);
  assert.match(home, /saveSettings\(\{ hideBalances: !hidden \}\)/u);
  assert.match(home, /hidden=\{hidden\}/u);
  assert.equal((source("../../src/ui/screens/home/AssetList.tsx").match(/maskBalance\(hidden,/gu) ?? []).length, 2);
  // The RWA tab masks the holding; its review sheet still shows the real amount.
  assert.match(home, /<RwaList hidden=\{hidden\} \/>/u);
  const rwa = source("../../src/ui/screens/home/RwaList.tsx");
  assert.match(rwa, /label=\{t\("rwa\.balance"\)\} value=\{maskBalance\(hidden,/u);
  assert.equal((rwa.match(/maskBalance\(/gu) ?? []).length, 1);
  for (const path of [
    "../../src/ui/screens/Send.tsx",
    "../../src/ui/screens/send/SendNft.tsx",
    "../../src/ui/screens/Approve.tsx",
    "../../src/ui/screens/Swap.tsx",
    "../../src/ui/components/TransactionReview.tsx",
  ]) {
    assert.doesNotMatch(source(path), /balanceMask|hideBalances/u, path);
  }
});

const NOW = 1_800_000_000_000;

test("a send draft is offered back only to the same account and network for ten minutes", () => {
  const { parseSendDraft, SEND_DRAFT_MAX_AGE_MS } = loadDraft();
  assert.equal(SEND_DRAFT_MAX_AGE_MS, 600_000);
  const draft = { account: ACCOUNT.toLowerCase(), networkId: "litvm-4441", tokenId: "native", to: KNOWN, amount: "1.5", at: NOW - 60_000 };
  assert.deepEqual(plain(parseSendDraft(draft, ACCOUNT, "litvm-4441", NOW)), draft);
  assert.equal(parseSendDraft({ ...draft, at: NOW - 600_001 }, ACCOUNT, "litvm-4441", NOW), null);
  assert.equal(parseSendDraft({ ...draft, at: NOW + 120_000 }, ACCOUNT, "litvm-4441", NOW), null);
  assert.equal(parseSendDraft(draft, KNOWN, "litvm-4441", NOW), null);
  assert.equal(parseSendDraft(draft, ACCOUNT, "custom-31337-abc", NOW), null);
  assert.equal(parseSendDraft({ ...draft, to: "", amount: "" }, ACCOUNT, "litvm-4441", NOW), null);
  assert.equal(parseSendDraft({ ...draft, amount: 1.5 }, ACCOUNT, "litvm-4441", NOW), null);
  assert.equal(parseSendDraft({ ...draft, to: "x".repeat(129) }, ACCOUNT, "litvm-4441", NOW), null);
  assert.equal(parseSendDraft("garbage", ACCOUNT, "litvm-4441", NOW), null);
  assert.equal(parseSendDraft(null, ACCOUNT, "litvm-4441", NOW), null);
});

test("saving an empty form removes the draft; a typed one round-trips", async () => {
  const { store, saveSendDraft, loadSendDraft, clearSendDraft } = loadDraft();
  await saveSendDraft({ account: ACCOUNT, networkId: "litvm-4441", tokenId: "nusd", to: KNOWN, amount: "2" }, NOW);
  assert.deepEqual(plain(await loadSendDraft(ACCOUNT, "litvm-4441", NOW + 1_000)), {
    account: ACCOUNT.toLowerCase(), networkId: "litvm-4441", tokenId: "nusd", to: KNOWN, amount: "2", at: NOW,
  });
  assert.deepEqual(Object.keys(JSON.parse(store.map.get(STORAGE_KEYS.sendDraft)!)).sort(), ["account", "amount", "at", "networkId", "to", "tokenId"]);
  await saveSendDraft({ account: ACCOUNT, networkId: "litvm-4441", tokenId: "nusd", to: "", amount: "" }, NOW);
  assert.equal(store.map.has(STORAGE_KEYS.sendDraft), false);
  await saveSendDraft({ account: ACCOUNT, networkId: "litvm-4441", tokenId: "nusd", to: KNOWN, amount: "" }, NOW);
  await clearSendDraft();
  assert.equal(store.map.has(STORAGE_KEYS.sendDraft), false);
});

test("the draft is cleared on a successful send and whenever the wallet is seen locked", () => {
  const send = source("../../src/ui/screens/Send.tsx");
  const success = send.indexOf("const sent = (hash: Hex): void => {");
  const sent = send.indexOf("sent(await sendToken(");
  const cleared = send.indexOf("clearSendDraft()", success);
  assert.ok(success > 0 && cleared > success && cleared < sent && sent < send.indexOf("} catch (cause)", sent));
  // Restored only on a plain Send, and only before the user typed.
  assert.match(send, /if \(initial !== null \|\| address === null\) return undefined;/u);
  assert.match(send, /draft === null \|\| edited\.current/u);
  assert.match(send, /if \(!edited\.current \|\| address === null\) return;/u);
  assert.match(source("../../src/ui/App.tsx"), /if \(phase === "locked"\) void clearSendDraft\(\)/u);
});

let server: ViteDevServer | null = null;
after(async () => {
  await server?.close();
});

test("hideBalances reads as false from 1.0.9 settings and from anything but true; erase removes the new records", async () => {
  server ??= await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "silent" });
  const [vault, storage] = await Promise.all([
    server.ssrLoadModule("/src/core/keyring/vault.ts") as Promise<typeof import("../../src/core/keyring/vault.ts")>,
    server.ssrLoadModule("/src/core/platform/storage.ts") as Promise<typeof import("../../src/core/platform/storage.ts")>,
  ]);
  const { persistentStore } = storage;
  try {
    // The 1.0.9 shape: no hideBalances key at all.
    await persistentStore.set(STORAGE_KEYS.settings, {
      autoLockMinutes: 15, slippageBps: 50, locale: "en", theme: "dark", networkId: "litvm-4441", customNetworks: [],
    });
    const legacy = await vault.readSettings();
    assert.equal(legacy.hideBalances, false);
    assert.equal(legacy.autoLockMinutes, 15);
    for (const bad of ["true", 1, null, {}]) {
      await persistentStore.set(STORAGE_KEYS.settings, { hideBalances: bad });
      assert.equal((await vault.readSettings()).hideBalances, false, String(bad));
    }
    await vault.writeSettings({ hideBalances: true });
    assert.equal((await vault.readSettings()).hideBalances, true);

    await persistentStore.set(STORAGE_KEYS.recipients, { [ACCOUNT.toLowerCase()]: { "4441": [{ address: KNOWN.toLowerCase(), at: 1 }] } });
    await persistentStore.set(STORAGE_KEYS.sendDraft, { account: ACCOUNT.toLowerCase(), networkId: "litvm-4441", tokenId: "native", to: KNOWN, amount: "1", at: Date.now() });
    await vault.wipeWallet();
    assert.equal(await persistentStore.get(STORAGE_KEYS.recipients), null);
    assert.equal(await persistentStore.get(STORAGE_KEYS.sendDraft), null);
    assert.equal((await vault.readSettings()).hideBalances, false);
  } finally {
    await vault.wipeWallet();
  }
});

test("a recipient name is plain text of 24 characters at most, cleaned of control and bidi characters", () => {
  const { cleanRecipientName, MAX_RECIPIENT_NAME } = loadRecipients();
  assert.equal(MAX_RECIPIENT_NAME, 24);
  assert.equal(cleanRecipientName("  Alice \n\t savings "), "Alice savings");
  assert.equal(cleanRecipientName("Bob‮evil​"), "Bobevil");
  assert.equal(cleanRecipientName("x".repeat(24)), "x".repeat(24));
  assert.equal(cleanRecipientName("x".repeat(25)), null, "too long is refused, not cut");
  assert.equal(cleanRecipientName("😀".repeat(24)), "😀".repeat(24), "counted in code points");
  assert.equal(cleanRecipientName("   "), null);
  assert.equal(cleanRecipientName("‮"), null);
  assert.equal(cleanRecipientName(42), null);
});

test("names are set, kept across a new send, cleared and removed with their entry", async () => {
  const { store, rememberRecipient, renameRecipient, forgetRecipient, recentRecipients, recipientName } = loadRecipients();
  await rememberRecipient(ACCOUNT, "4441", KNOWN, 1_000);
  await rememberRecipient(ACCOUNT, "4441", FRESH, 2_000);
  await renameRecipient(ACCOUNT, "4441", KNOWN, " Alice ");
  // A name only goes on an address already in the list.
  await renameRecipient(ACCOUNT, "4441", LOOKALIKE, "Mallory");
  await rememberRecipient(ACCOUNT, "4441", KNOWN, 3_000);
  assert.deepEqual(plain(await recentRecipients(ACCOUNT, "4441")), [
    { address: KNOWN.toLowerCase(), at: 3_000, name: "Alice" },
    { address: FRESH.toLowerCase(), at: 2_000 },
  ]);
  const list = await recentRecipients(ACCOUNT, "4441");
  assert.equal(recipientName(list, KNOWN), "Alice");
  assert.equal(recipientName(list, LOOKALIKE), null, "a look-alike never borrows the name");
  assert.equal(recipientName(null, KNOWN), null);
  // Other chains and accounts are untouched.
  assert.deepEqual(plain(await recentRecipients(ACCOUNT, "31337")), []);
  const before = store.map.get(STORAGE_KEYS.recipients);
  await assert.rejects(renameRecipient(ACCOUNT, "4441", KNOWN, "x".repeat(25)));
  assert.equal(store.map.get(STORAGE_KEYS.recipients), before, "a refused name writes nothing");
  await renameRecipient(ACCOUNT, "4441", KNOWN, "  ");
  assert.deepEqual(plain(await recentRecipients(ACCOUNT, "4441"))[0], { address: KNOWN.toLowerCase(), at: 3_000 });
  await forgetRecipient(ACCOUNT, "4441", FRESH);
  assert.deepEqual(plain(await recentRecipients(ACCOUNT, "4441")).map((row: { address: string }) => row.address), [KNOWN.toLowerCase()]);
});

test("a stored bad name is dropped and its entry kept; named entries outlast the cap", async () => {
  const { store, rememberRecipient, renameRecipient, recentRecipients } = loadRecipients();
  store.map.set(STORAGE_KEYS.recipients, JSON.stringify({
    [ACCOUNT.toLowerCase()]: { "4441": [
      { address: KNOWN, at: 2, name: "x".repeat(40) },
      { address: FRESH, at: 1, name: { toString: "no" } },
      { address: LOOKALIKE, at: 3, name: "Ok⁦name" },
    ] },
  }));
  assert.deepEqual(plain(await recentRecipients(ACCOUNT, "4441")), [
    { address: LOOKALIKE.toLowerCase(), at: 3, name: "Okname" },
    { address: KNOWN.toLowerCase(), at: 2 },
    { address: FRESH.toLowerCase(), at: 1 },
  ]);
  await renameRecipient(ACCOUNT, "4441", FRESH, "Oldest");
  for (let i = 0; i < 20; i += 1) {
    await rememberRecipient(ACCOUNT, "4441", `0x${i.toString(16).padStart(40, "0")}`, 10_000 + i);
  }
  const list = await recentRecipients(ACCOUNT, "4441");
  assert.equal(list.length, 12);
  assert.ok(list.some((row) => row.address === FRESH.toLowerCase() && row.name === "Oldest"));
  assert.ok(list.some((row) => row.name === "Okname"));
  const times = plain(list.map((row) => row.at));
  assert.deepEqual(times, [...times].sort((a, b) => b - a), "still newest first");
});

test("names show in the recents, both send reviews, History and a Settings panel; risk still judges the address", () => {
  const hints = source("../../src/ui/components/RecipientHints.tsx");
  assert.match(hints, /\{entry\.name \?\? shortenAddress\(address\)\}/u);
  assert.match(hints, /title=\{address\}/u);
  assert.match(source("../../src/ui/screens/Send.tsx"), /recipientName\(known, job\.to\)[\s\S]{0,120}t\("send\.savedAs"\)/u);
  assert.match(source("../../src/ui/screens/send/SendNft.tsx"), /recipientName\(known, recipient\)[\s\S]{0,120}t\("send\.savedAs"\)/u);
  for (const path of ["../../src/ui/screens/Send.tsx", "../../src/ui/screens/send/SendNft.tsx"]) {
    assert.match(source(path), /recipientRisk\(recipient, \[\.\.\.known\.map\(\(entry\) => entry\.address\)/u);
  }
  const history = source("../../src/ui/screens/History.tsx");
  assert.match(history, /`\$\{name\} · \$\{shortenAddress\(detail\)\}`/u);
  const settings = source("../../src/ui/screens/Settings.tsx");
  assert.ok(settings.indexOf("<SavedRecipients />") > settings.indexOf("<TokenManager />"));
  const panel = source("../../src/ui/screens/settings/SavedRecipients.tsx");
  assert.match(panel, /renameRecipient\(address, scope, entry\.address, name\)/u);
  assert.match(panel, /forgetRecipient\(address, scope, entry\.address\)/u);
});
