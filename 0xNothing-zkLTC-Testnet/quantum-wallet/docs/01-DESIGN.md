# 01 — Thiết kế chi tiết: 0xQuantum Wallet

> Ngôn ngữ: tiếng Việt, thuật ngữ kỹ thuật giữ nguyên tiếng Anh.
> Codebase tham chiếu: `0xNothing-zkLTC-Testnet/apps/wallet`, `contracts`, `apps/web`.

---

## 1. Đối chiếu yêu cầu → cơ chế

| # | Yêu cầu của bạn | Cơ chế trong thiết kế này |
|---|---|---|
| 1 | Ví chạy trên **contract** | Smart-contract wallet = proxy EIP-1167 tới core bất biến (immutable), deploy qua **CREATE2**. Tài sản nằm ở **địa chỉ contract**, không nằm ở bất kỳ khoá EOA nào. |
| 2 | User **không tốn gas**, dev tài trợ | Mọi lệnh ra ngoài là **meta-transaction**: user ký intent EIP-712 ở client; một **sponsor relayer** của dev (giữ EOA cấp vốn) gửi giao dịch lên chuỗi và trả gas. Xem §7. |
| 3 | **Chỉ cần có zkLTC trong tài khoản** | Điều kiện **policy phía relayer** (chống spam): ví (địa chỉ contract) phải có số dư zkLTC > 0 trước khi relayer nhận relay; riêng fee/đơn vị gas do dev trả. Không có ràng buộc gas on-chain nào cho user. |
| 4 | User **chỉ cần ký** | Client chỉ: (a) đọc số dư/quotes, (b) **ký intent** bằng khoá chữ ký, (c) gửi intent cho relayer. Relayer lo phần còn lại (broadcast + theo dõi receipt). |
| 5 | **Gửi được bất kỳ token nào** | Hợp đồng có `execute(call[])` đa năng + `executeBatch`. Token ERC-20 gửi qua `execute` gọi `token.transfer(to, amount)` với `msg.sender == wallet contract` (chính là chủ token) → chuẩn cho mọi ERC-20. Native zkLTC gửi qua `value`. Swap/pump/nft cũng chỉ là các `call` đi qua. |
| 6 | Có **mật khẩu hoặc private key mã hoá**, nén/icon/ký tự gõ được để **kháng lượng tử** | "Mật khẩu" = **secret entropy cao sinh ngẫu nhiên** được mã hoá thành chuỗi **icon/emoji/unicode + checksum** (kiểu BIP-39 nhưng là biểu tượng). Khoá/cây khoá và mọi bí mật **dẫn xuất từ secret**; trên đĩa/trên mạng chỉ tồn tại **ciphertext** (AES-GCM) do key dẫn xuất từ secret mã hoá. Secret KHÔNG bao giờ lên chuỗi dạng rõ. |
| 7 | **Xoay mật khẩu/private key không đổi ví** | Vì tài sản ở địa chỉ contract và quyền ký là **state on-chain** (root của cây khoá + epoch), xoay khoá = 1 intent `rotateKey(newRoot)` — **địa chỉ ví giữ nguyên**. Đổi secret mới cũng chỉ là sinh cây mới + xoay. |
| 8 | **Tối ưu nhất cho kháng lượng tử** | Ở chế độ quantum: khoá chữ ký là **hash-based (Merkle–Winternitz)** — xác minh chỉ dùng `keccak256`, **không ECDSA trong đường bảo mật**. Chữ ký ECDSA bị máy tính lượng tử phá bằng Shor; hash thì không (chỉ Grover làm giảm ~một nửa). Xem §3 & §5. |
| 9 | **Ví contract giao dịch/dùng như ví thường** | Địa chỉ contract dùng để **nhận** (kể cả trước khi deploy — counterfactual), **gửi**, và **ký** qua **EIP-1271** (`isValidSignature`) để các dApp/exchange chấp nhận như tài khoản thường. |
| 10 | **Tích hợp vào ví + nút chọn "di chuyển sang kháng lượng tử / ví bảo mật"** | Settings → panel **"Bảo mật lượng tử"** hướng dẫn tạo secret → deploy (sponsored) → chuyển account active của dApp về địa chỉ proxy. Chi tiết §9. |
| 11 | **Build trong folder riêng** | Toàn bộ code mới nằm trong `quantum-wallet/`. Tích hợp vào ví cũ là các **patch có kiểm soát**, liệt kê rõ ở phase 4. |

