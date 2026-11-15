// 0xWallet extension end-to-end check (MV3, real Chromium in the new headless mode).
//
// NOT part of `npm test` (that glob is tests/**/*.test.ts). Run it by hand:
//   1. Build first, from apps/wallet:  npm run build   (the unpacked extension is dist/)
//   2. Install playwright-core OUTSIDE this repository, e.g. in a scratch folder:
//        npm install playwright-core      (run inside that folder, never inside the repo)
//   3. Set the environment and run (PowerShell, one command per line):
//        $env:PLAYWRIGHT_CORE = "<folder that contains node_modules/playwright-core>"
//        $env:CHROME = "<full path to a Chromium or Chrome for Testing chrome.exe>"
//        node tests/e2e/extension.e2e.mjs
//   CHROME may be left out when playwright-core's own Chromium is installed.
//   Optional: WALLET_DIR (apps/wallet, default: two folders up from this file),
//   WALLET_DIST (default WALLET_DIR/dist), E2E_OUT (where results.json goes, default a
//   temp folder), KEEP_PROFILE=1.
//
// It drives the unpacked extension against a local dapp page with a throwaway wallet
// whose password is random and never printed (nor is its phrase). One line per check;
// exit code 1 when any check fails. It never approves an eth_sendTransaction; the Send
// review section fakes the balance and the gas estimate for the popup page only and
// aborts any raw-transaction broadcast. The browser profile is deleted at the end.
// Steps 18-24 (feature wave): side panel and tab, badge, current site, watchAsset and
// addEthereumChain, the worker-stop message, official/look-alike hosts, token approvals.
// They answer some requests in the harness and never send them: a proposed network's
// RPC (on a host the manifest already grants), the two https test sites of step 23,
// the tab read of step 20 (activeTab needs a real toolbar click) and the allowance
// read of step 24 (the Revoke review is cancelled, never confirmed).
// Steps 25-30 (feature wave, comfort): first-run and What is new cards, identicons, sheet
// focus, pending rows on Home, recipient names, History CSV (saved to E2E_OUT), toasts,
// the notifications switch, System theme, Lock now, remembered tab and pair, Earn paging,
// the LiteForge RPC field and Change RPC, the locale chunk and preload warnings. Receipts,
// staking positions and the test RPCs there are answered by the harness, never sent.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function die(message) {
  console.error(`extension.e2e: ${message}`);
  process.exit(2);
}
// playwright-core lives outside the repository (no install inside it).
const PW_DIR = process.env.PLAYWRIGHT_CORE;
if (!PW_DIR) die("set PLAYWRIGHT_CORE to a folder that contains node_modules/playwright-core (npm install playwright-core there, outside the repository).");
let chromium;
try {
  const entry = createRequire(path.join(path.resolve(PW_DIR), "noop.js")).resolve("playwright-core");
  const mod = await import(pathToFileURL(entry).href);
  chromium = mod.chromium ?? mod.default?.chromium;
  if (!chromium) throw new Error("module has no chromium export");
} catch (e) {
  die(`playwright-core not found under PLAYWRIGHT_CORE=${PW_DIR} (${String(e?.message ?? e).split(/\r?\n/)[0]}).`);
}

const WALLET = path.resolve(process.env.WALLET_DIR ?? path.join(HERE, "..", ".."));
const DIST = path.resolve(process.env.WALLET_DIST ?? path.join(WALLET, "dist"));
if (!fs.existsSync(path.join(DIST, "manifest.json"))) die(`no built extension at ${DIST}: run npm run build first (or set WALLET_DIST).`);
let CHROME = process.env.CHROME;
if (!CHROME) { try { CHROME = chromium.executablePath(); } catch {} }
if (!CHROME || !fs.existsSync(CHROME)) die("set CHROME to a full Chromium executable (chrome.exe); playwright-core's own Chromium is not installed.");
const VIEM = process.env.VIEM ?? path.join(WALLET, "node_modules", "viem", "_esm", "index.js");
if (!fs.existsSync(VIEM)) die(`viem not found at ${VIEM}: run npm install in apps/wallet (or set VIEM).`);
const { verifyMessage, verifyTypedData, getAddress, multicall3Abi, decodeFunctionData, decodeFunctionResult, encodeFunctionResult, encodeAbiParameters, parseAbi } = await import(pathToFileURL(VIEM).href);
const OUT = process.env.E2E_OUT ?? fs.mkdtempSync(path.join(os.tmpdir(), "wallet-e2e-out-"));
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const logs = { popup: [], approval: [], dapp: [], worker: [], network: [], preload: [] };
let failures = 0;
function check(name, pass, detail = "") {
  results.push({ name, pass: !!pass, detail: String(detail) });
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + String(detail).replace(/\s+/g, " ").slice(0, 300) : ""}`);
}
function note(name, detail) {
  results.push({ name, pass: true, note: true, detail: String(detail) });
  console.log(`NOTE  ${name}  -- ${String(detail).replace(/\s+/g, " ").slice(0, 300)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function within(ms, promise, label) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timeout ${ms}ms: ${label}`)), ms); });
  try { return await Promise.race([promise, timeout]); } finally { clearTimeout(t); }
}
// E2E_ONLY=1,17 runs only those numbered steps (1 is needed by every other one).
const ONLY = process.env.E2E_ONLY ? process.env.E2E_ONLY.split(",").map((x) => x.trim()) : null;
async function step(name, fn) {
  const num = name.match(/^\d+/)?.[0];
  if (ONLY && num && !ONLY.includes(num)) return;
  try { await fn(); } catch (e) { check(name, false, `threw: ${String(e?.message ?? e).split(/\r?\n/)[0]}`); }
}
async function until(fn, ms = 5000, every = 100) {
  const start = Date.now();
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() - start > ms) return v;
    await sleep(every);
  }
}

// ---------- the dapp page ----------
const DAPP_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>E2E Dapp</title>
<script>
window.__ev = []; window.__6963 = [];
window.addEventListener("eip6963:announceProvider", (e) => window.__6963.push({ info: e.detail && e.detail.info, hasProvider: !!(e.detail && e.detail.provider) }));
window.rq = (method, params) => window.ethereum.request({ method, params })
  .then((result) => ({ result }), (e) => ({ error: { code: e && e.code, message: e && e.message } }));
window.addEventListener("DOMContentLoaded", () => {
  if (window.ethereum) {
    window.ethereum.on("accountsChanged", (a) => window.__ev.push(["accountsChanged", a]));
    window.ethereum.on("chainChanged", (c) => window.__ev.push(["chainChanged", c]));
  }
  window.dispatchEvent(new Event("eip6963:requestProvider"));
});
</script></head><body><h1>E2E dapp</h1></body></html>`;
const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(DAPP_HTML);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const DAPP = `http://localhost:${server.address().port}/`;
const DAPP_ORIGIN = DAPP.slice(0, -1);

// ---------- browser ----------
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "wallet-e2e-profile-"));
const PASSWORD = crypto.randomBytes(18).toString("base64url"); // never printed
const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  executablePath: CHROME,
  viewport: { width: 360, height: 600 },
  args: ["--headless=new", `--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, "--no-first-run"],
});
let sw = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 20_000 });
const attachWorker = (w) => { try { w.on("console", (m) => logs.worker.push(`${m.type()}: ${m.text()}`)); } catch {} };
attachWorker(sw);
context.on("serviceworker", (w) => { sw = w; attachWorker(w); });
const EXT_ID = new URL(sw.url()).host;
const POPUP = `chrome-extension://${EXT_ID}/index.html`;
note("0 extension", `version ${JSON.parse(fs.readFileSync(path.join(DIST, "manifest.json"), "utf8")).version}`);

function watch(page, bucket) {
  page.on("console", (m) => {
    if (m.type() !== "error" && m.type() !== "warning") return;
    const text = m.text();
    if (m.type() === "warning" && /preload/i.test(text)) { logs.preload.push(`${bucket}: ${text}`); return; }
    if (/Failed to load resource|net::ERR|ERR_NAME|fetch/i.test(text)) logs.network.push(`${bucket}: ${text}`);
    else logs[bucket].push(`${m.type()}: ${text}`);
  });
  page.on("pageerror", (e) => logs[bucket].push(`pageerror: ${e.message}`));
  page.on("requestfailed", (r) => logs.network.push(`${bucket}: ${r.url()} ${r.failure()?.errorText}`));
}

const popup = await context.newPage();
watch(popup, "popup");
await popup.goto(POPUP);

const approveBtn = (p) => p.locator(".w-flow-actions .w-btn-row button").nth(1);
const rejectBtn = (p) => p.locator(".w-flow-actions .w-btn-row button").nth(0);
const isApproval = (p) => p.url().includes("#/approve");
const openApprovals = () => context.pages().filter((p) => !p.isClosed() && isApproval(p));
async function approvalPage(timeout = 15_000) {
  const open = openApprovals()[0];
  const page = open ?? await context.waitForEvent("page", { predicate: isApproval, timeout });
  if (!page.__watched) { watch(page, "approval"); page.__watched = true; }
  await page.waitForLoadState("domcontentloaded");
  await page.locator('.w-flow-actions .w-btn-row button, input[type="password"]').first().waitFor({ timeout });
  return page;
}
async function waitClosed(page, ms = 5000) {
  const start = Date.now();
  while (!page.isClosed() && Date.now() - start < ms) await sleep(100);
  return page.isClosed();
}
async function waitEnabled(button, ms = 8000) {
  const start = Date.now();
  const disabledAtStart = await button.isDisabled();
  while (await button.isDisabled()) {
    if (Date.now() - start > ms) throw new Error("button never enabled");
    await sleep(25);
  }
  return { disabledAtStart, ms: Date.now() - start };
}
const waitArmed = (page) => waitEnabled(approveBtn(page));
async function rejectAll(page) {
  while (!page.isClosed() && await rejectBtn(page).count().catch(() => 0)) {
    await rejectBtn(page).click({ timeout: 3000 }).catch(() => {});
    await sleep(700);
  }
}
async function unlockIfNeeded(page) {
  const pw = page.locator('input[type="password"]');
  await sleep(300);
  if (await pw.count() === 1 && await pw.isVisible()) {
    await pw.fill(PASSWORD);
    await pw.press("Enter");
    await pw.waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
  }
}
const visibleText = (p) => p.evaluate(() => document.body.innerText);
const readLocal = (key) => popup.evaluate(async (k) => (await chrome.storage.local.get(k))[k] ?? [], key);

// ---------- 1. onboarding through the phrase check, lock, unlock ----------
let account = null;
await step("1 onboarding", async () => {
  await popup.getByRole("button", { name: "Create a new wallet" }).click();
  await popup.locator(".w-seed .w-word").first().waitFor();
  // Kept in this process only; never printed or written.
  const readWords = () => popup.$$eval(".w-seed .w-word", (els) => els.map((el) => (el.lastChild?.textContent ?? "").trim()));
  const words = await readWords();
  const toVerify = async () => {
    const box = popup.locator('[data-step="seed"] input.w-check');
    if (!(await box.isChecked())) await box.check();
    await popup.locator('[data-step="seed"]').getByRole("button", { name: "Continue" }).click();
    await popup.locator('[data-step="verify"]').waitFor({ timeout: 10_000 });
  };
  await toVerify();
  const input = popup.locator('[data-step="verify"] input.w-input');
  // A wrong word ends the check; Back returns to the same phrase.
  await input.fill("zzzzqqq");
  await input.press("Enter");
  await popup.locator('[data-step="verify"] [role="alert"]').waitFor({ timeout: 5000 });
  check("1e a wrong word ends the phrase check (field read-only, no chips)",
    await input.getAttribute("readonly") !== null && await popup.locator('[data-step="verify"] .w-onb-suggest').count() === 0);
  await popup.getByRole("button", { name: "Back to the phrase" }).click();
  await popup.locator('[data-step="seed"]').waitFor({ timeout: 5000 });
  const again = await readWords();
  check("1f back from a failed check shows the same phrase", again.length === words.length && again.every((w, i) => w === words[i]), `${words.length} words`);
  await toVerify();
  let rounds = 0;
  while (await popup.locator('[data-step="verify"]').count() && rounds < 5) {
    const label = await popup.locator('[data-step="verify"] .w-label').innerText();
    const n = Number(label.match(/\d+/)?.[0]);
    const prev = label;
    await input.fill(words[n - 1] ?? "");
    await input.press("Enter");
    rounds++;
    await until(async () => !(await popup.locator('[data-step="verify"]').count())
      || (await popup.locator('[data-step="verify"] .w-label').innerText()) !== prev, 5000);
  }
  const pws = popup.locator('input[type="password"]');
  await pws.first().waitFor({ timeout: 10_000 });
  check("1g the phrase check asks three words, then the password step", rounds === 3 && await popup.locator('[data-step="password"]').count() === 1, `rounds=${rounds}`);
  await pws.nth(0).fill(PASSWORD);
  await pws.nth(1).fill(PASSWORD);
  await popup.getByRole("button", { name: "Open wallet" }).click();
  await popup.locator('[data-step="password"]').waitFor({ state: "detached", timeout: 20_000 });
  await sleep(800);
  const text = await visibleText(popup);
  check("1a create wallet through the phrase check opens the wallet", !/Open wallet/.test(text) && text.length > 20, popup.url());
});
await step("1 lock and unlock", async () => {
  await popup.evaluate(() => { location.hash = "#/settings"; });
  await popup.getByRole("button", { name: /Lock now/ }).click();
  const pw = popup.locator('input[type="password"]');
  await pw.waitFor({ timeout: 10_000 });
  check("1b lock from Settings shows the unlock screen", true);
  await pw.fill(PASSWORD + "x");
  await pw.press("Enter");
  const err = popup.locator('[role="alert"], [data-tone="error"], .w-note[data-tone="error"]');
  await err.first().waitFor({ timeout: 10_000 }).catch(() => {});
  check("1c wrong password shows an error", await err.count() > 0 && await pw.count() === 1, (await err.allInnerTexts()).join(" | "));
  await pw.fill(PASSWORD);
  await pw.press("Enter");
  await pw.waitFor({ state: "detached", timeout: 15_000 });
  check("1d right password opens the wallet", true);
});

// ---------- 2. every route, themes, locales ----------
const ROUTES = ["home", "send", "receive", "history", "swap", "mint", "earn", "lend", "dapps", "settings"];
async function setPrefs(locale, theme) {
  await popup.evaluate(() => { location.hash = "#/settings"; });
  const sel = popup.locator('select:has(option[value="vi"])');
  await sel.waitFor();
  if (await sel.inputValue() !== locale) { await sel.selectOption(locale); await sleep(600); }
  const seg = popup.locator('.w-seg[aria-labelledby="set-background"] button').nth(theme === "dark" ? 0 : 1);
  if (await seg.getAttribute("aria-pressed") !== "true") { await seg.click(); await sleep(600); }
  return popup.evaluate(() => ({ theme: document.documentElement.dataset.theme, lang: document.documentElement.lang }));
}
for (const [locale, theme] of [["en", "dark"], ["vi", "light"], ["de", "dark"], ["de", "light"], ["vi", "dark"], ["en", "dark"]]) {
  await step(`2 routes ${locale}/${theme}`, async () => {
    const applied = await setPrefs(locale, theme);
    const bad = [];
    for (const route of ROUTES) {
      const before = logs.popup.length;
      await popup.evaluate((r) => { location.hash = `#/${r}`; }, route);
      await sleep(1200);
      const text = await visibleText(popup);
      const errs = logs.popup.slice(before);
      if (text.trim().length < 20 || /Something went wrong|Đã xảy ra lỗi|Etwas ist schiefgelaufen/i.test(text)) bad.push(`${route}: blank or crash screen`);
      if (errs.length) bad.push(`${route}: ${errs.join(" / ")}`);
    }
    check(`2 routes render clean (${locale}/${theme}; applied theme=${applied.theme})`, bad.length === 0 && applied.theme === theme, bad.join(" ; "));
  });
}

// ---------- 3. provider injection ----------
const dapp = await context.newPage();
watch(dapp, "dapp");
await dapp.goto(DAPP);
await sleep(500);
const rq = (method, params) => dapp.evaluate(([m, p]) => window.rq(m, p), [method, params])
  .catch((e) => ({ crashed: String(e?.message ?? e).split(/\r?\n/)[0] }));
const dappEvents = () => dapp.evaluate(() => window.__ev);
const clearEvents = () => dapp.evaluate(() => { window.__ev.length = 0; });
await step("3 provider injection", async () => {
  check("3a window.ethereum exists", await dapp.evaluate(() => !!window.ethereum));
  const ann = await dapp.evaluate(() => window.__6963);
  check("3b EIP-6963 announce arrives", ann.length > 0 && ann[0].hasProvider, JSON.stringify(ann.map((a) => a.info && { name: a.info.name, rdns: a.info.rdns, uuid: !!a.info.uuid, icon: (a.info.icon || "").slice(0, 22) })));
  const chain = await rq("eth_chainId");
  check("3c eth_chainId is 0x1159", chain.result === "0x1159", JSON.stringify(chain));
  const acc = await rq("eth_accounts");
  check("3d eth_accounts is [] before connecting", Array.isArray(acc.result) && acc.result.length === 0, JSON.stringify(acc));
});

// ---------- 4. connect ----------
await step("4 connect", async () => {
  const pending = rq("eth_requestAccounts");
  const ap = await approvalPage();
  await approveBtn(ap).waitFor();
  const armed = await waitArmed(ap);
  // Measured on the window's own clock: Playwright attaches to a new window late.
  const age = await ap.evaluate(() => Math.round(performance.now()));
  check("4a Approve disabled at first, enabled only after the 800 ms arm delay", armed.disabledAtStart && age >= 800 && armed.ms < 3000, `window age ${age} ms, ${armed.ms} ms after it was seen`);
  await approveBtn(ap).click();
  const res = await within(15_000, pending, "eth_requestAccounts");
  account = res.result?.[0];
  check("4b approving returns the account", /^0x[0-9a-fA-F]{40}$/.test(account ?? ""), JSON.stringify(res));
  await sleep(500);
  const ev = await dappEvents();
  const now = await rq("eth_accounts");
  // EXT-05: the provider reports accountsChanged only when the value differs from
  // what it last told the page, and the eth_requestAccounts answer already told it.
  check("4c page sees the account at once and no contradicting accountsChanged",
    now.result?.[0]?.toLowerCase() === account?.toLowerCase()
      && ev.every(([n, a]) => n !== "accountsChanged" || a?.[0]?.toLowerCase() === account?.toLowerCase()),
    `eth_accounts=${JSON.stringify(now)} events=${JSON.stringify(ev)}`);
  check("4d approval window closes after the last answer", await waitClosed(ap));
  await popup.evaluate(() => { location.hash = "#/dapps"; });
  await sleep(1000);
  check("4e site listed under Connected sites", (await visibleText(popup)).includes(DAPP_ORIGIN));
});

// ---------- 5. personal_sign: text asks nothing, a 32-byte hash needs the acknowledgement ----------
const MSG = "0xWallet e2e: sign this text " + crypto.randomBytes(4).toString("hex");
await step("5 personal_sign", async () => {
  const pending = rq("personal_sign", [MSG, account]);
  const ap = await approvalPage();
  await unlockIfNeeded(ap);
  check("5a window shows the text", (await visibleText(ap)).includes(MSG));
  check("5e a text message shows no danger warning and no acknowledgement",
    await ap.locator(".w-approve-ack").count() === 0 && await ap.locator(".w-approve-risk").count() === 0);
  await waitArmed(ap);
  await approveBtn(ap).click();
  const res = await within(15_000, pending, "personal_sign");
  const ok = res.result ? await verifyMessage({ address: account, message: MSG, signature: res.result }) : false;
  check("5b signature recovers to the account", ok, res.error ? JSON.stringify(res.error) : "");
  await waitClosed(ap);
  const hex = "0x" + Buffer.from(MSG + " hex").toString("hex");
  const p2 = rq("personal_sign", [hex, account]);
  const ap2 = await approvalPage();
  check("5c hex-encoded message is shown decoded", (await visibleText(ap2)).includes(MSG + " hex"), "");
  await waitArmed(ap2);
  await approveBtn(ap2).click();
  const r2 = await within(15_000, p2, "personal_sign hex");
  const ok2 = r2.result ? await verifyMessage({ address: account, message: { raw: hex }, signature: r2.result }) : false;
  check("5d hex message signature recovers (signed as raw bytes)", ok2, r2.error ? JSON.stringify(r2.error) : "");
  await waitClosed(ap2);
});
await step("5 personal_sign of a 32-byte hash", async () => {
  let HASH;
  do { HASH = "0x" + crypto.randomBytes(32).toString("hex"); } while (/^0x(?:[2-7][0-9a-f])+$/.test(HASH));
  const pending = rq("personal_sign", [HASH, account]);
  const ap = await approvalPage();
  const ack = ap.locator(".w-approve-ack input.w-check");
  await ack.waitFor({ timeout: 5000 });
  const warn = (await ap.locator(".w-approve-risk").allInnerTexts()).join(" ");
  check("5f a 32-byte hash shows the danger warning", warn.trim().length > 0, warn);
  await sleep(1500); // well past the 800 ms arm delay
  check("5g Approve stays disabled until the acknowledgement is ticked", await approveBtn(ap).isDisabled());
  await ack.check();
  const armed = await waitEnabled(approveBtn(ap), 3000).catch(() => null);
  check("5h ticking the acknowledgement enables Approve", !!armed, armed ? `${armed.ms} ms` : "never enabled");
  await approveBtn(ap).click();
  const res = await within(15_000, pending, "personal_sign hash");
  const ok = res.result ? await verifyMessage({ address: account, message: { raw: HASH }, signature: res.result }) : false;
  check("5i the acknowledged hash signature recovers", ok, res.error ? JSON.stringify(res.error) : "");
  await waitClosed(ap);
});

// ---------- 6. typed data ----------
const typed = (chainId) => ({
  domain: { name: "E2E", version: "1", chainId },
  types: {
    EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }],
    Mail: [{ name: "contents", type: "string" }],
  },
  primaryType: "Mail",
  message: { contents: "hello typed" },
});
await step("6 signTypedData_v4", async () => {
  const data = typed(4441);
  const pending = rq("eth_signTypedData_v4", [account, JSON.stringify(data)]);
  const ap = await approvalPage();
  await waitArmed(ap);
  await approveBtn(ap).click();
  const res = await within(15_000, pending, "typed");
  const { EIP712Domain, ...types } = data.types;
  const ok = res.result ? await verifyTypedData({ address: account, domain: data.domain, types, primaryType: "Mail", message: data.message, signature: res.result }) : false;
  check("6a typed data signature verifies", ok, res.error ? JSON.stringify(res.error) : "");
  await waitClosed(ap);
  const p2 = rq("eth_signTypedData_v4", [account, typed(1)]);
  const ap2 = await approvalPage();
  await sleep(1500);
  const disabled = await approveBtn(ap2).isDisabled();
  const flagged = /chain other than|4441/.test(await visibleText(ap2));
  check("6b wrong-chain typed data is refused or flagged", disabled && flagged, `approveDisabled=${disabled} flagged=${flagged}`);
  await rejectBtn(ap2).click();
  const r2 = await within(10_000, p2, "typed wrong chain");
  check("6c rejecting it returns 4001", r2.error?.code === 4001, JSON.stringify(r2));
  await waitClosed(ap2);
});

