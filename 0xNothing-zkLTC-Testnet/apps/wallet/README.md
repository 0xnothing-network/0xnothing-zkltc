# 0xWallet

One React app in two shells: a Manifest V3 browser extension and a Capacitor
Android build. Both load the same `dist/`, speak to the same LitVM LiteForge
testnet (chain **4441**), and reuse the design tokens of the 0xFi surface in
`apps/web`.

## Requirements

- **Node 22.6+** (Node 24 recommended). `npm test` runs TypeScript through
  node's own type stripping; Vite 8 needs a modern runtime anyway.
- **Chrome 111+** for the extension — `minimum_chrome_version` in the manifest,
  set by the MAIN-world content script.
- **Android Studio + JDK 21** for the Android build.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server on `:5183`. Browser-only preview: no `chrome.*`, so storage falls back to the web backend and the dapp bridge is inert. |
| `npm run build` | The whole bundle: app + service worker, then the two classic scripts. |
| `npm run build:app` | `vite build` only — `index.html`, `assets/`, `background.js`. Empties `dist/`. |
| `npm run build:inject` | `content.js` + `inpage.js` only, as IIFE with unhashed names. |
| `npm run build:android` | `npm run build`, then `cap sync android`. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm test` | node's built-in runner over `tests/*.test.ts`. |
| `npm run icons` | Regenerates `public/icons/*`. |

Order matters if you run the two build halves separately: `build:app` empties
`dist/`, `build:inject` adds to it.

## Load the extension

```bash
npm install
npm run build
```

Then `chrome://extensions` → Developer mode → **Load unpacked** →
`apps/wallet/dist`. Reload the extension after each rebuild.

What `dist/` contains:

- `index.html` + `assets/` — the popup and the approval window
- `background.js` — the service worker, emitted as ESM because the manifest
  declares `"type": "module"`
- `content.js` (ISOLATED relay) and `inpage.js` (MAIN-world EIP-1193 provider) —
  classic scripts, `document_start`, all frames
- `manifest.json`, `_locales/`, `icons/`, `fonts/`, `tokens/`

Permissions: `storage` and `alarms`, plus the built-in LitVM RPC host. A custom
RPC asks for its own optional origin permission only after the user saves that
network in Settings. No `tabs`, no `activeTab`, and no permanent broad host
access.

## Android

`android/` is not committed. Create it once, then sync on every build:

```bash
npx cap add android
npm run build:android    # build + cap sync android
npx cap open android
```

`androidScheme: "https"` keeps the WebView on a secure origin so WebCrypto (the
keyring) and storage behave exactly as they do in the extension. `cleartext` and
`allowMixedContent` are off, and the `CapacitorHttp` plugin is disabled so
`fetch` stays the browser's rather than a native bridge.

## Security model

Described as built, not as intended.

**One secret on disk.** `{ mnemonic, imported[] }` in a single AES-GCM-256 blob:
PBKDF2-SHA256, 600 000 iterations, 16-byte salt, 12-byte IV. Addresses, labels
and which account is active are public metadata kept in the clear, so a locked
wallet still renders without touching key material.

**Unlocked means a key is held, not a password.** `unlock()` derives the AES key
and stores *the key* in session storage — `chrome.storage.session` in the
extension, an in-process `Map` on Android — with an `expiresAt`. Both are
memory-only, so locking is a single delete with nothing left behind. Auto-lock
defaults to 15 minutes and is pushed out by deliberate actions.

**Signers are built per use and never cached**, so a lock takes effect
everywhere at once. Revealing a seed phrase or a private key re-asks for the
password even while unlocked.

**The service worker holds no key material and cannot sign.** Anything needing a
signature is written to `chrome.storage.local` and handed to a separate approval
window (`index.html#/approve?id=…`, 380×660) — a window rather than a panel in
the popup, because a popup closes on a stray click and a signing prompt that
vanishes is a way to lose track of what was approved. Unanswered after 300 s it
resolves as a 4001 rejection. A `chrome.alarms` keepalive holds the worker up
while the queue is non-empty, and a queue left behind by an evicted worker
re-opens its window on startup.

**Origins come from the browser.** `sender.origin` decides which grant applies,
never what the page claims about itself; anything that is not http(s) is refused
outright. Grants are per origin and expose only the active account, so
`eth_accounts` tells a site that was never connected nothing at all.

**The RPC proxy is an allow-list.** 23 read methods are forwarded by raw `fetch`
to the selected built-in or saved RPC — no viem client in the worker, and no
dynamic `import()` anywhere in its graph, which MV3 forbids. `eth_chainId` and
`net_version` are answered locally. An unlisted method is refused (-32601)
rather than forwarded. `wallet_switchEthereumChain` and
`wallet_addEthereumChain` can only select a network already saved in the wallet
(anything else → 4902); the wallet UI validates and stores custom profiles.
`wallet_watchAsset` returns false.

**Hex quantities from a page are parsed in exactly one place** — the approval
window. It re-estimates gas even when the page dictates a limit, names the four
selectors worth naming (`transfer`, `approve`, `transferFrom`,
`safeTransferFrom`) and shows raw calldata for everything else, flags a
typed-data `chainId` that is not 4441, flags a request belonging to an account
other than the one on screen, and disables Approve when a parameter does not
parse.

**ERC-20 approvals are for the exact amount**, and are skipped entirely when the
existing allowance already covers it. Nothing here asks for an unlimited
allowance.

**Network profiles are explicit.** LitVM LiteForge (chain 4441) is compiled in
as the default. Settings can add HTTPS RPCs (or loopback HTTP for a local node),
with chain ID, currency metadata and an optional explorer. The selected profile
is stored locally, custom ERC-20s are isolated by network, and LitVM-only DeFi
screens are clearly gated on other chains.

**Extension-pages CSP:** `script-src 'self'; object-src 'none'; base-uri 'self';
form-action 'none'; frame-ancestors 'none'`.

**The provider does not squat.** `window.zeroxnothing` always; `window.ethereum`
only when no other wallet has claimed it. Discovery is EIP-6963.

### Known limits

- **Receive QR is local-only.** The QR is generated on the device and can be
  saved as a PNG; it contains the address only. The address is also shown in
  8-character groups with a copy button.
- **The approval window may not know the tab's title.** Without the `tabs`
  permission `sender.tab.title` is undefined, and the window falls back to the
  full origin under the host. The host is the identity that matters.
- **History is local.** It lists what this wallet submitted. Transfers received
  while the wallet was closed are not in it; the explorer is the source of truth.
- **Prices are display-only.** zkLTC comes from the DIA LTC/USD feed, read
  through the adapter NUSD itself is bound to — the wallet resolves it with
  `NUSD.oracle()` rather than trusting a copied address, so the price on screen
  is the one a mint would settle at. NUSD is 1.00 because it is the unit of
  account and that same feed defines its mint. Everything else is the spot
  reserves of its NUSD pool — manipulable in a thin pool, and the `NUSD/WzkLTC`
  pool on this testnet is known to sit far from the feed. Swap quotes compare
  delivered output across route shapes and avoid that pool when it is
  unfavourable; they do not fix it.
- **A password is a delay, not a guarantee.** 600 000 PBKDF2 iterations buy time
  against a stolen blob and nothing more. Do not reuse a mainnet seed here.
- **Android locks harder than the extension.** Its session store is process
  memory, so killing the app locks the wallet.
- No hardware wallet or WalletConnect. Custom networks support native balances,
  ERC-20 reads and signed transfers; 0xFi/0xPump/0xPixel contract screens stay
  on LitVM until their deployments are known on another chain.

## Layout

```
src/
  config/     chain, networks, contracts, assets, dapp list
  abis/       parseAbi fragments, one export
  core/
    keyring/  crypto (PBKDF2 + AES-GCM), vault, mnemonic
    i18n/     English catalog, eight overlays in locales/, t()
    lib/      format, swapMath, errors, pixelSvg — no chain imports
    platform/ storage backends, chrome.storage helpers, env probes
    rpc/      viem client, one shared block ticker
    services/ portfolio, prices, tokens, nfts, swap, lend, transfer,
              tx, history, dapp, oracle, walletEvents
  extension/  background (worker), content (ISOLATED), inpage (MAIN),
              protocol (types shared by all three)
  ui/         App, router, state/, hooks/, components/, screens/
  styles/     wallet.css
tests/        node --test, no bundler
scripts/      build-all, build-inject, generate-icons
```

Realtime data is one `eth_blockNumber` poll every 3 s, shared by every `useLiveRead`
on screen and suspended while the document is hidden. Storage-only reads pass
`{ live: false }` and never poll.

## Language

Nine languages, English by default: English, Tiếng Việt, 中文, Español, Français,
Deutsch, 日本語, 한국어, Русский. **Settings → Language** switches the whole
surface at once, and the choice is remembered per device.

`src/core/i18n/catalog.ts` is the English catalog and the only source of keys —
`MessageKey` is `keyof typeof EN`, so a typo is a type error and a string with no
key cannot be rendered. The eight files in `locales/` are `Partial` overlays: a
key they omit falls back to English rather than breaking the build. That fallback
is used deliberately for terms that carry no language (`NFT`, `Dapp`, `Swap`,
`{amount} {symbol}`, the four ERC-20 selector names) instead of restating them
nine times. `tests/i18n.test.ts` keeps every gap declared, so an accidental
omission fails a test while an intentional one is a line in a list.

No dependency and no async: all nine catalogs are bundled, `t()` is a plain
function callable from services as well as components, and the active locale is
mirrored into `localStorage` so the first frame after a reload is already in the
right language. `ERASE` — the word typed to confirm a wipe — is translated only
where a keyboard produces it without an IME.

What is *not* translated: JSON-RPC error text in `services/dapp.ts` and
`extension/background.ts`, which dapps read rather than people, and which keeps
the catalog out of the service-worker bundle. Persisted history stores message
keys, not rendered strings, so past transactions follow the language too.

The extension's store listing is localised the way MV3 wants it:
`public/_locales/<locale>/messages.json` plus `"description":
"__MSG_extDescription__"` in the manifest. The browser picks that by *its* UI
language, independently of the wallet's own setting; `name` and `short_name` stay
literal because they are brand.

## Design tokens

`src/styles/wallet.css` reproduces the palette, spacing and type scale of
`apps/web/app/0xFi/globals.css` value for value: the `.fi-root` custom properties
become `.w-root` ones. `tests/tokens.test.ts` pins that, so drift in either file
fails a test instead of being noticed by eye later. Only `--w-gutter` and
`--w-nav-height` are the wallet's own. There are no inline styles anywhere;
variants ride on data attributes.

Nothing in the stylesheet is sized to a string, because nine languages share it:
a label wraps instead of running past its border, every `1fr` track is
`minmax(0, 1fr)` so one long word cannot widen a column, and in a label/value row
the label is what yields — the value keeps its line. Two exceptions are
deliberate: a chip in a list row stays on one line and the row gives it the
space, and the total on Home is never abbreviated, so the 24h figure drops below
it rather than pushing a digit out of view.

The `@font-face` for Departure Mono lives in `index.html` rather than the
stylesheet: under `base: "./"`, a `url()` inside `assets/*.css` resolves one
directory too deep.

## Tests

`npm test` runs node's built-in runner straight over TypeScript — no Vite, no
jsdom. 40 tests in eleven files: number formatting and parsing, swap math (the
native gas reserve, slippage flooring and clamping), the dapp protocol constants
and the chain-ID hex, the nine translation catalogs, and the token duplication
above.

With no bundler in the loop, a test can only import a module whose own imports
are bare package specifiers or carry an explicit `.ts` — node will not resolve the
extensionless relative paths the app uses. That is why the money arithmetic sits
in `src/core/lib/swapMath.ts`, which imports nothing at all, why the locale files
reach for `Catalog` with `import type` (erased before resolution), and why
`__WALLET_VERSION__` (a `define` replacement) is referenced only from `.tsx`
files no test reaches.
