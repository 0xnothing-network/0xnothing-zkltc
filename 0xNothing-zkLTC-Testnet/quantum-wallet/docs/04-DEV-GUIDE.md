# 04 — Dev Quick Guide (0xQuantum)

Hướng dẫn nhanh cho dev: chạy, test, sửa, và **những luật tuyệt đối không được phá**.
Đọc mục [Luật vàng](#luật-vàng-đọc-trước-khi-sửa-bất-cứ-dòng-nào) trước tiên — phần còn
lại là thao tác.

---

## 0. Trạng thái hiện tại

| Thành phần | Trạng thái | Vị trí |
|---|---|---|
| Contracts (Factory + Wallet + HashSig) | **đã deploy LiteForge** | `contracts/src/` |
| SDK TypeScript | xong | `sdk/src/` |
| Relayer (dev trả gas) | xong, chạy local | `relayer/src/` |
| Tích hợp extension | **xong** — route `quantum` trong ví | `apps/wallet/src/ui/screens/QuantumWallet.tsx` |

**Factory đã live:** `0xC23e270707B636101C4B43882dE38A840037BaCe` (chain 4441).

> ⛔ **KHÔNG chạy lại `forge script DeployFactory`.** Nó sẽ tạo factory **thứ hai** ở
> địa chỉ khác, và **mọi địa chỉ ví đã dự đoán từ factory cũ sẽ sai** — tiền của user
> nằm ở địa chỉ tính từ factory cũ. Deploy lại = mất dấu ví.

---

## 1. Chạy trong 3 lệnh

```bash
# 1) typecheck + build dist  (KHÔNG deploy lại — đúng như ý muốn)
cd quantum-wallet && bash build-dist.sh
#    Windows cmd/PowerShell: dùng build-dist.cmd (xem cảnh báo bên dưới)

# 2) bật relayer trả gas (cửa sổ terminal riêng, để nguyên)
cd quantum-wallet/relayer && npm start        # http://127.0.0.1:8787

# 3) nạp extension
# chrome://extensions -> Developer mode -> Load unpacked -> apps/wallet/dist
```

> ⚠️ **Windows: đừng gõ `bash build-dist.sh` trong cmd/PowerShell.** `bash` ở đó
> trỏ vào **WSL launcher** (`C:\Windows\System32\bash.exe`), mà WSL2 cần
> virtualization — máy chưa bật thì nó chết ngay:
> `HCS_E_HYPERV_NOT_INSTALLED`, script còn chưa được đọc.
> Dùng một trong hai:
> - `build-dist.cmd` (bản cmd.exe, cùng thư mục — **không** nạp `PRIVATE_KEY`
>   vào môi trường, chỉ đọc đúng dòng `QW_FACTORY=`), hoặc
> - Git Bash đầy đủ: `"C:\Program Files\Git\bin\bash.exe" build-dist.sh`
>
> Hoặc chạy tay, khỏi cần shell nào — `apps/wallet/.env.local` đã có sẵn factory:
> ```cmd
> cd apps\wallet
> npm run typecheck
> npm run build
> ```
> Sửa **manifest** thì không cần build lại: `dist/` là thứ Chrome đọc, và nội dung
> trong `dist/` được sinh từ `public/` — chỉ cần **Reload** ở `chrome://extensions`.

Kiểm tra relayer sống: `curl localhost:8787/health` → phải thấy `sponsor` khác `null`
(nếu `null` nghĩa là thiếu key → relayer chỉ simulate, không gửi tx thật).

### Biến môi trường

| File | Biến | Ý nghĩa |
|---|---|---|
| `quantum-wallet/.env.local` | `PRIVATE_KEY` | **Khoá dev** — vừa deploy factory vừa trả gas. **Bí mật tuyệt đối.** |
| `quantum-wallet/.env.local` | `QW_FACTORY` | Địa chỉ factory đã deploy |
| `apps/wallet/.env.local` | `VITE_QUANTUM_FACTORY` | `build-dist.sh` tự ghi từ `QW_FACTORY` |
| (tuỳ chọn) | `VITE_QUANTUM_RELAYER` | Trỏ ví sang relayer khác; mặc định `http://127.0.0.1:8787` |
| (tuỳ chọn) | `QW_RELAY_HUB` | Địa chỉ `QuantumRelayHub`. Relayer công bố nó ở `/health` để node DePIN tự phát hiện. Đặt sai = node được gửi tới contract không hoàn tiền cho ai |
| (tuỳ chọn) | `VITE_QUANTUM_RELAY_HUB` | Cùng địa chỉ, nhưng cho node trong extension. Thiếu = node **từ chối bật** |

Relayer nhận `QW_SPONSOR_KEY`, nhưng **chấp nhận `PRIVATE_KEY` làm alias** — nên không
cần nhân bản secret sang tên biến thứ hai (`relayer/src/config.ts:45`).

Hai biến hub là **optional có chủ ý**: hub deploy *sau* factory, nên `null` phải hợp lệ
ở mọi consumer. Xem [05-DEPIN §7](05-DEPIN.md) để biết thứ tự deploy.

---

## 2. Luật vàng (đọc trước khi sửa bất cứ dòng nào)

### 2.1 Một lá = một chữ ký. Vĩnh viễn.

Chữ ký WOTS là **one-time**. Ký **hai digest khác nhau trên cùng một leaf** sẽ lộ giá
trị chuỗi hash ở hai độ sâu cho mỗi chain → **ai cũng giả mạo được chữ ký thứ ba**.
Đây không phải "double-spend", đây là **mất khoá**.

Hệ quả bắt buộc, đã cài sẵn — **đừng gỡ**:

- Intent được **ghi xuống đĩa TRƯỚC khi** gửi cho relayer (`writePending`).
- Gửi lại = **POST lại đúng bytes cũ**, không bao giờ ký lại
  (`relayIntent`). Kể cả khi relayer trả lỗi, kể cả khi tx pending mãi.
- `writePending` **ném lỗi** nếu đã có intent khác đang treo — chứ không ghi đè.
- Mọi lần ký đều đi qua **một cửa duy nhất**: `claimSignedIntent()`
  ([account.ts](../../apps/wallet/src/core/quantum/account.ts)). Không gọi
  `signNext`/`executeIntent`/`rotateIntent` trực tiếp từ UI.

### 2.2 Vì sao op không có deadline ngắn

`OP_NO_EXPIRY = 0xffffffff` (năm 2106) là `validUntil` mặc định. Lý do: **digest có
commit `validUntil`**, nên nếu deadline hết hạn thì không thể ký lại với deadline mới
(sẽ là chữ ký thứ hai trên cùng leaf). Deadline ngắn = một lần relayer chết là **cháy
luôn một leaf**. Policy relayer miễn trừ đúng giá trị sentinel này
(`relayer/src/policy.ts`), các giá trị khác vẫn bị ép vào cửa sổ skew.

### 2.3 Leaf cuối cùng thuộc về `rotateRoot`

Contract: `RESERVED_ROTATE_LEAVES = 1`.

- `executeSigned` / `signMessage`: revert `TreeExhausted` khi `leafIndex >= 1023`
- `rotateRoot`: **được phép** tiêu leaf 1023

Nghĩa là cây 1024 lá → **1023 lần gửi tiền + 1 lần xoay khoá**. Client và relayer đều
mirror luật này (`EXECUTE_LEAF_LIMIT` trong `sdk/src/constants.ts`). Nếu bỏ mirror:
ví ký execute ở leaf 1023 → tx không bao giờ vào được → muốn thoát phải rotate → rotate
lại ký **lần hai** trên leaf 1023 → **lộ khoá**. Đây là bug đã được sửa; đừng tái tạo.

Trong UI có **hai** cờ khác nhau, đừng gộp lại thành một:

| Cờ | Nghĩa | Dùng cho |
|---|---|---|
| `canSign` | đã deploy + không có intent treo | nút **Rotate** |
| `ready` | `canSign` **và** cây còn leaf để execute | form **Send** |

Gộp hai cờ = khi hết leaf sẽ **khoá luôn nút rotate**, tức là khoá đúng cái nút mà màn
hình đang bảo user bấm → ví kẹt cứng.

### 2.4 Xoay khoá không đổi địa chỉ

Địa chỉ = CREATE2 salt theo root **epoch 0**. Rotate chỉ đổi `merkleRoot` bên trong
contract. Nhưng: sau khi rotate, `entropyHex` trên đĩa là secret **mới**, mà root của nó
**không phải** salt → **không còn tính lại địa chỉ từ secret được nữa**. Vì vậy địa chỉ
được **lưu thẳng** vào record (`QuantumStored.address`). Đừng xoá field đó.

Khi rotate, secret kế nhiệm được **gửi kèm intent** (`successorEntropyHex`) để nếu
rotation lên chain lúc popup đã đóng, ví vẫn nhận được secret mới thay vì kẹt với cây
đã nghỉ hưu.

### 2.5 Route gốc `#/` = ví quantum. Đừng để nó trỏ về Home.

Extension mở ở `index.html` **không có hash**, nên `parseHash("")` quyết định màn
hình đầu tiên. `DEFAULT_ROUTE = "quantum"` trong `ui/router.ts` khiến mở ví là vào
thẳng ví quantum. Ví HD cũ **không mất** — vẫn ở `#/home`.

Ba chỗ phải giữ nhất quán, sai một chỗ là hỏng nút Back:

| Chỗ | Giá trị đúng | Nếu sai |
|---|---|---|
| `parseHash` fallback | `DEFAULT_ROUTE` (quantum) | mở ví ra Home như cũ |
| `goHome()` | `navigate("#/home")` | **nút Back trong chính ví quantum thành nút chết** — `#/` lại resolve về quantum nên nó quay về đúng màn hình đang đứng |
| `BottomNav` item `home` | `path: "#/home"` | bấm tab **Home** lại mở ví quantum |

Đây là lý do `goHome()` **không** được viết `navigate("#/")` nữa. Muốn đổi mặc định
về Home thì sửa đúng một dòng `DEFAULT_ROUTE` — nhưng khi đó `#/` và `#/home` lại
trùng nhau, và tab Home phải đổi ngược về `#/`.

---

## 3. Bản đồ code

```
quantum-wallet/
├─ contracts/src/QuantumWallet.sol      # nguồn sự thật. Mọi hằng số phải khớp file này
├─ sdk/src/
│   ├─ constants.ts                     # TREE_N, RESERVED_ROTATE_LEAVES, domain bytes
│   ├─ wots.ts / merkle.ts / signer.ts  # chữ ký một lần + cây Merkle
│   ├─ digest.ts                        # digest op / rotate / message
│   ├─ wallet.ts                        # QuantumAccount + OP_NO_EXPIRY
│   └─ icons.ts                         # codec 24 icon <-> 32 byte entropy
├─ relayer/src/
│   ├─ policy.ts                        # validate thuần, không I/O  <- test ở đây
│   └─ server.ts                        # rate limit, simulate, broadcast tuần tự
└─ docs/                                # 01-DESIGN, 02-THREAT-MODEL, 03-ROADMAP, file này

apps/wallet/src/core/quantum/
├─ account.ts    # claimSignedIntent  <- CỬA DUY NHẤT để tạo chữ ký
├─ storage.ts    # record trong vault (mã hoá) + withSignLock (Web Locks)
├─ client.ts     # gọi relayer
└─ config.ts     # factory / relayer URL

apps/wallet/src/ui/screens/QuantumWallet.tsx   # màn hình ví
```

---

## 4. Luồng hoạt động

### Tạo ví
1. `newSecret()` → 32 byte CSPRNG + chuỗi 24 icon (đây là **backup duy nhất**).
2. `createQuantum()` dự đoán địa chỉ CREATE2 từ root epoch-0.
3. **Lưu secret ngay lúc này** — địa chỉ có thể nhận tiền **trước khi** contract được
   deploy, nên mất secret ở bước này là mất tiền.
4. Activate → relayer deploy contract (user trả 0 gas).

### Gửi tiền
1. Form submit → mở sheet review (**chưa ký gì cả**).
2. Bấm xác nhận → `claimSignedIntent("execute", …)`:
   - vào `withSignLock` (mutex giữa các cửa sổ extension)
   - đọc lại **state trên chain** + **đĩa** ngay tại thời điểm ký (bỏ qua React state cũ)
   - từ chối nếu: chưa deploy / sai epoch / đang có intent treo / cursor lệch / hết leaf
   - ký → **ghi đĩa** → mới trả về
3. POST cho relayer → relayer simulate → broadcast → đợi receipt.
4. Relayer lỗi? Intent **vẫn treo**, poll 4s/lần tự gửi lại **đúng bytes đó**.

### Xoay khoá
Giống hệt, nhưng `kind = "rotate"` và được phép dùng leaf 1023.

---

## 5. Test

```bash
cd quantum-wallet/relayer && npm test        # policy + rate limit, chạy ở đâu cũng được
cd quantum-wallet/sdk     && npm test        # vector WOTS/Merkle
cd quantum-wallet/sdk     && npm run vectors # sinh lại vector (khi đổi crypto)
cd quantum-wallet/contracts && forge test    # contract

# e2e thật (cần anvil):
cd quantum-wallet/relayer
node --import ../nodehooks.mjs --experimental-strip-types test/e2e.ts
```

> ⚠️ `npm start` và `npm test` chạy bằng `--experimental-strip-types`: Node **xoá type
> chứ không kiểm tra**. Một lỗi import trên đường khởi động (ví dụ dùng `dirname` mà
> quên import) sẽ **lọt qua toàn bộ test** và chỉ nổ khi bật server thật.
> **`npm run typecheck` là thứ duy nhất bắt được lỗi đó** — `build-dist.sh` đã bao gồm.

Sau khi sửa `wots.ts` / `crypto.ts` / `merkle.ts`: **bắt buộc** chạy `npm run vectors`
+ `forge test`. Chỉ cần lệch một byte giữa TS và Solidity là **mọi chữ ký hỏng**.

---

## 6. Gỡ lỗi nhanh

| Triệu chứng | Nguyên nhân thường gặp | Cách xử lý |
|---|---|---|
| `relayer unreachable at http://127.0.0.1:8787: Failed to fetch` | **1)** relayer chưa chạy — 90% các ca; **2)** Chrome chặn vì thiếu host permission / Private Network Access | `curl localhost:8787/health` trước (xem mục dưới) |
| `sponsor: null` ở `/health` | thiếu `PRIVATE_KEY`/`QW_SPONSOR_KEY` | kiểm tra `.env.local`, restart relayer |
| `simulation failed: …` | intent sẽ revert | đọc revert đã decode; **không** ký lại |
| Ví báo "đang có thao tác chờ" | intent treo chưa lên chain | để poll tự retry; **không** xoá storage |
| `leafDiverged` | mất record pending nhưng cursor đã tiến | khôi phục bằng 24 icon + địa chỉ |
| `leafExhausted` | hết 1023 leaf | Rotate secret (miễn phí, giữ nguyên địa chỉ) |
| Địa chỉ ví "sai" sau khi deploy lại factory | đã chạy `DeployFactory` lần hai | dùng lại factory cũ trong `.env.local` |