// ---------- 7. reject and close ----------
await step("7 reject / close", async () => {
  const p1 = rq("personal_sign", ["reject me", account]);
  const ap = await approvalPage();
  await rejectBtn(ap).click();
  const r1 = await within(10_000, p1, "reject");
  check("7a Reject returns 4001", r1.error?.code === 4001, JSON.stringify(r1));
  await waitClosed(ap);
  const p2 = rq("personal_sign", ["close me", account]);
  const ap2 = await approvalPage();
  await ap2.close();
  const r2 = await within(10_000, p2, "close");
  check("7b closing the approval window rejects with 4001", r2.error?.code === 4001, JSON.stringify(r2));
});

// ---------- 8. queue and the per-tab cap ----------
await step("8 two requests back to back", async () => {
  const pa = rq("personal_sign", ["queue first", account]);
  await sleep(150);
  const pb = rq("personal_sign", ["queue second", account]);
  const ap = await approvalPage();
  await sleep(1000);
  const t1 = await visibleText(ap);
  const pages = openApprovals().length;
  check("8a one window, first request shown, says one more is waiting", t1.includes("queue first") && !t1.includes("queue second") && /1 more waiting/.test(t1) && pages === 1, `windows=${pages}`);
  await rejectBtn(ap).click();
  const ra = await within(10_000, pa, "queue first");
  await ap.getByText("queue second").waitFor({ timeout: 10_000 });
  const t2 = await visibleText(ap);
  check("8b second shown after the first is answered, queue note gone", ra.error?.code === 4001 && !/more waiting/.test(t2));
  const armed = await waitArmed(ap);
  check("8c Approve re-disarmed for the second request", armed.disabledAtStart, `${armed.ms} ms`);
  await rejectBtn(ap).click();
  const rb = await within(10_000, pb, "queue second");
  check("8d second rejected with 4001", rb.error?.code === 4001, JSON.stringify(rb));
  await waitClosed(ap);
});
await step("8 per-tab pending cap", async () => {
  const ps = [];
  for (let i = 0; i < 4; i++) { ps.push(rq("personal_sign", [`cap ${i}`, account])); await sleep(200); }
  const ap = await approvalPage();
  await sleep(800);
  const fifth = await within(10_000, rq("personal_sign", ["cap 4", account]), "fifth request");
  check("8e a fifth pending request from one tab is refused with -32002", fifth.error?.code === -32002, JSON.stringify(fifth));
  await rejectAll(ap);
  const rs = await Promise.all(ps.map((p) => within(10_000, p, "cap answer").catch((e) => ({ timeout: e.message }))));
  check("8f the four queued requests all answer 4001 when rejected", rs.every((r) => r.error?.code === 4001), JSON.stringify(rs.map((r) => r.error?.code ?? r)));
});

// ---------- 9. chains ----------
await step("9 chains", async () => {
  const r = await rq("wallet_switchEthereumChain", [{ chainId: "0x1" }]);
  check("9a switch to unknown chain returns 4902", r.error?.code === 4902, JSON.stringify(r));
  const same = await rq("wallet_switchEthereumChain", [{ chainId: "0x1159" }]);
  check("9b switch to the active chain returns null", same.result === null, JSON.stringify(same));
  // Built-in NUSD and the 0xPump factory (no symbol(): not a token), from src/config/contracts.ts.
  const NUSD = "0x69320A82ACCeC1b8A5EF59fd02b217e7ea4aEa19";
  const NOT_A_TOKEN = "0x0239baEc3c695A6EA893Ad90a7608112e0580526";
  // F11: a connected page may propose a network; the window shows it and is rejected here.
  const addP = rq("wallet_addEthereumChain", [{ chainId: "0x2105", chainName: "Base", rpcUrls: ["https://mainnet.base.org"], nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 } }]);
  const addAp = await approvalPage();
  await sleep(1200);
  const addText = (await addAp.locator("body").innerText()).replace(/\s+/g, " ");
  check("9c a proposed network shows its chain id, name and RPC host", /8453/.test(addText) && /Base/.test(addText) && /mainnet\.base\.org/.test(addText), addText.slice(0, 300));
  note("9c the proposal's RPC check", /8453 \(0x2105\)/.test(addText) ? addText.slice(0, 400) : "row missing");
  await rejectBtn(addAp).click();
  const add = await within(10_000, addP, "add reject");
  check("9c Reject of a proposed network returns 4001", add.error?.code === 4001, JSON.stringify(add));
  await waitClosed(addAp);
  const known = await within(10_000, rq("wallet_addEthereumChain", [{ chainId: "0x1159", chainName: "Other", rpcUrls: ["https://rpc.example.org"], nativeCurrency: { name: "Coin", symbol: "CN", decimals: 18 } }]), "known chain");
  check("9m proposing a saved chain answers null with no window", known.result === null && openApprovals().length === 0, JSON.stringify(known));
  for (const [label, proposal] of [
    ["http RPC", { chainId: "0x2105", chainName: "Base", rpcUrls: ["http://mainnet.base.org"], nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 } }],
    ["IP RPC", { chainId: "0x2105", chainName: "Base", rpcUrls: ["https://127.0.0.1:8545"], nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 } }],
    ["reserved name", { chainId: "0x2105", chainName: "LiteForge 2", rpcUrls: ["https://mainnet.base.org"], nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 } }],
  ]) {
    const refused = await within(10_000, rq("wallet_addEthereumChain", [proposal]), label);
    check(`9o a proposal with ${label} is -32602 with no window`, refused.error?.code === -32602 && openApprovals().length === 0, JSON.stringify(refused));
  }
  const mismatchP = rq("wallet_addEthereumChain", [{ chainId: "0x1", chainName: "Probe test", rpcUrls: ["https://rpc.testnet.liteforge.zeeve.net"], nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 } }]);
  const mismatchAp = await approvalPage();
  await sleep(4000);
  check("9n an RPC answering another chain keeps Approve disabled", await approveBtn(mismatchAp).isDisabled(), "");
  await rejectBtn(mismatchAp).click();
  const mismatch = await within(10_000, mismatchP, "mismatch reject");
  check("9n Reject returns 4001", mismatch.error?.code === 4001, JSON.stringify(mismatch));
  await waitClosed(mismatchAp);
  // F5: wallet_watchAsset.
  const builtin = await within(10_000, rq("wallet_watchAsset", { type: "ERC20", options: { address: NUSD, symbol: "NUSD", decimals: 18 } }), "builtin token");
  check("9i watchAsset for a built-in token answers true with no window", builtin.result === true && openApprovals().length === 0, JSON.stringify(builtin));
  for (const [label, params] of [
    ["a 30-character symbol", { type: "ERC20", options: { address: NUSD, symbol: "X".repeat(30) } }],
    ["ERC721", { type: "ERC721", options: { address: NUSD } }],
    ["an image only", { type: "ERC20", options: { image: "https://example.org/x.png" } }],
  ]) {
    const refused = await within(10_000, rq("wallet_watchAsset", params), label);
    check(`9k watchAsset with ${label} is -32602 with no window`, refused.error?.code === -32602 && openApprovals().length === 0, JSON.stringify(refused));
  }
  const fakeP = rq("wallet_watchAsset", { type: "ERC20", options: { address: NOT_A_TOKEN, symbol: "FAKE", decimals: 6 } });
  const fakeAp = await approvalPage();
  await sleep(800);
  const dupe = await within(10_000, rq("wallet_watchAsset", { type: "ERC20", options: { address: NOT_A_TOKEN } }), "duplicate token");
  check("9l the same token offered twice is -32002", dupe.error?.code === -32002, JSON.stringify(dupe));
  await sleep(3000);
  check("9j a contract that is not a token keeps Approve disabled", await approveBtn(fakeAp).isDisabled(), "");
  await rejectBtn(fakeAp).click();
  const fake = await within(10_000, fakeP, "watch reject");
  check("9j Reject of a watched token returns 4001", fake.error?.code === 4001, JSON.stringify(fake));
  await waitClosed(fakeAp);
  const upper = await rq("wallet_switchEthereumChain", [{ chainId: "0X1159" }]);
  note("9d chainId with upper-case 0X prefix", JSON.stringify(upper));
  const num = await rq("wallet_switchEthereumChain", [{ chainId: 4441 }]);
  check("9e numeric chainId 4441 is accepted (null), no JavaScript error text", num.result === null && !/is not a function|undefined|TypeError/.test(JSON.stringify(num)), JSON.stringify(num));
  const num1 = await rq("wallet_switchEthereumChain", [{ chainId: 1 }]);
  check("9f numeric chainId of an unsaved chain returns 4902", num1.error?.code === 4902, JSON.stringify(num1));
  const bad = await rq("wallet_switchEthereumChain", [{ chainId: 4441.5 }]);
  check("9g fractional chainId is a clean -32602", bad.error?.code === -32602, JSON.stringify(bad));
});