---

## 2. Bối cảnh codebase (cái đang có)

Đã khảo sát kỹ (ghi nguồn file:line):

- **Chain:** LitVM LiteForge Testnet — Caldera rollup, **EVM**, `chainId 4441`, native **zkLTC** (18 decimals). RPC `https://liteforge.rpc.caldera.xyz/infra-partner-http`. Không có bằng chứng về ERC-4337 bundler/paymaster hệ thống sẵn → phải tự làm meta-transaction. Nguồn: `apps/wallet/src/config/chain.ts`, `apps/wallet/src/config/networks.ts`, `config/networks/liteforge-testnet.json`.
- **Ví hiện tại = keyring ECDSA.** Vault duy nhất AES-GCM-256 (PBKDF2-SHA256 600k) chứa `{ mnemonic, imported[] }`; tài khoản HD `mnemonicToAccount` (secp256k1). Mọi giao dịch gửi qua `walletClientFor(...).sendTransaction` — **user trả gas**, không relayer. Nguồn: `apps/wallet/src/core/keyring/vault.ts`, `crypto.ts`, `core/services/tx.ts`, `core/rpc/client.ts`.
- **Tài khoản** hiện chỉ có `source: "hd" | "imported"` (`AccountMeta`). Muốn thêm loại "smart/quantum" phải mở rộng mô hình này mà **không phá** dữ liệu cũ (`readAccounts` validate nghiêm ngặt). Nguồn: `vault.ts:63-73,293-330`.
- **Cầu nối dApp:** approval window ký, worker không giữ key. `eth_sendTransaction`, `personal_sign`, `signTypedData_v4` đi qua `askUser(...)`. Nguồn: `apps/wallet/src/extension/background.ts`, `core/services/dapp.ts`.
- **UI:** hash-router (`router.ts`), Settings đã có panel ImportAccount/ChangePassword/RevealSecrets/DangerZone → vị trí đặt panel mới.
- **Contract cũ:** Foundry (`contracts/`), đã deploy NUSD/OracleNUSD (ERC-20 đồng thời là module mint/redeem), PumpToken/ZeroXPump, 0xFi pool, DEX router/factory. Địa chỉ testnet: `apps/wallet/src/config/contracts.ts`, manifest `deployments/liteforge-testnet/deployments.json`. Những token này là **đối tượng để ví gửi thử**.
- **Backend:** `apps/web` là Next.js (deploy Railway), có API routes + `features/pump/server` → **nơi đặt relayer** (hoặc worker riêng). Voucher EIP-712 server-side đã từng được dùng trong dự án (`pointsVoucher.ts`, xem `docs/SECURITY.md`) → có tiền lệ ký/relay phía server.
- **Chưa có sẵn:** bất kỳ hạ tầng account-abstraction / paymaster / meta-tx / post-quantum nào (grep toàn repo = rỗng). Đây là greenfield.

---

## 3. Sự thật mật mã về "kháng lượng tử trên EVM" (đọc kỹ)

Để thiết kế **trung thực**, phải phân biệt rõ cái gì lượng tử phá được và không:

| Nguyên lý | Trạng thái trước máy tính lượng tử (QTM) |
|---|---|
| **ECDSA / secp256k1** (mọi ví EVM hiện tại) | **Phá** — thuật toán **Shor** giải discrete log từ public key. Entropy khoá 256-bit không giúp gì. Mọi EOA hiện hữu đều "không kháng lượng tử". |
| RSA / lattice / pairing | Shor / tấn công cấu trúc → phá. |
| **Hash** (keccak256, SHA-256, SHA-3) | **Chỉ Grover**, làm tiền ảnh ~một nửa: preimage 256-bit còn ~128-bit an toàn → vẫn an toàn thực dụng. |
| **Chữ ký hash-based** (Lamport / Winternitz / Merkle) | **Kháng lượng tử** — xác minh chỉ bằng hash. |
| ZK (STARK/SNARK) | Kháng lượng tử *nếu* dùng hash thân thiện PQ (keccak/poseidon) — nhưng chi phí verifier trên EVM còn nặng. |

