# DOGEOS × PIXEL

Bản độc lập của 0xPixel cho DogeOS, đặt tại `C:\Users\tdat\Desktop\0xnothing\0xPixel-Dogeos`.

**Web:** http://localhost:3300/DOGEOSxPIXEL

## Chạy

```powershell
cd C:\Users\tdat\Desktop\0xnothing\0xPixel-Dogeos
npm ci
npm run build
npm start
```

`npm start` tự dùng cổng 3300 khi còn trống. Nếu web workspace đã chạy trên 3300, app dùng 3301 và được chuyển tiếp qua route `/DOGEOSxPIXEL` của workspace. File tích hợp duy nhất nằm ngoài thư mục này là `../0xNothing-zkLTC-Testnet/apps/web/app/DOGEOSxPIXEL/[[...path]]/route.ts`.

`npm run dev` chạy Vite middleware để phát triển; refresh browser sau khi sửa source. `PORT` có thể cấu hình trong `.env.local`.

## Đã có

- Chế độ sáng/tối: nút mặt trăng/mặt trời cạnh Connect wallet; mặc định theo hệ thống, lưu lựa chọn trên trình duyệt và áp dụng trước khi trang vẽ lần đầu.
- Studio 8/16/32/64/128/256: pencil, eraser, flood fill, eyedropper, màu tùy chọn, grid, undo/redo, nét vẽ liên tục, lưu draft cả khi reload nhanh.
- Import PNG/JPEG/WebP hoặc JSON, export PNG/JSON; ảnh import được rasterize theo kích thước canvas.
- ERC-721: miễn phí mint ngoài phí mạng; ảnh SVG, tên và mô tả lưu hoàn toàn trên chain; chống mint trùng và encoding không canonical.
- Collection: người đang sở hữu ít nhất một NFT được tạo collection; chủ collection sửa tên/mô tả; chủ NFT thêm NFT vào collection của mình hoặc gỡ khỏi collection hiện tại.
- Marketplace non-custodial: niêm yết, thay giá, hủy niêm yết, mua bằng DOGE, offer ký quỹ, nhận offer, hủy/reclaim offer hết hạn, rút tiền.
- Token approval riêng từng NFT; kiểm tra quyền, expiry, listing ID và ownership nonce trước khi mua.
- Trang Explore, Collections, My pixels, Activity; search, lọc, sắp xếp, phân trang, chi tiết NFT, lịch sử và link explorer.
- Browser wallet qua EIP-1193/EIP-6963, chuyển chain, kiểm tra session/account trước khi ký, xử lý từ chối ký.
- Ước lượng phí thực thi **và** phí data/finality qua oracle DOGEOS trước khi gửi giao dịch. Ví cần đủ DOGE ngoài giá mua/offer.
- Subgraph đã deploy trên Goldsky; RPC event index dự phòng khi endpoint lỗi hoặc chậm đồng bộ.

Collection là nhóm curate trong cùng contract ERC-721, không phải một contract NFT mới. Khi NFT đổi chủ, membership được giữ để bảo toàn câu chuyện; chủ mới có thể chuyển NFT sang collection của mình. Ảnh, creator và royalty không đổi.

## Mạng và contract đã deploy

| Thuộc tính | Giá trị |
| --- | --- |
| Mạng | DogeOS Chikyū Testnet |
| Chain ID | 6281971 |
| Native token | DOGE, 18 decimals |
| RPC | https://rpc.testnet.dogeos.com |
| Compiler / EVM | Solidity 0.8.34 / Prague, via IR, optimizer 200 |
| NFT | `0x5f99636850e62d41e03b29ba53b5dc285d4ceab8` |
| Marketplace | `0xc1f82f63ee635154e5655afe2fcba4a5e85b1e6b` |
| NFT start block | 8204635 |
| Marketplace start block | 8204637 |
| Fee recipient | `0x3e2641D38f7A309Ed82bC5009bB2aA0010122005` |

Deployment, transaction hash và bytecode settings ở `deployments/chikyu.json`. Đây là testnet và mọi khoản thanh toán dùng test DOGE.