Xem state trên chain: đọc `epoch`, `leafIndex`, `merkleRoot`, `nonce` qua
`readWalletState()` (`sdk/src/reads.ts`).

### 6.1 `Failed to fetch` — chẩn đoán theo thứ tự

Lỗi này **cố tình mơ hồ**: trình duyệt ném cùng một `TypeError` cho "không có gì
lắng nghe ở cổng đó" và "có server nhưng bị chặn". `client.ts` bắt nó và báo
`relayer unreachable`. Đừng đoán — chạy hai lệnh sau theo thứ tự:

```bash
# (1) Relayer có sống không?  -> nếu KHÔNG có output: đây là nguyên nhân.
curl -i localhost:8787/health
#     -> đây là ca phổ biến nhất. Bật relayer:
#        cd quantum-wallet/relayer && npm start

# (2) Nếu (1) trả về JSON mà ví vẫn báo Failed to fetch -> trình duyệt đang chặn.
#     Kiểm tra preflight có header private-network không:
curl -i -X OPTIONS localhost:8787/relay \
  -H "Origin: chrome-extension://abc" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: content-type"
#     -> phải thấy access-control-allow-private-network: true
```

Nếu (1) sống mà (2) đủ header, kiểm tra **host permission** của extension:

- `http://127.0.0.1/*` phải nằm trong **`host_permissions`** của
  `apps/wallet/public/manifest.json` — **không phải** `optional_host_permissions`.
