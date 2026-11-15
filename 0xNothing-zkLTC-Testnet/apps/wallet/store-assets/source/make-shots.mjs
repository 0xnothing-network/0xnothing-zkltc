// 0xWallet store screenshots: captures of the REAL interface of the built extension.
//
// Not a mock-up: it drives the unpacked extension in dist/ with Playwright (as
// tests/e2e/extension.e2e.mjs does) and saves what the wallet itself draws.
// Run from apps/wallet, after a release build (npm run build), PowerShell one per line:
//   $env:PLAYWRIGHT_CORE = "<folder that contains node_modules/playwright-core>"
//   $env:CHROME = "<full path to a Chromium or Chrome for Testing chrome.exe>"
//   $env:SHOTS_OUT = "<folder for the raw captures>"
//   node store-assets/source/make-shots.mjs
// Optional: WALLET_DIR (default apps/wallet, two folders up), WALLET_DIST (default
// WALLET_DIR/dist), SHOTS_LOCALES (default "en,vi").
//
// Demo data only. A throwaway wallet is created with a random password that is never
// printed or stored (nor is its phrase); the browser profile is deleted at the end.
// Balances (12.5 zkLTC, 250 NUSD, 3.2 WzkLTC) and one NUSD allowance are answered to the
// wallet's own pages by the harness; every other read goes to the LiteForge testnet RPC.
// History rows, one named saved recipient and one approval record are seeded in the
// shapes the wallet validates. Broadcasts are aborted; the dapp's approve request is
// captured and then REJECTED, never approved.
//
// Output: SHOTS_OUT/<locale>/<nn>-<name>.png at 360x600, deviceScaleFactor 3 (1080x1800),
// dark theme; the side-panel scene is 1280x800 at the same scale (3840x2400).
//
// Compose step (no browser profile, no extension): lays those raw captures out with
// store-shots.html and writes the store images at their exact sizes.
//   $env:COMPOSE = "1"   (plus PLAYWRIGHT_CORE, CHROME, SHOTS_OUT as above)
//   node store-assets/source/make-shots.mjs
// Writes chrome-web-store-ready/{global-en,localized-vi}/0N-*.png (1280x800),
// chrome-web-store-ready/promo/{small-promo-440x280,marquee-1400x560}.png and the
// contact sheets in previews/, under COMPOSE_OUT (default: store-assets).
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
function die(message) {
  console.error(`make-shots: ${message}`);
  process.exit(2);
}

