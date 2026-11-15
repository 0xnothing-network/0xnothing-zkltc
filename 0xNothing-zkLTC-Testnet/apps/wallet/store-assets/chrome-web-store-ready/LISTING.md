# 0xWallet 1.0.10 - Chrome Web Store dashboard entries

Everything to enter in the Chrome Web Store developer dashboard for 0xWallet 1.0.10, tab by tab, in the dashboard's order. Paste the text inside each fenced block as it is. Character counts are Unicode characters of the block. Where the official pages give no limit, the line says so; check the counter the dashboard shows.

Sources: the current tree (apps/wallet, version 1.0.10) and the developer.chrome.com pages listed at the end. Before you tick anything, read the "Only the owner" section.

## 1. Package

### Package file

Upload a ZIP of the built `dist/` folder, with `manifest.json` at the root of the ZIP. The ZIP cut on 2026-11-15 already carries the summaries below (they live in `public/_locales`, and the store summary comes from the package).

Manifest facts the dashboard will show:

- name `0xWallet`, version `1.0.10`, `minimum_chrome_version` 120, `default_locale` `en`
- permissions: `storage`, `alarms`, `idle`, `sidePanel`, `activeTab`
- optional permissions: `notifications`
- host permissions: `https://rpc.testnet.liteforge.zeeve.net/*`, `https://0xnothing.xyz/*`, `https://api.goldsky.com/*`
- optional host permissions: `https://*/*`, `http://127.0.0.1/*`, `http://localhost/*`, `http://[::1]/*`
- content scripts on `http://*/*` and `https://*/*`, all frames, `document_start`: `inpage.js` in the MAIN world, `content.js` in the ISOLATED world
- side panel `index.html?surface=panel`; command `_execute_action` with Alt+Shift+W

### Summary (manifest `description`, the store summary and the line under the name in chrome://extensions)

Today every locale says `0xNothing Wallet`. Proposed text for `extDescription.message` in each `public/_locales/<locale>/messages.json`. Limit: 132 characters, plain text (manifest description reference).

| Locale | Characters | Proposed summary |
|---|---|---|
| en | 130 | Self-custody wallet for the LitVM LiteForge testnet. Hold, send and swap test assets, connect to dapps. Test assets have no value. |
| vi | 126 | Ví tự lưu ký cho testnet LitVM LiteForge. Giữ, gửi, hoán đổi tài sản thử nghiệm và kết nối dapp. Tài sản này không có giá trị. |
| zh_CN | 60 | LitVM LiteForge 测试网的自托管钱包。持有、发送、兑换测试资产，并连接去中心化应用。测试资产没有货币价值。 |
| es | 131 | Monedero de autocustodia para la testnet LitVM LiteForge. Guarda, envía e intercambia activos de prueba. No tienen valor monetario. |
| fr | 127 | Portefeuille autonome pour le testnet LitVM LiteForge. Gardez, envoyez et échangez des actifs de test. Ils n'ont aucune valeur. |
| de | 129 | Selbstverwahrte Wallet für das LitVM LiteForge Testnet. Test-Assets halten, senden, tauschen, mit Dapps verbinden. Ohne Geldwert. |
| ja | 84 | LitVM LiteForge テストネット用のセルフカストディ型ウォレット。テスト資産の保管、送金、スワップ、dapp への接続。テスト資産に金銭的価値はありません。 |
| ko | 93 | LitVM LiteForge 테스트넷용 자기 보관형 지갑입니다. 테스트 자산 보관, 전송, 스왑, dapp 연결을 지원합니다. 테스트 자산에는 금전적 가치가 없습니다. |
| ru | 132 | Некастодиальный кошелёк для тестовой сети LitVM LiteForge. Храните, отправляйте и обменивайте тестовые активы без денежной ценности. |

Note for the engineer who applies them: the French line uses a straight apostrophe; keep it as is inside the JSON string.

## 2. Store listing

### Detailed description (English, the default listing)

Limit: none is stated on the official pages; the dashboard shows its own counter. Plain text, no markdown.