Hệ quả thực dụng cho EVM:

1. **Không thể "làm ECDSA kháng lượng tử" bằng cách tăng entropy hay đổi biểu diễn khoá.** Khoá chữ ký phải chuyển sang **hash-based signature** nếu muốn thật sự kháng QTM.
2. Trên EVM, xác minh hash-based là khả thi và rẻ: `keccak256` là native (~30–37 gas/hash 32B). **Chữ ký Winternitz–Merkle**: kích thước ~2.5 KB, gas verify ~ chục nghìn gas → phù hợp mô hình sponsor testnet.
3. Chữ ký hash-based **một lần dùng (one-time)**: ký 2 thông điệp cùng một khoá = lộ secret. Giải pháp chuẩn là **cây Merkle**: mỗi `execute` tiêu 1 lá, xác minh qua đường auth-path về **root** lưu trên chuỗi. Hết cây (hoặc chủ động) → **xoay root** (đổi epoch) — chính là "xoay khoá không đổi ví".
4. **Password con người thì không đủ entropy** dù có dùng icon. Bí mật phải được **sinh ngẫu nhiên** (~200+ bit) rồi *mã hoá hiển thị* thành icon cho dễ gõ/lưu — không phải để người dùng *tự chọn*. Icon chỉ là **biểu diễn**, entropy đến từ random.

**Quy tắc vàng của thiết kế:** *secret/icon-chuỗi không bao giờ trực tiếp uỷ quyền on-chain* (vì không thể chứng minh biết preimage trên chuỗi công khai mà không để lộ nó). Secret là: (a) **seed sinh mọi khoá chữ ký**, (b) **yếu tố mã hoá** khoá ở rest, (c) **cơ chế khôi phục**. Uỷ quyền on-chain do **khoá chữ ký hash-based** (dẫn xuất từ secret) đảm nhiệm.

---

## 4. Kiến trúc tổng thể

```
                        ┌────────────────────────────────────────────┐
  User (extension/web)  │  apps/wallet UI ── sdk/0xQuantum           │
                        │  • tạo/khôi phục secret icon (client-only) │
                        │  • cây khoá Merkle–Winternitz              │
                        │  • ký intent EIP-712 (WalletOp)            │
                        └──────────────┬─────────────────────────────┘
                                       │ intent đã ký (không chứa secret)
                                       ▼
                        ┌────────────────────────────────────────────┐
   Sponsor (dev)        │  relayer (Next/Worker) — giữ EOA cấp vốn   │
                        │  • policy: ví có zkLTC, daily cap, anti-spam│
                        │  • deploy CREATE2 lần đầu (sponsored)       │
                        │  • gửi executeSigned + trả gas             │
                        └──────────────┬─────────────────────────────┘
                                       ▼  eth_sendRawTransaction
   Chain                ┌────────────────────────────────────────────┐
   LitVM LiteForge      │  QuantumWalletFactory (CREATE2)             │
   (chainId 4441)       │  QuantumWalletCore (immutable logic)        │
                        │     - root cây Merkle + epoch + leafIndex   │
                        │     - execute / executeSigned / rotateKey   │
                        │     - EIP-1271 isValidSignature             │
                        └────────────────────────────────────────────┘
```

### Các khối

| Khối | Nhiệm vụ | Nằm ở |
|---|---|---|
| `contracts/` | Factory + Core wallet bất biến + thư viện verify WOTS/Merkle | folder mới (Foundry) |
| `sdk/` | Sinh/khôi phục secret icon; sinh cây khoá; ký WOTS; build & gửi intent; đọc số dư | folder mới (TS, dùng WebCrypto) |
| `relayer/` | Nhận intent đã ký, validate, trả gas | server (Next route hoặc worker riêng) |
| `extension/` | Patch tích hợp vào `apps/wallet` | riêng, có kiểm soát |

---

## 5. Vật liệu mật mã (đặc tả tham số)

### 5.1 Secret dạng icon (backup/password kháng lượng tử)

