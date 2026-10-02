# 0xPixel V2 — kết quả 01/10/2026

Đã nghiên cứu, triển khai V2 trên LitVM testnet (chain 4441), mint NFT mẫu vào
ví cung cấp private key và cập nhật mã web/ví/subgraph để dùng cả V1 lẫn V2.
Bytecode trên chain khớp hoàn toàn artifact đã test. Các API production local
đã đọc được NFT vừa mint qua RPC.

## Deployment

| Mục | Giá trị |
|---|---|
| V2 | `0xd83cb7acef921f98b6b983cbb712a583869da9eb` |
| Block deploy | 56,305,414 |
| Runtime | 16,521 bytes |
| NFT mẫu | #1, 256×256, 4.096 đoạn màu |
| Chủ sở hữu mẫu | `0x58633401dCc383F010688e950878000000000000` |
| Chi phí deploy | 0,001000167794646 testnet zkLTC |
| Chi phí mint mẫu | 0,002358061141440 testnet zkLTC |
| Tổng hai giao dịch | 0,003358228936086 testnet zkLTC |

[Giao dịch deploy](https://liteforge.explorer.caldera.xyz/tx/0xc305351d7bbe4395b821a67a7299e468bdcc3365d0d5b749b1d090568fa91758)
và [giao dịch mint](https://liteforge.explorer.caldera.xyz/tx/0xb373aa7038d2d34e0e2e0064e058c8adb0877b0c15a3dd8103606ef60ee23c7f)
đã có receipt thành công qua RPC. Explorer đang index khoảng 83% số block và
chưa nhận diện địa chỉ mới, nên các trang giao dịch/source có thể chưa hiện.
Hai API verification của explorer đều từ chối với “Address is not a
smart-contract”; **source verification trên explorer còn pending**. Chain RPC
đã xác nhận code, ownership, ERC-721 metadata/ERC-2981, dữ liệu ảnh và JSON.

Journal công khai, ABI và mẫu SVG/JSON nằm trong
`0xNothing-zkLTC-Testnet/deployments/liteforge-testnet/pixel-v2*`.
`standard-input.json` chứa đủ 14 source compiler input để verify lại. Private
key được đọc trong process ký, không đưa vào argument, journal hoặc log.

## Thiết kế và giới hạn

V1 là collection cố định, chỉ mint 8/16/32/64 và lưu grid bằng `uint8`.
V1 đã có `tokenURI`, nhưng mô tả trong form mint trước đây không được lưu.
V2 dùng `uint16`, hỗ trợ 8/16/32/64/128/256, lưu tên/mô tả/ảnh/attributes bất
biến hoàn toàn on-chain theo
[ERC-721 metadata](https://eips.ethereum.org/EIPS/eip-721). Royalty creator
vẫn là 1% qua [ERC-2981](https://eips.ethereum.org/EIPS/eip-2981).

Dữ liệu nén là 6 byte binary mỗi đoạn ngang: x, y, độ dài trừ 1, RGB. Đoạn dài
256 được biểu diễn đúng. Tối đa 4.096 đoạn / 24.576 byte; ảnh 256² nhiều chi
tiết không nhất thiết mint được. Editor đếm độ phức tạp trước khi yêu cầu ký.
Các đoạn phải có thứ tự, không chồng lấn và gộp màu liền nhau; hash bao gồm
grid và encoding chuẩn, chống bản sao do đổi encoding trong V2. Registry V1
và V2 độc lập.

Binary được lưu vào code bất biến với STOP đầu mỗi chunk, thay cho chuỗi hex
và nhiều storage slot. Chunk lớn nhất 24.571 byte runtime, dưới
[giới hạn EIP-170](https://eips.ethereum.org/EIPS/eip-170). SVG dùng path gọn,
buffer có giới hạn và Base64 theo từng nhóm; helper giữ attribution/notice MIT
của [Solady](https://github.com/Vectorized/solady/blob/main/src/utils/Base64.sol).

## Benchmark

Số đo dưới đây là Forge; receipt thực tế ở trên có thêm chi phí giao dịch.

| Trường hợp | Gas | Độ dài tokenURI |
|---|---:|---:|
| Mint 256² / 4.096 đoạn | 8.136.569 | — |
| Metadata 256² / 4.096 đoạn | 29.302.504 | 321.737 bytes |
| Cùng ảnh, tên 64 + mô tả 1.024 byte control cần escape | 31.167.509 | 330.401 bytes |

Ở cùng ca 64²/4.096 đoạn, bước tối ưu giảm gas metadata của implementation V2
từ khoảng 65,02 triệu xuống 26,35 triệu (~59,5%). Đây là so sánh các bản V2
trong quá trình tối ưu. Script live đọc `tokenURI` với gas allowance 40 triệu.

## Tương thích và kiểm chứng

NFT cũ và marketplace giữ nguyên địa chỉ. `tokenData` V2 giữ tuple cũ và tách
đoạn 256 thành 255+1 cho reader cũ. Mint mới dùng `mintPacked`; đọc mô tả dùng
`tokenPackedData`. Mọi identity, route chuyển NFT và cache ảnh dùng collection
+ token ID. URL ảnh lịch sử thiếu collection tiếp tục trỏ V1.

Subgraph có datasource V2 và description, codegen/build đạt; bản hosted chưa
publish. Web đọc V2 từ RPC và hợp nhất với NFT cũ. Activity truy vấn RPC không
batch, chia range nhỏ, giới hạn concurrency và xử lý timeout để hiển thị mint
mới trong lúc explorer index chậm.

`npm run verify` đạt **663 test**, cùng typecheck/lint/build web, ví và các
subgraph. Sau sửa timeout activity, toàn bộ test web và production build được
chạy lại thành công. 26 test contract V2 gồm 1.024 lượt fuzz, kiểm tra toàn bộ
lookup Base64, UTF-8/control JSON, giới hạn chunk, approvals, self-transfer,
safe receiver/reentry/forwarding và royalty. Review độc lập không phát hiện
lỗi cụ thể trong implementation đóng băng.

`check-web.mjs` đạt bốn nhóm kiểm tra qua production local/RPC thật:

- Mô tả tiếng Việt và creator đọc lại đúng.
- 4.096 path của ảnh API khớp toàn bộ hình học/RGB on-chain; ảnh V1 #1 khác V2 #1.
- Inventory trả 13 NFT thuộc cả hai collection, không trùng identity.
- Sự kiện mint V2 #1 xuất hiện qua RPC khi explorer chưa có dữ liệu.

Log ở `verify.log`, `web-final.log`, `web-smoke.json`. Graph đã refresh:
1.331 file, 10.858 node, 14.487 edge. Mã web/ví/subgraph đã cập nhật trong
workspace; deployment on-chain đã hoàn tất.