// ---------- 10. transactions (never approved) ----------
await step("10 eth_sendTransaction", async () => {
  const pending = rq("eth_sendTransaction", [{ from: account, to: account, value: "0x2386f26fc10000" }]);
  const ap = await approvalPage();
  await sleep(1500);
  const text = await visibleText(ap);
  const short = account.slice(2, 6).toLowerCase();
  check("10a window shows the decoded request (amount and recipient)", /0[.,]01/.test(text) && text.toLowerCase().replace(/\s+/g, "").includes(short), text.replace(/\s+/g, " ").slice(0, 200));
  await rejectBtn(ap).click(); // never approve a transaction
  const r = await within(10_000, pending, "tx reject");
  check("10b rejected transaction returns 4001", r.error?.code === 4001, JSON.stringify(r));
  await waitClosed(ap);
  for (const [label, tx] of [
    ["short to", { to: "0x123" }],
    ["non-hex value", { to: account, value: "100" }],
    ["array param", ["x"]],
    ["string chainId", { to: account, chainId: "4441x" }],
    ["fractional chainId", { to: account, chainId: 4441.5 }],
  ]) {
    const m = await rq("eth_sendTransaction", [tx]);
    check(`10c malformed (${label}) refused with -32602`, m.error?.code === -32602, JSON.stringify(m));
  }
  const wrong = await rq("eth_sendTransaction", [{ to: account, chainId: "0x1" }]);
  check("10d chainId of another network refused", wrong.error?.code === -32602, JSON.stringify(wrong));
  const none = await rq("eth_sendTransaction", []);
  check("10e missing params refused with -32602", none.error?.code === -32602, JSON.stringify(none));
  // F18 spending cap: built-in NUSD, approve(spender = this account, 1,000 NUSD). Never approved.
  const NUSD = "0x69320A82ACCeC1b8A5EF59fd02b217e7ea4aEa19";
  const word = (n) => n.toString(16).padStart(64, "0");
  const approveData = `0x095ea7b3${word(BigInt(account))}${word(1000n * 10n ** 18n)}`;
  const capPending = rq("eth_sendTransaction", [{ from: account, to: NUSD, data: approveData }]);
  const capAp = await approvalPage();
  const capInput = capAp.locator('.w-approve-flow input[inputmode="decimal"]');
  await capInput.waitFor({ timeout: 15_000 }).catch(() => {});
  const capText = (await visibleText(capAp)).replace(/\s+/g, " ");
  check("10f the approve review offers a spending cap with the requested 1,000 NUSD",
    capText.includes("Spending cap") && /Requested by the site\s*1,000 NUSD/.test(capText) && (await capInput.count()) === 1, capText.slice(0, 300));
  if ((await capInput.count()) === 1) {
    await capInput.fill("5");
    await sleep(300);
    const lowered = (await visibleText(capAp)).replace(/\s+/g, " ");
    const raw = ((await capAp.locator(".w-approve-raw").textContent()) ?? "").trim();
    check("10f2 typing 5 shows You allow 5 NUSD and rewrites only the amount word",
      /You allow\s*5 NUSD/.test(lowered) && raw.endsWith("4563918244f40000") && raw.slice(0, 74) === approveData.slice(0, 74) && raw.length === approveData.length,
      `${lowered.slice(0, 200)} | ${raw}`);
    await capInput.fill("2000");
    await sleep(300);
    const high = (await visibleText(capAp)).replace(/\s+/g, " ");
    const approveDisabled = await capAp.locator(".w-flow-actions .w-btn-row button").nth(1).isDisabled();
    check("10f3 a cap above the request is refused and Approve is disabled",
      high.includes("cannot be more than the site asked for") && approveDisabled, high.slice(0, 200));
  }
  await rejectBtn(capAp).click(); // never approve a transaction
  const capR = await within(10_000, capPending, "cap reject");
  check("10f4 rejecting the approve returns 4001", capR.error?.code === 4001, JSON.stringify(capR));
  await waitClosed(capAp);
  for (const [id, label, data] of [
    ["10g", "an approve with one extra byte", `${approveData}00`],
    ["10h", "a transfer", `0xa9059cbb${word(BigInt(account))}${word(1n)}`],
  ]) {
    const sent = rq("eth_sendTransaction", [{ from: account, to: NUSD, data }]);
    const w = await approvalPage();
    await sleep(2500);
    const editors = await w.locator('.w-approve-flow input[inputmode="decimal"]').count();
    const shownRaw = ((await w.locator(".w-approve-raw").textContent()) ?? "").trim();
    check(`${id} ${label} gets no cap editor and its calldata is shown unchanged`, editors === 0 && shownRaw === data, `editors=${editors} raw=...${shownRaw.slice(-12)}`);
    await rejectBtn(w).click(); // never approve a transaction
    await within(10_000, sent, `${id} reject`).catch(() => {});
    await waitClosed(w);
  }
});

// ---------- 11. locked ----------
await step("11 locked wallet", async () => {
  await popup.evaluate(() => { location.hash = "#/settings"; });
  await popup.getByRole("button", { name: /Lock now/ }).click();
  await popup.locator('input[type="password"]').waitFor({ timeout: 10_000 });
  const a = await rq("eth_accounts");
  note("11a eth_accounts while locked", JSON.stringify(a));
  const b = await within(10_000, rq("eth_requestAccounts"), "requestAccounts locked").catch((e) => ({ timeout: e.message }));
  note("11b eth_requestAccounts while locked", JSON.stringify(b));
  const pending = rq("personal_sign", ["signed while locked?", account]);
  const ap = await approvalPage();
  await sleep(1500);
  const asksPassword = await ap.locator('input[type="password"]').count() > 0;
  check("11c a sign request while locked asks for the password first", asksPassword, "");
  await ap.close();
  const r = await within(10_000, pending, "locked sign close");
  check("11d closing the locked window rejects with 4001", r.error?.code === 4001, JSON.stringify(r));
  await unlockIfNeeded(popup);
});

// ---------- 16. a second account: per-origin grants, ping-only broadcast ----------
let account2 = null;
await step("16 second account", async () => {
  // Record what the worker sends to tabs (the content script receives exactly this).
  await sw.evaluate(() => {
    globalThis.__e2eSent = [];
    if (!globalThis.__e2eWrapped) {
      const original = chrome.tabs.sendMessage.bind(chrome.tabs);
      chrome.tabs.sendMessage = (...args) => {
        try { globalThis.__e2eSent.push(JSON.parse(JSON.stringify(args[1] ?? null))); } catch {}
        return original(...args);
      };
      globalThis.__e2eWrapped = true;
    }
  });
  await clearEvents();
  await popup.evaluate(() => { location.hash = "#/home"; });
  await popup.locator("button.w-head-title").click();
  const sheet = popup.locator(".w-account-sheet");
  await sheet.waitFor({ timeout: 5000 });
  const rowsBefore = await sheet.locator(".w-account").count();
  await sheet.getByRole("button", { name: /Add account/ }).click();
  await until(async () => (await popup.locator(".w-account-sheet .w-account").count()) > rowsBefore
    || (await popup.locator(".w-account-sheet").count()) === 0, 15_000);
  if (await popup.locator(".w-account-sheet").count()) await popup.keyboard.press("Escape");
  if (await popup.locator(".w-account-sheet").count()) await popup.locator(".w-account-sheet .w-sheet-head .w-back").click().catch(() => {});
  await until(async () => (await dappEvents()).length > 0, 5000);
  await sleep(500);
  const ev = await dappEvents();
  check("16a after switching to a new account the connected page gets accountsChanged []",
    ev.some(([n, a]) => n === "accountsChanged" && Array.isArray(a) && a.length === 0), JSON.stringify(ev));
  const acc = await rq("eth_accounts");
  check("16b eth_accounts is [] for the account the site was not granted", Array.isArray(acc.result) && acc.result.length === 0, JSON.stringify(acc));
  const sent = await sw.evaluate(() => globalThis.__e2eSent ?? []).catch((e) => ({ error: e.message }));
  const events = Array.isArray(sent) ? sent.filter((m) => m?.kind === "provider-event") : [];
  const leaky = events.filter((m) => Object.keys(m).sort().join() !== "kind,name" || /0x[0-9a-fA-F]{40}|https?:\/\//.test(JSON.stringify(m)));
  check("16c the broadcast event carries only its name (no address, no origin list)", events.length > 0 && leaky.length === 0,
    `provider-event messages=${events.length} sample=${JSON.stringify(events[0] ?? sent)} leaky=${JSON.stringify(leaky.slice(0, 2))}`);
  await clearEvents();
  const pending = rq("eth_requestAccounts");
  const ap = await approvalPage();
  await waitArmed(ap);
  await approveBtn(ap).click();
  const res = await within(15_000, pending, "connect second account");
  account2 = res.result?.[0] ?? null;
  check("16d connecting grants the second account", /^0x[0-9a-fA-F]{40}$/.test(account2 ?? "") && account2.toLowerCase() !== account.toLowerCase() && res.result.length === 1, JSON.stringify(res));
  await waitClosed(ap);
  await clearEvents();
  await popup.locator("button.w-head-title").click();
  await popup.locator(".w-account-sheet").waitFor({ timeout: 5000 });
  await popup.locator('.w-account-sheet .w-account[aria-current="false"] .w-account-main').first().click();
  await sleep(2500);
  if (await popup.locator(".w-account-sheet").count()) await popup.keyboard.press("Escape");
  const prompted = openApprovals().length;
  const ev2 = await dappEvents();
  const back = await rq("eth_accounts");
  check("16e switching back gives the first account without a prompt",
    prompted === 0 && back.result?.[0]?.toLowerCase() === account.toLowerCase()
      && ev2.some(([n, a]) => n === "accountsChanged" && a?.[0]?.toLowerCase() === account.toLowerCase()),
    `prompts=${prompted} eth_accounts=${JSON.stringify(back)} events=${JSON.stringify(ev2)}`);
  await popup.evaluate(() => { location.hash = "#/dapps"; });
  await sleep(1000);
  const listed = (await visibleText(popup)).toLowerCase();
  note("16f Connected sites lists both granted accounts",
    `${listed.includes(account.slice(0, 6).toLowerCase())} / ${listed.includes(account2?.slice(-4).toLowerCase() ?? "-")}`);
});

// ---------- 12. revoke from the wallet opened as a tab ----------
await step("12 revoke", async () => {
  await clearEvents();
  const ui = await context.newPage();
  watch(ui, "popup");
  await ui.goto(`${POPUP}#/dapps`);
  await ui.waitForLoadState("domcontentloaded");
  await unlockIfNeeded(ui);
  await ui.evaluate(() => { location.hash = "#/dapps"; });
  const row = ui.locator(".w-dapp-site", { hasText: DAPP_ORIGIN });
  await row.waitFor({ timeout: 10_000 });
  await row.getByRole("button", { name: /Revoke/ }).click();
  await row.waitFor({ state: "detached", timeout: 10_000 });
  await until(async () => (await dappEvents()).length > 0, 3000);
  const ev = await dappEvents();
  check("12a revoking from a wallet tab delivers accountsChanged [] to the page", ev.some(([n, a]) => n === "accountsChanged" && Array.isArray(a) && a.length === 0), JSON.stringify(ev));
  const a = await rq("eth_accounts");
  check("12b eth_accounts is [] after revoke", Array.isArray(a.result) && a.result.length === 0, JSON.stringify(a));
  const s = await rq("personal_sign", ["after revoke", account]);
  check("12c signing after revoke refused with 4100", s.error?.code === 4100, JSON.stringify(s));
  await ui.close();
});

// ---------- 13. worker stopped while a connect is pending ----------
await step("13 worker stop", async () => {
  const pending = rq("eth_requestAccounts");
  const ap = await approvalPage();
  await sleep(500);
  const cdp = await context.newCDPSession(popup);
  await cdp.send("ServiceWorker.enable");
  await cdp.send("ServiceWorker.stopAllWorkers");
  const r = await within(15_000, pending, "pending across stop").catch((e) => ({ timeout: e.message }));
  note("13a pending request when the worker stopped", JSON.stringify(r));
  check("13b the pending request settles (no hang)", !r.timeout, JSON.stringify(r));
  await sleep(1500);
  const apOpen = !ap.isClosed();
  note("13c approval window after the stop", apOpen ? (await visibleText(ap)).replace(/\s+/g, " ").slice(0, 160) : "closed");
  const c = await within(10_000, rq("eth_chainId"), "chainId after stop").catch((e) => ({ timeout: e.message }));
  check("13d next read request works after the stop", c.result === "0x1159", JSON.stringify(c));
  if (apOpen) {
    const clickable = !(await approveBtn(ap).isDisabled().catch(() => true));
    note("13e stale approval window Approve enabled?", String(clickable));
    if (clickable) {
      await approveBtn(ap).click().catch(() => {});
      await sleep(2000);
      const after = ap.isClosed() ? "(window closed)" : (await visibleText(ap)).replace(/\s+/g, " ").slice(0, 200);
      const acc = await rq("eth_accounts");
      note("13h Approve clicked on the stale request", `window: ${after} ; eth_accounts now ${JSON.stringify(acc)}`);
      check("13i approving a request whose caller already got an error grants nothing silently", Array.isArray(acc.result) && acc.result.length === 0, JSON.stringify(acc));
      if (acc.result?.length) await rq("wallet_revokePermissions", [{ eth_accounts: {} }]);
    }
    await ap.close().catch(() => {});
  }
  await sleep(500);
  const next = rq("eth_requestAccounts");
  const ap2 = await approvalPage().catch(() => null);
  check("13f a new connect request opens an approval window", !!ap2, "");
  if (ap2) {
    // The test page is served from a local origin: neither official nor a look-alike.
    await rejectBtn(ap2).waitFor().catch(() => {});
    const marks = await ap2.locator(".w-approve-official, [data-lookalike]").count();
    check("13l a local test page gets neither the official mark nor the look-alike warning", marks === 0, `marks=${marks}`);
    await rejectBtn(ap2).click();
  }
  const rn = await within(10_000, next, "connect after stop").catch((e) => ({ timeout: e.message }));
  check("13g that request answers (rejected -> 4001)", rn.error?.code === 4001, JSON.stringify(rn));
  if (ap2) await waitClosed(ap2);
  const cooled = await within(5_000, rq("eth_requestAccounts"), "connect in cooldown").catch((e) => ({ timeout: e.message }));
  check("13j a connect right after a user rejection answers 4001 without a prompt (30 s cooldown)", cooled.error?.code === 4001 && openApprovals().length === 0, JSON.stringify(cooled));
  await cdp.detach().catch(() => {});
  note("13k waiting out the 30 s connect cooldown", "31 s");
  await sleep(31_000);
});

// ---------- 14. dapp reload / navigation while pending ----------
await step("14 reload while pending", async () => {
  const ours = async () => (await readLocal("wallet.pending.v1")).filter((row) => row?.origin === DAPP_ORIGIN);
  const orphan = rq("eth_requestAccounts");
  const ap = await approvalPage();
  await sleep(400);
  await dapp.reload();
  await sleep(1500);
  void orphan;
  const left = await until(async () => (await ours()).length === 0, 4000) ? 0 : (await ours()).length;
  const closed = await waitClosed(ap, 4000);
  check("14a reloading the page rejects its pending connect (row gone, window closed)", left === 0 && closed, `rows=${left} window=${closed ? "closed" : "open"}`);
  const again = rq("eth_requestAccounts");
  const ap2 = await approvalPage(8_000).catch(() => null);
  check("14b the reloaded page can connect at once (a prompt opens)", !!ap2, ap2 ? "" : JSON.stringify(await within(3000, again, "again").catch((e) => ({ timeout: e.message }))));
  if (ap2) { await waitArmed(ap2); await approveBtn(ap2).click(); }
  const r = await within(15_000, again, "connect after reload").catch((e) => ({ timeout: e.message }));
  check("14c that connect returns the active account", r.result?.[0]?.toLowerCase() === account.toLowerCase(), JSON.stringify(r));
  if (ap2) await waitClosed(ap2);
  const sign = rq("personal_sign", ["orphan sign", account]);
  const ap3 = await approvalPage();
  await sleep(300);
  await dapp.reload();
  await sleep(1500);
  void sign;
  const left3 = await until(async () => (await ours()).length === 0, 4000) ? 0 : (await ours()).length;
  const closed3 = await waitClosed(ap3, 4000);
  check("14d reloading rejects a pending sign request too", left3 === 0 && closed3, `rows=${left3} window=${closed3 ? "closed" : "open"}`);
  const spa = rq("personal_sign", ["spa keeps me", account]);
  const ap4 = await approvalPage();
  await sleep(300);
  await dapp.evaluate(() => history.pushState({}, "", "/spa-route"));
  await sleep(2000);
  const kept = !ap4.isClosed() && (await visibleText(ap4)).includes("spa keeps me") && (await ours()).length === 1;
  check("14e an SPA pushState keeps the pending request", kept, ap4.isClosed() ? "window closed" : "");
  if (!ap4.isClosed()) await rejectBtn(ap4).click().catch(() => {});
  const rs = await within(10_000, spa, "spa answer").catch((e) => ({ timeout: e.message }));
  check("14f the same page still gets the answer (4001)", rs.error?.code === 4001, JSON.stringify(rs));
  for (const p of openApprovals()) await rejectAll(p);
  await dapp.goto(DAPP);
  await sleep(800);
});

// ---------- 15. approve after the worker died: nothing is signed for nobody ----------
await step("15 approve after worker stop", async () => {
  for (const p of openApprovals()) await p.close().catch(() => {});
  await sleep(800);
  const acc = (await rq("eth_accounts")).result ?? [];
  if (!acc.length) { check("15 needs a connected site", false, "site not connected"); return; }
  const beforeIds = new Set((await readLocal("wallet.resolved.v1")).map((e) => e.id));
  const pending = rq("personal_sign", ["after the worker died", acc[0]]);
  const ap = await approvalPage();
  await sleep(300);
  const cdp = await context.newCDPSession(popup);
  await cdp.send("ServiceWorker.enable");
  await cdp.send("ServiceWorker.stopAllWorkers");
  const r = await within(15_000, pending, "sign across stop").catch((e) => ({ timeout: e.message }));
  note("15a page answer", JSON.stringify(r));
  let clicked = false;
  if (!ap.isClosed()) {
    const armed = await waitArmed(ap).catch(() => null);
    if (armed) { await approveBtn(ap).click().catch(() => {}); clicked = true; }
  }
  await sleep(2500);
  const shown = ap.isClosed() ? "(window closed)" : (await visibleText(ap)).replace(/\s+/g, " ").slice(0, 200);
  const resolved = (await readLocal("wallet.resolved.v1")).filter((e) => !beforeIds.has(e.id));
  const signatures = resolved.filter((e) => typeof e.result === "string" && e.result.length > 100).length;
  check("15b the old approval window refuses to sign a request the worker lost", signatures === 0,
    `page=${JSON.stringify(r)}; approve clicked=${clicked}; window: ${shown}; signatures in wallet.resolved.v1=${signatures}`);
  note("15c what the old window showed", shown);
  if (!ap.isClosed()) await ap.close().catch(() => {});
  await cdp.detach().catch(() => {});
});

// ---------- 17. Send review arming, hidden balances, Send draft (popup only, faked balance) ----------
// The popup's balance reads answered as 1 zkLTC and its gas estimate as 21000 (page only);
// any broadcast is aborted. `counts` gathers seen / faked / blocked.
const RPC_HOST = "rpc.testnet.liteforge.zeeve.net";
function fakeOneZkltc(counts) {
  const ONE = "0xde0b6b3a7640000"; // 1 zkLTC, shown to the popup only
  const GET_ETH_BALANCE = "0x4d2301cc";
  const ONE_WORD = encodeAbiParameters([{ type: "uint256" }], [BigInt(ONE)]);
  const isBalanceCall = (c) => c?.method === "eth_call" && typeof c.params?.[0]?.data === "string";
  return async (route) => {
    const req = route.request();
    let body = null;
    try { body = req.method() === "POST" ? req.postDataJSON() : null; } catch {}
    if (!body) return route.continue();
    const calls = Array.isArray(body) ? body : [body];
    if (calls.some((c) => /^eth_send(Raw)?Transaction$/.test(c?.method ?? ""))) { counts.blocked++; return route.abort(); }
    counts.seen++;
    if (!calls.some((c) => c?.method === "eth_getBalance" || c?.method === "eth_estimateGas" || isBalanceCall(c))) return route.continue();
    const resp = await route.fetch();
    let json;
    try { json = await resp.json(); } catch { return route.fulfill({ response: resp }); }
    const list = Array.isArray(json) ? json : [json];
    for (const res of list) {
      const call = calls.find((c) => c?.id === res?.id);
      if (!call) continue;
      if (call.method === "eth_getBalance") { delete res.error; res.result = ONE; counts.faked++; }
      if (call.method === "eth_estimateGas") { delete res.error; res.result = "0x5208"; counts.faked++; }
      if (isBalanceCall(call) && typeof res.result === "string") {
        const data = call.params[0].data;
        if (data.startsWith(GET_ETH_BALANCE)) { res.result = ONE_WORD; counts.faked++; continue; }
        try {
          const { functionName, args } = decodeFunctionData({ abi: multicall3Abi, data });
          if (functionName !== "aggregate3") continue;
          const hits = args[0].map((c, i) => (c.callData.startsWith(GET_ETH_BALANCE) ? i : -1)).filter((i) => i >= 0);
          if (!hits.length) continue;
          const out = [...decodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", data: res.result })];
          for (const i of hits) out[i] = { success: true, returnData: ONE_WORD };
          res.result = encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: out });
          counts.faked += hits.length;
        } catch {}
      }
    }
    return route.fulfill({ response: resp, json: Array.isArray(json) ? list : list[0] });
  };
}
await step("17 send review, hide balances, draft", async () => {
  const counts = { seen: 0, faked: 0, blocked: 0 };
  const handler = fakeOneZkltc(counts);
  const matcher = (url) => url.hostname === RPC_HOST;
  await popup.route(matcher, handler);
  try {
    await popup.reload();
    await unlockIfNeeded(popup);
    await popup.evaluate(() => { location.hash = "#/home"; });
    const total = popup.locator(".w-total");
    await until(async () => !/^[…—]?$/.test((await total.innerText()).trim()), 15_000);
    const shownTotal = (await total.innerText()).trim();
    const eye = popup.locator("button.w-total-eye");
    if (await eye.getAttribute("aria-pressed") === "true") { await eye.click(); await sleep(500); }
    await eye.click();
    await until(async () => (await total.innerText()).trim() === "••••", 5000);
    const home = await visibleText(popup);
    check("17a hide balances masks the Home total", (await total.innerText()).trim() === "••••" && shownTotal !== "••••" && home.includes("••••"), `before=${shownTotal}`);

    const TO = getAddress("0x" + crypto.randomBytes(20).toString("hex"));
    await popup.evaluate(() => { location.hash = "#/send"; });
    const recipient = popup.locator('form.w-send-flow input[placeholder="0x…"]');
    const amountInput = popup.locator('form.w-send-flow input[inputmode="decimal"]');
    await recipient.waitFor({ timeout: 10_000 });
    await recipient.fill(TO);
    await amountInput.fill("0.001");
    await sleep(1200);
    await popup.reload();
    await unlockIfNeeded(popup);
    await popup.evaluate(() => { location.hash = "#/send"; });
    await recipient.waitFor({ timeout: 10_000 });
    await until(async () => (await recipient.inputValue()) !== "", 5000);
    const restored = { to: await recipient.inputValue(), amount: await amountInput.inputValue(), note: (await visibleText(popup)).includes("Draft restored") };
    check("17b a draft typed on Send is still there after the popup page is reopened",
      restored.to.toLowerCase() === TO.toLowerCase() && restored.amount === "0.001" && restored.note, `amount=${restored.amount} note=${restored.note} toMatches=${restored.to.toLowerCase() === TO.toLowerCase()}`);

    const submit = popup.locator('form.w-send-flow button[type="submit"]');
    const ready = await until(async () => !(await submit.isDisabled()), 20_000, 200);
    if (!ready) {
      check("17c the Send review cannot be confirmed in its first 500 ms", false, `Send never enabled (RPC requests seen=${counts.seen}, faked answers=${counts.faked}); page: ${(await visibleText(popup)).replace(/\s+/g, " ").slice(0, 200)}`);
    } else {
      await submit.click();
      const confirm = popup.locator(".w-swap-review .w-btn-row button").nth(1);
      await confirm.waitFor({ timeout: 5000 });
      const armed = await waitEnabled(confirm, 5000);
      check("17c the Send review cannot be confirmed in its first 500 ms", armed.disabledAtStart && armed.ms >= 400 && armed.ms < 3000, `enabled after ${armed.ms} ms`);
      const review = await popup.locator(".w-swap-review").innerText();
      check("17d hidden balances do not mask the review", /0[.,]001/.test(review) && !review.includes("••••"), review.replace(/\s+/g, " ").slice(0, 160));
      await popup.locator(".w-swap-review .w-btn-row button").nth(0).click(); // Cancel, never Confirm
      await popup.locator(".w-swap-review").waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
    }
    const clear = popup.locator(".w-draft button");
    if (await clear.count()) await clear.click();
    else { await recipient.fill(""); await amountInput.fill(""); }
    await popup.evaluate(() => { location.hash = "#/home"; });
    await eye.waitFor({ timeout: 5000 });
    if (await eye.getAttribute("aria-pressed") === "true") await eye.click();
    note("17e RPC requests seen / faked answers / blocked broadcasts", `${counts.seen} / ${counts.faked} / ${counts.blocked}`);
  } finally {
    // Ignores a fetch still in flight (it would reject after the context closes).
    await popup.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
  }
});

