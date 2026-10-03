# 0xNothing — tiến độ rà soát và nâng cấp

**Ngày:** 2026-10-03 (Asia/Saigon)  
**Phạm vi:** web LITVM và code dùng chung cho Testnet/Mainnet; giữ phong cách pixel, Departure Mono, nền tối và cấu trúc sản phẩm.  
**Trạng thái:** đã hoàn tất các bản sửa/nâng cấp dưới đây; kiểm thử tự động, build cuối và HTTP smoke đều đạt. Chưa commit hoặc phát hành lên production. Giới hạn visual QA 0xFi được ghi rõ bên dưới.

## Cấu trúc đã xác nhận

| Thành phần | Vị trí | Vai trò |
| --- | --- | --- |
| Web dùng chung | `0xNothing-zkLTC-Testnet/apps/web` | Next.js 15.5.24 App Router, React 19, wagmi 3, viem 2, TanStack Query 5, Tailwind 4 |
| 0xPixel | `apps/web/features/pixel`, `apps/web/app/0xpixel`, `contracts/src/0xpixel` | Vẽ/mint NFT, gallery, marketplace; hỗ trợ legacy và V2 |
| 0xPump | `apps/web/features/pump`, `contracts/src/0xpump`, `subgraphs/0xpump` | NUSD launchpad, curve trading, graduation có kiểm tra trạng thái onchain |
| 0xFi | `apps/web/features/fi`, `0xFi/contracts`, `0xFi/subgraph` | Swap, pools, lending, synth, earn và các thao tác nhiều bước |
| API và dữ liệu | `apps/web/app/api`, `apps/web/lib/server` | RPC/subgraph fallback, IPFS/metadata, cache và giới hạn yêu cầu |
| Ví | `apps/wallet` | Extension MV3 và app Android dùng chung React UI |
| Mainnet | `0xNothing-zkLTC-Mainnet` | Release overlay sử dụng frontend đã kiểm chứng từ Testnet, không có frontend phát triển độc lập |
| Công cụ/check | `scripts`, `TESTING.md`, `package.json` | Kiểm thử tooling, web, wallet, contracts và subgraphs |
| Đồ thị context | `graft` | Tra cứu spans/symbols/callers trước khi sửa source |

Đối chiếu: `0xNothing-zkLTC-Testnet/docs/ARCHITECTURE.md`, `0xNothing-zkLTC-Mainnet/README.md`, `0xNothing-zkLTC-Mainnet/apps/web-release/README.md`, cấu hình package và source tương ứng.

## Mốc ban đầu

- Git ban đầu sạch, branch `main`.
- Web: **153/153** kiểm thử đạt; TypeScript đạt.
- Lint thất bại **54 errors, 1431 warnings**: cấu hình quét cả bundle sinh ra ở `.dogeos`; test đóng gói đặt biến tên `module`, vi phạm quy tắc Next.js.
- Frontend hiện đang cấu hình **LitVM LiteForge Testnet, chain ID 4441**.
- Mainnet config vẫn `blocked-until-official-network-values-are-published`: chain ID/RPC/explorer, oracle, stablecoin, settlement route, DEX và adapter chưa có giá trị chính thức trong repo. Graduation Mainnet đang tắt.

## Tiến độ

- [x] Rà cấu trúc, ranh giới sản phẩm và mô hình release Testnet/Mainnet.
- [x] Ghi nhận baseline và sửa lint quét artifact sinh ra.
- [x] Đưa kiểm thử đóng gói DogeOS vào lệnh `test:web`.
- [x] Thêm trang khôi phục lỗi toàn web và lỗi root layout, giữ phong cách hiện tại; skip-link có đích nhận focus.
- [x] Xử lý giao dịch bị hủy/thay thế, tránh báo thành công sai hoặc chạy tiếp thao tác nhiều bước.
- [x] Sửa cache làm mới NFT sau mint/transfer; giới hạn payload RPC inventory.
- [x] Sửa TTL metadata khi upstream trả dữ liệu thiếu hoặc lỗi.
- [x] Nâng cấp home, responsive, tương tác, loading và accessibility dùng chung.
- [x] Chạy kiểm thử hồi quy, lint, TypeScript và các checks hợp đồng/subgraph liên quan.
- [x] Build production cuối sau sửa link Explorer tăng gas đạt 34/34 trang.
- [x] Kiểm tra home trên desktop/mobile và 0xPump mobile; ghi lại giới hạn browser bên dưới.
- [x] Refresh đồ thị `graft`.

