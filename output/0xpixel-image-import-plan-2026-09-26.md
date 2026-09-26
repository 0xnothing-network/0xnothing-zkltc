# Kế hoạch nâng cấp 0xPixel: Image → Your Artwork

Trạng thái: kế hoạch kỹ thuật/sản phẩm, chưa triển khai tính năng.

## 1. Mục tiêu

Người dùng chọn grid → chọn ảnh → xem bản pixel được tạo tự động → Apply to artwork → chỉnh sửa bằng bộ vẽ hiện tại → tải xuống hoặc mint. Không cần tải ảnh đã chuyển đổi về rồi nhập lại, không cần ví để chuyển ảnh, không cần AI API hay máy chủ nhận ảnh.

Giữ style pixel/mono hiện tại. Giữ luồng vẽ tay, AI prompt/import dữ liệu hiện có, kiểm tra artwork trùng, estimate gas và mint. Không mở rộng contract/grid trong bản này.

## 2. Cơ sở đã kiểm tra trong repository

- `apps/web/app/0xpixel/page.tsx:47-130`: grid/pixelData là state trung tâm; handleApplyPixelData có snapshot Undo; đổi grid hiện xóa tranh và xóa history.
- `features/pixel/components/Toolbar.tsx:26`: grid 8/16/32/64.
- `features/pixel/components/Canvas.tsx:7-16,130-155`: nhận ma trận màu, vẽ ô RGB hoặc transparent. Đây là dữ liệu mà importer phải sinh ra.
- `features/pixel/components/MintPanel.tsx:77-114`: preview PNG và packed data debounce 600 ms, kiểm tra checkOriginal.
- `features/pixel/components/MintPanel.tsx:222-245`: estimate gas và đối chiếu block gas limit trước khi gửi.
- `lib/gridParser.ts:62-99`: mỗi run thực tế gồm 6 byte x/y/count/r/g/b. Comment cũ ghi 5 byte là sai; cần sửa tài liệu cùng đợt tích hợp.
- `MintPanel.tsx:302-305`: dung lượng đang ước tính bằng grid² × 7, chưa phải payload thực.
- Contract reference `contracts/src/0xpixel/reference/0xPixel.deployed.sol:135-171,361-380`: nhận chuỗi hex RLE, grid tối đa 64, hash trên payload + grid. Đây là bằng chứng trong repo, chưa xác minh bytecode deployment live trong lượt lập kế hoạch.

Các đường dẫn phía web trong tài liệu này nằm dưới `0xNothing-zkLTC-Testnet/apps/web/`.

## 3. Trải nghiệm người dùng

### Luồng chính

1. Grid hiện tại được chọn trước; importer mặc định lấy đúng grid đó, không tự đổi 16 thành 32.
2. Nút IMPORT IMAGE đặt cạnh nhóm grid/tools; mobile có lối mở gần canvas để không phải cuộn xuống cuối trang.
3. File picker là lối chính; desktop bổ sung kéo-thả. Không đăng ký paste toàn trang gây chiếm thao tác nhập text.
4. Chọn ảnh xong tự decode và tạo preview, không cần nút Convert riêng.
5. Một dialog desktop hoặc sheet mobile gồm ảnh nguồn/crop và bản pixel. Preview pixel phóng bằng nearest-neighbor, có nền checkerboard khi trong suốt.
6. Thiết lập mặc định: giữ toàn ảnh bằng Fit, padding transparent; ảnh không vuông không bị kéo méo. Người dùng có thể chuyển Fill rồi kéo vùng crop/zoom để lấp đầy grid.
7. Các điều khiển cơ bản: grid đích, Fit/Fill, preset chất lượng, số màu; tùy chọn nâng cao thu gọn.
8. Apply to artwork ghi một lần vào state editor. Canvas và MINT YOUR ARTWORK cùng lấy ma trận mới, vẽ tiếp bình thường. Import không tự mint.
9. Undo một lần khôi phục cả tranh và grid trước đó. Cancel/đóng dialog không thay đổi tranh.

### Grid và preset khởi điểm

| Grid | Số ô | Gợi ý |
| --- | ---: | --- |
| 8 × 8 | 64 | Biểu tượng rất đơn giản, 4–8 màu |
| 16 × 16 | 256 | Logo/avatar đơn giản, 8–16 màu |
| 32 × 32 | 1.024 | Cân bằng chi tiết/kích thước, 16–32 màu |
| 64 × 64 | 4.096 | Ảnh nhiều chi tiết, 32–64 màu; kiểm tra khả năng mint |