- Optional host permission **không được cấp tự động**; muốn có thì phải gọi
  `chrome.permissions.request()` từ một thao tác người dùng. Ví này **không** làm
  điều đó cho relayer (hàm `requestRpcPermission` trong `Settings.tsx` chỉ dùng cho
  RPC do người dùng tự thêm), nên để nó ở dạng optional = **chắc chắn không có
  quyền**.
- Sửa manifest xong phải **build lại** (`bash build-dist.sh`) rồi vào
  `chrome://extensions` bấm **Reload** — Chrome đọc `dist/manifest.json`, không
  đọc `public/`.
- Trong `chrome://extensions` → Details, mục **Site access** phải thấy
  `http://127.0.0.1/*` được cấp.

> Lý do kỹ thuật: extension page (popup) gọi `fetch()` tới `127.0.0.1` là request
> xuyên origin. Có host permission thì Chrome bỏ qua cả CORS **và** Private Network
> Access; không có thì phụ thuộc vào header của server. Cấp thẳng trong manifest
> đơn giản hơn và khớp với cách các RPC endpoint (`liteforge.rpc.caldera.xyz`) đã
> được khai báo. `https://*/*` vẫn để optional vì đó mới là ca thật sự tuỳ ý.

---

## 7. Việc còn lại trước khi lên production

