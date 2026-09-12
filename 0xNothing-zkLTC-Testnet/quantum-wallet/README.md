# 0xQuantum Wallet (`quantum-wallet/`)

**Ví thông minh (smart-contract wallet) chạy trên LitVM LiteForge Testnet** — người dùng **không trả gas** (dev tài trợ qua relayer), **chỉ ký**, gửi được **mọi token**, và có chế độ **kháng lượng tử** với chuỗi ký tự/icon có entropy cao, **xoay khoá mà không đổi địa chỉ ví**.

> ✅ **Trạng thái: Phase 0–4 đã xong** — contracts đã deploy LiteForge, SDK + relayer chạy được,
> và ví đã tích hợp vào `apps/wallet` (route `quantum`, màn hình `ui/screens/QuantumWallet.tsx`).
> Factory đang live: `0xC23e270707B636101C4B43882dE38A840037BaCe` — **không deploy lại** (xem dev guide).

## Đọc gì trước

| Tài liệu | Nội dung |
|---|---|
| [docs/04-DEV-GUIDE.md](docs/04-DEV-GUIDE.md) | **Bắt đầu ở đây** — chạy/test trong 3 lệnh, luật vàng khi sửa code, gỡ lỗi |
| [docs/01-DESIGN.md](docs/01-DESIGN.md) | Kiến trúc tổng thể + **cơ chế hoạt động từng bước** (deploy, ký, relay, xoay khoá, khôi phục) |
| [docs/02-THREAT-MODEL.md](docs/02-THREAT-MODEL.md) | Vì sao đây là **phương án an toàn nhất** + mô hình mối đe doạ + **giới hạn trung thực** |
| [docs/03-ROADMAP.md](docs/03-ROADMAP.md) | Lộ trình **deep-build** theo giai đoạn (contracts → SDK → relayer → tích hợp ví) |

## Cấu trúc hiện tại

```
quantum-wallet/
├─ README.md
├─ docs/                  # thiết kế & kế hoạch (bắt đầu ở 04-DEV-GUIDE.md)
├─ contracts/             # Foundry: QuantumWalletFactory, QuantumWallet,
│                         #   libs/HashSig (WOTS), EIP-1271, test/ unit + mocks
├─ sdk/                   # TS: sinh khoá, ký Merkle-Winternitz, digest,
│                         #   icon-codec 2048 glyph, vault wrap, relay client, vectors
├─ relayer/               # sponsor relayer (dev trả gas), policy + e2e anvil
└─ build-dist.sh          # typecheck + build dist (KHÔNG deploy lại factory)
```

Phần tích hợp ví nằm trong `apps/wallet/src/core/quantum/` và
`apps/wallet/src/ui/screens/QuantumWallet.tsx`.

## Nguyên tắc chặn đứng mọi sai lệch

1. **Tài sản sống ở địa chỉ hợp đồng** — địa chỉ chỉ là hàm của mã CREATE2, không phải của bất kỳ khoá nào → xoay/đánh mất khoá **không bao giờ đổi địa chỉ** và không đụng tới tài sản.
2. **Khoá chữ ký kháng lượng tử** = chữ ký hash-based (Merkle + Winternitz, chỉ dùng keccak256 để xác minh) — **không có ECDSA nào nằm trong đường bảo mật chính** ở chế độ quantum.
3. **"Mật khẩu" thực chất là secret entropy cao** (sinh ngẫu nhiên, hiển thị dạng chuỗi icon/emoji/ký tự gõ được) — mọi thứ (cây khoá, salt, address) dẫn xuất từ secret này; secret **chỉ ở client**, không bao giờ lên chuỗi ở dạng rõ.
4. **Mọi lệnh chuyển tiền là meta-transaction** do relayer của dev gửi → user chỉ ký intent EIP-712, relayer trả gas (sponsor). Relayer **không bao giờ thấy secret/khoá**, chỉ thấy chữ ký hợp lệ.