Các số màu là preset đề xuất, không phải ràng buộc contract. Không hứa ảnh chân dung/chữ nhỏ sẽ rõ ở grid thấp.

Presets: Balanced (mặc định, palette thích nghi, không dithering), Photo (palette rộng hơn, dithering tùy chọn), Logo/Pixel (giữ nét, không nhiễu), Mint-friendly (ít màu hơn, ưu tiên vùng màu liền). Mỗi preset chỉ đổi tham số công khai, có thể chỉnh lại.

## 4. Pipeline chuyển đổi

File → xác thực → decode/orientation → crop/fit → resample → alpha policy → quantize → optional dither → normalize matrix → đo RLE → preview → apply.

- Xác thực file dựa trên dung lượng, header/format và kết quả decode; không chỉ extension hoặc MIME do trình duyệt gửi.
- Chuẩn hóa EXIF orientation và không gian màu sRGB. Kiểm tra ảnh chụp điện thoại xoay ngang/dọc thực tế.
- Đọc kích thước từ header trước khi decode khi format cho phép. Ngưỡng ban đầu đề xuất: 12 MB và 24 megapixel; điều chỉnh qua test thiết bị. Resize lúc decode là tối ưu, không phải bảo đảm decoder không cấp phát ảnh gốc.
- Giữ một bản nguồn và một bản làm việc có cạnh tối đa khoảng 1.024–2.048 pixel. Khi đổi grid/settings luôn tính lại từ nguồn/bản làm việc chuẩn, không resample từ tranh pixel cũ.
- Ảnh chụp: area/box sampling để lấy màu đại diện từng ô. Pixel art/logo sắc nét: có nearest-neighbor. Không dùng tắt smoothing đơn thuần làm thuật toán duy nhất cho tất cả ảnh.
- Trong suốt: đầu ra chỉ RGB hoặc transparent. Với Preserve transparency, dùng threshold alpha có thể chỉnh; màu vùng rìa được tính theo alpha để tránh viền đen. Với Background color, composite lên màu nền đã chọn trước khi quantize. Không giả lập bán trong suốt mà contract không lưu được.
- Quantization: baseline median-cut xác định kết quả ổn định, loại ô transparent khỏi thống kê; gán màu theo khoảng cách cảm nhận màu. So sánh Wu/thuật toán thay thế bằng bộ ảnh chuẩn trước khi chọn dependency. Không cần mô hình AI cho bản đầu.
- Dithering tắt mặc định. Ordered dither mức nhẹ là tùy chọn; chỉ thêm Floyd–Steinberg khi kiểm thử cho thấy giá trị rõ ràng. Preview phải cho thấy tác động tới chi tiết và số run.
- Chuẩn hóa màu thành `#RRGGBB` cùng casing, ma trận đúng N hàng × N cột, không NaN/undefined, transparent dùng đúng literal hiện tại.
- Cùng buffer RGBA đã chuẩn hóa và settings phải cho cùng kết quả. Không hứa decode file/color profile giống từng byte trên mọi engine trình duyệt.

## 5. Format hỗ trợ

P0: JPEG, PNG, WebP. AVIF/BMP nhận khi trình duyệt giải mã được và đã qua kiểm thử tương ứng. GIF/APNG/animated WebP chỉ công bố frame đầu khi có đường decode xác định và fixture chứng minh; nếu chưa có thì báo chưa hỗ trợ ảnh động, không lấy frame ngẫu nhiên.

P1: HEIC/HEIF bằng decoder WASM tải khi cần, sau khi đánh giá license/bundle/memory. P2: SVG qua raster hóa cô lập và chặn tài nguyên ngoài nếu thật sự cần. Không hứa PSD/RAW/PDF hoặc mọi codec là được hỗ trợ ngay. “Ảnh bất kỳ” nên hiểu là mọi nội dung ảnh trong các định dạng đã công bố.

Không nhận URL ảnh từ xa trong P0. Ảnh nguồn và EXIF không được gửi lên server; chỉ artwork đã xác nhận đi vào luồng mint hiện có. Không log tên file/nội dung vào telemetry.

## 6. Hiệu năng và quản lý trạng thái

