# Public DOGEOS × PIXEL

## Vì sao bản public báo offline

Route của workspace trước đây gọi cố định `http://127.0.0.1:3301`. Sau khi deploy workspace, địa chỉ đó trỏ vào máy hosting. Server DOGEOSxPIXEL trên máy Windows không tự được đưa lên cùng workspace.

Ứng dụng có frontend Vite và backend Node/Express cho catalog, metadata, RPC đọc và index dự phòng. Chỉ upload `dist` không cung cấp các API này. Backend không cần PRIVATE_KEY hoặc Goldsky API token.

## Bản Vercel của www.0xnothing.xyz

Workspace Next.js đóng gói DOGEOSxPIXEL vào chính bản deploy. Trong `0xNothing-zkLTC-Testnet/apps/web`, `npm run build` chạy prepare script trước `next build`: build frontend, bundle Node handler và đưa các file runtime cần thiết vào `.dogeos`. Route `/DOGEOSxPIXEL` phục vụ frontend, assets và API từ bundle này trong production.

Vercel vẫn dùng Root Directory `0xNothing-zkLTC-Testnet/apps/web`, Build Command `npm run build`. Build cần truy cập thư mục `0xPixel-Dogeos` trong cùng repository; bật tùy chọn Include source files outside of the Root Directory nếu project đang giới hạn nguồn vào thư mục web. Không cần tạo project/backend thứ hai hoặc giữ máy Windows chạy.

Không đặt `DOGEOS_PIXEL_ORIGIN` khi dùng bundle mặc định. Nếu trước đây đã đặt biến này trỏ tới localhost hoặc service không chạy, xóa biến ở environment production rồi redeploy. Biến này chỉ dùng khi chủ động chọn backend bên ngoài.

Next.js file tracing đưa `.dogeos` vào function `/DOGEOSxPIXEL`. Prepare script chỉ đóng gói frontend đã build, Node handler, deployment public và hai ABI; không copy `.env.local`, private key, Goldsky token, checkpoint hoặc output test.

Railway dùng cùng bundle trong image Next.js standalone. Cloudflare DNS/CDN đặt trước Railway cũng dùng backend này. Cấu hình deploy trực tiếp lên Cloudflare Workers/OpenNext trong repo là một runtime khác: bundle Node dùng filesystem và dynamic import chưa được xác minh trên Worker. Với đường deploy đó, cần cấu hình `DOGEOS_PIXEL_ORIGIN` tới một Node origin đang chạy và kiểm tra truy cập từ Worker; không mặc định coi bản Node là tương thích Workers.

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

## Tùy chọn backend bên ngoài workspace

Nếu muốn workspace dùng một backend Node riêng, deploy service ở trên rồi đặt **DOGEOS_PIXEL_ORIGIN** trong environment của workspace Next.js bằng origin thật của service đó, gồm scheme + hostname + port khi cần. Không thêm `/DOGEOSxPIXEL`, query, credentials hay trailing path vào biến này.

Khi biến này có giá trị, server-side proxy giữ nguyên path và query, chuyển tiếp GET/HEAD/POST, giới hạn body 64 KiB và từ chối cấu hình trỏ ngược về chính workspace. Thay environment của workspace rồi redeploy/restart workspace. Khi không cấu hình biến này, production dùng bundle mặc định.

Trong local development, workspace trên 3300 vẫn có thể chuyển tiếp tới app trên 3301. Khi app chạy riêng trên 3300 thì mở app trực tiếp như hiện tại.

## Kiểm chứng bản public

1. Mở `/DOGEOSxPIXEL/api/config`: HTTP 200, chainId `6281971`.
2. Mở `/DOGEOSxPIXEL/api/catalog?limit=2`: JSON có NFT và trường `source`.
3. Mở `/DOGEOSxPIXEL/market`, `/DOGEOSxPIXEL/studio`, `/DOGEOSxPIXEL/collections` trực tiếp và reload; assets phải tải được.
4. Kiểm tra server chạy liên tục và route RPC nhận POST. Ví ký từ trình duyệt; server chỉ đọc/ước lượng RPC.

Các test hosting/proxy nằm ở `tests/hosting-smoke.test.mjs` và `tests/proxy-hosting.test.mjs`, bao gồm production giữ đúng PORT, truy cập qua host mạng, proxy origin, query/body/header, giới hạn request và tránh self-loop.

Tham khảo [Next.js self-hosting](https://nextjs.org/docs/app/guides/self-hosting) và [Node Docker image](https://github.com/nodejs/docker-node/blob/main/README.md).
