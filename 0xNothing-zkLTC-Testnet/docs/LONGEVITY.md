# Vận hành dài hạn không cần bảo trì (2026-10-13)

Mục tiêu: 0xNothing chạy được khoảng 2 năm khi không có ai trực. Tài liệu này ghi rõ hệ thống phụ thuộc vào những gì, mỗi thứ hỏng thì chuyện gì xảy ra, và việc nào phải làm **trước khi rời đi**. Mọi kết luận bên dưới đã được đối chiếu trên chuỗi LiteForge 4441 hoặc bằng test trong repo vào ngày lập tài liệu.

## 1. Contract (bất biến, không cần nâng cấp)

Toàn bộ contract đã deploy là bất biến, không có proxy. Chúng không "hết hạn" và không cần ai nâng cấp.

| Hạng mục | Trạng thái đã kiểm tra |
| --- | --- |
| Phân tích tĩnh (Slither 0.11.6, mức High/Medium) | Không có phát hiện thật. Các cờ còn lại là mẫu có chủ đích: Newton seed của `mulDiv`, kiểm tra chênh lệch số dư trong hàm `nonReentrant`, so sánh `== 0` |
| Graduation của 0xPump | Permissionless. Admin của Pump là `PumpGraduationController`, nên ai cũng bấm được nút Graduate trên web. Không cần keeper |
| Points staking | Có `redeemPoints()` trực tiếp. Server ký voucher không bắt buộc phải chạy |
| Lending | Lãi tuyến tính theo thời gian, cộng dồn ở mỗi tương tác; không tràn số dù để yên nhiều năm |
| `ZeroXFiPair` dùng `uint32` timestamp | Mẫu TWAP của Uniswap V2, tràn có chủ đích (năm 2106) |
| Marketplace zkLTC cũ | **Đã pause** (tx `0x5cdff334…a65d`), không ai mua được 566 listing giá cũ |
| Marketplace NUSD | Fork smoke test 4/4 trên bytecode thật; cancel, hoàn offer, rút credit luôn mở kể cả khi pause |

## 2. Phụ thuộc bên ngoài và cách hệ thống phản ứng

| Phụ thuộc | Nếu ngừng hoạt động | Mức độ |
| --- | --- | --- |
| **Oracle DIA trên LiteForge** (LTC, BTC, ETH; giới hạn tuổi giá 90 phút) | Mint/redeem NUSD, vay, mint synth, thanh lý đều dừng (fail-closed). **Testnet:** `OracleNUSD.redeemAtOracle` không có lối thoát khác, nên zkLTC thế chấp bị khóa cho tới khi DIA chạy lại. **Mainnet (chưa deploy):** đã thêm `emergencyRedeem`, sau 7 ngày oracle chết thì người giữ NUSD được rút theo tỷ lệ mà không cần giá | Cao, ngoài tầm kiểm soát |
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
- Ví này **có thể**: pause; đổi cấu hình rủi ro của lending và synth (LTV, ngưỡng thanh lý, cap); bật/tắt collection; rút phí giao thức.
- Rủi ro chính khi vắng mặt là **lộ key**, không phải mất key. Mất key chỉ khiến không ai đổi được cấu hình; người dùng vẫn rút được vì các lối thoát không cần admin.

## 4. Việc cần làm trước khi rời đi (chỉ chủ dự án làm được)

1. **Key:** sao lưu seed của ví owner ở nơi offline; không để private key nằm trong `.env.local` trên máy dùng hằng ngày. Cân nhắc chuyển owner/guardian sang multisig nếu LiteForge có Safe.
2. **Hosting:** trả trước Railway đủ 2 năm, hoặc chuyển sang Cloudflare Workers (xem `CLOUDFLARE_WORKERS.md`).
3. **Tên miền:** bật tự gia hạn, hoặc trả trước tới sau ngày trở về.
4. **Pinata:** đảm bảo gói/khóa `PINATA_JWT` còn hiệu lực trong 2 năm, hoặc chấp nhận tạm dừng tạo token mới.
5. **Farm:** thưởng của nBTC/NUSD và nETH/NUSD hết vào **19/10/2026**, wzkLTC/NUSD đã hết. Nạp thêm nếu muốn farm tiếp; nếu không, UI sẽ không hiển thị APY.
6. **Points:** kiểm tra `redemptionReserve` của `NusdPointsStaking` đủ cho số điểm sẽ được đổi.
7. **Merge và deploy** branch `feat/nusd-marketplace-upgrade` lên hosting.
8. **Goldsky:** giữ tài khoản hoạt động; nếu subgraph bị xóa, web tự dùng RPC.

## 5. Khi quay lại hoặc nhờ người khác kiểm tra

```bash
npm run verify
```

```bash
npm --prefix 0xNothing-zkLTC-Testnet/0xFi run audit:live:report
```

Fork smoke test của marketplace NUSD (cần `LITVM_RPC_URL`, không gửi giao dịch):

```bash
forge test --root 0xNothing-zkLTC-Testnet/contracts --match-contract NusdMarketplaceSmokeForkTest
```