// ---------- feature wave helpers ----------
const LITEFORGE_RPC = "https://rpc.testnet.liteforge.zeeve.net";
const NUSD_TOKEN = "0x69320A82ACCeC1b8A5EF59fd02b217e7ea4aEa19";
const ALLOWANCE = "0xdd62ed3e";
const readSettings = () => popup.evaluate(async () => (await chrome.storage.local.get("wallet.settings.v1"))["wallet.settings.v1"] ?? null);
const viewOf = (p) => p.evaluate(() => {
  const el = document.querySelector("[data-view]");
  const html = document.documentElement;
  return {
    view: el?.getAttribute("data-view") ?? null,
    surface: el?.getAttribute("data-surface") ?? null,
    sideways: html.scrollWidth > html.clientWidth,
    width: html.clientWidth,
  };
});
async function openSheet(p) {
  await p.evaluate(() => { location.hash = "#/home"; });
  await p.locator("button.w-head-title").click();
  const sheet = p.locator(".w-account-sheet");
  await sheet.waitFor({ timeout: 5000 });
  return sheet;
}
const actionNames = async (p) => (await p.locator(".w-account-sheet .w-account-actions button").allInnerTexts()).map((s) => s.trim());
// The worker's stop is asked through any page's CDP session.
async function stopWorker() {
  const cdp = await context.newCDPSession(popup);
  await cdp.send("ServiceWorker.enable");
  await cdp.send("ServiceWorker.stopAllWorkers");
  await cdp.detach().catch(() => {});
}
// A second local origin (127.0.0.1 instead of localhost): never connected.
const STRANGER = `http://127.0.0.1:${server.address().port}/`;

// ---------- 18. side panel, wallet tab, shortcut (F1, F2, F4) ----------
await step("18 side panel, tab, shortcut", async () => {
  const mf = JSON.parse(fs.readFileSync(path.join(DIST, "manifest.json"), "utf8"));
  check("18a the built manifest declares the side panel page, the shortcut, sidePanel + activeTab, notifications only as optional",
    mf.side_panel?.default_path === "index.html?surface=panel"
      && mf.commands?._execute_action?.suggested_key?.default === "Alt+Shift+W"
      && JSON.stringify(mf.permissions) === JSON.stringify(["storage", "alarms", "idle", "sidePanel", "activeTab"])
      && JSON.stringify(mf.optional_permissions) === JSON.stringify(["notifications"]),
    JSON.stringify({ side_panel: mf.side_panel, commands: mf.commands, permissions: mf.permissions, optional: mf.optional_permissions }));
  const cmds = await popup.evaluate(async () => (await chrome.commands.getAll()).map((c) => ({ name: c.name, shortcut: c.shortcut })));
  check("18b Chrome registered the _execute_action command", cmds.some((c) => c.name === "_execute_action"), JSON.stringify(cmds));
  await popup.evaluate(() => { location.hash = "#/settings"; });
  await popup.getByText("chrome://extensions/shortcuts").first().waitFor({ timeout: 5000 }).catch(() => {});
  const settingsText = await visibleText(popup);
  check("18c Settings says where Chrome lets the user set the shortcut", settingsText.includes("chrome://extensions/shortcuts"), "");
  check("18d the popup page has chrome.sidePanel.open", await popup.evaluate(() => typeof chrome.sidePanel?.open === "function"));

  // The side panel page, rendered in a tab at 400 px (the same document Chrome puts in the panel).
  const panel = await context.newPage();
  watch(panel, "popup");
  await panel.setViewportSize({ width: 400, height: 720 });
  await panel.goto(`${POPUP}?surface=panel#/home`);
  await panel.waitForLoadState("domcontentloaded");
  await unlockIfNeeded(panel);
  await panel.locator("button.w-head-title").waitFor({ timeout: 10_000 });
  const shape = await viewOf(panel);
  check("18e the side panel page at 400 px uses the full layout (data-view panel, data-surface full), no sideways scroll",
    shape.view === "panel" && shape.surface === "full" && !shape.sideways && shape.width === 400, JSON.stringify(shape));
  const bad = [];
  for (const route of ["home", "send", "receive", "history", "dapps", "settings"]) {
    const before = logs.popup.length;
    await panel.evaluate((r) => { location.hash = `#/${r}`; }, route);
    await sleep(900);
    const text = await visibleText(panel);
    const v = await viewOf(panel);
    if (text.trim().length < 20 || /Something went wrong/.test(text)) bad.push(`${route}: blank or crash`);
    if (v.sideways) bad.push(`${route}: sideways scroll`);
    if (logs.popup.length > before) bad.push(`${route}: ${logs.popup.slice(before).join(" / ")}`);
  }
  check("18f every main screen renders in the side panel page at 400 px", bad.length === 0, bad.join(" ; "));
  const widths = [];
  for (const w of [320, 500]) {
    await panel.setViewportSize({ width: w, height: 720 });
    await panel.evaluate(() => { location.hash = "#/home"; });
    await sleep(600);
    widths.push({ w, ...(await viewOf(panel)) });
  }
  check("18g no sideways scroll at 320 and 500 px", widths.every((v) => !v.sideways), JSON.stringify(widths));
  await panel.setViewportSize({ width: 400, height: 720 });
  await panel.evaluate(() => { location.hash = "#/dapps"; });
  await sleep(1000);
  check("18h the side panel shows no current-site card (the tab's origin is not known there)", await panel.locator(".w-dapp-current").count() === 0);
  await openSheet(panel);
  const panelActions = await actionNames(panel);
  check("18i the panel's account sheet offers Open in tab and Lock now, not Side panel",
    panelActions.some((s) => /Open in tab/.test(s)) && panelActions.some((s) => /Lock now/.test(s)) && !panelActions.some((s) => /Side panel/.test(s)),
    JSON.stringify(panelActions));
  // Approvals still use the approval window while the panel is open.
  const signP = rq("personal_sign", ["panel open", account]);
  const ap = await approvalPage();
  check("18j with the panel open a dapp request still opens the approval window", isApproval(ap), ap.url().replace(/^.*index\.html/, "index.html"));
  await rejectBtn(ap).click();
  const signR = await within(10_000, signP, "panel sign reject");
  check("18k that request rejects with 4001", signR.error?.code === 4001, JSON.stringify(signR));
  await waitClosed(ap);

  // F2 from the panel: a new wallet tab opens and the panel stays.
  const tabWait = context.waitForEvent("page", { predicate: (p) => p.url().includes("surface=tab"), timeout: 10_000 });
  await panel.locator(".w-account-sheet .w-account-actions button", { hasText: "Open in tab" }).click();
  const tab = await tabWait.catch(() => null);
  check("18l Open in tab opens index.html?surface=tab and the panel stays open", !!tab && !panel.isClosed(), tab ? tab.url().replace(/^.*index\.html/, "index.html") : "no tab");
  if (tab) {
    watch(tab, "popup");
    await tab.setViewportSize({ width: 900, height: 800 });
    await tab.waitForLoadState("domcontentloaded");
    await unlockIfNeeded(tab);
    await tab.locator("button.w-head-title").waitFor({ timeout: 10_000 });
    const tabShape = await viewOf(tab);
    const tabText = await visibleText(tab);
    check("18m the wallet tab is the full layout (data-view tab) and opens unlocked on Home",
      tabShape.view === "tab" && tabShape.surface === "full" && !tabShape.sideways && tabText.trim().length > 20, JSON.stringify(tabShape));
    await openSheet(tab);
    const tabActions = await actionNames(tab);
    check("18n the tab's account sheet offers neither Side panel nor Open in tab, only Lock now",
      tabActions.length === 1 && /Lock now/.test(tabActions[0]), JSON.stringify(tabActions));
    await tab.keyboard.press("Escape");
    await tab.evaluate(() => { location.hash = "#/dapps"; });
    await tab.locator(".w-dapp-site", { hasText: DAPP_ORIGIN }).first().waitFor({ timeout: 8000 }).catch(() => {});
    check("18o the wallet tab lists the connected site (it works like the popup)", (await visibleText(tab)).includes(DAPP_ORIGIN));
    await tab.close();
  }
  await panel.close();

  // F1 for real, from a popup-view page: the click is a user gesture for Chrome.
  const pop = await context.newPage();
  watch(pop, "popup");
  await pop.goto(`${POPUP}#/home`);
  await unlockIfNeeded(pop);
  await openSheet(pop);
  const popActions = await actionNames(pop);
  check("18p the popup's account sheet offers Side panel, Open in tab and Lock now",
    ["Side panel", "Open in tab", "Lock now"].every((n) => popActions.some((s) => s.includes(n))), JSON.stringify(popActions));
  const sideBtn = pop.locator(".w-account-sheet .w-account-actions button", { hasText: "Side panel" });
  await until(async () => !(await sideBtn.isDisabled()), 5000);
  const panelWait = context.waitForEvent("page", { predicate: (p) => p.url().includes("surface=panel"), timeout: 6000 }).catch(() => null);
  await sideBtn.click();
  const closed = await waitClosed(pop, 6000);
  const toast = closed ? "" : (await pop.locator(".w-toast").allInnerTexts().catch(() => [])).join(" ");
  check("18q clicking Side panel makes Chrome open the panel (sidePanel.open resolved, the popup closed itself)", closed, closed ? "" : `popup still open; toast: ${toast}`);
  const realPanel = await panelWait;
  if (realPanel) {
    await realPanel.waitForLoadState("domcontentloaded").catch(() => {});
    await sleep(1500);
    const v = await viewOf(realPanel).catch((e) => ({ error: e.message }));
    note("18r the real side panel page", `${realPanel.url().replace(/^.*index\.html/, "index.html")} ${JSON.stringify(v)}`);
  } else {
    note("18r the real side panel page", "Playwright did not expose the panel's page target (checked above in a tab at 400 px instead)");
  }
  if (!pop.isClosed()) await pop.close();
});

