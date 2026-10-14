# Vận hành dài hạn không cần bảo trì (2026-10-13, cập nhật 14/10 cho tokenomics v2)

Mục tiêu: 0xNothing chạy được khoảng 2 năm khi không có ai trực. Tài liệu này ghi rõ hệ thống phụ thuộc vào những gì, mỗi thứ hỏng thì chuyện gì xảy ra, và việc nào phải làm **trước khi rời đi**. Mọi kết luận bên dưới đã được đối chiếu trên chuỗi LiteForge 4441 hoặc bằng test trong repo vào ngày lập tài liệu.

## 1. Contract (bất biến, không cần nâng cấp)

Toàn bộ contract đã deploy là bất biến, không có proxy. Chúng không "hết hạn" và không cần ai nâng cấp.

**Bộ đang hoạt động là v2** (`docs/TOKENOMICS_V2.md`, `deployments/liteforge-testnet/v2.json`). Mọi dòng phí v2 đều do bất kỳ ai đẩy đi; vòng thưởng 0xPoints do bất kỳ ai đóng; vote mint thặng dư không có owner. Không có việc định kỳ nào bắt buộc phải có người làm.

| Hạng mục | Trạng thái đã kiểm tra |
| --- | --- |
| Phân tích tĩnh (Slither 0.11.6, mức High/Medium) | Không có phát hiện thật. Các cờ còn lại là mẫu có chủ đích: Newton seed của `mulDiv`, kiểm tra chênh lệch số dư trong hàm `nonReentrant`, so sánh `== 0` |
| Graduation của 0xPump | Permissionless. Admin của Pump là `PumpGraduationController`, nên ai cũng bấm được nút Graduate trên web. Không cần keeper |
| 0xPoints (v2) | `RewardStaking` không owner, không pause. Ai cũng đóng vòng khi pool đủ 10,000 NUSD; claim không hết hạn; gốc luôn rút được khi đáo hạn. Points v1 và API ký voucher đã bị gỡ khỏi web |
| Phí giao thức (v2) | Pump, router, lending, synth đều gửi phí tới `FeeSplitter` hoặc quỹ bằng lời gọi công khai; trang Earn có nút Send cho từng nguồn |
| Lending | Lãi tuyến tính theo thời gian, cộng dồn ở mỗi tương tác; không tràn số dù để yên nhiều năm |
| `ZeroXFiPair` dùng `uint32` timestamp | Mẫu TWAP của Uniswap V2, tràn có chủ đích (năm 2106) |
| Marketplace zkLTC cũ | **Đã pause** (tx `0x5cdff334…a65d`), không ai mua được 566 listing giá cũ |
| Marketplace NUSD v2 | 0.1% burn + 0.4% creator, không phí nền tảng. Cancel, hoàn offer, rút credit luôn mở kể cả khi pause. Marketplace v1 (`0x188e…f377`) vẫn chạy nhưng web không dùng |
| Fork smoke test v2 | `V2TokenomicsSmokeForkTest` chạy trên bộ v2 thật (phí, vòng thưởng, burn, vote mint) |

## 2. Phụ thuộc bên ngoài và cách hệ thống phản ứng

| Phụ thuộc | Nếu ngừng hoạt động | Mức độ |
| --- | --- | --- |
| **Oracle DIA trên LiteForge** (LTC, BTC, ETH; giới hạn tuổi giá 90 phút) | Mint/redeem NUSD, vay, mint synth, thanh lý, vote mint đều dừng (fail-closed). **Testnet v2:** NUSD v2 có `emergencyRedeem`: ai cũng báo lỗi oracle, sau 7 ngày người giữ NUSD rút zkLTC theo tỷ lệ, không cần giá, không ai chặn được (trang NUSD có panel "Emergency exit"). NUSD v1 vẫn không có lối thoát này | Cao, ngoài tầm kiểm soát |
| RPC Caldera | Web và ví tự chuyển từ `infra-partner-http` sang `/http` công khai (cùng origin). Nếu cả hai đổi, cập nhật `LITVM_RPC_URL` / `LITVM_RPC_FALLBACK_URL` trong `apps/web/lib/publicConfig.ts` và `apps/wallet/src/config/chain.ts` | Thấp |
| Goldsky (subgraph 0xPump, 0xFi, Pixel V1, NUSD) | Mọi trang có đường dự phòng đọc RPC: Pump đọc markets/trades/holders, 0xFi có RPC tail, NUSD activity quét log. Chậm hơn nhưng không hỏng | Thấp |
| Hosting (Railway, 1 replica, có healthcheck `/api/health`) | Web ngừng hiển thị; contract vẫn chạy và dùng được qua explorer | Trung bình: cần trả tiền đủ 2 năm |
| Tên miền `0xnothing.xyz` | Web mất địa chỉ | Trung bình: gia hạn trước |
| Pinata (IPFS upload, biến `PINATA_JWT`) | Tạo token Pump cần upload ảnh/metadata sẽ lỗi; giao dịch các token cũ vẫn bình thường | Trung bình |
| Node.js | Docker image đã chuyển sang Node 24 LTS (hỗ trợ tới 04/2028). Node 22 EOL 04/2027 | Đã xử lý |
| Bản thân testnet LiteForge | Nếu testnet bị reset hoặc ngừng, mọi trạng thái mất. Không có cách phòng | Ngoài tầm kiểm soát |