- Lazy-load dialog và worker khi mở importer; không thêm thư viện xử lý ảnh nặng vào bundle tải trang đầu.
- Worker + OffscreenCanvas/createImageBitmap khi hỗ trợ. Fallback HTMLImageElement/canvas giới hạn kích thước; các vòng tính toán dài chia batch/yield.
- Một nguồn decode, một job active, tối đa một request mới nhất đang chờ. Không decode lại file mỗi lần kéo slider.
- Debounce thiết lập 100–150 ms, render preview bằng requestAnimationFrame. Phân biệt draft preview và committed artwork.
- Job mang sourceRevision/settingsRevision/grid. Kết quả cũ không được thay preview mới; Apply chỉ bật khi kết quả khớp settings hiện tại.
- Loại kết quả cũ chưa đủ để tiết kiệm CPU: vòng tính toán có điểm hủy/yield; khi thay nguồn hoặc đóng dialog thì terminate job/worker phù hợp.
- Chụp editor revision lúc mở importer; nếu artwork thay đổi ngoài dialog, không tự ghi đè khi job cũ trả về.
- Cleanup object URLs, ImageBitmap.close, worker, event listeners khi thay nguồn/đóng dialog/unmount. Không lưu base64 ảnh lớn vào React state hoặc localStorage.
- PNG preview, packed data, originality check chỉ chạy trên artwork đã Apply, không chạy theo từng lần kéo crop. Giữ 600 ms debounce hiện tại cho bước chuẩn bị mint.

Chỉ tiêu nghiệm thu đề xuất, chưa phải benchmark: ảnh JPEG/PNG 4 MP → 64² có preview đầu p95 ≤1 giây desktop và ≤2,5 giây mobile tầm trung; thay thiết lập sau decode p95 ≤200 ms desktop/≤400 ms mobile; không có long task >50 ms do quantization trên main thread trong đường worker; lặp 20 lần thay ảnh không tăng bộ nhớ đơn điệu. Ghi rõ máy/trình duyệt/fixture trước khi kết luận.

## 7. Payload và mint

- RLE một run = 6 byte. Grid 64² xấu nhất có 4.096 run = 24.576 byte packed.
- Contract reference nhận chuỗi hex: cùng trường hợp này có 49.154 ký tự ASCII gồm `0x`; chưa tính ABI overhead. Phân biệt packed bytes, string bytes và calldata size trong diagnostics.
- UI chỉ cần thông tin dễ hiểu: số màu, kích thước artwork thực, trạng thái kiểm tra khả năng mint. Không đưa cấu trúc RLE vào trải nghiệm mặc định.
- Giảm số màu không bảo đảm ít run; dithering có thể tăng run. Đo chính xác sau mỗi candidate thay vì suy ra từ số màu/grid.
- Nếu artwork vượt ngân sách thực tế, đề xuất candidate ít màu hơn/tắt dithering/grid nhỏ hơn, cho xem trước rồi tự chọn. Không âm thầm đổi tranh đã Apply để làm giao dịch rẻ hơn.
- Estimate gas theo payload/name/account/chain hiện tại và kiểm tra lại khi gửi. Lỗi RPC hiển thị là chưa kiểm tra được, không gắn nhãn artwork chắc chắn không mint được.
- Kiểm tra checkOriginal giữ nguyên. Đây là kiểm tra trùng payload theo contract, không phải nhận diện mọi ảnh nhìn giống nhau.
- Sửa comment 5-byte sai và số dung lượng grid²×7 hiện tại trong cùng đợt, không đổi encoder/ABI/hash hay địa chỉ contract.
- Kiểm tra round-trip matrix → packed → SVG/gallery/wallet trên fixtures để phát hiện lệch màu, alpha hoặc tọa độ.

## 8. Tích hợp theo file

| File dự kiến | Trách nhiệm |
| --- | --- |
| `features/pixel/components/ImageImportDialog.tsx` | chọn file, crop, presets, preview và Apply/Cancel |
| `features/pixel/hooks/useImageImport.ts` | state machine, job revision, worker và cleanup |
| `features/pixel/lib/imageImport/types.ts` | settings/result/error có kiểu rõ ràng |
| `features/pixel/lib/imageImport/decode.ts` | validation, dimensions, orientation, decode/fallback |
| `features/pixel/lib/imageImport/convert.ts` | resample, alpha, quantize, dithering; hàm thuần có fixture |
| `features/pixel/workers/imageImport.worker.ts` | xử lý nặng ngoài main thread |
| `features/pixel/lib/artworkStats.ts` | thống kê màu/run/kích thước chính xác từ encoder hiện tại |
| `app/0xpixel/page.tsx` | mở dialog, commit atomic grid+matrix, history có gridSize |
| `features/pixel/components/Toolbar.tsx` | lối vào IMPORT IMAGE; dùng callback hiện tại |
| `features/pixel/components/MintPanel.tsx` | số liệu thực, trạng thái chuẩn bị và kiểm tra mint đúng revision |
| `lib/gridParser.ts` | sửa comment định dạng; giữ output encoding |
| `tests/client/` và fixtures | kiểm thử editor/import/worker/codec/round-trip |