// ---------- 19. toolbar badge (F3) ----------
await step("19 toolbar badge", async () => {
  for (const p of openApprovals()) await rejectAll(p);
  const badge = () => sw.evaluate(() => chrome.action.getBadgeText({}));
  const badgeIs = (text, ms = 5000) => until(async () => (await badge()) === text, ms);
  check("19a no badge while nothing waits", await badgeIs(""), JSON.stringify(await badge().catch((e) => e.message)));
  const pa = rq("personal_sign", ["badge one", account]);
  await sleep(250);
  const pb = rq("personal_sign", ["badge two", account]);
  const ap = await approvalPage();
  check("19b two waiting requests show 2 on the toolbar icon", await badgeIs("2"), JSON.stringify(await badge()));
  await rejectBtn(ap).click();
  await within(10_000, pa, "badge one");
  check("19c the badge follows the queue down to 1", await badgeIs("1"), JSON.stringify(await badge()));
  await ap.getByText("badge two").waitFor({ timeout: 10_000 });
  await rejectBtn(ap).click();
  await within(10_000, pb, "badge two");
  check("19d the badge clears when the queue is empty", await badgeIs(""), JSON.stringify(await badge()));
  await waitClosed(ap);
  // A worker restart recomputes it from the queue (a wrong text is planted first).
  const pc = rq("personal_sign", ["badge across a restart", account]);
  const ap2 = await approvalPage();
  await badgeIs("1");
  await sw.evaluate(() => chrome.action.setBadgeText({ text: "7" }));
  const oldWorker = sw;
  await stopWorker();
  const answer = await within(15_000, pc, "badge restart").catch((e) => ({ timeout: e.message }));
  await within(10_000, rq("eth_chainId"), "wake the worker").catch(() => {});
  await until(async () => sw !== oldWorker, 8000);
  const queued = await until(async () => {
    const text = await badge();
    const rows = (await readLocal("wallet.pending.v1")).length;
    return text !== "7" && text === (rows ? String(rows) : "") ? { text, rows } : null;
  }, 10_000);
  check("19e after a worker restart the badge is recomputed from the queue", !!queued, JSON.stringify({ queued, now: await badge().catch((e) => e.message), answer }));
  if (!ap2.isClosed()) await ap2.close().catch(() => {});
  await badgeIs("");
});

// ---------- 20. current site on the Dapp screen (F9) ----------
await step("20 current site", async () => {
  await dapp.bringToFront();
  const seen = await popup.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return { url: tab?.url ?? null, hasTab: !!tab };
  });
  note("20a what the popup page can read of the active tab without a toolbar click", JSON.stringify(seen));
  await popup.evaluate(() => { location.hash = "#/home"; });
  await sleep(300);
  await popup.evaluate(() => { location.hash = "#/dapps"; });
  await popup.locator(".w-dapp-site").first().waitFor({ timeout: 8000 }).catch(() => {});
  await sleep(800);
  const card = popup.locator(".w-dapp-current");
  if (seen.url) {
    const text = (await card.innerText().catch(() => "")).replace(/\s+/g, " ");
    check("20b the Dapp screen's first card shows the active tab's origin as connected with its account",
      text.includes(DAPP_ORIGIN) && text.includes("Connected") && text.toLowerCase().includes(account.slice(-4).toLowerCase()), text);
  } else {
    check("20b without activeTab (no toolbar click in automation) the popup shows no current-site card, never a guess", await card.count() === 0, "");
  }
  // The card itself, with the tab read answered as Chrome answers after a toolbar click
  // (activeTab cannot be granted by automation). Only the URL is given; no title.
  const shown = [];
  for (const [label, url] of [["connected", DAPP], ["not connected", STRANGER], ["not a web page", "chrome://extensions/"]]) {
    const p = await context.newPage();
    watch(p, "popup");
    await p.addInitScript((u) => {
      const install = () => {
        if (!globalThis.chrome?.tabs?.query) return false;
        chrome.tabs.query = async () => [{ id: 1, url: u, title: "<b>page text</b>" }];
        return true;
      };
      if (!install()) document.addEventListener("DOMContentLoaded", install, { once: true });
    }, url);
    await p.goto(`${POPUP}#/dapps`);
    await unlockIfNeeded(p);
    await p.evaluate(() => { location.hash = "#/dapps"; });
    await p.locator(".w-dapp-site").first().waitFor({ timeout: 8000 }).catch(() => {});
    await sleep(800);
    const c = p.locator(".w-dapp-current");
    const first = await p.locator(".w-dapps > *").first().getAttribute("class").catch(() => "");
    shown.push({ label, count: await c.count(), first, text: (await c.innerText().catch(() => "")).replace(/\s+/g, " "), revoke: await c.getByRole("button", { name: /Revoke/ }).count() });
    await p.close();
  }
  const [conn, stranger, other] = shown;
  check("20c (tab read stubbed) a connected site: first card, origin, Connected with the account, a Revoke button",
    conn.count === 1 && /w-dapp-current/.test(conn.first ?? "") && conn.text.includes(DAPP_ORIGIN) && /Connected/.test(conn.text)
      && conn.text.toLowerCase().includes(account.slice(-4).toLowerCase()) && conn.revoke === 1 && !conn.text.includes("page text"), JSON.stringify(conn));
  check("20d (tab read stubbed) an unconnected site: its origin and Not connected, no Revoke",
    stranger.count === 1 && stranger.text.includes(STRANGER.slice(0, -1)) && /Not connected/.test(stranger.text) && stranger.revoke === 0, JSON.stringify(stranger));
  check("20e (tab read stubbed) a chrome:// tab shows no card", other.count === 0, JSON.stringify(other));
});

// ---------- 21. wallet_watchAsset and wallet_addEthereumChain (F5, F11) ----------
await step("21 dapp proposals", async () => {
  for (const p of openApprovals()) await rejectAll(p);
  // An unconnected origin is refused before any window.
  const other = await context.newPage();
  watch(other, "dapp");
  await other.goto(STRANGER);
  await sleep(500);
  const orq = (method, params) => other.evaluate(([m, p]) => window.rq(m, p), [method, params]);
  const w0 = await orq("wallet_watchAsset", { type: "ERC20", options: { address: NUSD_TOKEN, symbol: "NUSD", decimals: 18 } });
  check("21a watchAsset from an unconnected page answers 4100 with no window", w0.error?.code === 4100 && openApprovals().length === 0, JSON.stringify(w0));
  const a0 = await orq("wallet_addEthereumChain", [{ chainId: "0x1a2b3", chainName: "E2E Net", rpcUrls: ["https://rpc.e2e-test.org"], nativeCurrency: { name: "E2E Coin", symbol: "EEC", decimals: 18 } }]);
  check("21b addEthereumChain from an unconnected page answers 4100 with no window", a0.error?.code === 4100 && openApprovals().length === 0, JSON.stringify(a0));
  await other.close();

  // F5 with a token that is not built in: the first pair of the 0xNothing DEX (an LP token).
  const ethCall = async (to, data) => (await (await fetch(LITEFORGE_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }) })).json()).result;
  const pairWord = await ethCall("0xc6B675d701a168789A5cc7Dd04Ef9e531886114c", "0x1e3dd18b" + "0".repeat(64));
  const LP = getAddress("0x" + pairWord.slice(-40));
  const lpSymbolHex = await ethCall(LP, "0x95d89b41");
  const lpSymbol = Buffer.from(lpSymbolHex.slice(130, 130 + 2 * Number(BigInt("0x" + lpSymbolHex.slice(66, 130)))), "hex").toString("utf8");
  const tokensText = async () => JSON.stringify(await popup.evaluate(async () => (await chrome.storage.local.get("wallet.tokens.v1"))["wallet.tokens.v1"] ?? null)).toLowerCase();
  const mismatchP = rq("wallet_watchAsset", { type: "ERC20", options: { address: LP, symbol: "FAKE", decimals: 6 } });
  const m = await approvalPage();
  await m.getByText("The site says").waitFor({ timeout: 15_000 }).catch(() => {});
  const mText = (await visibleText(m)).replace(/\s+/g, " ");
  check(`21c a claim that differs from the contract is flagged (the site says FAKE · 6, the contract ${lpSymbol} · 18)`,
    mText.includes("The site says") && mText.includes("FAKE · 6") && mText.includes("differ from the token contract") && mText.includes(lpSymbol) && / 18 /.test(mText)
      && await m.locator('.w-row[data-tone="red"], [data-tone="red"]').count() > 0, mText.slice(0, 400));
  await rejectBtn(m).click();
  const mR = await within(10_000, mismatchP, "watch mismatch reject");
  check("21d Reject of a watched token answers 4001 and adds nothing", mR.error?.code === 4001 && !(await tokensText()).includes(LP.toLowerCase()), JSON.stringify(mR));
  await waitClosed(m);
  const addTokP = rq("wallet_watchAsset", { type: "ERC20", options: { address: LP, symbol: lpSymbol, decimals: 18 } });
  const a = await approvalPage();
  const armedTok = await waitArmed(a).catch(() => null);
  const aText = (await visibleText(a)).replace(/\s+/g, " ");
  check("21e a matching offer shows the contract's values, no mismatch flag, and Approve arms",
    !!armedTok && aText.includes("Add a token") && aText.includes(lpSymbol) && !aText.includes("The site says"), aText.slice(0, 300));
  await approveBtn(a).click();
  const aR = await within(15_000, addTokP, "watch approve");
  const savedTok = await until(async () => (await tokensText()).includes(LP.toLowerCase()), 5000);
  check("21f Approve adds the token for the active network and answers true", aR.result === true && !!savedTok, JSON.stringify(aR));
  await waitClosed(a);

  // F11 with an RPC the wallet can reach: a granted host, answered by this harness (no real traffic).
  const CHAIN = 0x1a2b3;
  const RPC = "https://api.goldsky.com/e2e-proposed-rpc";
  let probes = 0;
  const rpcRoute = async (route) => {
    const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "content-type": "application/json" };
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    let body = null;
    try { body = route.request().postDataJSON(); } catch {}
    probes++;
    const answer = (c) => ({ jsonrpc: "2.0", id: c?.id ?? 1, ...(c?.method === "eth_chainId" ? { result: "0x" + CHAIN.toString(16) } : { error: { code: -32601, message: "not here" } }) });
    return route.fulfill({ status: 200, headers, body: JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)) });
  };
  await context.route((url) => url.href.startsWith(RPC), rpcRoute);
  try {
    const proposal = { chainId: "0x" + CHAIN.toString(16), chainName: "E2E Net", rpcUrls: [RPC], blockExplorerUrls: ["https://explorer.e2e-test.org"], nativeCurrency: { name: "E2E Coin", symbol: "EEC", decimals: 18 } };
    const settingsBefore = JSON.stringify(await readSettings());
    await clearEvents();
    const addP = rq("wallet_addEthereumChain", [proposal]);
    const w = await approvalPage();
    await sleep(300);
    const dup = await within(10_000, rq("wallet_addEthereumChain", [{ ...proposal, chainId: "0x1a2b4" }]), "second proposal");
    check("21g a second proposal from the same page while one waits is -32002", dup.error?.code === -32002, JSON.stringify(dup));
    await w.getByText(`The RPC answers chain ${CHAIN}`).waitFor({ timeout: 12_000 }).catch(() => {});
    const wText = (await visibleText(w)).replace(/\s+/g, " ");
    check("21h the proposal shows the chain id, name, currency, RPC host and full URL, explorer host, the untrusted note and the check",
      wText.includes(`${CHAIN} (0x1a2b3)`) && wText.includes("E2E Net") && wText.includes("EEC") && wText.includes("api.goldsky.com")
        && wText.includes(RPC) && wText.includes("explorer.e2e-test.org") && /untrusted/i.test(wText) && wText.includes(`The RPC answers chain ${CHAIN}`),
      wText.slice(0, 500));
    check("21i nothing is saved before Approve", JSON.stringify(await readSettings()) === settingsBefore && !settingsBefore.includes(RPC), "");
    const armedNet = await waitArmed(w).catch(() => null);
    check("21j Approve arms once the wallet's own eth_chainId probe matched", !!armedNet && probes > 0, `probes=${probes}`);
    await approveBtn(w).click();
    const addR = await within(15_000, addP, "add approve");
    await sleep(800);
    const after = JSON.stringify(await readSettings());
    const chain = await rq("eth_chainId");
    const ev = await dappEvents();
    check("21k Approve saves the network, answers null and switches nothing",
      addR.result === null && after.includes(RPC) && after.includes("E2E Net") && chain.result === "0x1159" && !ev.some(([n]) => n === "chainChanged"),
      `answer=${JSON.stringify(addR)} chainId=${chain.result} events=${JSON.stringify(ev)}`);
    await waitClosed(w);
    // A proposal for a saved chain, or for LiteForge itself, changes nothing.
    for (const [label, p] of [
      ["the chain just saved, with another RPC", { ...proposal, chainName: "Renamed", rpcUrls: ["https://rpc.e2e-other.org"] }],
      ["LiteForge 4441", { chainId: "0x1159", chainName: "Other", rpcUrls: ["https://rpc.e2e-other.org"], nativeCurrency: { name: "Coin", symbol: "CN", decimals: 18 } }],
    ]) {
      const before = JSON.stringify(await readSettings());
      const r = await within(10_000, rq("wallet_addEthereumChain", [p]), label);
      await sleep(300);
      check(`21l a proposal for ${label} answers null, opens no window and changes no setting`,
        r.result === null && openApprovals().length === 0 && JSON.stringify(await readSettings()) === before, JSON.stringify(r));
    }
    // The dapp may then ask to switch: that is the normal switch approval (rejected here).
    const swP = rq("wallet_switchEthereumChain", [{ chainId: proposal.chainId }]);
    const sw2 = await approvalPage();
    await sleep(800);
    check("21m switching to the added network goes through the switch approval", /Switch|network/i.test(await visibleText(sw2)), "");
    await rejectBtn(sw2).click();
    const swR = await within(10_000, swP, "switch reject");
    check("21n rejecting that switch answers 4001 and the chain stays 4441", swR.error?.code === 4001 && (await rq("eth_chainId")).result === "0x1159", JSON.stringify(swR));
    await waitClosed(sw2);
  } finally {
    await context.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
  }
});

