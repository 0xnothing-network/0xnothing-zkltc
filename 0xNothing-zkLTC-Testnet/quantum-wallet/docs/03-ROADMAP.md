# 03 — Lộ trình deep-build theo giai đoạn

> Mỗi phase có **file đích cụ thể**, **mốc hoàn thành (definition of done)**, và **kiểm thử bắt buộc**.
> Build **sau khi bạn duyệt**. Tích hợp vào `apps/wallet` (phase 4) được tách riêng và cần **duyệt lần hai**.

## Phase 0 — Nền tảng & sandbox (mở đầu)

- [ ] Tạo cây folder trong `quantum-wallet/`: `contracts/`, `sdk/`, `relayer/`, `extension/`, `test/`.
- [ ] Foundry project độc lập (`foundry.toml`, Solidity ≥ 0.8.24) cạnh `contracts/` hiện có — **không** đụng các hợp đồng 0xPump/0xFi/NUSD đang chạy.
- [ ] Cập nhật `config/networks/liteforge-testnet.json`/`deployments/` nếu cần đăng ký địa chỉ factory (chỉ thêm, không sửa hợp đồng cũ).
- [ ] Khoá **reference vectors** (ts vector ↔ solidity) cho WOTS/Merkle ngay từ đầu để mọi phase kiểm chéo.
- [ ] Quy ước: mọi private key của dev relayer **chỉ trong env**, không bao giờ `NEXT_PUBLIC_` (đúng chuẩn `docs/SECURITY.md`).

## Phase 1 — Contracts (Foundry)

File đích trong `quantum-wallet/contracts/src/`:
- [ ] `interfaces/IQuantumWallet.sol`, `interfaces/IQuantumWalletFactory.sol`
- [ ] `libs/HashSig.sol` — verify WOTS (keccak256, w=4, len 67), checksum, replay-safe theo nibble.
- [ ] `libs/Merkle.sol` — verify auth-path từ leaf về root.
- [ ] `QuantumWalletCore.sol` — state (§6.2 DESIGN), `executeSigned`, `rotateMerkleRoot`, `isValidSignature` (EIP-1271), optional guardian/`recover`/timelock, reentrancy guard.
- [ ] `QuantumWalletFactory.sol` — CREATE2 + initData gắn `root0`/epoch0/config; salt từ commitment.
- [ ] `QuantumWalletProxy.sol` — minimal EIP-1167 (hoặc dùng chuẩn clone có sẵn `contracts/src/common/Clones.sol` nếu phù hợp — **chỉ tham chiếu**, không sửa).

DoD: `forge build` sạch; `forge test` gồm:
- verify WOTS bằng vector sinh từ SDK TS (khớp byte-to-byte);
- chống replay nonce; chống reuse lá (leafIndex tuần tự);
- rotate root đúng epoch; từ chối lá cũ sau rotate;
- reentrancy test; revert khi deadline/`wallet` mismatch;
- EIP-1271 magic value; chống front-run deploy (salt sai → địa chỉ khác);
- fuzz: chữ ký ngẫu nhiên không thể giả mạo (verify fail).

## Phase 2 — SDK (TypeScript, WebCrypto)

File đích trong `quantum-wallet/sdk/src/`:
- [ ] `iconcodec.ts` — từ điển 2048 codepoint, sinh/encode/decode, checksum, NFKC, cross-font test.
- [ ] `derive.ts` — HKDF(secret)→seed epoch/salt/commitment; AES-GCM wrap/unwrap state.
- [ ] `wots.ts` + `merkle.ts` — streaming builder (frontier O(H)), ký, auth path; xuất vector cho phase 1.
- [ ] `op.ts` — WalletOp builder + EIP-712 digest + `validUntil`.
- [ ] `relay.ts` — POST relayer, retry, parse revert.
- [ ] `reads.ts` — số dư/nonce/epoch/merkleRoot.
- [ ] `recovery.ts` — tái sinh state chỉ từ secret (mô phỏng "mất thiết bị").

