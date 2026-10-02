# Rà soát DOGEOS × PIXEL — 02/10/2026

Đã rà soát source ứng dụng, contract, indexer và công cụ triển khai; sửa các lỗi tìm được rồi kiểm tra lại bằng unit tests, fuzz/invariant tests, trình duyệt và dữ liệu chain/Goldsky thật. Web đang chạy tại http://localhost:3300/DOGEOSxPIXEL.

## Phạm vi

| Nhóm | Nội dung đã kiểm tra |
| --- | --- |
| `contracts/src` — 6 contracts/libraries | ERC-721/2981, enumeration, transfer callbacks/reentrancy, ownership nonce, approval, canonical packed pixels, UTF-8/JSON/SVG/Base64, lưu dữ liệu theo chunk, collection quyền owner, listing/offer/expiry, pull payments, làm tròn royalty và escrow |
| `server` — 4 modules | API/query/body/RPC validation, pagination, snapshot nhất quán, checkpoint atomic, reorg/hash/deployment identity, cache và request đang chạy, approval, metadata, collection previews, fallback subgraph |
| `src` — 18 source/style/type files | Wallet EIP-1193/6963, đổi chain/account/provider, gửi giao dịch và replacement, phí DOGEOS, số tiền chính xác theo wei, theme, state/request races, collection/NFT/offer pagination, Studio, import/export/draft/history, dialog/accessibility, clipboard, responsive layout |
| `subgraph` | 4 mapping/config modules, schema, manifest, deployment blocks/addresses, approval, lịch sử listing, Transfer/Sold ordering, credits, collections và query tương thích Graph Node |
| `scripts` — 7 modules | Chain guard trước ký, deployment guard chống triển khai trùng, artifact paths, ABI export, manifest generation, local server, smoke/finalize |
| Cấu hình, tài liệu, assets, tests | Vite/TS/Foundry/package/lockfiles, HTML/favicon, env mẫu, Docker Compose, license notices, deployment records và các bộ kiểm thử |

Dependency source trong `node_modules`, graph context và build output không được coi là source tự viết. Dependencies được kiểm tra bằng npm audit; ABI và bytecode sinh ra được so sánh với artifact và contract đã triển khai. Không chỉnh sửa các project khác trong workspace ở đợt này.

## Các lỗi và bản sửa

- Chặn session ví thay đổi trong mọi bước bất đồng bộ, kể cả ngay trước `eth_sendTransaction`; không khôi phục connection đã disconnect từ response cũ. Event lặp lại không vô hiệu giao dịch hợp lệ. Việc thêm chain luôn được theo sau bởi lệnh switch rõ ràng.
- Không báo thành công khi người dùng cancel/replace giao dịch. Giữ thông báo lỗi session bên trong lỗi RPC được thư viện bọc lại; xử lý cả rejection không phải `Error` và clipboard bị từ chối.
- Đọc giá chính xác đến 1 wei; từ chối exponent, số âm, dư precision và overflow uint256. Ước lượng phí execution + data/finality làm tròn lên; dùng đúng bộ gas/EIP-1559 fees đã ước lượng khi gửi.
- Không hiển thị NFT, earnings hay offers của tài khoản trước trong lúc chờ dữ liệu mới. Abort/epoch/account guards chặn response muộn ghi đè state hiện tại.
- Phân trang offers trong wallet và NFT detail; collection previews được lấy theo membership riêng, kể cả NFT nằm ngoài trang catalog đầu tiên. Append/deduplicate giữ dữ liệu đã tải.
- Listing bị revoke approval được loại khỏi số lượng và phân trang For sale. Reapproval được xử lý đúng, lịch sử vẫn giữ. Self-transfer xóa approval riêng từng token. Goldsky yêu cầu `or` ở cấp riêng; query đã được sửa và kiểm tra trên endpoint thật.
- Checkpoint chỉ công bố sau khi lưu thành công, có version/chain/NFT/market identity và canonical hash. Reorg loại cache artwork cũ, kể cả request đang chạy; concurrent reads chia sẻ công việc. Các token trong một response được đọc tại cùng block.
- API giới hạn body, query, RPC batch/concurrency/gas/log range, từ chối query trùng hoặc malformed, trả 404 cho NFT không tồn tại. Lỗi nội bộ không đưa secret ra response.
- Studio giữ metadata trên canvas trống; draft vượt giới hạn mint vẫn lưu/export đủ 65,536 runs. Storage corrupt/denied/quota không làm editor ngừng hoạt động. JSON/numeric/hex được kiểm tra nghiêm ngặt.
- Pointer chính, interpolation, pointer cancel, no-op strokes và undo/redo/resize/import metadata được xử lý nhất quán. RAF gộp render; import bất đồng bộ không ghi đè chỉnh sửa mới. Kiểm tra kích thước PNG/JPEG/WebP trước decode; PNG export lấy từ document hiện tại.
- Dialog có tên truy cập, click padding/drag từ trong ra ngoài không đóng nhầm form, body scroll lock hỗ trợ dialog lồng nhau. SVG card/detail được memoize; giá và tên dài được wrap.