// ---------- 22. a request waiting when the worker died (X2) ----------
await step("22 worker died while waiting", async () => {
  for (const p of openApprovals()) await rejectAll(p);
  const pending = rq("personal_sign", ["waiting while the worker dies", account]);
  const ap = await approvalPage();
  await sleep(300);
  await stopWorker();
  const r = await within(15_000, pending, "X2").catch((e) => ({ timeout: e.message }));
  check("22a the page gets 4900 with the wallet's own message, not Chrome's text",
    r.error?.code === 4900 && r.error?.message === "The wallet stopped before it answered. Try the request again." && !/listener|message channel|Receiving end/i.test(JSON.stringify(r)),
    JSON.stringify(r));
  if (!ap.isClosed()) await ap.close().catch(() => {});
  await within(10_000, rq("eth_chainId"), "wake").catch(() => {});
});

// ---------- 23. official-site mark and look-alike warning (F17) ----------
await step("23 official and look-alike hosts", async () => {
  // Both pages are answered by this harness (route), so no request leaves the machine.
  const hosts = { official: "https://www.0xnothing.network/", lookalike: "https://0xnothing-app.com/" };
  const serve = (route) => route.fulfill({ status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: DAPP_HTML });
  const match = (url) => url.href.startsWith(hosts.official) || url.href.startsWith(hosts.lookalike);
  await context.route(match, serve);
  try {
    for (const [kind, url] of Object.entries(hosts)) {
      const p = await context.newPage();
      watch(p, "dapp");
      await p.goto(url);
      await sleep(500);
      const pending = p.evaluate(() => window.rq("eth_requestAccounts"));
      const ap = await approvalPage();
      await rejectBtn(ap).waitFor();
      const official = await ap.locator(".w-approve-official").count();
      const lookalike = await ap.locator("[data-lookalike]").count();
      const alert = (await ap.locator('[role="alert"]').allInnerTexts()).join(" ");
      if (kind === "official") {
        check("23a the exact official host www.0xnothing.network gets the official mark and no warning", official === 1 && lookalike === 0 && !/looks like an official/.test(alert), `official=${official} lookalike=${lookalike}`);
      } else {
        const armed = await waitArmed(ap).catch(() => null);
        check("23b a look-alike host (0xnothing-app.com) gets the red warning, no official mark, and Approve still arms",
          official === 0 && lookalike === 1 && /looks like an official 0xNothing site/.test(alert) && !!armed, `official=${official} lookalike=${lookalike} alert=${alert.slice(0, 120)}`);
      }
      await rejectBtn(ap).click(); // never connect these
      const r = await within(10_000, pending, `${kind} reject`).catch((e) => ({ timeout: e.message }));
      check(`23${kind === "official" ? "c" : "d"} rejecting the ${kind} connect answers 4001`, r.error?.code === 4001, JSON.stringify(r));
      await waitClosed(ap);
      await p.close();
    }
  } finally {
    await context.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
  }
});

// ---------- 24. token approvals panel (F19) ----------
await step("24 token approvals", async () => {
  const KEY = "wallet.approvals.v1";
  const setBook = (book) => popup.evaluate(async ([k, v]) => { if (v === null) await chrome.storage.local.remove(k); else await chrome.storage.local.set({ [k]: v }); }, [KEY, book]);
  const panelText = async () => (await popup.locator("#token-approvals").innerText().catch(() => "")).replace(/\s+/g, " ");
  // The panel reads once per open (Refresh shows only beside rows): reopen it after a write.
  const reopenPanel = async () => {
    await popup.evaluate(() => { location.hash = "#/home"; });
    await sleep(300);
    await popup.evaluate(() => { location.hash = "#/settings?panel=approvals"; });
    await popup.locator("#token-approvals").waitFor({ timeout: 8000 });
  };
  await setBook(null);
  await popup.evaluate(() => { location.hash = "#/dapps"; });
  const link = popup.getByRole("button", { name: "Token approvals" });
  await link.waitFor({ timeout: 8000 });
  const order = await popup.locator(".w-dapps > *").first().getAttribute("class");
  await link.click();
  await popup.locator("#token-approvals").waitFor({ timeout: 8000 });
  await until(async () => /No token approvals recorded/.test(await panelText()), 8000);
  check("24a the Dapp screen's Token approvals link opens the panel, empty on a fresh wallet",
    /#\/settings/.test(popup.url()) && /No token approvals recorded/.test(await panelText()), `${popup.url().replace(/^.*#/, "#")} first=${order}`);
  // A record as the wallet writes it after signing approve(spender, amount): NUSD, spender = this account.
  const acct = account.toLowerCase();
  const hash = "0x" + crypto.randomBytes(32).toString("hex");
  await setBook({ [acct]: { 4441: [{ token: NUSD_TOKEN.toLowerCase(), spender: acct, hash, at: Date.now() }] } });
  // The live allowance of this fresh account is 0, which offers no Revoke; the popup's
  // allowance read is answered as 5 NUSD so the Revoke review can be opened (never confirmed).
  let faked = 0, blocked = 0;
  const FIVE = encodeAbiParameters([{ type: "uint256" }], [5n * 10n ** 18n]);
  const handler = async (route) => {
    let body = null;
    try { body = route.request().method() === "POST" ? route.request().postDataJSON() : null; } catch {}
    if (!body) return route.continue();
    const calls = Array.isArray(body) ? body : [body];
    if (calls.some((c) => /^eth_send(Raw)?Transaction$/.test(c?.method ?? ""))) { blocked++; return route.abort(); }
    if (!calls.some((c) => c?.method === "eth_call")) return route.continue();
    const resp = await route.fetch();
    let json;
    try { json = await resp.json(); } catch { return route.fulfill({ response: resp }); }
    const list = Array.isArray(json) ? json : [json];
    for (const res of list) {
      const call = calls.find((c) => c?.id === res?.id);
      const data = call?.method === "eth_call" ? call.params?.[0]?.data : null;
      if (typeof data !== "string" || typeof res.result !== "string") continue;
      if (data.startsWith(ALLOWANCE)) { res.result = FIVE; faked++; continue; }
      try {
        const { functionName, args } = decodeFunctionData({ abi: multicall3Abi, data });
        if (functionName !== "aggregate3") continue;
        const hits = args[0].map((c, i) => (c.callData.startsWith(ALLOWANCE) ? i : -1)).filter((i) => i >= 0);
        if (!hits.length) continue;
        const out = [...decodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", data: res.result })];
        for (const i of hits) out[i] = { success: true, returnData: FIVE };
        res.result = encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: out });
        faked += hits.length;
      } catch {}
    }
    return route.fulfill({ response: resp, json: Array.isArray(json) ? list : list[0] });
  };
  const matcher = (url) => url.hostname === new URL(LITEFORGE_RPC).hostname;
  await popup.route(matcher, handler);
  try {
    await reopenPanel();
    await until(async () => /NUSD/.test(await panelText()) && /Allowance: (?!…)/.test(await panelText()), 10_000);
    const text = await panelText();
    const compact = text.replace(/\s+/g, "").toLowerCase();
    check("24b a recorded approval shows the token, the full spender and the allowance read through the RPC (answered 5 NUSD by the harness)",
      text.includes("NUSD") && compact.includes(acct.slice(2)) && /Allowance: 5 NUSD/.test(text) && faked > 0, `${text.slice(0, 300)} faked=${faked}`);
    const revoke = popup.locator("#token-approvals").getByRole("button", { name: /^Revoke$/ });
    await revoke.first().click();
    const review = popup.locator(".w-swap-review");
    await review.waitFor({ timeout: 8000 });
    const rText = (await review.innerText()).replace(/\s+/g, " ");
    check("24c Revoke opens the normal review: approve to zero (After 0 NUSD), spender in full",
      /After\s*0 NUSD/.test(rText) && rText.replace(/\s+/g, "").toLowerCase().includes(acct.slice(2)), rText.slice(0, 300));
    await review.locator(".w-btn-row button").nth(0).click(); // Cancel, never Confirm
    await review.waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
    note("24d RPC answers faked / broadcasts blocked", `${faked} / ${blocked}`);
  } finally {
    await popup.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
  }
  // A damaged record never breaks the panel.
  const before = logs.popup.length;
  await setBook({ [acct]: { 4441: [{ token: "not an address", spender: 7 }, "x"], abc: 5 }, __proto__x: 1, junk: [1, 2] });
  await reopenPanel();
  await until(async () => /No token approvals recorded/.test(await panelText()), 8000);
  check("24e a damaged approvals record still renders the panel (empty, no error)", /No token approvals recorded/.test(await panelText()) && logs.popup.length === before, logs.popup.slice(before).join(" | "));
  await setBook(null);
});

// ---------- comfort helpers (steps 25-31) ----------
const VERSION = JSON.parse(fs.readFileSync(path.join(DIST, "manifest.json"), "utf8")).version;
const activeAddress = () => popup.evaluate(async () => (await chrome.storage.local.get("wallet.accounts.v1"))["wallet.accounts.v1"]?.active ?? null);
const writeLocal = (key, value) => popup.evaluate(async ([k, v]) => { if (v === null) await chrome.storage.local.remove(k); else await chrome.storage.local.set({ [k]: v }); }, [key, value]);
const readRaw = (key) => popup.evaluate(async (k) => (await chrome.storage.local.get(k))[k] ?? null, key);
async function reopenPopup(hash = "#/home") {
  await popup.reload();
  await popup.waitForLoadState("domcontentloaded");
  await unlockIfNeeded(popup);
  await popup.evaluate((h) => { location.hash = h; }, hash);
  await sleep(800);
}
const randomAddress = () => getAddress("0x" + crypto.randomBytes(20).toString("hex"));
const randomHash = () => "0x" + crypto.randomBytes(32).toString("hex");
// What the page showed first, recorded from the document's start (extension pages only):
// every value <html data-theme> took and the first text #root held.
await context.addInitScript(() => {
  if (location.protocol !== "chrome-extension:") return;
  const seen = { themes: [], firstText: null };
  window.__firstPaint = seen;
  // <html> may not exist yet at this point: one observer on the document sees it arrive.
  const look = () => {
    const v = document.documentElement?.getAttribute("data-theme");
    if (v && seen.themes[seen.themes.length - 1] !== v) seen.themes.push(v);
    if (seen.firstText === null) {
      const text = document.getElementById("root")?.textContent?.trim();
      if (text) seen.firstText = text.slice(0, 80);
    }
  };
  look();
  new MutationObserver(look).observe(document, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["data-theme"] });
});
// A JSON-RPC answer for the popup's own RPC host: `answer(call)` returns a result to fake
// it, or undefined to pass the call on. Broadcasts are always aborted.
function rpcAnswerer(answer, counts = { blocked: 0 }) {
  return async (route) => {
    let body = null;
    try { body = route.request().method() === "POST" ? route.request().postDataJSON() : null; } catch {}
    if (!body) return route.continue();
    const calls = Array.isArray(body) ? body : [body];
    if (calls.some((c) => /^eth_send(Raw)?Transaction$/.test(c?.method ?? ""))) { counts.blocked++; return route.abort(); }
    const faked = calls.map((c) => answer(c));
    if (faked.every((f) => f === undefined)) return route.continue();
    let real = [];
    if (faked.some((f) => f === undefined)) {
      const resp = await route.fetch();
      try { real = [].concat(await resp.json()); } catch { real = []; }
    }
    const out = calls.map((c, i) => (faked[i] !== undefined
      ? { jsonrpc: "2.0", id: c.id, result: faked[i] === null ? null : faked[i] }
      : real.find((r) => r?.id === c.id) ?? { jsonrpc: "2.0", id: c.id, error: { code: -32603, message: "no answer" } }));
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(Array.isArray(body) ? out : out[0]) });
  };
}

// ---------- 25. Home: first-run card, What is new, identicons, focus, pending rows (F8, F16, F15, O5, F6) ----------
await step("25 home comfort", async () => {
  await reopenPopup("#/home");
  const me = await activeAddress();
  const first = popup.locator("#home-first-title");
  const news = popup.locator("#home-news-title");
  await until(async () => (await first.count()) > 0, 15_000);
  check("25a the first-run card shows for the empty throwaway wallet, with Receive and Get NUSD",
    await first.count() === 1 && /Receive/.test(await popup.locator(".w-home-card").innerText()) && /NUSD/.test(await popup.locator(".w-home-card").innerText()),
    (await popup.locator(".w-home-card").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 200));
  check("25b What is new does not show on a fresh install (the version is marked seen at onboarding)",
    await news.count() === 0 && await readRaw("wallet.seenVersion.v1") === VERSION, `seen=${JSON.stringify(await readRaw("wallet.seenVersion.v1"))}`);
  check("25c no faucet link on the first-run card (the repository names none)",
    !/faucet/i.test(await popup.locator(".w-home-card").innerText().catch(() => "")), "");
  // A vault from an older version has no seen mark: the card shows once, alone in the slot.
  await writeLocal("wallet.seenVersion.v1", null);
  await reopenPopup("#/home");
  await until(async () => (await news.count()) > 0, 10_000);
  const lines = await popup.locator(".w-home-card-list li").count();
  check("25d after an update What is new shows once (five lines at most) and the first-run card does not show with it",
    await news.count() === 1 && await first.count() === 0 && lines > 0 && lines <= 5, `lines=${lines} title=${await news.innerText().catch(() => "")}`);
  await popup.locator(".w-home-card").getByRole("button", { name: "Done" }).click();
  await until(async () => (await news.count()) === 0, 5000);
  await reopenPopup("#/home");
  await until(async () => (await first.count()) > 0, 10_000);
  check("25e Done remembers the version: after reopening only the first-run card shows",
    await news.count() === 0 && await first.count() === 1 && await readRaw("wallet.seenVersion.v1") === VERSION, "");

  // F15 identicons: the Home header, every account row, different per address.
  const headSrc = await popup.locator(".w-head .w-avatar img.w-identicon").getAttribute("src").catch(() => null);
  check("25f the Home header draws an identicon (local SVG data URL) instead of a letter", /^data:image\/svg\+xml/.test(headSrc ?? ""), (headSrc ?? "").slice(0, 40));
  // O5: open the sheet from the keyboard; focus goes in, and back to the opener on close.
  const opener = popup.locator("button.w-head-title");
  await opener.focus();
  await popup.keyboard.press("Enter");
  const sheet = popup.locator(".w-account-sheet");
  await sheet.waitFor({ timeout: 5000 });
  await sleep(300);
  const inside = await popup.evaluate(() => !!document.querySelector(".w-account-sheet")?.contains(document.activeElement));
  if (await sheet.locator(".w-account").count() < 2) {
    await sheet.getByRole("button", { name: /Add account/ }).click();
    await until(async () => (await popup.locator(".w-account-sheet .w-account").count()) >= 2 || (await popup.locator(".w-account-sheet").count()) === 0, 15_000);
    if (!(await sheet.count())) { await opener.focus(); await popup.keyboard.press("Enter"); await sheet.waitFor({ timeout: 5000 }); }
  }
  const srcs = await sheet.locator(".w-account img.w-identicon").evaluateAll((els) => els.map((e) => e.getAttribute("src")));
  check("25g every account row draws an identicon and two accounts look different",
    srcs.length >= 2 && srcs.every((s) => /^data:image\/svg\+xml/.test(s ?? "")) && new Set(srcs).size === srcs.length, `rows=${srcs.length} distinct=${new Set(srcs).size}`);
  const rowsText = (await sheet.innerText()).replace(/\s+/g, " ");
  check("25h the account sheet's foot row offers Lock now (and Side panel / Open in tab on the extension)",
    (await actionNames(popup)).some((n) => /Lock now/.test(n)), (await actionNames(popup)).join(" | "));
  await popup.keyboard.press("Escape");
  await sheet.waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
  await sleep(300);
  const back = await popup.evaluate(() => document.activeElement?.classList.contains("w-head-title") ?? false);
  check("25i a sheet takes keyboard focus when it opens and gives it back to its opener when it closes", inside && back, `inside=${inside} back=${back} ${rowsText.slice(0, 0)}`);
  // The active account may have changed above (Add account): make sure it is the first one again.
  if ((await activeAddress())?.toLowerCase() !== me?.toLowerCase()) {
    await opener.click();
    await sheet.waitFor({ timeout: 5000 });
    await sheet.locator('.w-account[aria-current="false"] .w-account-main').first().click();
    await sleep(1500);
    if (await sheet.count()) await popup.keyboard.press("Escape");
  }

  // F6: no receipt traffic while nothing is pending; four pending rows show as three, then settle in place.
  const receipts = [];
  const onReq = (r) => { try { const b = r.postData() ?? ""; if (b.includes("eth_getTransactionReceipt")) receipts.push(Date.now()); } catch {} };
  popup.on("request", onReq);
  await sleep(8000);
  const idle = receipts.length;
  const KEY = "wallet.history.v1";
  const historyBefore = await readRaw(KEY);
  const owner = (await activeAddress()).toLowerCase();
  const hashes = [randomHash(), randomHash(), randomHash(), randomHash()];
  const now = Date.now();
  const rows = hashes.map((hash, i) => ({ hash, account: getAddress(owner), networkId: "litvm-4441", kind: "send", status: "pending", at: now - i * 1000, summary: `E2E pending ${i + 1}` }));
  let settle = false;
  const RECEIPT = (hash) => ({
    transactionHash: hash, transactionIndex: "0x0", blockHash: randomHash(), blockNumber: "0x1", from: owner, to: owner,
    cumulativeGasUsed: "0x5208", gasUsed: "0x5208", effectiveGasPrice: "0x1", contractAddress: null, logs: [],
    logsBloom: "0x" + "0".repeat(512), status: "0x1", type: "0x2",
  });
  const counts = { blocked: 0 };
  await popup.route((url) => url.hostname === RPC_HOST, rpcAnswerer((c) => {
    if (c?.method !== "eth_getTransactionReceipt") return undefined;
    const hash = String(c.params?.[0] ?? "").toLowerCase();
    if (!hashes.includes(hash)) return undefined;
    return settle ? RECEIPT(hash) : null;
  }, counts));
  try {
    await writeLocal(KEY, { ...(historyBefore ?? {}), [owner]: [...rows, ...((historyBefore ?? {})[owner] ?? [])] });
    await reopenPopup("#/home");
    const pend = popup.locator(".w-home-pending .w-tx");
    await until(async () => (await pend.count()) > 0, 15_000);
    const shown = await pend.count();
    const statuses = await pend.evaluateAll((els) => els.map((e) => e.getAttribute("data-status")));
    const tabsAfter = await popup.evaluate(() => {
      const p = document.querySelector(".w-home-pending"); const tabs = document.querySelector(".w-tabs");
      return !!(p && tabs && (p.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING));
    });
    check("25j no receipt is asked while nothing is pending; four pending rows show as three, above the token tabs",
      idle === 0 && shown === 3 && statuses.every((s) => s === "pending") && tabsAfter, `receipts while idle=${idle} shown=${shown} statuses=${statuses} aboveTabs=${tabsAfter}`);
    const firstCardGone = await first.count() === 0;
    settle = true;
    await until(async () => (await pend.evaluateAll((els) => els.map((e) => e.getAttribute("data-status")))).every((s) => s === "success"), 20_000, 300);
    const after = await pend.evaluateAll((els) => els.map((e) => e.getAttribute("data-status")));
    const stored = ((await readRaw(KEY)) ?? {})[owner] ?? [];
    check("25k the rows settle in place when their receipts arrive (and history storage follows)",
      after.length > 0 && after.every((s) => s === "success") && hashes.every((h) => stored.find((r) => r.hash === h)?.status === "success"),
      `statuses=${after} stored=${hashes.map((h) => stored.find((r) => r.hash === h)?.status)}`);
    check("25l with a history row the first-run card no longer shows", firstCardGone, "");
    note("25m receipt requests while rows were pending / broadcasts blocked", `${receipts.length - idle} / ${counts.blocked}`);
  } finally {
    popup.off("request", onReq);
    await popup.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
    await writeLocal(KEY, historyBefore);
  }

  // F15 in the approval window: a connect from a never-connected origin shows the signer's identicon (rejected).
  const stranger = await context.newPage();
  watch(stranger, "dapp");
  await stranger.goto(STRANGER);
  await sleep(500);
  const conn = stranger.evaluate(() => window.rq("eth_requestAccounts", []));
  const ap = await approvalPage();
  await sleep(800);
  const signerSrc = await ap.locator(".w-signer img.w-identicon").first().getAttribute("src").catch(() => null);
  check("25n the approval window's signer shows an identicon", /^data:image\/svg\+xml/.test(signerSrc ?? ""), (signerSrc ?? "none").slice(0, 40));
  await rejectAll(ap);
  const cr = await within(15_000, conn, "stranger connect");
  check("25o that connect was rejected (4001)", cr.error?.code === 4001, JSON.stringify(cr));
  await stranger.close();
});