DoD: `sdk` tự chạy vector test; test "ký bằng cây TS → verify bằng contract thật trên LiteForge (hoặc anvil fork)" pass; test khôi phục từ secret trên bộ nhớ trống tái tạo đúng epoch/leafIndex.

## Phase 3 — Relayer (sponsor)

File đích: route server trong `apps/web/app/api/qwallet/relay/route.ts` **hoặc** `quantum-wallet/relayer/` (chọn sau khi xem hạ tầng Railway/Clerk worker thực tế):
- [ ] Endpoint POST: validate op/sig/size/rate-limit; policy (balance>0, daily cap/ví, chainId 4441); pre-check `eth_estimateGas`/simulate.
- [ ] EOA cấp vốn (env secret); deploy-on-first-use; broadcast; poll receipt.
- [ ] Nút dự phòng "gửi thủ công" phía client (broadcast từ RPC thường).

DoD: test tích hợp relay 1 op native + 1 op ERC-20 (NUSD/wzkLTC) thật trên LiteForge; relayer hết tiền → lỗi rõ ràng, user không mất gì; không có đường relayer đọc secret.

## Phase 4 — Tích hợp ví `apps/wallet` (CẦN DUYỆT RIÊNG)

Chỉ sau khi bạn duyệt **lần hai**. File chạm (đã khảo sát, xem DESIGN §9):
- `src/core/keyring/vault.ts` (mở rộng model account, **giữ validator cũ**)
- `src/core/platform/storageKeys.ts`, `src/core/keyring/crypto.ts` (thêm khối vault quantum riêng)
- `src/core/services/transfer.ts`, `src/core/services/tx.ts` (route account quantum qua SDK/relay)
- `src/extension/background.ts`, `src/core/services/dapp.ts` (eth_sendTransaction/sign với account quantum; broadcast accountsChanged)
- `src/ui/screens/settings/QuantumWallet.tsx` (mới) + `src/ui/screens/Settings.tsx` (mount panel), `src/ui/screens/home/*` (huy hiệu PQ)
- `src/core/i18n/locales/*.ts` (chuỗi mới)
- Không đổi hành vi EOA mặc định; quantum = opt-in.

DoD: tạo ví quantum → deploy → gửi native + 1 ERC-20 → đổi secret → cùng địa chỉ → khôi phục trên "thiết bị mới" giả lập → toàn bộ test cũ của `apps/wallet` (`tests/`) vẫn xanh.

## Phase 5 — Cứng hoá & báo cáo

- [ ] Audit thủ công: reentrancy, nonce/lá edge, cạn cây, rotate race, front-run deploy.
- [ ] `/security-review` trên toàn diff.
- [ ] Ghi `quantum-wallet/docs/AUDIT.md` + cập nhật `docs/SECURITY.md` (mục ví quantum) khi được phép.
- [ ] Tài liệu vận hành relayer (top-up, cap, fallback) — theo mẫu `docs/DEPLOYMENT.md`.

---

## Đánh giá rủi ro build

| Rủi ro | Mức | Giảm thiểu |
|---|---|---|
| Sai tham số WOTS/không khớp TS↔Solidity | Cao | Reference vectors từ phase 0; fuzz; forge test bắt buộc |
| Cạn cây/mất leafIndex | Cao | Tự xoay ở 90%; recovery từ secret; guardian optional |
| Tích hợp vỡ test ví cũ | TB | Phase 4 tách; chạy full `tests/`; opt-in |
| Gas verify cao hơn dự tính | TB | Đo thật phase 1–3; hạ `w`/tăng H; budget cap relayer |
| Chain testnet biến mất/reset | TB | Deploy script lặp lại được; config tập trung |

**Kế hoạch ước lượng:** Phase 0–1 (contract + test) là nặng nhất về đúng đắn mật mã; phase 2–3 nhanh hơn nhờ vector chung; phase 4 phụ thuộc duyệt UI. Build theo thứ tự 0→3 trước, dừng báo cáo, rồi phase 4.
