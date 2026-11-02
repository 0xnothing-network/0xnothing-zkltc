# 0xNothing zkLTC — mainnet preparation

Bản chuẩn bị cho mainnet, sinh từ bộ testnet v3 đang chạy (`../0xNothing-zkLTC-Testnet`). **Chưa deploy gì.** Web, ví và subgraph vẫn chạy testnet.

## Có gì trong thư mục này

| Thư mục | Nội dung |
| --- | --- |
| `contracts/` | Core v3 đúng như testnet: OracleRouter, NUSD, FeeSplitter, RewardStaking, OwnerTreasury, 0xPump + graduation, 0xPixel V2 + marketplace NUSD. Thêm `src/oracle/DIAOracleAdapter.sol`: adapter DIA có giới hạn giá, mainnet tự deploy. |
| `0xFi/contracts/` | 0xFi v3: factory/router V2, gauge, graduation adapter/controller, lending V2, synth, LP locker, metadata registry, WzkLTC. |
| `config/mainnet.env.example` | Các biến môi trường mà script cần. Không có giá trị mặc định nào. |

Chỉ những contract mà script deploy v3 thực sự dùng mới được sao chép. Các bản cũ v1/v2 không có ở đây. OpenZeppelin dùng chung bản vendored trong `../0xNothing-zkLTC-Testnet/0xFi/contracts/lib`.

Tham số kinh tế giữ nguyên như testnet (`../0xNothing-zkLTC-Testnet/docs/TOKENOMICS.md`):
- thặng dư 3,3× → 3,0×, mỗi tuần, chia 80/20;
- trần cung 1.000.000 NUSD, tự nhân đôi;
- phí NUSD 70/20/10, phí zkLTC 90/10;
- Pump 1.500/6.000;
- redeem luôn mở.

Muốn đổi thì sửa hằng số trong `contracts/script/DeployMainnetCore.s.sol`.

## Khác testnet: chống khai thác độ trễ oracle

Giữa hai lần cập nhật giá, giá DIA đứng yên còn giá thị trường vẫn chạy. Kẻ khai thác có thể mint NUSD ở giá cũ còn cao, rồi bán NUSD trên pool hoặc redeem sau khi giá cập nhật, để rút phần chênh từ dự trữ. Bản mainnet của `OracleNUSDv2` thêm ba lớp chặn (testnet đang chạy chưa có):

| Lớp | Cách hoạt động |
| --- | --- |
| Giá phải mới khi mint | `mint` và `releaseSurplus` từ chối giá cũ hơn `mintMaxPriceAge` (owner chỉnh trong khoảng 1 phút – 1 ngày). Redeem không bị chặn, vẫn luôn mở. |
| Hạn mức mint mỗi giờ | Mỗi giờ chỉ mint được tối đa `mintLimitPerWindow` NUSD. Kể cả khi oracle sai, số bị rút cũng có giới hạn. |
| Phí tới 2% | Trần phí mint và phí redeem nâng từ 0,5% lên 2%. Một vòng mint rồi redeem không có lời khi giá lệch nhỏ hơn khoảng hai lần phí (có fuzz test chứng minh). Nên đặt mỗi chiều phí ≥ một nửa ngưỡng lệch giá của feed. |

Ba giá trị này và tuổi giá tối đa của adapter đọc từ biến môi trường lúc deploy (`MAINNET_ORACLE_MAX_AGE_SECONDS`, `MAINNET_MINT_MAX_PRICE_AGE_SECONDS`, `MAINNET_MINT_LIMIT_PER_HOUR_NUSD`, `MAINNET_MINT_FEE_BPS`, `MAINNET_REDEEM_FEE_BPS`). Cách đặt theo feed thật:
- tuổi giá của adapter cao hơn heartbeat một chút;
- tuổi giá khi mint ≤ heartbeat;
- mỗi chiều phí ≥ một nửa ngưỡng lệch giá của feed.

## Kiểm thử

```bash
forge test --root 0xNothing-zkLTC-Mainnet/contracts
```

```bash
forge test --root 0xNothing-zkLTC-Mainnet/0xFi/contracts
```

Hoặc `npm run test:contracts:mainnet` ở gốc repo.

## Việc phải xong trước khi lên mainnet

1. **Dữ liệu chain:** chain ID, RPC, explorer của zkLTC mainnet; địa chỉ feed DIA LTC/USD, BTC/USD, ETH/USD (mô tả feed phải đúng `LTC/USD`, `BTC/USD`, `ETH/USD`); có wrapped zkLTC chuẩn hay không. Nếu không có thì deploy `0xFi/contracts/script/DeployWzkLTC.s.sol`.
2. **Bổ sung test còn thiếu.** Các test sau ở testnet viết cho AMM/lending v1 nên chưa sao chép:
   - farming (GaugeFactory/LiquidityGauge);
   - ZeroXFiGraduationAdapter và PumpGraduationController trên factory V2;
   - bộ test riêng cho PooledNUSDLendingPoolV2;
   - invariant AMM và rủi ro.

   Cần viết lại cho bản V2.
3. **Audit độc lập** toàn bộ `contracts/src` và `0xFi/contracts/src`.
4. **Quản trị:** dùng ví deploy riêng; sau khi deploy, chuyển admin/owner của từng contract sang multisig bằng bước chuyển 2 bước (`transferAdmin`/`acceptAdmin`, `transferOwnership`/`acceptOwnership`, `grantRole`/`renounceRole` của NUSD, `transferParamAdmin` của Pump).
5. **Hạn mức khởi đầu** (lending cap, debt ceiling synth, collateral cap) đang để bằng testnet và rất nhỏ. Xem lại trong `0xFi/contracts/script/Deploy0xFiMainnet.s.sol`.
6. **Hạ tầng:** subgraph Goldsky cho mainnet, cấu hình web/ví cho chain mới, keeper graduation.

## Deploy (khi đã đủ điều kiện)

Nạp biến từ `config/mainnet.env.example` (bản thật, không commit). Thứ tự:

1. Diễn tập trên fork: chạy `anvil --fork-url <MAINNET_RPC_URL>`, rồi chạy hai script bên dưới với `--rpc-url http://127.0.0.1:8545` và `MAINNET_MANIFEST_SUFFIX=.rehearsal`.
2. Chạy thật:

```bash
forge script script/DeployMainnetCore.s.sol:DeployMainnetCore --root 0xNothing-zkLTC-Mainnet/contracts --rpc-url $MAINNET_RPC_URL --broadcast --slow
```

```bash
forge script script/Deploy0xFiMainnet.s.sol:Deploy0xFiMainnet --root 0xNothing-zkLTC-Mainnet/0xFi/contracts --rpc-url $MAINNET_RPC_URL --broadcast --slow
```

Script 0xFi đọc địa chỉ core từ `MAINNET_NUSD`, `MAINNET_PUMP`… (lấy từ `contracts/deployments/mainnet-core.json`). Cả hai script từ chối chạy trên testnet 4441 và trên mọi chain khác `MAINNET_CHAIN_ID`. Graduation mở sau 1 giờ, giống bước `--activate` của testnet.
