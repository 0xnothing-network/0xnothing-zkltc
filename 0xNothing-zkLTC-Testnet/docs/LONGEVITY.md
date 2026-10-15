# Vận hành dài hạn không cần bảo trì (2026-10-13, cập nhật 15/10 cho tokenomics v3)

Mục tiêu: 0xNothing chạy được khoảng 2 năm khi không có ai trực. Tài liệu này ghi rõ hệ thống phụ thuộc vào những gì, mỗi thứ hỏng thì chuyện gì xảy ra, và việc nào phải làm **trước khi rời đi**. Mọi kết luận bên dưới đã được đối chiếu trên chuỗi LiteForge 4441 hoặc bằng test trong repo vào ngày lập tài liệu.

## 1. Contract (bất biến, không cần nâng cấp)

Toàn bộ contract đã deploy là bất biến, không có proxy. Chúng không "hết hạn" và không cần ai nâng cấp.

**Bộ đang hoạt động là v3** (`docs/TOKENOMICS.md`, `deployments/liteforge-testnet/v3.json`). Phí tự được thu mỗi khi có người stake hoặc claim, thưởng tự rải trong 7 ngày, còn thặng dư NUSD thì ai cũng nhả được (tối đa 1 lần/tuần). Không có việc định kỳ nào bắt buộc phải có người làm.

| Hạng mục | Trạng thái đã kiểm tra |
| --- | --- |
| Phân tích tĩnh (Slither 0.11.6, mức High/Medium) | Không có phát hiện thật. Các cờ còn lại là mẫu có chủ đích: Newton seed của `mulDiv`, kiểm tra chênh lệch số dư trong hàm `nonReentrant`, so sánh `== 0` |
| Graduation của 0xPump | Permissionless. Admin của Pump là `PumpGraduationController`, nên ai cũng bấm được nút Graduate trên web. Không cần keeper |
| 0xPoints (v3) | `RewardStaking` không owner, không pause. Mọi NUSD đi vào contract được rải đều trong 7 ngày theo trọng số; khi không ai stake, dòng thưởng tạm dừng chứ không mất; claim không hết hạn; rút gốc khi đáo hạn không phụ thuộc phí |
| Phí giao thức (v3) | Mọi phí về `FeeSplitter`: NUSD 70% người stake / 20% đốt / 10% quỹ, zkLTC 90% dự trữ NUSD / 10% quỹ. `harvest()` gom 4 nguồn, tự chạy trong mỗi lần stake và claim; trang NUSD → Earn (`/nusd/earn`) có nút "Distribute fees" |
| Oracle router | NUSD, lending và synth đọc giá qua router LTC/BTC/ETH. Nếu DIA đổi feed, owner trỏ router sang adapter mới (giá lệch ≤ 25% khi nguồn cũ còn sống), không phải deploy lại gì |
| Lending | Lãi tuyến tính theo thời gian, cộng dồn ở mỗi tương tác; không tràn số dù để yên nhiều năm |
| `ZeroXFiPair` dùng `uint32` timestamp | Mẫu TWAP của Uniswap V2, tràn có chủ đích (năm 2106) |
| Marketplace zkLTC cũ | **Đã pause** (tx `0x5cdff334…a65d`), không ai mua được 566 listing giá cũ |
| Marketplace NUSD (bộ v3) | 0.1% burn + 0.4% creator, không phí nền tảng. Cancel, hoàn offer, rút credit luôn mở kể cả khi pause. Marketplace của bộ v2 (`0xA5e3…7e09`) và v1 (`0x188e…f377`) vẫn chạy nhưng web không dùng |
| Fork smoke test v3 | `TokenomicsSmokeForkTest` chạy trên bộ v3 thật (nối dây, phí → harvest → dòng thưởng → claim → redeem, thặng dư 80/20) |

## 2. Phụ thuộc bên ngoài và cách hệ thống phản ứng

| Phụ thuộc | Nếu ngừng hoạt động | Mức độ |
| --- | --- | --- |
| **Oracle DIA trên LiteForge** (LTC, BTC, ETH; giới hạn tuổi giá 90 phút) | Mint/redeem NUSD, vay, mint synth, thanh lý, nhả thặng dư đều dừng (fail-closed). **Testnet v3:** nếu DIA chỉ đổi feed, owner trỏ oracle router sang adapter mới là xong. Nếu oracle chết hẳn, NUSD có `emergencyRedeem`: ai cũng báo lỗi oracle, sau 7 ngày người giữ NUSD rút zkLTC theo tỷ lệ, không cần giá, không ai chặn được (trang NUSD → Mint, `/nusd`, có panel "Emergency exit") | Cao, ngoài tầm kiểm soát |
| RPC Caldera | Web và ví tự chuyển từ `infra-partner-http` sang `/http` công khai (cùng origin); dữ liệu realtime của web đi qua WebSocket `infra-partner-ws` → `/ws`, mất socket thì web tự quay về polling. Nếu đổi host RPC, cập nhật `LITVM_RPC_URL` / `LITVM_RPC_FALLBACK_URL` / `LITVM_WS_URLS` trong `apps/web/lib/publicConfig.ts`, `apps/wallet/src/config/chain.ts`, **và `connect-src` của CSP trong `apps/web/next.config.ts`** (CSP chỉ cho trình duyệt gọi đúng host RPC; quên sửa thì web mất kết nối chain) | Thấp |
| Goldsky (subgraph 0xPump, 0xFi, marketplace NUSD) | Mọi trang có đường dự phòng đọc RPC: Pump đọc markets/trades/holders, 0xFi có RPC tail, NUSD activity quét log. Chậm hơn nhưng không hỏng | Thấp |
| Hosting (Railway, 1 replica, có healthcheck `/api/health`) | Web ngừng hiển thị; contract vẫn chạy và dùng được qua explorer | Trung bình: cần trả tiền đủ 2 năm |
| Tên miền `0xnothing.xyz` | Web mất địa chỉ | Trung bình: gia hạn trước |
| Pinata (IPFS upload, biến `PINATA_JWT`) | Tạo token Pump cần upload ảnh/metadata sẽ lỗi; giao dịch các token cũ vẫn bình thường | Trung bình |
| Node.js | Docker image đã chuyển sang Node 24 LTS (hỗ trợ tới 04/2028). Node 22 EOL 04/2027 | Đã xử lý |
| Bản thân testnet LiteForge | Nếu testnet bị reset hoặc ngừng, mọi trạng thái mất. Không có cách phòng | Ngoài tầm kiểm soát |