- **Nguồn entropy:** `crypto.getRandomValues` lấy `E` byte ngẫu nhiên. Mức mặc định đề xuất **32 byte = 256 bit**.
- **Biểu diễn icon:** chọn một **từ điển cố định** gồm `D` mã Unicode **gõ được** (emoji phổ biến + các block unicode + không dùng ký tự gây nhầm lẫn: không space/control/zero-width). Chọn `D = 2^11 = 2048` → mỗi icon mang **11 bit**. 24 icon ⇒ **264 bit** payload (đủ bù checksum + an toàn dư). Số icon cố định `M`.
- **Checksum:** `checksum = SHA-256(E)[0:11bit]` nối vào payload → chọn `M = ceil((256+11)/11) = 25` icon. Nhập sai 1 icon ⇒ checksum trượt ⇒ từ chối ngay (không cần mạng).
- **Normalization:** nhập lại dùng **NFKC** (emoji không bị NFKC phá, nhưng phòng chữ tương đương), trim, bỏ ký tự ẩn, so sánh canonical. Luôn có bước **"xác nhận lại secret"** khi tạo.
- **Khoá từ secret:** `sk = HKDF-SHA256(IKM = NFKC(secret), salt = random 16B lưu kèm ciphertext, info = "0xQ-v1:wrap", len 32)`. Phòng **offline brute-force**: kết hợp thêm vòng lặp công sức (tương tự PBKDF2, ví dụ 200k vòng SHA-256) — nhưng vì entropy đã 256 bit, đây là phòng thủ tầng 2, không phải chỗ dựa chính.
- **Ciphertext ở rest:** secret **không** được lưu; chỉ lưu khối `AES-GCM-256(sk, salt, iv)` chứa *các bí mật dẫn xuất* (seed cây epoch hiện tại, epoch, leafIndex, frontier, …). Cách này nhất quán với vault AES-GCM đang có của ví (`core/keyring/crypto.ts`) — tái dùng cùng kỹ thuật, module riêng.

> Lưu ý trung thực: emoji có thể **không hiển thị/khác phông** giữa thiết bị. Bản build phải dùng **mã codepoint** làm canonical (không phải hình vẽ), kiểm thử cross-font, và UI luôn hiện codepoint hex bên cạnh icon để người dùng đối chiếu khi lạ thiết bị.

### 5.2 Khoá chữ ký hash-based (Merkle–Winternitz)

Đây là **trái tim kháng lượng tử**. Tham số (sẽ khoá bằng reference vectors trong build):

| Tham số | Giá trị | Ghi chú |
|---|---|---|
| Hash | `keccak256`, n = 32 B | Native trên EVM, xác minh rẻ |
| Message digest | 256 bit (EIP-712 digest) | Đầu vào cố định 32 B |
| Winternitz `w` | 4 bit/chunk | len1 = 64 |
| Checksum chunks | 3 (len2) | `len2 = floor(log_16(64·15)) + 1 = 3` |
| **len tổng** | **67** | sig = 67 giá trị × 32 B |
| **Độ dài chữ ký WOTS** | **2 144 B** | calldata |
| Chiều cao cây Merkle `H` | **12** → 4 096 lá | 1 lá/op; tự xoay ở 90% |
| **Tổng chữ ký (WOTS + auth path)** | ≈ 2 144 + 12×32 = **2 528 B** | |
| Root on-chain | `bytes32` | lưu 1 slot |
| Verify gas ước tính | ~ 500 keccak + calldata ≈ **< 150k gas/op** | đủ rẻ để sponsor testnet |
| Phòng QTM | preimage 256 bit ⇒ Grover ~2^128 | chấp nhận (an toàn thực dụng) |

**Nguyên lý vận hành:**
- Secret key của WOTS lá `i` = **dẫn xuất xác định** từ seed epoch bằng PRF/HMAC: `sk_{i,j} = HMAC(seedEpoch, i ‖ j)`. → Không lưu 4096×67 bí mật (~8 MB); chỉ lưu **seed 32 B**.
- Xây cây **tuần tự (streaming)**, giữ **frontier O(H)** (Merkle tree builder kiểu binary-counter): mỗi lá mới tốn ~H hash khi hoàn tất subtree; mỗi lần ký lấy auth path O(H). Bộ nhớ ~vài trăm byte.
- **Kỷ luật một lần dùng:** hợp đồng giữ `leafIndex`; **chỉ chấp nhận đúng lá tuần tự kế tiếp** (không cho chọn lá tự do) → chống reuse tuyệt đối, trạng thái tối thiểu (1 uint). Khách ký ở 90% cây thì chủ động `rotateKey`.
- **Epoch:** seed mỗi cây = `KDF(S, "0xQ-v1:tree", epoch)`. Xoay = tăng epoch + build cây mới. Nếu mất thiết bị, nhập lại secret ⇒ **tái sinh đúng cây epoch hiện tại** → khôi phục mà không cần snapshot nào từ máy cũ.

