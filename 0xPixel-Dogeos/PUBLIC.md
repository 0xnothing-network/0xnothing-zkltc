# Public DOGEOS × PIXEL

## Vì sao bản public báo offline

Route của workspace trước đây gọi cố định `http://127.0.0.1:3301`. Sau khi deploy workspace, địa chỉ đó trỏ vào máy hosting. Server DOGEOSxPIXEL trên máy Windows không tự được đưa lên cùng workspace.

Ứng dụng có frontend Vite và backend Node/Express cho catalog, metadata, RPC đọc và index dự phòng. Chỉ upload `dist` không cung cấp các API này. Backend không cần PRIVATE_KEY hoặc Goldsky API token.

## Deploy ứng dụng độc lập

Thư mục deploy/build context: `0xPixel-Dogeos`.

- Build command: `npm ci && npm run build`.
- Start command: `npm start`.
- Node: 22.12 trở lên trong nhánh 22, hoặc Node 24.
- Environment: `NODE_ENV=production`, `HOST=0.0.0.0`; dùng `PORT` do hosting cấp.
- `SUBGRAPH_URL`: endpoint public `prod` đã có trong `.env.example`; không cần token.
- Health check: `/DOGEOSxPIXEL/api/config`.
- Đường dẫn web: `/DOGEOSxPIXEL`; cần chuyển tiếp cả các đường dẫn con, assets và POST `/DOGEOSxPIXEL/api/rpc`.

Thư mục `.runtime` phải có quyền ghi. Checkpoint có thể được tạo lại từ chain khi service restart; volume bền vững giúp giảm thời gian đọc lại logs. Không cần Forge hoặc `contracts/out` để chạy web.

### Docker

Dockerfile đã kèm build frontend và backend production. Image dùng user `node`, tạo `.runtime` có quyền ghi và có health check. `.dockerignore` loại `.env.local`, private keys, `.runtime`, output, contracts và subgraph khỏi build context.

```powershell
cd C:\Users\tdat\Desktop\0xnothing\0xPixel-Dogeos
docker build -t dogeos-pixel .
docker run -d --name dogeos-pixel -p 8080:3300 dogeos-pixel
```

Sau lệnh trên, kiểm tra `http://localhost:8080/DOGEOSxPIXEL` và `/DOGEOSxPIXEL/api/config`. Hosting cần HTTPS cho domain public; reverse proxy chuyển tiếp tới container và giữ nguyên path.

Máy hiện tại chưa có Docker, nên chưa chạy build image ở đây. Process smoke tests đã kiểm tra backend chạy với `HOST=0.0.0.0`, PORT riêng và RPC giả; không giao dịch chain.

## Public qua workspace Next.js

Nếu giữ URL của workspace rồi mở `/DOGEOSxPIXEL`, cần deploy backend Node ở trên và đặt **DOGEOS_PIXEL_ORIGIN** trong environment của workspace Next.js bằng origin thật của service đó, gồm scheme + hostname + port khi cần. Không thêm `/DOGEOSxPIXEL`, query, credentials hay trailing path vào biến này.

Production yêu cầu biến này; không tự gọi localhost. Server-side proxy giữ nguyên path và query, chuyển tiếp GET/HEAD/POST, giới hạn body 64 KiB và từ chối cấu hình trỏ ngược về chính workspace. Thay environment của workspace rồi redeploy/restart workspace.

Trong local development, workspace trên 3300 vẫn có thể chuyển tiếp tới app trên 3301. Khi app chạy riêng trên 3300 thì mở app trực tiếp như hiện tại.

## Kiểm chứng bản public

1. Mở `/DOGEOSxPIXEL/api/config`: HTTP 200, chainId `6281971`.
2. Mở `/DOGEOSxPIXEL/api/catalog?limit=2`: JSON có NFT và trường `source`.
3. Mở `/DOGEOSxPIXEL/market`, `/DOGEOSxPIXEL/studio`, `/DOGEOSxPIXEL/collections` trực tiếp và reload; assets phải tải được.
4. Kiểm tra server chạy liên tục và route RPC nhận POST. Ví ký từ trình duyệt; server chỉ đọc/ước lượng RPC.

Các test hosting/proxy nằm ở `tests/hosting-smoke.test.mjs` và `tests/proxy-hosting.test.mjs`, bao gồm production giữ đúng PORT, truy cập qua host mạng, proxy origin, query/body/header, giới hạn request và tránh self-loop.

Tham khảo [Next.js self-hosting](https://nextjs.org/docs/app/guides/self-hosting) và [Node Docker image](https://github.com/nodejs/docker-node/blob/main/README.md).
