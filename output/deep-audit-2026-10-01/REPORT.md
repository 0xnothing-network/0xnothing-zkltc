# Kiểm tra sâu và sửa source — 01/10/2026

Đã sửa các lỗi tái hiện được ở web, wallet và subgraph; bộ kiểm tra cuối repo đạt **701/701**. Server local đã khởi động lại tại **http://localhost:3300**.

## Các thay đổi chính

| Phần | Lỗi đã tái hiện | Kết quả sau sửa |
| --- | --- | --- |
| Pixel web | Đổi tài khoản, mạng hoặc connector trong lúc chờ estimate/approval vẫn có thể tiếp tục mint/list; giá listing đổi trong lúc approval | Ghim chain/account, kiểm tra lại phiên ví trước khi gửi; context đổi phải xem lại giao dịch |
| Activity NFT | Quét lại từ block triển khai có thể vượt giới hạn sau khi chain tăng; purchase bị bỏ sót nếu sự kiện Listed cũ chưa tải được | Checkpoint theo filter, quét gần đây có giới hạn, overlap 64 block để xử lý reorg, backfill lịch sử; đọc listing tuple để phục hồi ngữ cảnh sự kiện |
| Wallet ký dapp | Context/permission/approval claim thay đổi sau bước chờ lấy signer; network đã lưu đổi nhưng UI chưa cập nhật RPC | Kiểm tra lock, account, network identity, permission, claim và expiry tại điểm ký; ghim context của raw transaction |
| Wallet token | Lookup một profile khác vẫn đọc RPC đang active; địa chỉ builtin LitVM bị áp dụng sang chain khác | Dùng RPC của profile được yêu cầu; builtin và custom token được phân biệt theo network |
| Wallet auto-lock | Deadline dạng chuỗi, NaN, infinity hoặc object có thể không hết hạn và được gia hạn | Deadline phải là số nguyên an toàn, hợp lệ; dữ liệu sai đóng phiên |
| Wallet amount | `parseUnits` có thể làm tròn lượng nhập vượt số decimal; bỏ dấu phẩy có thể ghép các nhóm số sai | Giữ đúng token unit: từ chối precision không biểu diễn được và nhóm dấu phẩy sai; cho phép zero dư không đổi giá trị |
| Fi governance index | Một phần RPC thành công khiến cap/pause sai bị giữ lại mãi; trạng thái tất cả pause được dùng làm sentinel | `governanceReady` chỉ hoàn tất khi toàn bộ trường được đọc thành công; lỗi một phần được thử lại |
| Fi gauge index | Thiếu handler `RewardSchedulePaused` / `RewardScheduleResumed`, làm `periodFinish` sai | Thêm ABI, manifest, handler và generated bindings tương ứng |

Các sửa đổi được kiểm tra bằng regression có bước thất bại trước sửa. [Baseline](baseline.log) ghi nhận hai regression wallet còn đỏ khi bộ kiểm tra chạy tới chúng. [Gauge trước sửa](fi-gauge-before.log) lưu bốn case thất bại. [Kết quả Fi subgraph](fi-subgraph-after.log) lưu 22 case đạt sau sửa. Không phải mọi kết quả trước sửa đều có raw log riêng; các ghi nhận còn lại dựa trên lượt kiểm tra của worker.

## Kiểm tra cuối

`npm run verify` **exit 0**. [Log đầy đủ](verify-final.log).

| Suite | Kết quả |
| --- | ---: |
| Repo tooling | 11/11 |
| Web | 153/153 |
| Testnet contracts | 96/96 |
| Mainnet contracts | 72/72 |
| Pixel subgraph | 8/8 |
| Fi operations scripts | 28/28 |
| Fi contracts | 160/160 |
| Fi subgraph | 22/22 |
| Wallet | 151/151 |
| Tổng | **701/701** |

Pipeline cũng đã đạt typecheck/lint/production build web, typecheck/build wallet, codegen/build subgraph và kiểm tra parity Pump giữa Testnet/Mainnet. `git diff --check` đạt.

Kiểm tra sâu contract bổ sung:

- Toàn bộ 18 property `testFuzz*`: 6 Testnet, 4 Mainnet, 8 Fi; mỗi property 2.048 runs, tổng **36.864 lượt**. [Testnet](testnet-fuzz-2048.log), [Mainnet](mainnet-fuzz-2048.log), [Fi](fi-fuzz-2048.log).
- 17 invariant: 6 Testnet và 11 Fi, mỗi invariant 256 runs × 128 depth; đạt. [Lệnh, thuộc tính và giới hạn kiểm tra](contract-intensified-checks.md).
- 111 kiểm tra syntax Node/JSON/JSONC đạt. Parser PowerShell cũng xác nhận script finalize không có lỗi cú pháp; script không được thực thi.

## Kiểm tra với dữ liệu thật

[Web smoke JSON](web-smoke.json), [log](web-live.log), [script chạy lại](check-web.mjs).

1. Metadata V2 đọc đúng tên, mô tả tiếng Việt, creator và collection.
2. SVG 256×256 có đủ 4.096 path, geometry/RGB khớp artwork on-chain; cache V1 #1 và V2 #1 tách biệt.
3. Inventory đọc được cả hai collection và không trùng identity `collection + tokenId`; tại lượt kiểm tra có 16 NFT.
4. Activity trả HTTP 200 và 30 sự kiện, không trùng ID. `partialHistory=true`: mint mẫu #1 cũ chưa nằm trong cửa sổ hiện tại và sẽ được tải theo backfill, không bị trình bày như lịch sử đã đầy đủ.

Trình duyệt local đã kiểm tra grid 256×256, vẽ, preview và undo. Ở viewport 390px, canvas hiển thị 336×336, không có kích thước 0 hoặc tràn ngang; hai lần vẽ tạo hai đoạn màu và undo đưa về zero. Viewport được khôi phục, tab thử đã đóng. Không thực hiện giao dịch mới trên chain trong lượt audit này.

Activity cold start đọc khoảng 5.000 block gần đây; mỗi refresh tải thêm khoảng 1.000 block cũ theo filter. Trang đang hiển thị poll 5 giây, cache raw 3 giây; trang ẩn dừng đọc. UI báo **Earlier activity is still loading.** khi lịch sử còn thiếu. Cache/checkpoint ở process memory nên khởi động lại process sẽ bắt đầu tải lại; chưa thêm cơ sở dữ liệu lưu lâu dài.

## Phạm vi và mức kiểm chứng

[Inventory](inventory.json) gồm **481 source first-party**, 141 file test và 65 file cấu hình; phân biệt 777 file vendor/generated. Source gồm TS/TSX, Solidity, JS, CSS/HTML và script. Đây là inventory và phạm vi workspace checks, không phải tuyên bố mọi dòng của 481 file đã được đọc thủ công hoặc thực thi.

[Coverage theo từng file](coverage.json) và [ledger contract/subgraph](contract-subgraph-ledger.json) ghi rõ kiểm tra thủ công theo chức năng, kiểm tra API, regression, reference và phần chỉ qua workspace checks. Không có số phần trăm line coverage để suy diễn từ số test. Dependency vendor/generated không được coi là một cuộc audit thủ công độc lập.

Đã giữ các thay đổi có sẵn của RWA và việc bỏ Quantum Wallet. Không revert/stash/commit thay đổi của người dùng. Không sử dụng private key thật để ký/gửi giao dịch và không in private key trong lượt audit.

## Áp dụng và phần phụ thuộc môi trường

- Web local đang dùng source đã sửa. Wallet build mới nằm trong `apps/wallet/dist`; browser đang cài extension cần reload bản unpacked để dùng build mới.
- Hosted **Fi subgraph cần deploy/reindex** để nhận schema `governanceReady` và handler gauge mới. Lượt này chỉ sửa/build source; chưa publish subgraph hay web host.
- Không thay Solidity production hoặc redeploy Pixel V2. SHA-256 `ZeroXPixelV2.sol` vẫn là `9CB5DCBA80183AE9F3783CECA6B6C66AB75DFCE4D52D083E85DD425BB0CB2D31`.
- Explorer vẫn là dịch vụ bên ngoài đang chậm index; sửa ứng dụng giúp dữ liệu hiện tại tiếp tục đọc qua RPC và báo rõ lịch sử còn thiếu.