### 5.3 Intent / WalletOp (EIP-712)

```solidity
struct Call {
    address to;      // token/native/contract đích
    uint256 value;   // native wei (zkLTC)
    bytes data;      // calldata (vd ERC20.transfer calldata)
}

struct WalletOp {
    address wallet;      // địa chỉ contract wallet (phòng chuyển intent sang ví khác)
    uint64  epoch;       // epoch cây khoá ký intent này
    uint256 leafIndex;   // lá dùng để ký (phải = leafIndex hiện tại của contract)
    uint256 nonce;       // chống replay, khớp nonce trong contract
    uint256 validUntil;  // deadline (block.timestamp), mặc định +10 phút
    bytes32 digest;      // keccak256(abi.encode(calls, chainId, wallet, nonce, validUntil))
    Call[]  calls;       // 1..N lệnh (native, ERC-20, swap, pump, nft…)
}
```

- **Domain:** `{ name: "0xQuantumWallet", version: "1", chainId: 4441, verifyingContract: wallet }`.
- Client tính `digest`, ký digest bằng **WOTS** (tách 256 bit thành 64 nibble + checksum), đóng gói `Sig { epoch, leafIndex, wotsValues[67], authPath[12] }`.
- Ký lại bằng ECDSA **không tồn tại** ở chế độ quantum (xem §5.4).

### 5.4 Có nên giữ thêm ECDSA "tiện lợi" không?

- **Không khuyến nghị trong chế độ quantum mặc định.** Một authorizer ECDSA có quyền chuyển tiền sẽ **phá vỡ toàn bộ tuyên bố kháng lượng tử** (QTM chỉ cần phá 1 trong các đường). Cây WOTS có thể được **ký tự động** ở client mà user không thấy khác biệt — vì thế không cần ECDSA.
- Tuỳ chọn **"chế độ lai (hybrid)"** dành riêng khi cần tương tác dApp đời cũ đòi EOA thật sự — nhưng **không** phải mặc định và cảnh báo rõ giảm bảo mật.

---

## 6. Hợp đồng thông minh (đặc tả)

### 6.1 Deploy & địa chỉ (counterfactual)

> **AMENDMENT (quyết định khi build, thay thế mục cũ):** dùng **full-contract-per-wallet** qua CREATE2, **không** dùng proxy EIP-1167 + core immutable.
> Lý do: bỏ được delegatecall (mọi `msg.sender`/storage-context footgun) và bỏ race "deploy proxy trước khi core sẵn sàng / init lỗi mất proxy". Mỗi ví là **một hợp đồng độc lập**, tự chứa toàn bộ state + logic verify. Địa chỉ vẫn là CREATE2 xác định từ client, counterfactual y nguyên. Chi phí deploy một lần (sponsored) cao hơn proxy clone một chút — chấp nhận được trên testnet; phần logic dùng chung nằm trong `library HashSig` (code được `delegatecall`-free, nội tuyến vào từng ví). Không có admin, không upgrade: xoay khoá = `rotateRoot` (đổi merkle root/epoch), địa chỉ không đổi.

- Mỗi ví = **hợp đồng đầy đủ** deploy qua factory. Địa chỉ:
  `address = CREATE2(factory, salt, keccak256(initCode))`
  với `salt = keccak256("0xQ-salt-v1" ‖ chainId ‖ commitment)` và `commitment = keccak256(canonical init state: root0 ‖ epoch0 ‖ config)`.