### Phần tiếp tục sau khi bị giới hạn sử dụng

- Listener ví được giữ liên tục từ khi bắt đầu kết nối đến sau khi thành công, tránh bỏ event giữa response RPC và React commit. Account/chain events được đối chiếu với snapshot; disconnect hủy chờ ngay cả khi `eth_requestAccounts` không trả về, giúp người dùng chọn ví khác. Mỗi bước add/switch network kiểm tra session trước khi gọi tiếp, chặn popup từ provider đã ngắt hoặc đổi.
- EIP-6963 từ chối tên trống/ID quá dài, deduplicate cả UUID và provider identity; injected fallback cũng tuân thủ giới hạn 20 lựa chọn.
- API token riêng lẻ kiểm tra canonical checkpoint kể cả trong cooldown rồi đọc tại cùng block, loại artwork cache của fork cũ. Catalog vẫn dùng snapshot chung, không sync lặp cho mỗi NFT.
- Studio xử lý tọa độ cuối ở primary `pointerup` trước khi hoàn tất stroke; test down/up không có pointermove vẽ đủ 32 pixel. Pointer phụ, pointercancel, lost capture và no-op history được giữ đúng.

Production Solidity không đổi: không cần deploy lại NFT/market và không di chuyển tài sản. Subgraph đã chuyển `prod` sang **dogeos-pixel/1.0.1**.

## Kiểm chứng

| Kiểm tra | Kết quả |
| --- | --- |
| Unit/backend/mapping/fee/amount/codec/wallet guards | 48/48 passed |
| Contracts | 53/53 passed; 4 fuzz tests × 512 cases; mỗi invariant 64 runs × 96 calls, zero reverts |
| Codec reference/fuzz | 500 canonical artworks, 2,000 strokes, 200 independent flood-fill comparisons |
| Studio browser | 14 cases passed; final pointerup endpoint, draft 65,536 runs, storage failures, import races, JSON/PNG round-trip, header limits, 320/375px overflow checks |
| Wallet browser | Live reads/simulation + rejection, account change, disconnect; zero signed transactions |
| Wallet race browser | 11 cases passed; cached account during connect is rejected; account/chain/disconnect immediately before signing all stop before provider send |
| Wallet provider browser | 11 cases passed; discovery cap/validation/dedupe, interrupted add/switch, reconnect/provider replacement and disconnect during indefinitely pending connection |
| UI regressions | 29 checks passed: 24 route/theme/viewport combinations, saved theme/artwork preservation, 30 NFTs, 25 collection previews and 50 offers in both wallet/detail |
| API | Live discovery/filter/pagination/validation, read-only RPC bounds, source/env isolation passed |
| Goldsky | Healthy `_meta`, metadata/owner/approval/listing/collection/sale/credits và các bộ lọc khớp web; `source: subgraph` |
| Subgraph fallback | Endpoint unavailable, stale/error index, inconsistent IDs/supply, combined filters và pagination passed |
| ABI/bytecode/live accounting | Both deployed runtime bytecodes match compiled artifacts; frontend/subgraph ABIs match; immutable addresses correct; balance covers escrow + credits |
| Build | TypeScript + Vite production build and Graph codegen/WASM passed |
| Dependencies | Root and subgraph npm audit: 0 reported vulnerabilities at audit time |

Lượt Studio 256-grid ghi nhận stroke qua 50 pointer steps trong khoảng 851 ms theo thao tác automation, không có browser long task. Đây là phép đo trên máy hiện tại, không phải cam kết hiệu năng trên mọi thiết bị.

Bằng chứng và screenshot nằm trong `output/`: `deep-studio-regression.json`, `wallet-races.json`, `provider-discovery.json`, `wallet-browser.json`, `browser-smoke.json`, `api-smoke.json`, `ui-regressions.json`, `subgraph-client.json`, `subgraph-live.json`, `chain-readonly.json`, `deep-audit.json`.

## Giới hạn đã đo

Artwork tối đa 4,096 runs có thể cần khoảng **7.94M gas để mint** và **28.41M gas để tạo tokenURI đầy đủ**; URI mẫu biên dài 321,717 bytes. RPC bên thứ ba có giới hạn eth_call thấp có thể không render tokenURI này. Ứng dụng và subgraph đọc packed artwork để tránh việc tạo URI lớn khi index/catalog. Test boundary và deployed bytecode size đều passed.

Smoke giao dịch testnet thật trước đó vẫn lưu ở `output/live-smoke.json`. Đợt rà soát này không gửi giao dịch chain mới; fuzz/invariants chạy local, các bài browser giả lập provider chỉ từ chối ký. `npm run smoke:chain` là lệnh riêng thực hiện giao dịch và tiêu test DOGE.

Các kiểm tra trên giới hạn hành vi và mức tải được ghi rõ ở đây; kết quả pass không chứng minh phần mềm không thể còn lỗi trong tình huống chưa được kiểm thử.