## 3. Quyền quản trị

Ví `0x58633401dCc383F010688e950878000000000000` đang là owner, guardian và treasury của hầu hết contract (chế độ governance `direct`).

- Ví này **không** rút được escrow hay credit của người dùng ở marketplace NUSD, và không đổi được phí.
- Ví này **có thể**, không qua timelock và luôn trong giới hạn cứng của contract: pause mint NUSD, Pump, lending, synth; đổi cấu hình rủi ro của lending và synth (LTV, ngưỡng thanh lý, cap); chỉnh tham số NUSD (phí ≤ 0.5%, trần cung, ngưỡng thặng dư); tỷ lệ và nguồn của `FeeSplitter` (quỹ ≤ 20%); nguồn giá của oracle router; điều khoản Pump cho market mới; bật/tắt collection; **chi tiêu `OwnerTreasury`** (nhận 10% phí NUSD, 10% phí zkLTC và 20% thặng dư).
- Ví này **không** rút được phí giao thức, không dừng được redeem NUSD, không có quyền gì trên `RewardStaking`, và không sửa được market Pump đã tạo hay vị thế stake.
- Rủi ro chính khi vắng mặt là **lộ key**, không phải mất key. Mất key chỉ khiến không ai đổi được cấu hình; người dùng vẫn rút được vì các lối thoát không cần admin.

## 4. Việc cần làm trước khi rời đi (chỉ chủ dự án làm được)

1. **Key:** sao lưu seed của ví owner ở nơi offline; không để private key nằm trong `.env.local` trên máy dùng hằng ngày. Cân nhắc chuyển owner/guardian sang multisig nếu LiteForge có Safe.
2. **Hosting:** trả trước Railway đủ 2 năm, hoặc chuyển sang Cloudflare Workers (xem `CLOUDFLARE_WORKERS.md`).
3. **Tên miền:** bật tự gia hạn, hoặc trả trước tới sau ngày trở về.
4. **Pinata:** đảm bảo gói/khóa `PINATA_JWT` còn hiệu lực trong 2 năm, hoặc chấp nhận tạm dừng tạo token mới.
5. **Farm v2:** ba gauge LP mới (WzkLTC, nBTC, nETH với NUSD) chưa có thưởng. Nạp NUSD qua `GaugeFactory.fundGauge` nếu muốn farm; nếu không, UI ghi "Unfunded".
6. **Bộ cũ:** web không còn dùng v1 và v2. Ai còn stake ở `NusdPointsStaking` v1 hoặc `RewardStaking` v2 (`0x735D…CaE4`) rút gốc qua explorer khi đáo hạn; NUSD v2 vẫn redeem trực tiếp trên contract v2.
7. **Merge và deploy** branch `feat/tokenomics-v2` (đang chứa v3) lên hosting. Ba subgraph trên Goldsky đã chuyển sang địa chỉ v3 với tên cũ, nên bản web cũ đang chạy sẽ thấy dữ liệu v3 cho tới khi deploy bản mới.
8. **Goldsky:** giữ tài khoản hoạt động; nếu subgraph bị xóa, web tự dùng RPC.
9. **Thưởng khởi động (tùy chọn):** muốn người stake có thưởng sớm hơn phí thật thì chuyển NUSD từ quỹ vào `RewardStaking`. Contract tự nhận phần đó là thu nhập và rải đều trong 7 ngày.

## 5. Khi quay lại hoặc nhờ người khác kiểm tra

```bash
npm run verify
```

```bash
npm --prefix 0xNothing-zkLTC-Testnet/0xFi run audit:live:report
```

Fork smoke test của bộ v3 (cần `LITVM_RPC_URL`, không gửi giao dịch):

```bash
forge test --root 0xNothing-zkLTC-Testnet/contracts --match-contract TokenomicsSmokeForkTest
```

Trạng thái v3 (stage, cung NUSD, tỷ lệ bảo chứng, NUSD đang stake, thưởng đang chờ rải):

```bash
npm --prefix 0xNothing-zkLTC-Testnet/0xFi run deploy:v3:status
```