- **Nhận tiền trước khi deploy:** địa chỉ CREATE2 là xác định từ client (chỉ cần secret phía user). Ai cũng gửi zkLTC/ERC-20 tới đó được. Trước khi deploy không có code → không ai rút được. Kích hoạt = lần **gửi** đầu tiên, relayer deploy (sponsored).
- **Chống front-run deploy:** kẻ tấn công chỉ chiếm được địa chỉ nếu dựng **đúng (salt, initCode)** = phải biết `commitment` (bắt nguồn từ secret). Chưa deploy thì salt **không tồn tại on-chain**. Deploy bằng initCode lạ ⇒ địa chỉ khác ⇒ vô hại. Ngoài ra initData còn gắn `root0` — không thể giả mạo.

### 6.2 State on-chain (tối thiểu)

```
uint256 nonce;            // replay protection cho WalletOp
uint256 epoch;            // epoch cây Merkle hiện tại
bytes32 merkleRoot;       // root cây epoch
uint256 leafIndex;        // lá kế tiếp được phép (tăng tuần tự)
mapping(bytes4=>bool) support;  // EIP-1271 magic-value cache (tuỳ chọn)
address guardian;         // [tuỳ chọn, mặc định 0] tài khoản khôi phục khẩn cấp 2-chữ-ký
uint256 rotationDelay;    // timelock xoay root/guardian (mặc định 0 trong testnet dev, >0 khi mainnet)
```

Không lưu secret, không lưu khoá dài hạn nào ngoài `merkleRoot` (public key của cây).

### 6.3 Bề mặt hàm (signatures mục tiêu)

```solidity
interface IQuantumWallet {
    // Meta-path: relayer gọi, trả gas; contract xác thực người ký = owner thật sự.
    function executeSigned(WalletOp calldata op, WotsSig calldata sig) external;

    // Uỷ quyền on-chain thuần (guardian/ECDSA-legacy, khi bật lai):
    function executeFrom(address executor, Call[] calldata calls) external;

    // Xoay khoá KHÔNG đổi địa chỉ:
    //   - đổi root cây Merkle (epoch mới) — ký bằng lá hiện tại của cây cũ
    function rotateMerkleRoot(bytes32 newRoot, uint64 newEpoch, WotsSig calldata sig,
                              uint256 nonce) external;
    //   - (tuỳ chọn) bật/tắt guardian hoặc ECDSA authorizer, luôn qua timelock
    function setGuardian(address g, WotsSig calldata sig, uint256 nonce) external;

    // Khôi phục 2-chữ-ký: sau rotationDelay, nếu user mất cây epoch hiện tại,
    // guardian kết hợp secret preimage proof (kiểu hash-commit một lần) để đặt root mới.
    function recover(bytes32 newRoot, uint64 newEpoch, WotsSig calldata guardianSig) external;

    // EIP-1271 — ví ký được như tài khoản thường (permit, order, token-gated…)
    function isValidSignature(bytes32 hash, bytes calldata sig) external view returns (bytes4);

    // Đọc
    function nonce() external view returns (uint256);
    function epoch() external view returns (uint64);
    function merkleRoot() external view returns (bytes32);
    function leafIndex() external view returns (uint256);
}
```

**Verifier chung:** `verifyWots(digest32, root, epoch, leafIndex, sig)` đặt trong thư viện `HashSig.sol` thuần keccak256, không dùng `ecrecover` ở chế độ quantum. `executeSigned` thực hiện: (1) `require(op.wallet == address(this))`, (2) `nonce == op.nonce` rồi `nonce++`, (3) `block.timestamp <= op.validUntil`, (4) recompute `digest`, (5) `leafIndex == sig.leafIndex` rồi `leafIndex++`, (6) verify WOTS về `merkleRoot`, (7) lặp `calls[]` bằng external call. Reentrancy: tái dùng guard của dự án (`contracts/src/common/ReentrancyGuard.sol`) + trạng thái nonce tăng **trước** khi gọi ngoài.

### 6.4 "Dùng như ví bình thường" qua EIP-1271 & execute