State gợi ý: idle → decoding → converting → ready → applying → closed; error/cancel có thể xảy ra ở các giai đoạn xử lý. Editor history chuyển từ matrix-only sang `{ gridSize, pixelData }`, giới hạn 50 bước hiện có. Một lần Apply là một bước Undo; chỉnh preview không tạo history.

Không rewrite Canvas, không thay gallery/marketplace data contract. Chỉ sửa Canvas nếu cần lối mở importer ở mobile; luồng vẽ vẫn nhận ma trận như cũ.

## 9. Giai đoạn và điều kiện hoàn thành

1. **Khóa baseline và dữ liệu — 0,5 ngày:** fixture ảnh và test state/history; kiểm tra payload contract/ABI đang cấu hình, ghi lỗi verify wallet có sẵn tách riêng.
2. **Engine và worker — 1–1,5 ngày:** PNG/JPEG/WebP, orientation/crop/fit/alpha, resample, palette, latest-job-wins, cleanup. Chạy được fixtures và benchmark.
3. **UI và editor — 1–1,5 ngày:** desktop/mobile dialog, chọn grid/ảnh, auto preview, Apply, Undo across grid, Cancel không đổi tranh, keyboard/focus.
4. **Chất lượng và mint — 1 ngày:** presets/dither tùy chọn, packed statistics, round-trip, estimate chính xác, trạng thái pending không nhảy lỗi đỏ.
5. **QA và phát hành — 1–1,5 ngày:** mobile/Safari/Chrome/Edge, ảnh lớn/lỗi, build/typecheck/lint/tests, production-like smoke và feature flag rollback.

Ước lượng tổng P0: 5–7 ngày kỹ thuật với một người quen codebase; cần chốt lại sau spike codec/mobile. HEIC/SVG/AI background removal không nằm trong ước lượng này.

## 10. Bộ nghiệm thu

- 8²/16²/32²/64² luôn có đúng số ô; toàn bộ ô là RGB hợp lệ hoặc transparent.
- Ảnh portrait/landscape/EXIF rotated không méo hoặc xoay sai; Fit giữ đủ nội dung; Fill crop đúng vùng người dùng chọn.
- PNG trong suốt và alpha rìa không có viền đen bất ngờ; preview và dữ liệu export cùng chính sách nền.
- Đổi ảnh A→B liên tục, đổi grid lúc đang xử lý, kéo slider rồi Apply, đóng/mở lại không áp dụng kết quả cũ.
- Apply rồi pencil/eraser/fill/picker/zoom/pan/undo vẫn hoạt động; Undo một lần về đúng grid/tranh trước import.
- Canvas cũ giữ nguyên khi cancel, decode thất bại hoặc worker crash.
- Chọn lại cùng file vẫn phát sinh import; file lỗi/ảnh quá lớn có thông báo rõ và chọn ảnh khác được ngay.
- Preview chưa chuẩn bị xong không cho mint dữ liệu cũ; payload trùng và RPC failure được phân biệt.
- Ước lượng payload thực đúng cho 1 run, nhiều run, toàn ảnh rỗng, ảnh nhiều màu, dither và trường hợp xấu nhất.
- Mở trang vẽ không tải worker/codec; conversion không phát request chứa ảnh nguồn.
- Kiểm tra ít nhất portrait, logo, line art, pixel sprite, gradient, ảnh thiếu sáng, landscape, transparent PNG, EXIF JPEG, large photo, corrupted file và solid color.
- Web test/typecheck/lint/build + production smoke phải qua. Toàn repo chỉ gọi xanh khi tất cả checks thật sự qua; hai wallet test lỗi đã biết từ lượt trước không được che bằng skip.

## 11. Nguồn kỹ thuật tham khảo

- MDN createImageBitmap: orientation, crop, resize và decode trong worker: https://developer.mozilla.org/en-US/docs/Web/API/WorkerGlobalScope/createImageBitmap
- MDN OffscreenCanvas: canvas ngoài main thread: https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas
- MDN image formats: phạm vi codec và khác biệt browser: https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Image_types

Nâng cấp sau P0: HEIC lazy decoder; palette từ artwork; paste ảnh có kiểm soát; lưu draft có người dùng chọn; lựa chọn crop thông minh/background removal chạy local nếu chi phí tải/memory phù hợp. Giữ các chức năng này tách khỏi bundle cơ bản.