1. ~~Secret nằm plaintext trong `chrome.storage.local`~~ — **đã xong**: record 0xQuantum
   giờ nằm **trong vault AES-GCM**, cùng chỗ với seed phrase
   (`core/keyring/vault.ts` → `writeVaultQuantum`). Ba hệ quả cần nhớ:

   - **Đọc record cần vault đã mở khoá.** Không sao: phase gate ở `App.tsx` chặn mọi
     screen khi vault đóng, nên không có đường nào tới `readQuantum()` lúc khoá.
   - **`writeVaultQuantum` KHÔNG được đổi salt.** Nó ghi lại vault chỉ bằng *session
     key* (password đã bị xoá khỏi bộ nhớ sau khi unlock), nên phải tái dùng
     `salt` + `iterations` của blob cũ. Tạo salt mới ở đây = `keyForBlob(blob, password)`
     lần unlock sau trả **sai khoá** = **mất luôn ví chính**. Xem comment ở
     `keyring/crypto.ts` → `encryptWithKey`.
   - Vault cũ ghi bằng bản chưa mã hoá vẫn đọc được: `readQuantum()` migrate một lần
     rồi xoá slot plaintext (idempotent).
2. Relayer đang chạy local `127.0.0.1:8787` — production cần host + HTTPS + rate limit
   theo IP (hiện rate limit theo địa chỉ ví).
3. Chuỗi icon chưa có bản dịch i18n — màn hình quantum hiện chỉ có tiếng Anh
   (mọi locale đều fallback về `EN`).
4. `pending` (intent đã ký, chưa lên chain) **cũng** nằm trong vault, mà vault giới hạn
   1 MB ciphertext (`crypto.ts` → `MAX_CIPHERTEXT_BYTES`). Vault thường chỉ vài KB
   (tối đa 100 account nhập tay) nên còn rất xa ngưỡng, nhưng đừng nhồi thêm dữ liệu
   lớn vào record này.