Cả hai contract đã verify source thành công trên explorer: [NFT](https://dogeos-testnet.l2scan.co/address/0x5f99636850e62d41e03b29ba53b5dc285d4ceab8), [Marketplace](https://dogeos-testnet.l2scan.co/address/0xc1f82f63ee635154e5655afe2fcba4a5e85b1e6b).

## Mua bán và phí

NFT ở trong ví chủ khi niêm yết. Listing/offer từ UI có thời hạn 30 ngày; contract giới hạn tối đa 365 ngày. Người mua gửi đúng giá và đúng listing ID. Mỗi lần chuyển sang chủ khác tăng ownership nonce, nên listing cũ không sống lại khi NFT được chuyển về ví ban đầu.

Mỗi sale: seller nhận 98%, creator gốc 1%, protocol 1%, tính theo số nguyên wei. Nếu seller cũng là creator thì seller nhận tổng 99%. Earnings và refund được **credit** trong market; rút từ My pixels. Payout dùng pull payment, nên ví từ chối nhận DOGE không thể chặn sale. Bidder có thể hủy offer kể cả sau expiry để nhận refund credit.

## Secret và dữ liệu

`PRIVATE_KEY` ở `.env.local` chỉ dùng cho script deploy/smoke trên máy. Không đưa key vào browser, API config, bundle, URL hoặc subgraph. Browser luôn ký bằng wallet của người dùng. Server chỉ cho phép RPC đọc/estimate; không có API ký hay gửi giao dịch bằng key deployer.

`.env.local`, `.runtime`, dependency và build output được git-ignore. Không copy `.env.local` sang thư mục public. Thiết lập công khai xem `.env.example`.

RPC index đọc logs theo từng 1,000 blocks, có checkpoint, kiểm tra hash để phát hiện reorg và rebuild khi cần. Artwork được cache; ownership, collection và listing được kiểm tra lại trên cùng block khi trả chi tiết. Catalog giới hạn 48 NFT mỗi request và đọc có giới hạn concurrency.

`SUBGRAPH_URL` đã nối tới endpoint `prod` của Goldsky trong `.env.local` và `.env.example`: server dùng subgraph để tìm NFT/collection khi index không quá cũ và không có indexing error; fallback RPC khi endpoint lỗi. Quyền sở hữu và lệnh bán vẫn được kiểm tra trên chain trước giao dịch.

## Kiểm thử

```powershell
npm test
npm run test:contracts
npm run build
npm ci --prefix subgraph
npm run subgraph:build
# Web cần đang chạy cho ba lệnh sau:
npm run test:ui
npm run test:wallet-ui
npm run test:api
npm run test:subgraph-live
npm run test:subgraph-client
npm run test:studio
npm run test:wallet-races
npm run test:ui-regressions
npm run test:chain-readonly
npm run test:providers
```

53 contract checks, gồm 4 fuzz tests chạy 512 cases/test và 2 stateful invariants chạy 64 × 96 calls/invariant; 48 unit/backend/mapping/fee/codec tests. Browser tests kiểm tra desktop/mobile, draft 65,536 runs, import/export, phân trang, đổi session ngay trước ký, kết nối/đổi mạng đang chờ và từ chối ký. Ví giả lập không ký giao dịch. Báo cáo rà soát sâu và giới hạn kỹ thuật ở [AUDIT.md](./AUDIT.md).

Smoke test đã gửi giao dịch thật bằng deployer và ví test thứ hai: mint, collection của creator và secondary owner, membership, approval, list, buy, offer, accept, cancel, refund, earnings và royalty. Có 6 NFT mẫu thật đang niêm yết. Bằng chứng ở `output/live-smoke.json`; screenshot và báo cáo UI/API nằm cùng thư mục.

`npm run smoke:chain` **thực hiện giao dịch testnet và tiêu DOGE**; chỉ chạy khi muốn lặp lại integration test. Ví test của script được suy ra riêng từ key deployer trong memory để có thể phục hồi khi script gián đoạn. Script giữ dự phòng phí và hoàn phần DOGE dư về deployer. Một lần thử đầu đã để lại 0.08 test DOGE trong ví tạm `0x65d70CF87f3B0aCFf093ede20fA5Cf5AE03b162B` do thiếu dự phòng phí; ví tạm này không được giữ key. Các lần sau dùng signer có thể phục hồi.

## Subgraph

Đã deploy `dogeos-pixel/1.0.1`, tag `prod`, trong project Goldsky `dogosxpixel`. [GraphQL endpoint](https://api.goldsky.com/api/public/project_cmupqw08z0f4301vmcyh60xs9/subgraphs/dogeos-pixel/prod/gn) đã được nối vào web. Query thực kiểm tra NFT, collection, approval và sale không có indexing error. Xem [SUBGRAPH.md](./SUBGRAPH.md) để query, kiểm tra và deploy phiên bản mới. Bản ghi deployment ở `deployments/goldsky-subgraph.json`; kiểm tra tích hợp ở `output/subgraph-live.json`.

## Tài liệu đã đối chiếu

- [DogeOS Developer Quickstart](https://docs.dogeos.com/en/developers/developer-quickstart)
- [Contract deployment](https://docs.dogeos.com/en/developers/guides/contract-deployment-tutorial)
- [Ethereum & DogeOS differences](https://docs.dogeos.com/en/developers/ethereum-and-dogeos-differences)
- [Transaction fees](https://docs.dogeos.com/en/developers/transaction-fees-on-dogeos)
- [Contract verification](https://docs.dogeos.com/en/developers/verifying-smart-contracts)
- [The Graph: Graph Node](https://thegraph.com/docs/en/indexing/tooling/graph-node/)
- [Goldsky: Deploy a subgraph](https://docs.goldsky.com/subgraphs/deploying-subgraphs)

`DogeosPixel` kế thừa encoding/rendering của `ZeroXPixelV2`, tách riêng source để bản LitVM không bị đổi. Giao diện và marketplace được xây riêng cho DOGEOSxPIXEL.