## Các bản sửa đã hoàn thành

### Xác nhận giao dịch và luồng nhiều bước

- Thêm `lib/transactionReceipt.ts`, dùng chung cho toàn bộ 10 điểm chờ receipt của 0xFi/0xPump. Receipt thành công của giao dịch hủy trong ví không còn được coi là thao tác protocol thành công.
- Chỉ chấp nhận tăng gas khi Viem xác nhận `repriced` với ý định giao dịch giữ nguyên; từ chối `cancelled`, `replaced`, hash thay thế chưa xác minh và receipt reverted. Đã hủy/đổi thao tác thì việc tăng gas tiếp theo không phục hồi ý định ban đầu.
- 0xFi dừng các bước tiếp theo, giữ hash đã mined kể cả khi thất bại và làm mới dữ liệu sau thao tác đã mined.
- Thêm `lib/useProtocolReceipt.ts` cho mint/list/buy/cancel của 0xPixel và trang quản trị; thông báo thành công và bước list sau approve không nhận receipt hủy/thay thế. Hook cô lập trạng thái theo hash, từ chối replacement đã cache mà không có lịch sử xác minh.
- 0xPump mô phỏng lệnh trade sau approval, kiểm tra lại ví sau mô phỏng, từ chối quote chưa sẵn sàng/lỗi và khóa amount/side/slippage trong lúc gửi/xác nhận.
- Link Explorer khi xác nhận dùng hash thực tế sau tăng gas ở 0xFi, Pump fee claim, Pixel approval và Pixel purchase. Mẫu swap trong `/docs` cũng xử lý hủy/thay thế.

### Dữ liệu NFT và API

- `force=1` thực sự bỏ qua cache enumerate NFT 30 giây. Refresh lỗi trả lỗi thay vì giả danh sách cũ là mới, giữ cache tốt cho các lần đọc thường.
- Request token theo wallet+collection ngăn RPC cũ hoàn tất muộn ghi đè refresh mới; bookkeeping giới hạn 1.024 identity, token bị evict mất quyền ghi cache. Regression bao gồm ví vừa chuyển NFT cuối cùng, kết quả mới `[]`.
- Inventory V2 dùng `tokenPackedData` thay cho `tokenData` phải chuyển packed art sang chuỗi legacy trên chain. Metadata/listings được đọc theo batch tối đa 20 NFT, giữ thứ tự và hỗ trợ cả hai collection.
- Metadata thiếu/lỗi tạm thời trả `no-store` ở cả HTTP cache và Cloudflare CDN, tránh kéo dài lỗi 2 giây nội bộ thành 30–60 giây trên CDN; metadata đầy đủ vẫn dùng public cache.

### Giao diện, khôi phục và công cụ

- Giữ centered hero “Nothing to everything”, Departure Mono/pixel, palette tối/olive/mint và các URL hiện tại. Home có thứ bậc chữ/khoảng cách rõ hơn, mô tả ngắn cho 3 sản phẩm, footer và social link dễ dùng.
- Bố cục home thích ứng desktop, 390px và 320px; không tràn ngang. Mobile Pump sort không còn cắt nhãn “Last trade”.
- Focus bàn phím nhìn rõ trên button/link/control, touch target tốt hơn, feedback disabled/pressed nhất quán, hỗ trợ reduced motion/forced colors. Loader dùng cùng surface và có loading text cho screen reader.
- Thêm root/route error boundary với retry/home/docs; thông báo nhắc kiểm tra giao dịch đã gửi trước khi thử lại. Skip-link có đích nhận focus.
- ESLint bỏ qua `.dogeos` được sinh ra; sửa biến `module` trong test đóng gói. `test:web` chạy cả test đóng gói, không chỉ test TypeScript.
- Không thêm dependency hoặc thay framework, font nhận diện, địa chỉ triển khai hay logic hợp đồng.