```text
0xWallet is a self-custody wallet from the 0xNothing project for the LitVM LiteForge testnet (chain ID 4441). Your recovery phrase and private keys are created on your device and stay there, encrypted with your password. They are never sent to 0xNothing or to any server.

This version works on the LitVM LiteForge testnet. zkLTC, NUSD and every other asset on it are test assets with no monetary value.

What you can do with 0xWallet:
- Create a wallet with a 12-word recovery phrase and check your backup, or restore a wallet from a recovery phrase
- Add more accounts, or import an account from a private key
- See your test tokens, your 0xPixel NFTs, and transactions that are still pending
- Send tokens and 0xPixel NFTs, with a warning for a new recipient or an address that looks like one you used before, and optional names for saved recipients
- Receive with your address and a QR code
- Swap test tokens through 0xFi pools, mint and redeem NUSD, supply NUSD to the NUSD pool, and lock NUSD for 0xPoints
- Connect to websites through the standard wallet provider (EIP-1193 and EIP-6963). A site sees only the accounts you connect to it, and every signature and transaction opens a review window first
- Lower the spending cap a website asks for in a token approval before you sign it, and see and revoke the token approvals signed in this wallet
- Approve or reject token and network suggestions from websites
- See a mark on the official 0xNothing sites and a warning on look-alike addresses
- Add custom networks and your own RPC endpoints
- Export your transaction history as a CSV file
- Open the wallet as a popup, in the side panel or in a tab; Alt+Shift+W opens it
- Turn on optional notifications for confirmed or failed transactions
- Use it in nine languages with a black, white or system theme

The wallet locks itself after the auto-lock time you choose and when you lock your computer.

0xWallet has no account sign-up, no analytics and no telemetry. To work, it contacts the LiteForge RPC (or an RPC you add) to read the chain and send the transactions you approve, and the 0xNothing site and public Goldsky indexes for token and market data. The privacy policy explains what each one receives.
```

Characters: 2217 (limit: not stated)

### Detailed description (Vietnamese, localized listing for `vi`)

```text
0xWallet là ví tự lưu ký của dự án 0xNothing dành cho testnet LitVM LiteForge (chain ID 4441). Cụm từ khôi phục và khóa riêng được tạo trên thiết bị của bạn và chỉ nằm ở đó, được mã hóa bằng mật khẩu của bạn. Chúng không bao giờ được gửi tới 0xNothing hay bất kỳ máy chủ nào.

Phiên bản này hoạt động trên testnet LitVM LiteForge. zkLTC, NUSD và mọi tài sản khác trên mạng này là tài sản thử nghiệm, không có giá trị tiền tệ.

Bạn có thể làm gì với 0xWallet:
- Tạo ví với cụm từ khôi phục 12 từ và kiểm tra bản sao lưu, hoặc khôi phục ví từ cụm từ khôi phục
- Thêm tài khoản, hoặc nhập tài khoản từ khóa riêng
- Xem token thử nghiệm, NFT 0xPixel của bạn và các giao dịch đang chờ xác nhận
- Gửi token và NFT 0xPixel, có cảnh báo khi người nhận mới hoặc khi địa chỉ trông giống một địa chỉ bạn đã dùng, và có thể đặt tên cho người nhận đã lưu
- Nhận bằng địa chỉ và mã QR
- Hoán đổi token thử nghiệm qua các pool 0xFi, mint và đổi lại NUSD, gửi NUSD vào pool NUSD và khóa NUSD để nhận 0xPoints
- Kết nối với trang web qua provider ví chuẩn (EIP-1193 và EIP-6963). Mỗi trang chỉ thấy những tài khoản bạn kết nối cho nó, và mọi chữ ký hay giao dịch đều mở cửa sổ duyệt trước
- Giảm hạn mức chi tiêu mà trang web yêu cầu trong một lệnh approve token trước khi ký, xem và thu hồi các approve token đã ký trong ví này
- Chấp nhận hoặc từ chối đề xuất thêm token và mạng từ trang web
- Thấy dấu xác nhận trên các trang chính thức của 0xNothing và cảnh báo với địa chỉ trang giả mạo
- Thêm mạng tùy chỉnh và RPC riêng của bạn
- Xuất lịch sử giao dịch thành tệp CSV
- Mở ví dạng popup, trong bảng bên (side panel) hoặc trong một tab; phím Alt+Shift+W mở ví
- Bật thông báo tùy chọn khi giao dịch được xác nhận hoặc thất bại
- Dùng bằng chín ngôn ngữ, với giao diện đen, trắng hoặc theo hệ thống

Ví tự khóa sau thời gian tự khóa bạn chọn và khi bạn khóa máy tính.

0xWallet không cần đăng ký tài khoản, không có phân tích (analytics) và không gửi dữ liệu đo lường (telemetry). Để hoạt động, ví liên hệ RPC LiteForge (hoặc RPC bạn thêm) để đọc dữ liệu chuỗi khối và gửi các giao dịch bạn đã duyệt, cùng trang 0xNothing và chỉ mục công khai Goldsky để lấy dữ liệu token và thị trường. Chính sách quyền riêng tư nêu rõ mỗi bên nhận được gì.
```