// ---------- 26. saved recipient names, History CSV, toast close (F10, F13, O5) ----------
await step("26 recipient names and CSV", async () => {
  await reopenPopup("#/home");
  const owner = (await activeAddress()).toLowerCase();
  const R1 = randomAddress();
  const lower = R1.toLowerCase();
  const BOOK = "wallet.recipients.v1";
  const HIST = "wallet.history.v1";
  const bookBefore = await readRaw(BOOK);
  const historyBefore = await readRaw(HIST);
  await writeLocal(BOOK, { [owner]: { 4441: [{ address: lower, at: Date.now() }] } });
  const input = popup.locator(`#rcp-name-${lower}`);
  const rowOf = () => popup.locator(".w-set-form", { has: input });
  try {
    await reopenPopup("#/settings");
    await input.waitFor({ timeout: 10_000 });
    await input.scrollIntoViewIfNeeded();
    await input.fill("Alice e2e");
    await rowOf().getByRole("button", { name: "Save" }).click();
    await until(async () => (await readRaw(BOOK))?.[owner]?.["4441"]?.[0]?.name === "Alice e2e", 5000);
    check("26a a saved recipient can be named in Settings > Saved recipients", (await readRaw(BOOK))?.[owner]?.["4441"]?.[0]?.name === "Alice e2e", JSON.stringify((await readRaw(BOOK))?.[owner]?.["4441"]?.[0]?.name));
    // O5: the "Name saved" toast stays while hovered, and closes from its own button.
    const toast = popup.locator(".w-toast");
    await toast.waitFor({ timeout: 5000 });
    await toast.hover();
    await sleep(6000);
    const held = await toast.count() === 1;
    await popup.locator(".w-toast-close").click();
    await sleep(300);
    check("26b a toast stays while hovered (past its 5 s) and closes from its close control", held && await toast.count() === 0, `held=${held}`);
    const tooLong = "x".repeat(25);
    await input.fill(tooLong);
    const refused = await rowOf().getByRole("button", { name: "Save" }).isDisabled() && /24 characters/.test(await rowOf().innerText());
    check("26c a name over 24 characters is refused before saving", refused, "");
    await input.fill("Alice e2e");

    // Recents list and the Send review (balance and gas faked for the popup only; never confirmed).
    const counts = { seen: 0, faked: 0, blocked: 0 };
    await popup.route((url) => url.hostname === RPC_HOST, fakeOneZkltc(counts));
    try {
      await reopenPopup("#/send");
      const chip = popup.locator(".w-recent", { hasText: "Alice e2e" });
      await chip.first().waitFor({ timeout: 10_000 });
      const chipTitle = await chip.first().getAttribute("title");
      const chipIcon = await chip.first().locator("img.w-identicon").count();
      check("26d the recents list shows the name (full address in its title) with the recipient's identicon",
        chipTitle?.toLowerCase().includes(lower) && chipIcon === 1, `title=${chipTitle} icon=${chipIcon}`);
      await chip.first().click();
      const recipient = popup.locator('form.w-send-flow input[placeholder="0x…"]');
      await until(async () => (await recipient.inputValue()).toLowerCase() === lower, 5000);
      await popup.locator('form.w-send-flow input[inputmode="decimal"]').fill("0.001");
      const submit = popup.locator('form.w-send-flow button[type="submit"]');
      await until(async () => !(await submit.isDisabled()), 20_000, 200);
      await submit.click();
      const review = popup.locator(".w-swap-review");
      await review.waitFor({ timeout: 8000 });
      const rText = (await review.innerText()).replace(/\s+/g, " ");
      check("26e the Send review shows Saved as with the name", /Saved as\s*Alice e2e/.test(rText), rText.slice(0, 240));
      await review.locator(".w-btn-row button").nth(0).click(); // Cancel, never Confirm
      await review.waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
      const clear = popup.locator(".w-draft button");
      if (await clear.count()) await clear.click();
      note("26f RPC requests seen / faked / blocked broadcasts", `${counts.seen} / ${counts.faked} / ${counts.blocked}`);
    } finally {
      await popup.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
    }

    // History: the name on a row, then the CSV export (a summary starting with = must not run as a formula).
    const h1 = randomHash(), h2 = randomHash();
    const rows = [
      { hash: h1, account: getAddress(owner), networkId: "litvm-4441", kind: "send", status: "success", at: Date.now() - 5000, summary: "=1+2", detail: R1 },
      { hash: h2, account: getAddress(owner), networkId: "litvm-4441", kind: "send", status: "failed", at: Date.now() - 9000, summary: 'Sent "quoted", fine' },
    ];
    await writeLocal(HIST, { ...(historyBefore ?? {}), [owner]: [...rows, ...((historyBefore ?? {})[owner] ?? [])] });
    await reopenPopup("#/history");
    await until(async () => (await visibleText(popup)).includes("=1+2"), 10_000);
    const hText = (await visibleText(popup)).replace(/\s+/g, " ");
    check("26g a History row whose recipient is named shows the name and the short address", /Alice e2e · 0x[0-9a-fA-F]{2,}…/.test(hText), hText.slice(0, 240));
    const exportBtn = popup.locator(".w-hist-actions button", { hasText: "Export" });
    const [download] = await Promise.all([popup.waitForEvent("download", { timeout: 10_000 }), exportBtn.click()]);
    const file = path.join(OUT, "history-e2e.csv");
    await download.saveAs(file);
    const csv = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
    const lines = csv.split("\r\n").filter(Boolean);
    const cells = (line) => line.split(/,(?=")/);
    check("26h the CSV export produces a file with the header row (Date, Kind, Summary, Status, Hash, Network)",
      /^"?Date"?,"?Kind"?,"?Summary"?,"?Status"?,"?Hash"?,"?Network"?$/.test(lines[0] ?? "") && lines.length >= 3 && /\.csv$/.test(download.suggestedFilename()),
      `${download.suggestedFilename()} head=${lines[0]} rows=${lines.length - 1}`);
    const row1 = lines.find((l) => l.includes(h1)) ?? "";
    const row2 = lines.find((l) => l.includes(h2)) ?? "";
    check("26i a cell starting with = is escaped (leading ') and quotes are doubled, so a spreadsheet never runs it",
      cells(row1).some((c) => c.startsWith("\"'=1+2")) && !lines.some((l) => cells(l).some((c) => /^"?[=+\-@]/.test(c))) && row2.includes('""quoted""'),
      `row1=${row1.slice(0, 160)} row2=${row2.slice(0, 120)}`);

    // Rename and remove in Settings.
    await reopenPopup("#/settings");
    await input.waitFor({ timeout: 10_000 });
    await input.fill("Bob e2e");
    await rowOf().getByRole("button", { name: "Save" }).click();
    await until(async () => (await readRaw(BOOK))?.[owner]?.["4441"]?.[0]?.name === "Bob e2e", 5000);
    const renamed = (await readRaw(BOOK))?.[owner]?.["4441"]?.[0]?.name === "Bob e2e";
    await rowOf().getByRole("button", { name: "Remove" }).click();
    await until(async () => ((await readRaw(BOOK))?.[owner]?.["4441"] ?? []).length === 0, 5000);
    await sleep(300);
    check("26j the name can be renamed and the saved address removed in Settings",
      renamed && ((await readRaw(BOOK))?.[owner]?.["4441"] ?? []).length === 0 && await input.count() === 0, `renamed=${renamed}`);
    if (await popup.locator(".w-toast-close").count()) await popup.locator(".w-toast-close").click().catch(() => {});
  } finally {
    await writeLocal(BOOK, bookBefore);
    await writeLocal(HIST, historyBefore);
  }
});

// ---------- 27. notifications switch, System theme, Lock now, remembered tab and pair, "Copied" (F12, F20, F7) ----------
await step("27 preferences", async () => {
  const mf = JSON.parse(fs.readFileSync(path.join(DIST, "manifest.json"), "utf8"));
  check("27a notifications is declared only under optional_permissions",
    JSON.stringify(mf.optional_permissions) === '["notifications"]' && !mf.permissions.includes("notifications"), `permissions=${mf.permissions} optional=${mf.optional_permissions}`);
  const heldAtStart = await sw.evaluate(() => chrome.permissions.contains({ permissions: ["notifications"] })).catch((e) => `error ${e.message}`);
  await reopenPopup("#/settings");
  await popup.evaluate(() => {
    window.__permAsks = [];
    const original = chrome.permissions.request.bind(chrome.permissions);
    chrome.permissions.request = (req, ...rest) => {
      window.__permAsks.push({ req: JSON.parse(JSON.stringify(req)), at: Date.now() });
      const p = original(req, ...rest);
      p.then((v) => window.__permAsks.push({ answer: v }), (e) => window.__permAsks.push({ answer: `error ${e?.message}` }));
      return p;
    };
  });
  const seg = popup.locator('.w-seg[aria-labelledby="set-notifications"] button');
  await seg.first().waitFor({ timeout: 8000 });
  await until(async () => !(await seg.nth(1).isDisabled()), 5000);
  const offAtStart = await seg.nth(0).getAttribute("aria-pressed") === "true";
  const asksBefore = await popup.evaluate(() => window.__permAsks.length);
  await seg.nth(1).click();
  await sleep(300);
  const asks = await popup.evaluate(() => window.__permAsks);
  check("27b the switch is Off at first, nothing is held or asked before the click, and the click asks for notifications",
    heldAtStart === false && offAtStart && asksBefore === 0 && JSON.stringify(asks[0]?.req) === '{"permissions":["notifications"]}',
    `held=${heldAtStart} off=${offAtStart} before=${asksBefore} asks=${JSON.stringify(asks)}`);
  await until(async () => (await popup.evaluate(() => window.__permAsks.length)) > 1, 8000);
  const answer = (await popup.evaluate(() => window.__permAsks)).find((a) => "answer" in a)?.answer;
  await sleep(800);
  const onPressed = await seg.nth(1).getAttribute("aria-pressed") === "true";
  const stored = (await readSettings())?.notifications === true;
  const denied = /did not allow/.test(await visibleText(popup));
  check("27c the switch follows Chrome's answer (On and saved only when granted; refused shows the error)",
    answer === true ? onPressed && stored : (!onPressed && !stored && (answer === false ? denied : true)),
    `answer=${answer} on=${onPressed} stored=${stored} deniedNote=${denied}`);
  if (answer === true) {
    await seg.nth(0).click();
    await until(async () => (await readSettings())?.notifications === false, 5000);
    const still = await sw.evaluate(() => chrome.permissions.contains({ permissions: ["notifications"] })).catch(() => "error");
    check("27d Off saves false and releases the permission", (await readSettings())?.notifications === false && still === false, `held=${still}`);
  } else {
    note("27d notifications permission not granted in this headless profile", `answer=${answer}: the worker's notifications were not exercised`);
  }

  // F20 System appearance, live and at the first paint.
  const themeSeg = popup.locator('.w-seg[aria-labelledby="set-background"] button');
  const themeNow = () => popup.evaluate(() => document.documentElement.dataset.theme);
  await popup.emulateMedia({ colorScheme: "light" });
  await themeSeg.nth(2).click();
  await until(async () => (await readSettings())?.theme === "system", 5000);
  await until(async () => (await themeNow()) === "light", 3000);
  const lightNow = await themeNow();
  await popup.emulateMedia({ colorScheme: "dark" });
  await until(async () => (await themeNow()) === "dark", 3000);
  const darkNow = await themeNow();
  check("27e Appearance has System; it follows the emulated colour scheme live",
    (await themeSeg.count()) === 3 && /System/.test(await themeSeg.nth(2).innerText()) && lightNow === "light" && darkNow === "dark", `light->${lightNow} dark->${darkNow}`);
  await popup.emulateMedia({ colorScheme: "light" });
  await reopenPopup("#/settings");
  const fp = await popup.evaluate(() => window.__firstPaint ?? null);
  check("27f the first paint follows it too (theme-boot.js resolves System before the app runs)",
    fp?.themes?.[0] === "light" && !fp.themes.includes("dark") && (await themeNow()) === "light", JSON.stringify(fp?.themes ?? "no record"));
  await themeSeg.nth(0).click();
  await until(async () => (await readSettings())?.theme === "dark", 5000);
  await popup.emulateMedia({ colorScheme: null });

  // F20 Lock now from the account sheet.
  const sheet = await openSheet(popup);
  await sheet.locator(".w-account-actions").getByRole("button", { name: "Lock now" }).click();
  const pw = popup.locator('input[type="password"]');
  await pw.waitFor({ timeout: 10_000 }).catch(() => {});
  check("27g Lock now in the account sheet locks the wallet (unlock screen)", await pw.count() === 1, "");
  await unlockIfNeeded(popup);

  // F7 the Home tab and the swap pair are remembered after the popup is reopened.
  await popup.evaluate(() => { location.hash = "#/home"; });
  await popup.locator("#home-tab-nft").click();
  await sleep(500);
  await reopenPopup("#/home");
  await until(async () => (await popup.locator("#home-tab-nft").getAttribute("aria-selected")) === "true", 5000);
  const nftKept = await popup.locator("#home-tab-nft").getAttribute("aria-selected") === "true";
  await popup.locator("#home-tab-token").click();
  check("27h the Home tab last picked is restored after the popup is reopened", nftKept, `stored=${JSON.stringify(await readRaw("wallet.homeTab.v1"))}`);
  const pairText = async () => {
    const t = await visibleText(popup);
    const a = t.indexOf("NUSD"), b = t.indexOf("zkLTC");
    return a < 0 || b < 0 ? "?" : a < b ? "NUSD>zkLTC" : "zkLTC>NUSD";
  };
  await popup.evaluate(() => { location.hash = "#/swap"; });
  const flip = popup.locator(".w-swap-flip button");
  await flip.waitFor({ timeout: 8000 });
  await sleep(800);
  const before = await pairText();
  await flip.click();
  await sleep(800);
  const flipped = await pairText();
  await reopenPopup("#/swap");
  await flip.waitFor({ timeout: 8000 });
  await sleep(1200);
  const restored = await pairText();
  check("27i the swap pair is restored after the popup is reopened",
    before !== "?" && flipped !== before && restored === flipped, `before=${before} flipped=${flipped} restored=${restored} stored=${JSON.stringify(await readRaw("wallet.swapPair.v1"))}`);
  await flip.click();
  await sleep(500);

  // F7 "Copied" is spoken through one polite live region.
  await popup.evaluate(() => { location.hash = "#/home"; });
  await popup.getByRole("button", { name: /copy/i }).first().click();
  await sleep(600);
  const live = await popup.evaluate(() => [...document.querySelectorAll('.w-sr-only[role="status"]')].map((e) => `${e.getAttribute("aria-live")}:${e.textContent}`));
  check("27j copying the address announces Copied through an aria-live region", live.some((s) => /^polite:Copied/.test(s)), JSON.stringify(live));
});

// ---------- 28. Earn pages back past the newest 50 positions (O3) ----------
await step("28 earn paging", async () => {
  const STAKING = "0x59589d9a5840D2CEF7A6e4A8cB55C258cc73E483".toLowerCase();
  const abi = parseAbi([
    "function positionIdsOf(address user) view returns (uint256[])",
    "function getPosition(uint256 positionId) view returns ((address account, uint64 unlockTime, uint32 lockDuration, bool withdrawn, uint256 amount, uint256 weight))",
  ]);
  const owner = await activeAddress();
  const TOTAL = 120n;
  const unlock = BigInt(Math.floor(Date.now() / 1000) + 10 * 86400);
  const fakeCall = (target, data) => {
    if (String(target).toLowerCase() !== STAKING) return null;
    try {
      const { functionName, args } = decodeFunctionData({ abi, data });
      if (functionName === "positionIdsOf") return encodeFunctionResult({ abi, functionName, result: Array.from({ length: Number(TOTAL) }, (_, i) => BigInt(i + 1)) });
      if (functionName === "getPosition") return encodeFunctionResult({ abi, functionName, result: { account: owner, unlockTime: unlock, lockDuration: 30 * 86400, withdrawn: false, amount: 10n ** 18n, weight: 10n ** 18n } });
    } catch {}
    return null;
  };
  let faked = 0;
  const counts = { blocked: 0 };
  // Multicall reads are answered from the real aggregate3 result with the staking calls replaced.
  const handler = async (route) => {
    let body = null;
    try { body = route.request().method() === "POST" ? route.request().postDataJSON() : null; } catch {}
    if (!body) return route.continue();
    const calls = Array.isArray(body) ? body : [body];
    if (calls.some((c) => /^eth_send(Raw)?Transaction$/.test(c?.method ?? ""))) { counts.blocked++; return route.abort(); }
    if (!calls.some((c) => c?.method === "eth_call")) return route.continue();
    const resp = await route.fetch();
    let json;
    try { json = await resp.json(); } catch { return route.fulfill({ response: resp }); }
    const list = Array.isArray(json) ? json : [json];
    for (const res of list) {
      const call = calls.find((c) => c?.id === res?.id);
      const data = call?.method === "eth_call" ? call.params?.[0]?.data : null;
      if (typeof data !== "string" || typeof res.result !== "string") continue;
      try {
        const { functionName, args } = decodeFunctionData({ abi: multicall3Abi, data });
        if (functionName !== "aggregate3") continue;
        const out = [...decodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", data: res.result })];
        let hit = false;
        args[0].forEach((c, i) => { const r = fakeCall(c.target, c.callData); if (r) { out[i] = { success: true, returnData: r }; hit = true; faked++; } });
        if (hit) res.result = encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: out });
      } catch {}
    }
    return route.fulfill({ response: resp, json: Array.isArray(json) ? list : list[0] });
  };
  await popup.route((url) => url.hostname === RPC_HOST, handler);
  try {
    await reopenPopup("#/earn");
    const bars = popup.locator(".w-earn-positions progress.w-earn-progress");
    const more = popup.locator(".w-earn-positions").getByRole("button", { name: "Load older positions" });
    await until(async () => (await bars.count()) > 0, 20_000, 300);
    const page1 = await bars.count();
    const hasMore1 = await more.count() === 1;
    await more.click();
    await until(async () => (await bars.count()) > page1, 20_000, 300);
    const page2 = await bars.count();
    await more.click().catch(() => {});
    await until(async () => (await bars.count()) > page2, 20_000, 300);
    const page3 = await bars.count();
    const oldest = (await visibleText(popup)).includes("#1\n") || /#1(\D|$)/.test((await visibleText(popup)).replace(/#1\d+/g, ""));
    check("28a Earn shows the newest 50 of 120 positions with Load older, then 100, then all 120 (oldest included) and no more button",
      page1 === 50 && hasMore1 && page2 === 100 && page3 === 120 && (await more.count()) === 0 && oldest, `pages=${page1}/${page2}/${page3} more=${hasMore1}->${await more.count()} oldest=${oldest} faked=${faked}`);
    note("28b staking reads faked / broadcasts blocked", `${faked} / ${counts.blocked}`);
  } finally {
    await popup.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
  }
});

// ---------- 29. LiteForge RPC field and a custom network's RPC changed in place (O4) ----------
await step("29 network rpc", async () => {
  // Every RPC below except the public one lives on api.goldsky.com (a manifest host) and is
  // answered by this harness, so no permission prompt and no request leaves the machine.
  const BASE = "https://api.goldsky.com/e2e-o4";
  const chainOf = { wrong: 1, a: 0x1a2c0, b: 0x1a2c0, c: 0x1a2c0 };
  const rpcRoute = async (route) => {
    const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "content-type": "application/json" };
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    const which = new URL(route.request().url()).pathname.split("-").pop();
    let body = null;
    try { body = route.request().postDataJSON(); } catch {}
    const answer = (c) => ({ jsonrpc: "2.0", id: c?.id ?? 1, ...(c?.method === "eth_chainId" && chainOf[which] ? { result: "0x" + chainOf[which].toString(16) } : { error: { code: -32601, message: "not here" } }) });
    return route.fulfill({ status: 200, headers, body: JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)) });
  };
  await context.route((url) => url.href.startsWith(BASE), rpcRoute);
  const settingsBefore = await readSettings();
  try {
    await reopenPopup("#/settings");
    const box = popup.locator("details.w-disclosure", { has: popup.locator("summary", { hasText: /^LiteForge RPC$/ }) });
    await box.locator("summary").click();
    const field = box.locator("input.w-input");
    const save = box.getByRole("button", { name: "Use this RPC" });
    const errText = async () => (await box.locator('[role="alert"]').innerText().catch(() => "")).trim();
    await field.fill("http://example.com");
    await save.click();
    await sleep(300);
    check("29a the LiteForge RPC field refuses a non-https URL", /HTTPS/.test(await errText()) && !(await readSettings())?.litvmRpcUrl, await errText());
    await field.fill(`${BASE}-wrong`);
    await save.click();
    await until(async () => /answers chain/.test(await errText()), 12_000);
    check("29b it refuses a URL whose chain id is not 4441, and saves nothing", /answers chain 1, not LiteForge \(4441\)/.test(await errText()) && !(await readSettings())?.litvmRpcUrl, await errText());
    await field.fill("https://rpc.testnet.liteforge.zeeve.net");
    await save.click();
    await sleep(500);
    check("29c the default URL typed in saves nothing", !(await readSettings())?.litvmRpcUrl, JSON.stringify((await readSettings())?.litvmRpcUrl ?? null));
    const OWN = "https://rpc.testnet.liteforge.zeeve.net/?e2e=1";
    await field.fill(OWN);
    await save.click();
    await until(async () => !!(await readSettings())?.litvmRpcUrl, 15_000);
    const saved = (await readSettings())?.litvmRpcUrl;
    const warn = /untrusted/i.test(await visibleText(popup));
    const resetBtn = box.getByRole("button", { name: "Use the default RPC" });
    check("29d an RPC answering 4441 is saved, the untrusted note shows and Reset is offered", typeof saved === "string" && saved.includes("e2e=1") && warn && await resetBtn.count() === 1, `saved=${saved} warn=${warn}`);
    const chain = await rq("eth_chainId");
    const block = await rq("eth_blockNumber");
    check("29e with the user RPC set the dapp still sees 0x1159 and reads answer through the worker",
      chain.result === "0x1159" && /^0x[0-9a-f]+$/.test(block.result ?? ""), `${JSON.stringify(chain)} ${JSON.stringify(block)}`);
    await resetBtn.click();
    await until(async () => !(await readSettings())?.litvmRpcUrl, 5000);
    check("29f Reset returns to the default (no override stored, no Reset control)", !(await readSettings())?.litvmRpcUrl && await resetBtn.count() === 0, JSON.stringify((await readSettings())?.litvmRpcUrl ?? null));

    // (b) A saved custom network's RPC changed in place.
    const net = { id: "x", name: "E2E O4 Net", chainId: chainOf.a, rpcUrl: `${BASE}-a`, explorerUrl: "", nativeCurrency: { name: "O4 Coin", symbol: "OFC", decimals: 18 }, builtin: false };
    const cur = await readSettings();
    await writeLocal("wallet.settings.v1", { ...cur, customNetworks: [...(cur.customNetworks ?? []), net] });
    await reopenPopup("#/settings");
    const row = popup.locator(".w-network-row", { hasText: "E2E O4 Net" });
    await row.waitFor({ timeout: 8000 });
    const indexBefore = ((await readSettings()).customNetworks ?? []).findIndex((n) => n.name === "E2E O4 Net");
    await row.getByRole("button", { name: "Change RPC" }).click();
    const form = popup.locator("form.w-set-form", { has: popup.locator(`input[placeholder^="${BASE}-a"]`) });
    await form.waitFor({ timeout: 5000 });
    await form.locator("input").fill(`${BASE}-wrong`);
    await form.getByRole("button", { name: "Change RPC" }).click();
    await until(async () => /answers chain/.test(await form.innerText()), 12_000);
    const refused = (await form.innerText()).replace(/\s+/g, " ");
    check("29g Change RPC refuses an RPC answering another chain id", new RegExp(`answers chain 1, not ${chainOf.a}`).test(refused)
      && (await readSettings()).customNetworks.some((n) => n.rpcUrl.startsWith(`${BASE}-a`)), refused.slice(0, 160));
    await form.locator("input").fill(`${BASE}-b`);
    await form.getByRole("button", { name: "Change RPC" }).click();
    await until(async () => (await readSettings()).customNetworks.some((n) => n.rpcUrl.startsWith(`${BASE}-b`)), 12_000);
    const list = (await readSettings()).customNetworks ?? [];
    const moved = list.findIndex((n) => n.rpcUrl.startsWith(`${BASE}-b`));
    check("29h Change RPC saves an RPC answering the same chain in place (same position, name and currency kept, old URL gone)",
      moved === indexBefore && list[moved]?.name === "E2E O4 Net" && list[moved]?.nativeCurrency?.symbol === "OFC" && !list.some((n) => n.rpcUrl.startsWith(`${BASE}-a`)),
      `index ${indexBefore}->${moved} ${JSON.stringify(list[moved] ?? null).slice(0, 160)}`);
  } finally {
    await context.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
    if (settingsBefore) {
      const now = await readSettings();
      await writeLocal("wallet.settings.v1", { ...now, litvmRpcUrl: undefined, customNetworks: settingsBefore.customNetworks ?? [], networkId: settingsBefore.networkId });
    }
  }
});