## 3. Quyền quản trị

Ví `0x58633401dCc383F010688e950878000000000000` đang là owner, guardian và treasury của hầu hết contract (chế độ governance `direct`).

- Ví này **không** rút được escrow hay credit của người dùng ở marketplace NUSD, và không đổi được phí.
- Ví này **có thể**: pause; đổi cấu hình rủi ro của lending và synth (LTV, ngưỡng thanh lý, cap); bật/tắt collection; **chi tiêu `OwnerTreasury`** (nhận 50% doanh thu NUSD và 100% phí zkLTC).
- Ví này **không** rút được phí giao thức ở v2, và không có quyền gì trên `RewardStaking`, `FeeSplitter`, `SurplusMintGovernor`, router v2.
- Rủi ro chính khi vắng mặt là **lộ key**, không phải mất key. Mất key chỉ khiến không ai đổi được cấu hình; người dùng vẫn rút được vì các lối thoát không cần admin.

## 4. Việc cần làm trước khi rời đi (chỉ chủ dự án làm được)

1. **Key:** sao lưu seed của ví owner ở nơi offline; không để private key nằm trong `.env.local` trên máy dùng hằng ngày. Cân nhắc chuyển owner/guardian sang multisig nếu LiteForge có Safe.
2. **Hosting:** trả trước Railway đủ 2 năm, hoặc chuyển sang Cloudflare Workers (xem `CLOUDFLARE_WORKERS.md`).
3. **Tên miền:** bật tự gia hạn, hoặc trả trước tới sau ngày trở về.
4. **Pinata:** đảm bảo gói/khóa `PINATA_JWT` còn hiệu lực trong 2 năm, hoặc chấp nhận tạm dừng tạo token mới.
5. **Farm v2:** ba gauge LP mới (WzkLTC, nBTC, nETH với NUSD) chưa có thưởng. Nạp NUSD qua `GaugeFactory.fundGauge` nếu muốn farm; nếu không, UI ghi "Unfunded".
6. **Points v1:** không còn dùng. Ai còn stake ở `NusdPointsStaking` v1 rút gốc qua explorer khi đáo hạn (web đã gỡ giao diện v1).
7. **Merge và deploy** branch `feat/tokenomics-v2` lên hosting. Web production hiện vẫn chạy v1 cho tới khi bạn deploy; subgraph v2 có tên riêng (`*-v2`) nên không ảnh hưởng bản đang chạy.
8. **Goldsky:** giữ tài khoản hoạt động; nếu subgraph bị xóa, web tự dùng RPC.
9. **Ngân sách vote:** nạp tối đa 3,000 NUSD vào `SurplusMintGovernor` (trang Vote → "Fund incentives") nếu muốn người bỏ phiếu được thưởng 1–10 NUSD.
10. **Vòng thưởng đầu tiên:** pool chỉ đầy dần theo phí thật. Nếu muốn khởi động sớm, chuyển NUSD từ quỹ vào `RewardStaking` (contract coi phần dư là pool).

## 5. Khi quay lại hoặc nhờ người khác kiểm tra

```bash
npm run verify
```

```bash
npm --prefix 0xNothing-zkLTC-Testnet/0xFi run audit:live:report
```

Fork smoke test của bộ v2 (cần `LITVM_RPC_URL`, không gửi giao dịch):

```bash
forge test --root 0xNothing-zkLTC-Testnet/contracts --match-contract V2TokenomicsSmokeForkTest
```

Trạng thái v2 (stage, cung NUSD, giá trị dự trữ, pool thưởng):

```bash
npm --prefix 0xNothing-zkLTC-Testnet/0xFi run deploy:v2:status
```
