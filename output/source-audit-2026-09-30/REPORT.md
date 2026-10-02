# Rà soát source 0xNothing — 30/09/2026

Đã sửa 5 nhóm lỗi xác nhận được, thêm 21 test hồi quy và hoàn tất `npm run verify` với exit code 0. Tổng cộng 617 test pass. Đây là kiểm kê và kiểm tra tự động trên toàn phạm vi source/config nhận diện được, kết hợp đọc sâu các luồng core; **chưa hoàn thành yêu cầu đọc tay toàn bộ từng file**, đặc biệt phần vendored. Không coi test pass hoặc hash inventory là bằng chứng hết bug.

## Core được giữ nguyên

- NUSD mint/redeem qua oracle DIA, không thêm phí giao thức vào hai thao tác này.
- Pump giữ mô hình reservation trả trước, lifecycle TRADING/READY/GRADUATED và mục tiêu READY 6.000 NUSD.
- 0xFi giữ phí pool/route, mô hình lending, backing synth và các tham số risk đã quy định.
- Web và extension/Android tiếp tục dùng chung các lớp core tương ứng; mainnet giữ vai trò release overlay.
- Giữ các thay đổi có sẵn của working tree, gồm việc gỡ Quantum Wallet và thêm RWA. Không reset, commit, deploy hoặc broadcast giao dịch.

## Lỗi đã sửa

| Nhóm | Trước khi sửa | Hành vi mới và bằng chứng |
| --- | --- | --- |
| Ký giao dịch sau thay đổi trạng thái ví | RPC client giữ signer đã lấy trước khi chuẩn bị nonce/gas/fees; khóa ví trong thời gian chờ không thu hồi signer đó | Client giữ metadata công khai và lấy signer mới tại từng điểm ký; kiểm tra lại khóa, tài khoản active và RPC. Test bao phủ ký hash, authorization, message, transaction và typed data |
| Chọn route swap đang pause | Route oracle báo output cao hơn có thể thắng route AMM đang thực thi được | Ưu tiên route thực thi được, rồi mới so output. Giữ quote pause khi tất cả route đều dừng để UI hiển thị đúng trạng thái; kiểm tra cả mint/redeem và lỗi đọc pause |
| Tiêu nhầm NUSD nhận ngoài route | Web/ví tính lượng bridge bằng chênh lệch số dư trước/sau; chuyển khoản khác trong lúc chờ có thể bị cộng vào bước sau | Dùng net ERC-20 Transfer trong receipt của chính giao dịch. Lọc contract, người nhận, luồng vào/ra, self-transfer và malformed log; thiếu delivery dừng bước sau. Bỏ hai RPC `balanceOf` mỗi route hai bước; giữ nguyên floor slippage cuối |
| Storage web không đồng bộ cùng tab | Backend localStorage không thông báo cho subscriber khi chính tab ghi/xóa; không xử lý clear và có thể nhận event từ storage area khác | Subscriber theo dõi set/setMany/remove cùng tab và event liên tab, lọc đúng storage area, xử lý clear/corrupt JSON, cleanup listener. Lỗi callback không còn bị coi là lỗi JSON và gọi lại callback |
| Token RWA thu thêm phí từ người gửi | `_pull` chỉ kiểm tra số token market nhận, chấp nhận token trừ thêm tiền của người gửi ngoài amount/cost đã review | Kiểm tra chính xác cả sender debit và market credit. Ba test funding/buy/sell fail trên code cũ, pass sau sửa, đồng thời chứng minh rollback balances/fees/daily accounting |

Các điểm sửa chính:

- `0xNothing-zkLTC-Testnet/apps/wallet/src/core/rpc/client.ts:58`
- `0xNothing-zkLTC-Testnet/apps/wallet/src/core/platform/storage.ts:79`
- `0xNothing-zkLTC-Testnet/apps/wallet/src/core/services/swap.ts:482`, `:663`, `:701`
- `0xNothing-zkLTC-Testnet/shared/transactions/tokenDelivery.ts:16`
- `0xNothing-zkLTC-Testnet/apps/web/features/fi/lib/hooks/useProtocolTransaction.ts:208`
- `0xNothing-zkLTC-Testnet/0xFi/contracts/src/rwa/RwaMarket.sol:173`