// ---------- 30. only the active locale loads, first paint in it (O1); link-preload warnings (O6) ----------
await step("30 locale chunk and preload", async () => {
  const LOCALE_CHUNK = /\/assets\/(de|es|fr|ja|ko|ru|vi|zh)-[\w-]+\.js(\?|$)/;
  await setPrefs("vi", "dark");
  const chunks = [];
  const onReq = (r) => { const m = LOCALE_CHUNK.exec(r.url()); if (m) chunks.push(m[1]); };
  popup.on("request", onReq);
  const preloadBefore = logs.preload.length;
  await popup.reload();
  await popup.waitForLoadState("load");
  await sleep(1500);
  popup.off("request", onReq);
  const fp = await popup.evaluate(() => window.__firstPaint ?? null);
  const lang = await popup.evaluate(() => document.documentElement.lang);
  check("30a after choosing Vietnamese and reloading, the first paint is Vietnamese and only the vi chunk was requested",
    typeof fp?.firstText === "string" && /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i.test(fp.firstText) && !/Opening wallet/.test(fp.firstText)
      && lang === "vi" && chunks.length >= 1 && chunks.every((c) => c === "vi"),
    `first="${fp?.firstText ?? "?"}" lang=${lang} chunks=${JSON.stringify(chunks)}`);
  await unlockIfNeeded(popup);
  await setPrefs("en", "dark");
  const chunksEn = [];
  const onReqEn = (r) => { const m = LOCALE_CHUNK.exec(r.url()); if (m) chunksEn.push(m[1]); };
  popup.on("request", onReqEn);
  await popup.reload();
  await popup.waitForLoadState("load");
  await sleep(1200);
  popup.off("request", onReqEn);
  check("30b back in English a reload requests no locale chunk", chunksEn.length === 0, JSON.stringify(chunksEn));
  await unlockIfNeeded(popup);
  check("30c no link-preload warning on this Chromium build for the reloads above or the whole run so far",
    logs.preload.length === 0 && logs.preload.length === preloadBefore, logs.preload.length ? `${logs.preload.length}, e.g. ${logs.preload[0]}` : "0");
});

// ---------- logs ----------
check("logs: no console error or unhandled rejection in wallet pages", logs.popup.length + logs.approval.length === 0,
  [...logs.popup.map((l) => "popup " + l), ...logs.approval.map((l) => "approval " + l)].slice(0, 8).join(" | "));
note("logs: worker", logs.worker.slice(0, 10).join(" | ") || "(none captured)");
note("logs: link-preload warnings (not counted)", logs.preload.length ? `${logs.preload.length}, e.g. ${logs.preload[0]}` : "(none)");
note("logs: network failures (not counted)", [...new Set(logs.network.map((l) => l.replace(/\?.*$/, "")))].slice(0, 10).join(" | ") || "(none)");

const RESULTS = path.join(OUT, "results.json");
fs.writeFileSync(RESULTS, JSON.stringify({ at: new Date().toISOString(), results, logs }, null, 2));
await context.close();
server.close();
if (!process.env.KEEP_PROFILE) fs.rmSync(profile, { recursive: true, force: true });
console.log(`\n${results.filter((r) => !r.note).length - failures} passed, ${failures} failed  (results: ${RESULTS})`);
process.exit(failures ? 1 : 0);