Characters: 2228 (limit: not stated)

### Category

Choose **Tools**.

Reason: the store's current list (Accessibility, Art & Design, Communication, Developer Tools, Education, Entertainment, Functionality & UI, Games, Household, Just for Fun, News & Weather, Privacy & Security, Shopping, Social Media & Networking, Tools, Travel, Well-being, Workflow & Planning) has no finance or wallet category. "Tools" is defined as "Tools that don't fit into other categories". "Privacy & Security" (VPNs, password safes, phishing deterrence) was not chosen because the wallet's purpose is holding and using test assets, and the listing must not suggest a security promise.

### Language

English (the package's `default_locale` is `en`). Add Vietnamese as a localized listing with the Vietnamese description and the `localized-vi` screenshots. The other seven locales get the package summary only.

### Graphic assets

Follow `UPLOAD.md` in this folder: store icon `store-icon-128.png`, five screenshots per set (`global-en/` for all locales, `localized-vi/` for Vietnamese), small promo tile and marquee in `promo/`. The video field stays empty.

These images were remade from the 1.0.10 build on 2026-11-15 (`source/make-shots.mjs`): real captures of the extension with demo data, composed at 1280x800, in English and Vietnamese. The store asks that screenshots show the latest version's functionality, so upload these and remove the older ones from the listing. `v2/01-portfolio-1280x800.png` is an older draft and is not mapped in `UPLOAD.md`.

### Official URL

Leave empty unless the site is verified for your publisher account in Google Search Console.

### Homepage URL

```text
https://0xnothing.app
```

Characters: 21. Found in `apps/web/wrangler.jsonc` (route `0xnothing.app`, custom domain) and `docs/CLOUDFLARE_WORKERS.md`. The wallet code itself uses `https://0xnothing.xyz` (`src/config/dapps.ts`, `apps/web/lib/publicConfig.ts`); all three domains serve the app (see "Only the owner" item 2).

### Support URL

```text
https://0xnothing.app/docs
```

Characters: 26. The `/docs` route exists in `apps/web/app/docs`, and the wallet's Dapp tab links to it (`src/config/dapps.ts`). Other contact points the repository uses: `https://x.com/0xnothing_net` (`apps/web/app/page.tsx`) and `0xnothing.network@gmail.com` (`apps/web/app/privacy/page.tsx`).

### Mature content

Leave off.

## 3. Privacy practices

### Single purpose description

Limit: not stated on the official pages.

```text
0xWallet is a self-custody wallet for the LitVM LiteForge testnet. It creates and keeps the user's keys on the device, shows the user's test assets and history, and signs and sends the transactions and messages the user approves, both inside the wallet and when a website asks through the wallet provider.
```

Characters: 305 (limit: not stated)

### Permission justification: storage

```text
Saves the wallet on this device: the vault with the recovery phrase and imported keys, encrypted with the user's password (PBKDF2-SHA256, 600,000 iterations, AES-GCM-256); public account data, settings, custom networks and tokens, transaction history, saved recipients, site connections and the queue of site requests waiting for approval. chrome.storage.session holds the unlock key only while the wallet is unlocked. Both areas are limited to the extension's own pages and service worker, so content scripts cannot read them. Nothing is synced or uploaded.
```

Characters: 558 (limit: not stated)

### Permission justification: alarms

```text
The service worker uses three alarms. The auto-lock alarm removes the unlock key at the auto-lock deadline even when no wallet page is open. A 30-second keep-alive alarm runs only while a website request waits for approval, so the request is not lost when Chrome suspends the worker. Only when the user has turned on notifications and a transaction is pending, a 30-second alarm checks its receipt to show the result. Each alarm is cleared when it is no longer needed.
```

Characters: 468 (limit: not stated)

### Permission justification: idle

```text
The service worker listens to chrome.idle.onStateChanged only to lock the wallet: when the state becomes "locked" (the user locked the computer), it removes the unlock key from session storage. No idle time or activity is recorded or sent.
```

Characters: 239 (limit: not stated)

### Permission justification: sidePanel

```text
Lets the user open the wallet in Chrome's side panel from the account sheet. The panel shows the same wallet page as the popup (index.html?surface=panel) and stays open while the user works on a website.
```

Characters: 203 (limit: not stated)

### Permission justification: activeTab

```text
After the user clicks the toolbar icon (or presses the shortcut), the Dapp screen of the popup reads the address of the active tab once to show whether that site is connected to the wallet, with a button to revoke it. Only the origin (scheme and host) of http and https pages is used. It is not stored and not sent anywhere.
```

Characters: 324 (limit: not stated)

### Permission justification: notifications (optional permission)

```text
Optional. Chrome asks for it only when the user switches on Notifications in Settings. The wallet then shows a system notification when a transaction sent from this wallet confirms or fails, and when a website request waits for approval while the approval window is not in focus. A transaction notification shows the transaction's line from the wallet's History (for a transaction a website asked for, that is "Request from" and the site's host name) or a short transaction hash; the waiting notice names no site. A notification never holds a key or a recovery phrase. Switching the setting off or erasing the wallet removes the permission.
```

Characters: 640 (limit: not stated)

### Host permission justification

```text
Fixed hosts: rpc.testnet.liteforge.zeeve.net is the LitVM LiteForge testnet RPC, used to read balances and contracts and to send the transactions the user signed. 0xnothing.xyz (the project API) and api.goldsky.com (public indexes, its fallback) serve public token, pool and price data and token images for the Swap and Home screens; no wallet address is sent to them.
Optional https://*/* and local hosts: nothing is granted at install. Chrome asks inside the user's click, only when the user saves an RPC (custom network, own LiteForge RPC, or a network a site suggested and the user approved) or re-allows a saved one, and only for that RPC host (http only for loopback). The grant is removed when no saved network uses it.
Content scripts on all http and https pages and frames: they add the wallet provider (EIP-1193, EIP-6963) so any website can ask to connect, and relay those requests to the service worker. They do not read or change page content, forms or cookies.
```

Characters: 974 (limit: not stated)

### Remote code

Select: **No, I am not using remote code.**

Explanation for your own reference (the dashboard asks for a justification only when you answer Yes):

```text
All JavaScript is in the package. The extension pages' CSP is script-src 'self' with no unsafe-eval and no wasm-unsafe-eval. The code has no eval, no new Function and no WebAssembly. Network responses are parsed as JSON data or shown as images; they are never executed.
```

Characters: 269 (limit: not stated)

### Data usage: what to tick

The official pages show the category names and the certification text only in screenshots. The names below are the dashboard's as known; compare them with the live form and adapt if Google has renamed one. Under the user data FAQ, data that is only processed or stored on the device still has to be disclosed.

| Category | Tick | Reason |
|---|---|---|
| Personally identifiable information | No | The wallet asks for no name, email, postal address, phone or ID; wallet addresses are disclosed under Financial and payment information. |
| Health information | No | None handled. |
| Financial and payment information | Yes | Wallet addresses, balances, transactions and signed transactions are handled; addresses and signed transactions go to the RPC to read the chain and broadcast. To show the 24-hour change on Home, the 0xNothing API (or Goldsky) is asked for the price history of 0xPump tokens the account holds, by token contract address, never by wallet address. |
| Authentication information | Yes | The password, recovery phrase and private keys are handled and stored on the device in an encrypted vault; they are never sent. |
| Personal communications | No | No email, chat or messages are read; a message a site asks the user to sign is covered under Website content. |
| Location | No (owner decides) | The code reads no location; servers see the IP address of each request only as part of the connection. See "Only the owner" item 7. |
| Web history | Yes | The wallet stores the origins of sites the user connected and of sites that sent requests, and reads the active tab's origin when the popup opens (activeTab); kept on the device only. |
| User activity | No | No clicks, keystrokes, scrolling or network traffic of the user are monitored; in-wallet actions such as the last tab or swap pair stay on the device as settings. |
| Website content | Yes | Requests a website sends (transactions, messages and typed data to sign, token and network suggestions, page title) are stored in the local approval queue and shown to the user; not sent to the developer. Public read calls a website makes through the provider (for example eth_call, eth_getBalance) are forwarded to the active RPC, which is how every injected wallet answers them. |

### Data usage: the three certifications

Read and tick these yourself. The wording below is how the dashboard words them as far as known; it is not printed as text on the official pages, so confirm it on the form.

```text
I do not sell or transfer user data to third parties, outside of the approved use cases
```

```text
I do not use or transfer user data for purposes that are unrelated to my item's single purpose
```

```text
I do not use or transfer user data to determine creditworthiness or for lending purposes
```

What the code does that bears on them: nothing is sold; the only transfers are the requests needed for the wallet to work (RPC, the 0xNothing site API, Goldsky, image gateways); no analytics or advertising code; no creditworthiness use. The Limited Use policy also asks for an affirmative statement on a website of yours (see "Only the owner" item 1).

### Privacy policy URL

```text
https://0xnothing.app/privacy
```

Characters: 29. The page exists (`apps/web/app/privacy/page.tsx`, linked from the home page). Its text was updated for 1.0.10 in the repository; deploy the web app before you submit (see "Only the owner" item 1).

## 4. Distribution

- Payments: free. The code has no payment or subscription.
- Visibility: Public.
- Regions: All regions. The code has no region rule; it is a testnet wallet with test assets only.
- Note from the program policies: cryptocurrency products are not featured by the store, though they are allowed.

## 5. Test instructions

Limit: not stated. The tab is optional; it helps the reviewer reach every permission without an account.

```text
0xWallet is a self-custody wallet for the LitVM LiteForge TESTNET (chain ID 4441). All assets are test assets with no monetary value. No account or login is needed.

Create a wallet:
1. Click the 0xWallet toolbar icon (or press Alt+Shift+W).
2. Choose "Create a new wallet", write down the 12 words shown, and set a password of at least 8 characters.
3. On "Check your backup", give back the three words asked for. The Home screen opens on LitVM LiteForge with a zero balance.
A new wallet holds no test zkLTC, so sending is not possible without test funds; every screen can still be opened.

See each permission in use:
- storage: close the popup and open it again; the wallet is kept and asks for the password.
- alarms: Settings (button at the top of Home) > Security > Auto-lock: choose 1 minute, wait one minute with all wallet windows closed, reopen: the unlock screen shows.
- idle: unlock the wallet, lock the computer, sign in again and reopen the popup: the wallet is locked.
- sidePanel: tap the account at the top of Home, then "Side panel". The same sheet has "Open in tab" and "Lock now".
- Content scripts: open a website that supports injected EVM wallets (EIP-6963), for example https://0xnothing.app, and connect a wallet: 0xWallet is listed. The approval window opens and the toolbar badge shows 1 while the request waits.
- activeTab: after connecting, click the toolbar icon on that site and open the Dapp tab: "This site" shows the connection and a Revoke button.
- notifications (optional): Settings > Appearance > Notifications: On. Chrome asks for the permission.
- optional host permission: Settings > Custom networks > Add custom network, enter an HTTPS RPC URL and save: Chrome asks for access to that one host.
```

Characters: 1739 (limit: not stated)

## 6. Only the owner

1. Privacy policy. The public policy is at `https://0xnothing.app/privacy` (`apps/web/app/privacy/page.tsx`). The page in the repository was updated for 1.0.10 on 2026-11-15 and closes the gaps listed below; the live site keeps showing the version of August 30, 2026 until the web app is deployed. Deploy it before you submit. The gaps it closes:
   - Chrome permissions lists only storage, alarms and host access. Add idle (locks on computer lock), sidePanel, activeTab (reads the current tab's origin when the popup opens, not stored) and the optional notifications permission; alarms also run auto-lock and the transaction watch.
   - It does not say that the content scripts run on every http and https page and frame to expose the provider.
   - Network requests do not name the IPFS image gateways (dweb.link, ipfs.io, gateway.pinata.cloud, mypinata.cloud), the 0xNothing image proxy, the LiteForge RPC override, or that a website can make public read calls to the RPC through the provider.
   - Data handled misses saved recipient names, the token approval records, notification texts and shown ids, the requesting page's title, the 10-minute send draft, and the CSV export (a file saved by the user).
   - The Home screen asks the 0xNothing API (or Goldsky) for the price history of the 0xPump tokens the account holds, by token contract address; together with the request's IP address that tells the server which of those tokens a user holds. Say so.
   - A transaction notification for a website's transaction shows that site's host name ("Request from ..."), and notification texts are cached on the device.
   - A website can suggest a network; when the user approves it, its RPC receives the same requests as any custom RPC.
   - Locking: add the auto-lock default (15 minutes, choices 1 to 60) and the lock on computer lock.
   - Add the affirmative Limited Use sentence, for example: "The use of information received by 0xWallet complies with the Chrome Web Store User Data Policy, including the Limited Use requirements."
   - Add that test assets have no monetary value, and the new effective date.
2. Domain 0xnothing.xyz. The 1.0.10 code calls `https://0xnothing.xyz` for market data and token images, holds a host permission for it and marks it as an official site. Checked on 2026-11-15: 0xnothing.xyz, 0xnothing.app and 0xnothing.network all answer and serve the same market API behind the same Cloudflare nameservers. Keep all three domains renewed.
3. The nine summaries above are already in `public/_locales` and in the ZIP (applied on 2026-11-15). Read them once.
4. The screenshots and promo tiles were remade from the 1.0.10 build on 2026-11-15; upload the new files as `UPLOAD.md` maps them.
5. Confirm the category (Tools), the homepage URL and the support URL, and the publisher contact email on your account.
6. Read the data-usage table and tick the boxes and the three certifications yourself.
7. Location box: tick it if your 0xNothing site or Worker logs request IP addresses, since that API is yours; the extension code itself reads no location.
8. Decide whether reviewers get a funded throwaway testnet wallet; the repository has no faucet link. Never put a real recovery phrase in the test instructions.
9. The single purpose covers swap, mint, pool and 0xPoints screens as wallet features; you accept the review risk that a reviewer reads them as extra purposes.
10. Commit the 1.0.10 tree, then submit for review and publish. These are your actions.

## 7. What may lengthen the review

None of these is a policy breach; each is answered by the text above or needs only your awareness.

- Content scripts on every http and https page and frame: Chrome shows the "Read and change all your data on all websites" warning at install and the item is likely to get an in-depth review. There is no narrower option for an injected wallet provider; the host permission justification says what the scripts do and do not do.
- Optional `https://*/*`: it reads as all-site access although nothing is granted at install; the justification says it is asked per RPC host inside a click and released. Keep it out of `host_permissions`.
- Crypto wallet with swap, mint, pool and 0xPoints screens: crypto items are allowed but not featured; a reviewer may read the screens as more than one purpose (item 9). The testnet and no-value statements in the summary and description are the main answer.
- Minified code (Vite build, no source maps): minification is allowed, obfuscation is not; the reviewer may ask for source. Answer from the repository, never with secrets.
- Remote code: none (answer "No"). Remote data only (JSON and images); the CSP forbids eval.
- idle, activeTab, sidePanel, alarms and optional notifications are each used once for a narrow reason given in its justification.
- Until the web app is deployed, the live privacy policy does not cover 1.0.10 (item 1). That is the most likely reason for a rejection; deploy first.

## Official pages used

- https://developer.chrome.com/docs/webstore/cws-dashboard-privacy
- https://developer.chrome.com/docs/webstore/program-policies/user-data-faq
- https://developer.chrome.com/docs/webstore/program-policies/limited-use
- https://developer.chrome.com/docs/webstore/program-policies/policies
- https://developer.chrome.com/docs/webstore/program-policies/disclosure-requirements
- https://developer.chrome.com/docs/webstore/program-policies/quality-guidelines-faq
- https://developer.chrome.com/docs/webstore/cws-dashboard-listing
- https://developer.chrome.com/docs/webstore/best-listing
- https://developer.chrome.com/docs/webstore/best-practices
- https://developer.chrome.com/docs/extensions/reference/manifest/description
- https://developer.chrome.com/docs/webstore/cws-dashboard-distribution
- https://developer.chrome.com/docs/webstore/cws-dashboard-test-instructions