// ---------- environment (same handling as tests/e2e/extension.e2e.mjs) ----------
const PW_DIR = process.env.PLAYWRIGHT_CORE;
if (!PW_DIR) die("set PLAYWRIGHT_CORE to a folder that contains node_modules/playwright-core (installed outside the repository).");
let chromium;
try {
  const entry = createRequire(path.join(path.resolve(PW_DIR), "noop.js")).resolve("playwright-core");
  const mod = await import(pathToFileURL(entry).href);
  chromium = mod.chromium ?? mod.default?.chromium;
  if (!chromium) throw new Error("module has no chromium export");
} catch (e) {
  die(`playwright-core not found under PLAYWRIGHT_CORE=${PW_DIR} (${String(e?.message ?? e).split(/\r?\n/)[0]}).`);
}
// COMPOSE=1: no capture; lay the raw captures out as the store images (see compose()).
if (process.env.COMPOSE === "1") {
  await compose();
  process.exit(process.exitCode ?? 0);
}
const WALLET = path.resolve(process.env.WALLET_DIR ?? path.join(HERE, "..", ".."));
const DIST = path.resolve(process.env.WALLET_DIST ?? path.join(WALLET, "dist"));
if (!fs.existsSync(path.join(DIST, "manifest.json"))) die(`no built extension at ${DIST}: run npm run build first (or set WALLET_DIST).`);
let CHROME = process.env.CHROME;
if (!CHROME) { try { CHROME = chromium.executablePath(); } catch {} }
if (!CHROME || !fs.existsSync(CHROME)) die("set CHROME to a full Chromium executable (chrome.exe).");
const VIEM = process.env.VIEM ?? path.join(WALLET, "node_modules", "viem", "_esm", "index.js");
if (!fs.existsSync(VIEM)) die(`viem not found at ${VIEM}: run npm install in apps/wallet (or set VIEM).`);
const { getAddress, multicall3Abi, decodeFunctionData, decodeFunctionResult, encodeFunctionResult, encodeAbiParameters, parseUnits } = await import(pathToFileURL(VIEM).href);
const OUT = process.env.SHOTS_OUT;
if (!OUT) die("set SHOTS_OUT to the folder for the raw captures.");
const LOCALES = (process.env.SHOTS_LOCALES ?? "en,vi").split(",").map((s) => s.trim()).filter(Boolean);
const VERSION = JSON.parse(fs.readFileSync(path.join(DIST, "manifest.json"), "utf8")).version;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10_000, every = 150) {
  const start = Date.now();
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() - start > ms) return v;
    await sleep(every);
  }
}
async function within(ms, promise, label) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timeout ${ms}ms: ${label}`)), ms); });
  try { return await Promise.race([promise, timeout]); } finally { clearTimeout(t); }
}

// ---------- demo data ----------
const RPC_HOST = "rpc.testnet.liteforge.zeeve.net";
const TOKENS = {
  nusd: "0x69320A82ACCeC1b8A5EF59fd02b217e7ea4aEa19",
  wzkltc: "0xE93d4373CE1eDA3df6c3Ab7ed3ab07A07aA5939F",
};
const NATIVE_DEMO = parseUnits("12.5", 18);
const TOKEN_DEMO = new Map([
  [TOKENS.nusd.toLowerCase(), parseUnits("250", 18)],
  [TOKENS.wzkltc.toLowerCase(), parseUnits("3.2", 18)],
]);
const ALLOWANCE_DEMO = parseUnits("100", 18);
const BALANCE_OF = "0x70a08231";
const GET_ETH_BALANCE = "0x4d2301cc"; // Multicall3.getEthBalance
const ALLOWANCE = "0xdd62ed3e";
const word = (v) => encodeAbiParameters([{ type: "uint256" }], [v]);
const randomAddress = () => getAddress("0x" + crypto.randomBytes(20).toString("hex"));
const randomHash = () => "0x" + crypto.randomBytes(32).toString("hex");
// A made-up recipient and a made-up dapp spender: random addresses, nobody's wallet.
const ALICE = randomAddress();
const DAPP_SPENDER = randomAddress();
let ACCOUNT = null; // the throwaway wallet's first address, lowercase, once created

// The demo answer for one eth_call, or undefined to keep the node's answer.
function demoCall(to, data) {
  if (!ACCOUNT || typeof data !== "string") return undefined;
  const target = String(to ?? "").toLowerCase();
  const argOwner = data.length >= 74 ? "0x" + data.slice(34, 74).toLowerCase() : null;
  if (argOwner !== ACCOUNT) return undefined;
  if (data.startsWith(BALANCE_OF) && TOKEN_DEMO.has(target)) return word(TOKEN_DEMO.get(target));
  if (data.startsWith(GET_ETH_BALANCE)) return word(NATIVE_DEMO);
  if (data.startsWith(ALLOWANCE) && target === TOKENS.nusd.toLowerCase()) return word(ALLOWANCE_DEMO);
  return undefined;
}
// Answers the wallet pages' RPC reads with the demo balances; aborts any broadcast.
const counts = { faked: 0, blocked: 0 };
async function rpcRoute(route) {
  const req = route.request();
  let body = null;
  try { body = req.method() === "POST" ? req.postDataJSON() : null; } catch {}
  if (!body) return route.continue();
  const calls = Array.isArray(body) ? body : [body];
  if (calls.some((c) => /^eth_send(Raw)?Transaction$/.test(c?.method ?? ""))) { counts.blocked++; return route.abort(); }
  const touches = (c) => c?.method === "eth_getBalance" || c?.method === "eth_call" || c?.method === "eth_estimateGas";
  if (!ACCOUNT || !calls.some(touches)) return route.continue();
  let resp;
  try { resp = await route.fetch(); } catch { return route.abort().catch(() => {}); }
  let json;
  try { json = await resp.json(); } catch { return route.fulfill({ response: resp }); }
  const list = Array.isArray(json) ? json : [json];
  for (const res of list) {
    const call = calls.find((c) => c?.id === res?.id);
    if (!call) continue;
    if (call.method === "eth_getBalance" && String(call.params?.[0] ?? "").toLowerCase() === ACCOUNT) {
      delete res.error; res.result = "0x" + NATIVE_DEMO.toString(16); counts.faked++; continue;
    }
    if (call.method === "eth_estimateGas" && res.error) { delete res.error; res.result = "0xc350"; counts.faked++; continue; }
    if (call.method !== "eth_call" || typeof res.result !== "string") continue;
    const { to, data } = call.params?.[0] ?? {};
    const direct = demoCall(to, data);
    if (direct !== undefined) { res.result = direct; counts.faked++; continue; }
    try {
      const { functionName, args } = decodeFunctionData({ abi: multicall3Abi, data });
      if (functionName !== "aggregate3") continue;
      const out = [...decodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", data: res.result })];
      let hit = false;
      args[0].forEach((c, i) => {
        const v = demoCall(c.target, c.callData);
        if (v !== undefined) { out[i] = { success: true, returnData: v }; hit = true; counts.faked++; }
      });
      if (hit) res.result = encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: out });
    } catch {}
  }
  return route.fulfill({ response: resp, json: Array.isArray(json) ? list : list[0] });
}

// ---------- the local demo dapp page ----------
const DAPP_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Demo dapp</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; background: #111214; color: #e8e9eb; }
  header { display: flex; align-items: center; justify-content: space-between; padding: 18px 32px; border-bottom: 1px solid #24262a; }
  .brand { font-weight: 650; letter-spacing: .2px; }
  .pill { font-size: 13px; padding: 6px 12px; border: 1px solid #2e3136; border-radius: 999px; color: #b9bcc2; }
  main { max-width: 560px; margin: 72px auto; padding: 0 24px; }
  h1 { font-size: 30px; margin: 0 0 8px; }
  p { color: #9da1a8; margin: 0 0 28px; }
  .card { border: 1px solid #26292e; border-radius: 16px; padding: 22px; background: #16181b; }
  .row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #222428; }
  .row:last-child { border-bottom: 0; }
  .muted { color: #8b8f96; }
</style>
<script>
window.rq = (method, params) => window.ethereum.request({ method, params })
  .then((result) => ({ result }), (e) => ({ error: { code: e && e.code, message: e && e.message } }));
window.addEventListener("DOMContentLoaded", async () => {
  const set = (a) => { document.getElementById("acct").textContent = a && a[0] ? a[0].slice(0, 6) + "…" + a[0].slice(-4) : "Not connected"; };
  if (window.ethereum) {
    window.ethereum.on("accountsChanged", set);
    try { set(await window.ethereum.request({ method: "eth_accounts" })); } catch {}
  }
});
</script></head><body>
<header><span class="brand">Demo dapp</span><span class="pill" id="acct">Not connected</span></header>
<main>
  <h1>Approve NUSD</h1>
  <p>A local test page on LiteForge testnet. It asks the wallet to approve a spending cap.</p>
  <div class="card">
    <div class="row"><span class="muted">Network</span><span>LiteForge testnet</span></div>
    <div class="row"><span class="muted">Token</span><span>NUSD</span></div>
    <div class="row"><span class="muted">Requested cap</span><span>100 NUSD</span></div>
  </div>
</main></body></html>`;
const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(DAPP_HTML);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const DAPP = `http://localhost:${server.address().port}/`;