## Kiểm chứng cuối

| Phạm vi | Kết quả |
| --- | --- |
| Root tooling | 11 test pass |
| Web | 136 test pass; TypeScript, ESLint và production build pass |
| Wallet | 136 test pass; TypeScript và build app/background/content/inpage pass |
| Pump testnet contracts | 70 test pass |
| Mainnet contracts | 72 test pass |
| 0xFi contracts | 160 test pass, gồm 18 test RWA |
| Marketplace subgraph | 4 test pass; codegen/build pass |
| 0xFi operations scripts | 28 test pass |
| Pump testnet/mainnet và 0xFi subgraph | Codegen/build và các cổng compile/test trong `verify` pass |
| Whitespace / định dạng Solidity đã sửa | `git diff --check` và `forge fmt --check` pass |
| Graph | `graft build` thành công: 1.316 file, 10.667 node, 14.190 edge |

Tổng số test trên là 315 test Node và 302 test Solidity, không cộng riêng mỗi fuzz/invariant iteration. Một số fork test có thể return sớm khi không có cấu hình RPC; số pass không chứng minh đã chạy fork live. Không kiểm tra trực tiếp thiết bị Android hoặc ví live trong lượt này.

## Kiểm kê và giới hạn đọc source

`inventory.json` ghi SHA-256, kích thước, số dòng và phân loại cho 1.537 file source/config đang tồn tại, lấy từ file tracked và untracked không bị Git ignore:

- 568 file project.
- 131 file test.
- 746 file vendored.
- 91 file generated/artifact.
- 1 file metadata công cụ.

Scanner đọc toàn bộ byte của các file này, parse syntax JS/TS/JSON/JSONC và kiểm tra static relative imports JS/TS. Không còn finding từ các kiểm tra đó. Nó cũng lưu 292 entry ngoài danh sách extension source/config để có thể kiểm tra phạm vi loại trừ. File source Quantum Wallet đã bị xóa trước lượt này được ghi riêng, không khôi phục. Ignored dependencies, build caches, secrets và binary assets không nằm trong danh sách source đã đọc.

18 cặp source contract chung giữa testnet và mainnet có SHA-256 giống nhau. Đây là bằng chứng parity, không phải hai lần semantic review.

Đọc sâu lượt này tập trung vào RPC/signing, transaction/allowance, quote/execution swap, storage/locks, các guard của vault, live-read hook, HTTP readers, RWA shared core/oracle/market/client và transaction flow web. Tài liệu core và checkpoint audit trước được đối chiếu; kết quả lịch sử không được tính thành việc đọc lại toàn bộ source ở lượt hiện tại.

Vì vậy, yêu cầu “không bỏ sót file nào khi đọc tay toàn bộ source và sửa mọi bug” vẫn chưa được chứng minh hoàn tất. Phần còn thiếu gồm semantic review mọi file ngoài các luồng đọc sâu, toàn bộ vendor/tooling phụ trợ và kiểm thử hành vi thực tế trên browser/thiết bị/chain. Không sửa các phần đó chỉ vì pattern scan hoặc suy đoán.

## Evidence

- `verify-final.log`: lượt verify cuối sau các sửa logic, exit code 0.
- `rwa-before.log`: ba test sender-tax fail trước sửa.
- `rwa-after.log`: toàn bộ 18 test RWA pass sau sửa.
- `inventory.json`, `scan-summary.json`, `scan.mjs`: inventory và scanner tái chạy được.
- `graft-build.log`: graph refresh cuối.

Các log `verify.log` trong thư mục này và `source-audit-verify.log`/`source-audit-wallet.log` ở thư mục cha thuộc lượt kiểm tra trung gian, không thay thế kết quả cuối.