## Kết quả kiểm tra

| Kiểm tra | Kết quả |
| --- | --- |
| Web: `npm run test:web` | **180/180 đạt**, từ baseline 153 test; bao gồm đóng gói, receipt/race regressions |
| Pixel checks sau sửa link Explorer | **7/7 đạt** |
| Web: `npm run lint:web` | Đạt, không lỗi/cảnh báo |
| Web: `npm run typecheck:web` | Đạt |
| Web production build | Build cuối sau sửa Explorer đạt **34/34** trang, lint/TypeScript trong build đạt |
| Wallet tests / typecheck / build | **151/151 đạt**, TypeScript/build đạt |
| Root tooling | **11/11 đạt** |
| Testnet contracts | **96/96 đạt** (Foundry, bao gồm fuzz/invariants) |
| Mainnet contracts | **72/72 đạt** (Foundry local) |
| 0xFi contracts | **160/160 đạt**, size check đạt; warning timestamp hiện có không phải lỗi build |
| 0xFi scripts | Syntax **33** scripts đạt; **28/28** tests đạt |
| Pixel subgraph | **8/8** tests và codegen/build đạt |
| 0xFi subgraph | **22/22** tests và codegen/build đạt |
| Pump Testnet/Mainnet subgraphs | Parity **9** mirrored files đạt; codegen/build và compile tests đạt ở cả hai |
| RPC read-only | `eth_chainId = 0x1159 = 4441` khớp web cấu hình |
| HTTP smoke | `/`, `/0xFi/swap`, `/0xPump`, `/0xpixel` đều **200**, có đúng product/home copy mới; home có đích skip-link nhận focus |
| Git diff whitespace | Đạt |
| Graft | Refresh đạt: **1.419** files/cards, **16.044** edges |

Các thành phần của verification gate được chạy riêng để thu kết quả từng lớp,
không chạy lại lệnh tổng `npm run verify` sau khi từng check đã đạt. Foundry được
gọi từ `C:/Users/tdat/.foundry/bin/forge.exe` vì executable chưa có trên PATH.
Fork tests có điều kiện môi trường không đồng nghĩa đã chạy giao dịch thật trên mạng.

### Bundle và giới hạn xác minh

- Build: shared First Load JS **103 kB**, middleware **34,3 kB**, home **112 kB**, Fi swap **251 kB**, Fi pool detail **254 kB**, Pump home **216 kB**. Không tuyên bố bundle nhỏ hơn: so với mốc lịch sử tháng 8, shared chunk giữ nguyên, các route Fi tăng khoảng 2 kB với kiểm tra receipt mới.
- Đã nhìn trực tiếp home mới ở desktop, 390×844 và 320×568; Pump mobile có market data và không tràn ngang. Viewport override đã reset.
- Browser/CDP timeout ở bước focus/navigation khiến chưa hoàn tất visual QA 0xFi và chưa lưu được ảnh chụp cuối. HTTP/build/tests là bằng chứng kiểm tra khác, không thay thế phần visual QA còn thiếu.
- Không thực hiện giao dịch thật, deployment, thao tác ví người dùng, commit hoặc push. Preview local: `http://127.0.0.1:3000`.

## Giới hạn phát hành

Mainnet dùng chung source nên được hưởng các bản sửa frontend. Việc nâng cấp source không tự chứng minh đã sẵn sàng triển khai Mainnet: vẫn cần thông số mạng chính thức, địa chỉ deployment, oracle/settlement/DEX/adapter, indexing và các gate hợp đồng/release được xác minh. Không thay các giá trị `null` bằng địa chỉ suy đoán.