// ---------- browser ----------
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "wallet-shots-profile-"));
const PASSWORD = crypto.randomBytes(18).toString("base64url"); // never printed
const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  executablePath: CHROME,
  viewport: { width: 360, height: 600 },
  deviceScaleFactor: 3,
  colorScheme: "dark",
  // --hide-scrollbars: the headless default draws a classic scrollbar the popup never shows.
  args: ["--headless=new", `--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, "--no-first-run", "--hide-scrollbars"],
});
const problems = [];
const shots = [];
async function cleanup() {
  await context.close().catch(() => {});
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
try {
  await context.route((url) => url.hostname === RPC_HOST, rpcRoute);
  const sw = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 20_000 });
  const EXT_ID = new URL(sw.url()).host;
  const POPUP = `chrome-extension://${EXT_ID}/index.html`;
  console.log(`extension ${VERSION}`);

  const popup = await context.newPage();
  popup.on("pageerror", (e) => problems.push(`popup pageerror: ${e.message}`));
  await popup.goto(POPUP);
  const visibleText = (p) => p.evaluate(() => document.body.innerText);
  const writeLocal = (key, value) => popup.evaluate(async ([k, v]) => { await chrome.storage.local.set({ [k]: v }); }, [key, value]);
  const readLocal = (key) => popup.evaluate(async (k) => (await chrome.storage.local.get(k))[k] ?? null, key);
  async function unlockIfNeeded(page) {
    const pw = page.locator('input[type="password"]');
    await sleep(300);
    if (await pw.count() === 1 && await pw.isVisible()) {
      await pw.fill(PASSWORD);
      await pw.press("Enter");
      await pw.waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
    }
  }
  async function go(page, hash) {
    await page.evaluate((h) => { location.hash = h; }, hash);
    await sleep(500);
  }
  async function closeToasts(page) {
    for (const b of await page.locator(".w-toast-close").all()) await b.click().catch(() => {});
    await until(async () => (await page.locator(".w-toast").count()) === 0, 6000);
  }
  async function shoot(page, locale, name) {
    await closeToasts(page);
    await page.mouse.move(0, 0).catch(() => {});
    await sleep(400);
    const dir = path.join(OUT, locale);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}.png`);
    await page.screenshot({ path: file, animations: "disabled", caret: "hide" });
    const head = fs.readFileSync(file).subarray(16, 24);
    const size = `${head.readUInt32BE(0)}x${head.readUInt32BE(4)}`;
    shots.push(`${locale}/${name}.png ${size}`);
    console.log(`saved ${locale}/${name}.png ${size}`);
  }

  // ---------- 1. onboarding: a throwaway wallet ----------
  await popup.getByRole("button", { name: "Create a new wallet" }).click();
  await popup.locator(".w-seed .w-word").first().waitFor();
  // Kept in this process only; never printed or written.
  let words = await popup.$$eval(".w-seed .w-word", (els) => els.map((el) => (el.lastChild?.textContent ?? "").trim()));
  const box = popup.locator('[data-step="seed"] input.w-check');
  if (!(await box.isChecked())) await box.check();
  await popup.locator('[data-step="seed"]').getByRole("button", { name: "Continue" }).click();
  await popup.locator('[data-step="verify"]').waitFor({ timeout: 10_000 });
  const verifyInput = popup.locator('[data-step="verify"] input.w-input');
  for (let rounds = 0; await popup.locator('[data-step="verify"]').count() && rounds < 5; rounds++) {
    const label = await popup.locator('[data-step="verify"] .w-label').innerText();
    const n = Number(label.match(/\d+/)?.[0]);
    await verifyInput.fill(words[n - 1] ?? "");
    await verifyInput.press("Enter");
    await until(async () => !(await popup.locator('[data-step="verify"]').count())
      || (await popup.locator('[data-step="verify"] .w-label').innerText()) !== label, 5000);
  }
  words = null;
  const pws = popup.locator('input[type="password"]');
  await pws.first().waitFor({ timeout: 10_000 });
  await pws.nth(0).fill(PASSWORD);
  await pws.nth(1).fill(PASSWORD);
  await popup.getByRole("button", { name: "Open wallet" }).click();
  await popup.locator('[data-step="password"]').waitFor({ state: "detached", timeout: 20_000 });
  await sleep(800);
  const active = (await readLocal("wallet.accounts.v1"))?.active;
  if (!active) throw new Error("no active account after onboarding");
  ACCOUNT = active.toLowerCase();

  // ---------- 2. seeded demo records (the shapes the wallet validates) ----------
  const now = Date.now();
  const H = 3_600_000;
  const row = (kind, at, label, detail) => ({ hash: randomHash(), account: getAddress(ACCOUNT), networkId: "litvm-4441", kind, status: "success", at, label, ...(detail ? { detail } : {}) });
  await writeLocal("wallet.history.v1", {
    [ACCOUNT]: [
      row("send", now - 2 * H, { key: "tx.send", params: { amount: "2 zkLTC" } }, ALICE),
      row("approve", now - 26 * H, { key: "tx.approve", params: { symbol: "NUSD" } }),
      row("mint-nusd", now - 27 * H, { key: "tx.mint", params: { amount: "250.00" } }),
    ],
  });
  await writeLocal("wallet.recipients.v1", { [ACCOUNT]: { 4441: [{ address: ALICE.toLowerCase(), at: now - 2 * H, name: "Alice" }] } });
  await writeLocal("wallet.approvals.v1", { [ACCOUNT]: { 4441: [{ token: TOKENS.nusd.toLowerCase(), spender: DAPP_SPENDER.toLowerCase(), hash: randomHash(), at: now - 26 * H }] } });

  // ---------- 3. connect the local demo dapp (a connection, not a transaction) ----------
  const dapp = await context.newPage();
  await dapp.goto(DAPP);
  await sleep(600);
  const isApproval = (p) => p.url().includes("#/approve");
  async function approvalPage(timeout = 15_000) {
    const open = context.pages().find((p) => !p.isClosed() && isApproval(p));
    const page = open ?? await context.waitForEvent("page", { predicate: isApproval, timeout });
    await page.waitForLoadState("domcontentloaded");
    await page.setViewportSize({ width: 360, height: 600 });
    await page.locator('.w-flow-actions .w-btn-row button, input[type="password"]').first().waitFor({ timeout });
    return page;
  }
  const approveBtn = (p) => p.locator(".w-flow-actions .w-btn-row button").nth(1);
  const rejectBtn = (p) => p.locator(".w-flow-actions .w-btn-row button").nth(0);
  {
    const pending = dapp.evaluate(() => window.rq("eth_requestAccounts", []));
    const ap = await approvalPage();
    await until(async () => !(await approveBtn(ap).isDisabled()), 5000, 50);
    await approveBtn(ap).click();
    const res = await within(15_000, pending, "connect");
    if (String(res.result?.[0] ?? "").toLowerCase() !== ACCOUNT) throw new Error(`connect failed: ${JSON.stringify(res)}`);
  }

  async function setPrefs(locale) {
    await popup.bringToFront();
    await go(popup, "#/settings");
    const sel = popup.locator('select:has(option[value="vi"])');
    await sel.waitFor();
    if (await sel.inputValue() !== locale) { await sel.selectOption(locale); await sleep(800); }
    const seg = popup.locator('.w-seg[aria-labelledby="set-background"] button').nth(0); // dark
    if (await seg.getAttribute("aria-pressed") !== "true") { await seg.click(); await sleep(600); }
    return popup.evaluate(() => ({ theme: document.documentElement.dataset.theme, lang: document.documentElement.lang }));
  }
  async function reopen(page, hash) {
    await page.goto(`${page.url().split("#")[0]}${hash}`);
    await page.reload();
    await unlockIfNeeded(page);
    await go(page, hash);
  }
  // The visible part of a page's main scroll area: its box minus sticky or fixed bars.
  // Runs in the page; passed as source text because extension pages forbid eval.
  function pageView() {
    const boxes = [...document.querySelectorAll("*")].filter((e) => e.scrollHeight > e.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(e).overflowY) && e.clientHeight > 200);
    const box = boxes.sort((a, b) => b.clientHeight - a.clientHeight)[0] ?? document.scrollingElement;
    const r = box === document.scrollingElement ? { top: 0, bottom: innerHeight } : box.getBoundingClientRect();
    let top = Math.max(0, r.top), bottom = Math.min(innerHeight, r.bottom);
    for (const e of document.querySelectorAll("*")) {
      const pos = getComputedStyle(e).position;
      if (pos !== "sticky" && pos !== "fixed") continue;
      const b = e.getBoundingClientRect();
      if (b.height === 0 || b.height > innerHeight / 2) continue;
      if (b.top + b.height / 2 < innerHeight / 2) top = Math.max(top, b.bottom); else bottom = Math.min(bottom, b.top);
    }
    return { box, top, bottom };
  }
  const run = (page, fn, arg) => page.evaluate(`(${fn})(${pageView}, ${JSON.stringify(arg)})`);
  // Scrolls `selector` (an element, or the panel holding it with panel=true) to the top of
  // its scroll area, below any bar that covers it, then fits the edges (see fitEdges).
  async function scrollTo(page, selector, { panel = false, gap = 14 } = {}) {
    const ok = await run(page, (view, [sel, asPanel, pad]) => {
      let el = document.querySelector(sel);
      if (el && asPanel) el = el.closest("section.w-panel") ?? el;
      if (!el) return false;
      const { box, top } = view();
      box.scrollTop += el.getBoundingClientRect().top - top - pad;
      return true;
    }, [selector, panel, gap]);
    if (!ok) throw new Error(`nothing matches ${selector}`);
    await sleep(300);
    await fitEdges(page);
  }
  async function scrollPanel(page, title) {
    const id = await page.evaluate((t) => {
      const panel = [...document.querySelectorAll("section.w-panel")].find((s) => s.querySelector(".w-panel-head span")?.textContent?.trim() === t);
      if (!panel) return null;
      panel.dataset.shot = t;
      return t;
    }, title);
    if (!id) throw new Error(`no panel titled ${title}`);
    await scrollTo(page, `section.w-panel[data-shot="${title}"]`);
  }
  // Moves the scroll by the smallest step (within 80 px) after which no line of text is
  // cut by the top or the bottom of the visible scroll area, so no capture shows half a line.
  async function fitEdges(page) {
    await run(page, (view) => {
      const { box, top, bottom } = view();
      const r = { top, bottom };
      const lines = [];
      const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!n.textContent.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        for (const rect of range.getClientRects()) if (rect.height > 0) lines.push([rect.top, rect.bottom]);
      }
      const cut = (d) => lines.some(([t, b]) => (t - d < r.top && b - d > r.top) || (t - d < r.bottom && b - d > r.bottom));
      const max = box.scrollHeight - box.clientHeight;
      for (let step = 0; step <= 80; step += 2) {
        for (const d of step === 0 ? [0] : [step, -step]) {
          const next = box.scrollTop + d;
          if (next < 0 || next > max) continue;
          if (!cut(d)) { box.scrollTop = next; return; }
        }
      }
    }, null);
    await sleep(300);
  }

  const TITLES = {
    en: { security: "Security", network: "Network" },
    vi: { security: "Bảo mật", network: "Mạng" },
  };

  for (const locale of LOCALES) {
    const applied = await setPrefs(locale);
    console.log(`locale ${locale}: theme=${applied.theme} lang=${applied.lang}`);

    // 01 Home with balances and the token list
    await reopen(popup, "#/home");
    const total = popup.locator(".w-total");
    await until(async () => /\d/.test(await total.innerText()), 20_000);
    await until(async () => (await popup.locator(".w-asset").count()) >= 3, 20_000);
    await until(async () => (await popup.locator('[aria-busy="true"]').count()) === 0, 15_000);
    await sleep(1500);
    await shoot(popup, locale, "01-home");

    // 02 Swap: 1 zkLTC with a live quote from the testnet pools
    await reopen(popup, "#/swap");
    const amount = popup.locator('input[inputmode="decimal"]').first();
    await amount.waitFor({ timeout: 10_000 });
    await until(async () => !(await amount.isDisabled()), 10_000);
    await amount.fill("1");
    await until(async () => (await popup.locator('[aria-busy="true"]').count()) === 0, 20_000);
    await sleep(2500);
    await popup.locator("input:focus").evaluate((el) => el.blur()).catch(() => {});
    await shoot(popup, locale, "02-swap");

    // 03 The approval window: the dapp asks approve(spender, 100 NUSD). Captured, then REJECTED.
    {
      await dapp.bringToFront();
      const words2 = (v) => v.toString(16).padStart(64, "0");
      const data = `0x095ea7b3${words2(BigInt(DAPP_SPENDER))}${words2(100n * 10n ** 18n)}`;
      const pending = dapp.evaluate(([from, to, d]) => window.rq("eth_sendTransaction", [{ from, to, data: d }]), [ACCOUNT, TOKENS.nusd, data]);
      const ap = await approvalPage();
      await ap.locator('.w-approve-flow input[inputmode="decimal"]').waitFor({ timeout: 15_000 }).catch(() => {});
      await until(async () => (await ap.locator('[aria-busy="true"]').count()) === 0, 15_000);
      await until(async () => !(await approveBtn(ap).isDisabled()), 8000, 100);
      await sleep(1200);
      await shoot(ap, locale, "03-approve-request");
      // The same window scrolled to its spending-cap editor.
      await scrollTo(ap, '.w-approve-flow input[inputmode="decimal"]', { panel: true });
      await shoot(ap, locale, "03b-approve-cap");
      await rejectBtn(ap).click(); // never approve a transaction
      const res = await within(15_000, pending, "approve reject");
      if (res.error?.code !== 4001) problems.push(`approve request was not rejected with 4001: ${JSON.stringify(res)}`);
      else console.log("approve request rejected (4001)");
      await popup.bringToFront();
    }

    // 04 Receive with the QR code
    await reopen(popup, "#/receive");
    await until(async () => (await popup.locator("svg, canvas, img").count()) > 0, 10_000);
    await sleep(1200);
    await shoot(popup, locale, "04-receive");

    // 05 Settings: security (auto-lock), 06 Settings: network with the RPC field
    await reopen(popup, "#/settings");
    await sleep(800);
    await scrollPanel(popup, TITLES[locale]?.security ?? TITLES.en.security);
    await shoot(popup, locale, "05-settings-security");
    await scrollPanel(popup, TITLES[locale]?.network ?? TITLES.en.network);
    // Open the LiteForge RPC disclosure so its RPC field shows (nothing is typed or saved).
    await popup.locator(`section.w-panel[data-shot="${TITLES[locale]?.network ?? TITLES.en.network}"] details.w-disclosure > summary`).first().click();
    await sleep(500);
    await scrollPanel(popup, TITLES[locale]?.network ?? TITLES.en.network);
    await shoot(popup, locale, "06-settings-network");

    // 07 Token approvals (the seeded record; its allowance read answered as 100 NUSD)
    await reopen(popup, "#/settings");
    const approvals = popup.locator("#token-approvals");
    await approvals.waitFor({ timeout: 10_000 });
    await until(async () => /NUSD/.test(await approvals.innerText()) && !/…/.test(await approvals.innerText()), 15_000);
    // Saved recipients (the named demo recipient) and Token approvals together.
    await scrollTo(popup, '[id^="rcp-name-"]', { panel: true });
    await shoot(popup, locale, "07-token-approvals");

    // 08 History with the seeded rows
    await reopen(popup, "#/history");
    await until(async () => (await popup.locator(".w-tx").count()) >= 3, 10_000);
    await sleep(800);
    await shoot(popup, locale, "08-history");

    // 09 Dapp screen with the current site. activeTab needs a real toolbar click, so the
    // tab read is answered with the local dapp's URL, as Chrome answers after that click.
    {
      const p = await context.newPage();
      await p.addInitScript((u) => {
        const install = () => {
          if (!globalThis.chrome?.tabs?.query) return false;
          chrome.tabs.query = async () => [{ id: 1, url: u, title: "Demo dapp" }];
          return true;
        };
        if (!install()) document.addEventListener("DOMContentLoaded", install, { once: true });
      }, DAPP);
      await p.goto(`${POPUP}#/dapps`);
      await unlockIfNeeded(p);
      await go(p, "#/dapps");
      await p.locator(".w-dapp-current").first().waitFor({ timeout: 10_000 }).catch(() => {});
      await sleep(1500);
      await fitEdges(p);
      await shoot(p, locale, "09-dapps-current-site");
      await p.close();
    }

    // 10 Side panel beside the local dapp page (1280x800 scene of two real captures)
    {
      const W = 1280, HGT = 800, PANEL = 400;
      await dapp.setViewportSize({ width: W - PANEL, height: HGT });
      await dapp.reload();
      await sleep(1200);
      const left = await dapp.screenshot({ animations: "disabled" });
      const panel = await context.newPage();
      await panel.setViewportSize({ width: PANEL, height: HGT });
      await panel.goto(`${POPUP}?surface=panel#/home`);
      await unlockIfNeeded(panel);
      await go(panel, "#/home");
      await until(async () => (await panel.locator(".w-asset").count()) >= 3, 20_000);
      await until(async () => (await panel.locator('[aria-busy="true"]').count()) === 0, 15_000);
      await sleep(1500);
      const right = await panel.screenshot({ animations: "disabled" });
      await panel.close();
      await dapp.setViewportSize({ width: 360, height: 600 });
      const scene = await context.newPage();
      await scene.setViewportSize({ width: W, height: HGT });
      await scene.setContent(`<!doctype html><html><body style="margin:0;display:flex;background:#000">
        <img style="width:${W - PANEL}px;height:${HGT}px;display:block" src="data:image/png;base64,${left.toString("base64")}">
        <img style="width:${PANEL}px;height:${HGT}px;display:block;border-left:1px solid #2a2c30;box-sizing:border-box" src="data:image/png;base64,${right.toString("base64")}">
        </body></html>`);
      await sleep(500);
      await shoot(scene, locale, "10-side-panel");
      await scene.close();
    }
  }
  console.log(`rpc answers faked ${counts.faked}, broadcasts blocked ${counts.blocked}`);
  if (problems.length) console.log(`problems:\n  ${problems.join("\n  ")}`);
} catch (e) {
  console.error(`make-shots: ${String(e?.stack ?? e)}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
console.log(`${shots.length} captures in ${OUT}`);

// ---------- compose: the store images from the raw captures ----------
// The copy says what each screen does, in the words the wallet itself uses; no counts,
// ratings or promises. Vietnamese is written for the listing, not translated word by word.
async function compose() {
  const RAW = process.env.SHOTS_OUT;
  if (!RAW) die("set SHOTS_OUT to the folder that holds the raw captures (<locale>/<name>.png).");
  const DEST = path.resolve(process.env.COMPOSE_OUT ?? path.join(HERE, ".."));
  let chrome = process.env.CHROME;
  if (!chrome) { try { chrome = chromium.executablePath(); } catch {} }
  if (!chrome || !fs.existsSync(chrome)) die("set CHROME to a full Chromium executable (chrome.exe).");
  const TEMPLATE = pathToFileURL(path.join(HERE, "store-shots.html")).href;
  const SCALE = 1.15; // the 360x600 capture at 414x690 CSS px (from 1080x1800 source pixels)
  const SLOTS = [
    { file: "01-portfolio", raw: "01-home" },
    { file: "02-swap-search", raw: "02-swap" },
    { file: "03-review-sign", raw: "03-approve-request" },
    { file: "04-receive-qr", raw: "04-receive" },
    { file: "05-local-security-networks", raw: "05-settings-security" },
  ];
  const COPY = {
    en: {
      dir: "global-en",
      network: "LiteForge testnet",
      slots: [
        ["Your LiteForge wallet at a glance", "zkLTC, NUSD and your other tokens, each with its value in USD."],
        ["Swap tokens on LiteForge", "See the quote, minimum received, route and fee before you swap."],
        ["Read the request before you sign", "Site requests show the function called, the spender, the token and the allowance."],
        ["Receive with a QR code", "Share your address as a QR, copy it, or open it in the explorer."],
        ["Your keys stay on this device", "Encrypted with your password. Auto-lock, and a password check before keys are shown."],
      ],
    },
    vi: {
      dir: "localized-vi",
      network: "LiteForge testnet",
      slots: [
        ["Tài sản LiteForge trong một màn hình", "Số dư zkLTC, NUSD và các token khác, kèm giá\u00a0trị USD."],
        ["Swap token ngay trên LiteForge", "Xem báo giá, mức nhận tối thiểu, tuyến và phí trước khi swap."],
        ["Đọc kỹ yêu cầu trước khi ký", "Yêu cầu từ trang web hiện rõ hàm được gọi, bên được cấp quyền, token và hạn mức."],
        ["Nhận tài sản qua mã QR", "Chia sẻ địa chỉ bằng mã QR, sao chép hoặc mở trong explorer."],
        ["Khóa riêng nằm trên máy bạn", "Mã hóa bằng mật khẩu, tự động khóa, hỏi lại mật khẩu trước khi hiện khóa riêng."],
      ],
    },
  };
  const PROMO = {
    network: "LiteForge testnet",
    small: "A self-custody wallet for LitVM LiteForge",
    headline: "A wallet for LitVM LiteForge",
    line: "Hold, swap and receive on the testnet, and read each site request before you sign.",
    captures: ["01-home", "03-approve-request"],
  };
  const fileUrl = (p) => pathToFileURL(p).href;
  const need = (p) => { if (!fs.existsSync(p)) die(`missing capture ${p}`); return p; };
  const pngSize = (p) => { const b = fs.readFileSync(p); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), type: b[25], depth: b[24] }; };

  const browser = await chromium.launch({ executablePath: chrome, args: ["--headless=new", "--hide-scrollbars"] });
  const written = [];
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1, colorScheme: "dark" });
    async function render(out, width, height, spec) {
      await page.setViewportSize({ width, height });
      await page.goto(TEMPLATE);
      const info = await page.evaluate((s) => window.render(s), spec);
      const faces = spec.layout === "sheet" ? ["Departure Mono"] : ["Geist", "Departure Mono"];
      if (faces.some((f) => !info.fonts.includes(f))) throw new Error(`fonts not loaded for ${out}: ${info.fonts.join(", ")}`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      await page.screenshot({ path: out, clip: { x: 0, y: 0, width, height }, animations: "disabled" });
      const s = pngSize(out);
      written.push(out);
      console.log(`composed ${path.relative(DEST, out).split(path.sep).join("/")} ${s.w}x${s.h} type ${s.type} depth ${s.depth} ${fs.statSync(out).size} bytes`);
    }

    for (const [locale, copy] of Object.entries(COPY)) {
      for (const [i, slot] of SLOTS.entries()) {
        const [headline, line] = copy.slots[i];
        await render(path.join(DEST, "chrome-web-store-ready", copy.dir, `${slot.file}.png`), 1280, 800, {
          layout: "screenshot", lang: locale, scale: SCALE, index: String(i + 1).padStart(2, "0"), total: String(SLOTS.length).padStart(2, "0"),
          headline, line, network: copy.network, capture: fileUrl(need(path.join(RAW, locale, `${slot.raw}.png`))),
        });
      }
    }
    await render(path.join(DEST, "chrome-web-store-ready", "promo", "small-promo-440x280.png"), 440, 280, {
      layout: "small", lang: "en", line: PROMO.small, network: PROMO.network,
    });
    await render(path.join(DEST, "chrome-web-store-ready", "promo", "marquee-1400x560.png"), 1400, 560, {
      layout: "marquee", lang: "en", scale: 0.8, headline: PROMO.headline, line: PROMO.line, network: PROMO.network,
      captures: PROMO.captures.map((n) => fileUrl(need(path.join(RAW, "en", `${n}.png`)))),
    });

    // Contact sheets of what was just written.
    const ready = path.join(DEST, "chrome-web-store-ready");
    for (const [name, locale] of [["english-set", "en"], ["vietnamese-set", "vi"]]) {
      const items = SLOTS.map((s) => ({ src: fileUrl(path.join(ready, COPY[locale].dir, `${s.file}.png`)), label: `${s.file}.png`, w: 1280, h: 800 }));
      await render(path.join(DEST, "previews", `${name}.png`), 1280, 32 + 2 * (240 + 28 + 32), {
        layout: "sheet", width: 1280, cols: 3, cellWidth: 384, cellHeight: 240, items,
      });
    }
    await render(path.join(DEST, "previews", "promo-set.png"), 1236, 32 + 280 + 28 + 32, {
      layout: "sheet", width: 1236, cols: 2, cellWidth: 440, cellHeight: 280,
      items: [
        { src: fileUrl(path.join(ready, "promo", "small-promo-440x280.png")), label: "small-promo-440x280.png", w: 440, h: 280, width: 440 },
        { src: fileUrl(path.join(ready, "promo", "marquee-1400x560.png")), label: "marquee-1400x560.png", w: 1400, h: 560, width: 700 },
      ],
    });
  } catch (e) {
    console.error(`make-shots compose: ${String(e?.stack ?? e)}`);
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
  }
  console.log(`${written.length} images composed in ${DEST}`);
}
