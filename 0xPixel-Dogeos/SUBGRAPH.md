# Subgraph trên Goldsky

Đã deploy vào project **dogosxpixel**: `dogeos-pixel/1.0.1`, tag `prod`, network `dogeos-testnet`. Query thực trả về 6 NFT, 2 collection và 2 sale, không có indexing error tại thời điểm kiểm tra. Bản 1.0.1 thêm chỉ mục approval để bộ lọc For sale và phân trang loại listing bị revoke đúng cách.

- [Endpoint prod](https://api.goldsky.com/api/public/project_cmupqw08z0f4301vmcyh60xs9/subgraphs/dogeos-pixel/prod/gn)
- [Endpoint phiên bản 1.0.1](https://api.goldsky.com/api/public/project_cmupqw08z0f4301vmcyh60xs9/subgraphs/dogeos-pixel/1.0.1/gn)
- Bản ghi: `deployments/goldsky-subgraph.json`.
- Bằng chứng query và tích hợp web: `output/subgraph-live.json`.

Endpoint public không cần API token. CLI dùng đăng nhập Goldsky trên máy; không đưa token vào web hoặc source. `.env.local` của web đã có `SUBGRAPH_URL` trỏ tới tag `prod`; server đã restart để áp dụng.

Source ở `subgraph/src`, schema ở `subgraph/schema.graphql`, manifest ở `subgraph/subgraph.yaml`, ABI ở `subgraph/abis`.

## Build

```powershell
cd C:\Users\tdat\Desktop\0xnothing\0xPixel-Dogeos
npm ci --prefix subgraph
npm run subgraph:build
```

Manifest sinh tự động từ `deployments/chikyu.json`, không phải địa chỉ giả. Network mặc định `dogeos-testnet`. Có thể đặt `SUBGRAPH_NETWORK` trong `.env.local` nếu provider của bạn đặt tên mạng khác. `FEE_RECIPIENT` cũng sinh từ deployment để thống kê credit khớp contract.

| Data source | Start block |
| --- | --- |
| DogeosPixel: `0x5f99636850e62d41e03b29ba53b5dc285d4ceab8` | 8204635 |
| PixelMarket: `0xc1f82f63ee635154e5655afe2fcba4a5e85b1e6b` | 8204637 |

## Deploy phiên bản mới

```powershell
cd C:\Users\tdat\Desktop\0xnothing\0xPixel-Dogeos
# Chọn version mới; chuyển tag prod khi muốn web dùng version đó:
npm run subgraph:deploy -- dogeos-pixel/1.0.2 --tag audit
# Sau khi kiểm tra endpoint phiên bản mới:
goldsky subgraph tag create dogeos-pixel/1.0.2 --tag prod
```

`subgraph:deploy` build lại trước khi gọi Goldsky. Tag `prod` giữ URL ổn định khi chuyển phiên bản. Không cần deploy lại contract.

## Kiểm tra bản đang chạy

```powershell
goldsky subgraph list dogeos-pixel/1.0.1
npm run test:subgraph-live
# Log liên tục, Ctrl+C để dừng:
goldsky subgraph log dogeos-pixel/1.0.1 --since 10m --filter warn
```

Test live chỉ đọc, kiểm tra `_meta.hasIndexingErrors`, NFT/collection/listing và catalog của web qua endpoint thật. Catalog phải trả `source: "subgraph"`. Server tự dùng RPC khi endpoint lỗi hoặc index chưa theo kịp event mới. Sort theo giá dùng RPC vì GraphQL không hỗ trợ sắp xếp theo trường quan hệ listing trong query hiện tại.

## Graph Node riêng

Goldsky là provider đang dùng. The Graph cũng cho phép self-host Graph Node cho EVM network khi cần đổi provider.

Có file `subgraph/docker-compose.yml` cho Graph Node/Postgres/IPFS. Đặt `GRAPH_POSTGRES_PASSWORD` và `DOGEOS_ARCHIVE_RPC_URL` trong `subgraph/.env` trước khi chạy; không dùng key deployer ở đây. RPC cần hỗ trợ historical `eth_call` tại block mint vì mapping lấy packed artwork từ NFT contract. Public RPC có thể dùng cho thử nghiệm nếu hỗ trợ archive; hãy kiểm tra hoặc dùng archive provider khi triển khai lâu dài.

```powershell
cd subgraph
docker compose up -d
npm run create:local
npm run deploy:local
```

Chỉ chạy các lệnh Graph Node nếu muốn chuyển sang self-host. Dịch vụ bind cổng vào loopback. Các image tag `latest` cần được pin theo release/digest bạn chọn khi vận hành server.

GraphQL endpoint sau khi deploy Graph Node:

```text
http://127.0.0.1:8000/subgraphs/name/dogeos-pixel
```

Nếu dùng Graph Node thay Goldsky, đổi `.env.local` của web rồi restart `npm start`:

```dotenv
SUBGRAPH_URL=http://127.0.0.1:8000/subgraphs/name/dogeos-pixel
```

## Dữ liệu và xử lý event

- `Pixel`: packed artwork, creator, owner, ownership nonce, collection hiện tại, listing.
- `Collection`: owner, name, description, membership và pixel count.
- `Listing`: ID riêng mỗi lần đổi giá, seller, price, expiry, nonce, trạng thái lịch sử.
- `Offer`: bidder, amount ký quỹ, expiry và trạng thái; expiry được đánh giá theo timestamp lúc query/UI, không giả lập event hết hạn.
- `Sale`: giá, seller, buyer, royalty, protocol fee, kiểu fixed-price hoặc offer.
- `Account`: credit nhận từ sale/refund, trừ khi rút.
- `Activity` và `Stats`: log giao dịch, số mint/collection/sale, volume, royalty và fee.

Transfer xảy ra trước `Sold`/`OfferAccepted`: mapping giữ metadata/creator, cập nhật owner và vô hiệu listing cũ; sale handler đánh dấu lịch sử đã bán và cập nhật tiền. Self-transfer không tăng nonce. Credit seller/creator/fee recipient được cộng riêng kể cả khi cùng địa chỉ.

Mapping theo dõi `Approval` và `ApprovalForAll`. Revocation không xóa lịch sử listing; reapproval có thể khôi phục quyền bán nếu nonce, owner và expiry vẫn hợp lệ. Self-transfer xóa token approval nhưng giữ approval-for-all. Bộ lọc kết hợp dùng `or` ở một cấp riêng để tương thích Graph Node trên Goldsky. Web còn đọc `isListingActive` và simulate giao dịch. Khi chuyển mạng/tài khoản, session cũ không được dùng để ký.

Mapping logic được kiểm tra bằng entity-store harness chạy source thực, compile AssemblyScript/WASM và index thực trên Goldsky.

## Query ví dụ

```graphql
{
  pixels(first: 24, orderBy: tokenId, orderDirection: desc) {
    id name grid pixels owner creator
    collection { id name }
    listing { id price expiry status }
  }
  stats(id: "global") { minted collections sales volume royalties fees }
  _meta { block { number } hasIndexingErrors }
}
```

Graph CLI 0.98.1 khóa một số dependency cũ. `package.json` dùng overrides đã kiểm tra codegen/build để cập nhật dependency dễ bị lỗi; audit của cả subgraph toolchain hiện là 0 vulnerabilities. Khi nâng Graph CLI, chạy lại build và audit.

[Goldsky deployment](https://docs.goldsky.com/subgraphs/deploying-subgraphs) · [Goldsky GraphQL endpoints](https://docs.goldsky.com/subgraphs/graphql-endpoints) · [Graph Node docs](https://thegraph.com/docs/en/indexing/tooling/graph-node/)