- **Nhận:** bất kỳ ai gửi tới địa chỉ proxy (native/ERC-20/NFT) — không cần thao tác.
- **Gửi:** `Send`/`Swap`/dApp trong ví cũ chuyển thành build `WalletOp { calls }` → ký → relay. Lịch sử hiển thị bằng địa chỉ proxy.
- **Ký cho dApp:** dApp gọi `eth_signTypedData_v4` với tài khoản proxy → SDK bọc thành EIP-1271 proof (hoặc dApp gọi thẳng `isValidSignature`). 0xPump/0xFi đều có thể chấp nhận nếu họ check owner qua EIP-1271; phần tương thích liệt kê ở roadmap.

---

## 7. Sponsor relayer (dev trả gas)

Một endpoint bảo mật, **không giữ secret của user, không ký thay user**:

| Bước | Mô tả |
|---|---|
| 1. Nhận | `POST /relay` body = `{ op, sig, senderMeta }`. Giới hạn kích thước (≤ 64 KB), JSON nghiêm ngặt, rate-limit theo địa chỉ ví. |
| 2. Policy | (a) ví có `getBalance(wallet) > 0` (chống spam "ca rỗng"), (b) tổng gas/ngày/ví ≤ cap (vd 0.1 zkLTC), (c) epoch+nonce tương lai trong ngưỡng, (d) chỉ chainId 4441. |
| 3. Pre-check | `eth_estimateGas`/`eth_call` trên `executeSigned` để bắt revert trước khi tốn tiền (fail-closed; revert hiển thị về user). |
| 4. Deploy nếu cần | Nếu địa chỉ chưa có code → gửi `factory.createWallet(...)` trước (cùng intent lần đầu). |
| 5. Gửi | Sign raw tx từ **EOA cấp vốn** (private key chỉ ở env server/secret manager; tách khỏi `NEXT_PUBLIC_`; đúng chuẩn dự án đã có cho server secrets). Trả gas. |
| 6. Track | Poll receipt, trả về hash/status cho client; không trả phí cho user. |

- **Tách bạch:** relayer nhận **intent đã ký**; chữ ký WOTS chỉ chứng minh "chủ ví đồng ý", không lộ secret. Relayer chết ⇒ user tự broadcast `executeSigned` từ RPC thường bằng một nút "gửi thủ công" (vẫn không cần EOA — chỉ tốn gas user). Không có điểm "relayer lừa đảo" được: nó không thể tạo intent hợp lệ mà không có chữ ký.
- **Vị trí:** ưu tiên route trong `apps/web/app/api/qwallet/` (đã có backend Railway) hoặc worker riêng — chọn ở phase 3 sau khi xem hạ tầng deploy cụ thể.

---

## 8. SDK client (sdk/)

| Module | Nội dung |
|---|---|
| `iconcodec.ts` | sinh/giải mã chuỗi icon ↔ entropy + checksum; NFKC; validate; từ điển 2048 codepoint. |
| `derive.ts` | HKDF/PRF dẫn xuất seed epoch, salt, commitment; wrap/unwrap AES-GCM. |
| `merkle.ts` | streaming Merkle–WOTS builder (frontier O(H)), dẫn xuất lá theo seed. |
| `wots.ts` | ký/verify tham chiếu (dùng để sinh vector kiểm thử cho Solidity). |
| `op.ts` | build `WalletOp`, EIP-712 typing, digest. |
| `relay.ts` | gọi relayer, retry policy-safe, parse lỗi revert. |
| `reads.ts` | số dư, epoch, nonce, merkleRoot qua publicClient. |
| `eip1271.ts` | sinh proof chữ ký cho `isValidSignature`. |

Tất cả dùng **WebCrypto** (nhất quán với nguyên tắc "no crypto dependency trong bundle giữ secret" của `core/keyring/crypto.ts`).

---

## 9. Tích hợp ví extension (phase 4 — cần duyệt riêng)

Không đụng gì khi chưa duyệt. Khi build, các điểm chạm đã xác định:

1. **Vault/accounts:** thêm loại tài khoản mới song song, ví dụ `AccountMeta.source = "quantum"` + `index` trỏ tới bản ghi trong `qwallet` storage. **Giữ nguyên** validator cũ (`vault.ts:readAccounts`) — đọc dữ liệu cũ không vỡ; ghi thêm field mới ở bản nâng cấp. Vault **mới riêng** (`storageKeys` mới) chứa ciphertext của seed/state; khoá wrap từ secret icon, không lẫn với password vault ECDSA hiện tại (2 lớp độc lập).
2. **UI:** Settings → panel **"Bảo mật lượng tử (kháng lượng tử)"** (cạnh ImportAccount/ChangePassword): giải thích → sinh secret icon → xác nhận (2 lần) → relay deploy → hiển thị địa chỉ proxy → nút "Chuyển tài khoản hoạt động". Trong `Home`/`Send` hiển thị huy hiệu nhỏ "PQ" khi account đang là quantum.
3. **Luồng gửi:** `sendToken`/`sendNative` (`core/services/transfer.ts`, `tx.ts`) nếu account là quantum → route qua SDK build op + relay thay vì `walletClientFor(...).sendTransaction`. Lịch sử/UI quotes giữ nguyên hình dạng (hàm trả hash).
4. **dApp bridge:** `background.ts` khi `eth_sendTransaction`/`sign` với account quantum → vẫn qua approval window, nhưng execution gọi SDK (relay), trả hash (meta-tx) thay vì raw tx. `eth_accounts` trả địa chỉ proxy sau khi migrate. `switchNetwork` chỉ cho phép LitVM trong chế độ quantum (relayer chỉ sponsor chain này).
5. **i18n:** thêm chuỗi vào `core/i18n/locales/{vi,en,…}.ts` (mẫu có sẵn). Không hardcode.
6. **Di chuyển tài sản (tuỳ chọn):** nút "chuyển số dư EOA cũ → ví quantum" dùng chính meta-relay (1–2 op), hoặc để user tự chọn giữ 2 ví.
7. **Không phá mặc định:** quantum wallet là **opt-in**, account EOA mặc định giữ nguyên.

---

## 10. Migration UX (dòng chảy người dùng)

1. User mở **Settings → Bảo mật lượng tử**.
2. Màn hình giải thích: *"Ví hiện tại dùng chữ ký ECDSA — máy tính lượng tử tương lai có thể phá. Nâng cấp lên ví kháng lượng tử: địa chỉ mới, mọi giao dịch được dev trả gas, khoá tự xoay, không bao giờ phải đổi địa chỉ nữa."*
3. Ví **sinh secret 25 icon** + checksum; user chép/sao lưu, xác nhận nhập lại đúng.
4. (Chờ) relayer deploy ví CREATE2 (sponsored) → báo "Ví kháng lượng tử sẵn sàng".
5. Tuỳ chọn: **chuyển số dư** từ EOA hiện tại vào ví mới (sponsored).
6. `accountsChanged` → dApp mới nhận địa chỉ proxy.
7. Từ nay: **xoay khoá tự động** khi cây cạn (im lặng, nền), **đổi secret** bất kỳ lúc nào (không đổi địa chỉ), **khôi phục** bằng secret trên thiết bị mới.

---

## 11. Các lựa chọn đã loại & lý do

| Lựa chọn | Loại vì |
|---|---|
| ERC-4337 bundler/paymaster chuẩn | Không có bằng chứng chain hỗ trợ; entry-point + bundler là hạ tầng riêng. Tự làm meta-tx đơn giản, kiểm soát 100%, đủ cho sponsor testnet. Có thể bọc chuẩn 4337 sau nếu chain thêm entry-point. |
| "Password tự chọn" làm khoá uỷ quyền on-chain | Password người entropy thấp; không chứng minh được preimage trên chuỗi mà không lộ. |
| ECDSA + "hy vọng entropy cao" | Không kháng lượng tử (Shor). |
| Lattice/SPHINCS+ verify trên EVM | Không có precompile; gas không khả thi hiện tại. |
| ZK-STARK làm chữ ký | Verifier EVM còn nặng, phức tạp research-grade — để dành bản nâng cấp, không phải bản đầu. |
| Upgrade proxy có admin | Rủi ro "chiếm quyền upgrade"; core bất biến + xoay state an toàn hơn nhiều. |

**Khuyến nghị tổng:** Chế độ **PQ-only (hash-based)**, meta-tx sponsor, secret icon entropy cao, core bất biến. Đây là "phương án an toàn nhất" khả thi trên EVM ngày nay, với mọi giới hạn được khai báo trung thực ở `02-THREAT-MODEL.md`.
