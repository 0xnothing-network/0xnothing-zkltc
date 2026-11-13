# 0xNothing zkLTC — mainnet preparation

Bản chuẩn bị cho mainnet, sinh từ bộ testnet v3 đang chạy (`../0xNothing-zkLTC-Testnet`). **Chưa deploy gì.** Web, ví và subgraph vẫn chạy testnet.

## Có gì trong thư mục này

| Thư mục | Nội dung |
| --- | --- |
| `contracts/` | Core v3: OracleRouter, NUSD, FeeSplitter, RewardStaking, OwnerTreasury, 0xPump + graduation, 0xPixel V2 + marketplace NUSD. Thêm `src/oracle/DIAOracleAdapter.sol`: adapter DIA có giới hạn giá, mainnet tự deploy. |
| `0xFi/contracts/` | 0xFi v3: factory/router V2, gauge, graduation adapter/controller, lending V2, synth, LP locker, metadata registry, WzkLTC. |
| `config/mainnet.env.example` | Các biến môi trường mà script cần. Không có giá trị mặc định nào. |
| `docs/AUDIT_2026-11.md` | Báo cáo đợt audit nội bộ tháng 11/2026: 29 phát hiện, cách sửa, bảng quyền quản trị, những gì còn lại. |

Chỉ những contract mà script deploy v3 thực sự dùng mới được sao chép. Các bản cũ v1/v2 không có ở đây. OpenZeppelin dùng chung bản vendored trong `../0xNothing-zkLTC-Testnet/0xFi/contracts/lib`.

Tham số kinh tế giữ nguyên như testnet (`../0xNothing-zkLTC-Testnet/docs/TOKENOMICS.md`):
- thặng dư 3,3× → 3,0×, mỗi tuần, chia 80/20;
- trần cung 1.000.000 NUSD, tự nhân đôi;
- phí NUSD 70/20/10, phí zkLTC 90/10;
- Pump 1.500/6.000;
- redeem luôn mở.

Muốn đổi thì sửa hằng số trong `contracts/script/DeployMainnetCore.s.sol`.

## Khác testnet

Mã ở đây không còn giống hệt testnet. Các thay đổi dưới đây chỉ có ở bản mainnet; contract testnet đang chạy không đổi. Phần lớn đến từ đợt audit nội bộ (`docs/AUDIT_2026-11.md`), trong đó mỗi lỗi đã sửa đều có test tái hiện.

### NUSD: chống khai thác độ trễ oracle

Giữa hai lần cập nhật giá, giá DIA đứng yên còn giá thị trường vẫn chạy. Ai giao dịch với NUSD ở giá cũ sẽ rút phần chênh từ dự trữ. `OracleNUSDv2` bản mainnet chặn bằng bốn lớp:

| Lớp | Cách hoạt động |
| --- | --- |
| Giá phải mới khi mint | `mintAtOracle` và `releaseSurplus` từ chối giá cũ hơn `mintMaxPriceAge` (owner chỉnh trong khoảng 1 phút – 1 ngày). |
| Hạn mức mint nạp lại dần | Không mint được quá `mintLimitPerWindow` NUSD cùng lúc; hạn mức đã dùng nạp lại đều trong một giờ. Kể cả khi oracle sai, số bị rút vẫn có giới hạn. |
| Phí mỗi chiều tới 2% | Giao dịch với giá trễ chỉ cần một chiều (mint rồi bán NUSD, hoặc mua NUSD rồi redeem), nên **mỗi** phí phải ≥ ngưỡng lệch giá của feed. Script deploy từ chối cấu hình thấp hơn. |
| Redeem với giá cũ trả phí tối đa | Redeem không bao giờ bị chặn. Nhưng khi giá cũ hơn `mintMaxPriceAge`, redeem trả phí 2% thay cho `redeemFeeBps`; phí ở lại dự trữ. |

### NUSD: lối thoát khi oracle chết, và thặng dư

- **Lối thoát 7 ngày.** Khi oracle không định giá được, ai cũng gọi được `reportOracleFailure`. Nếu báo cáo còn đứng sau 7 ngày và lúc đó oracle vẫn chết thì `emergencyRedeem` trả mỗi người phần dự trữ theo tỉ lệ. Báo cáo bị xoá ngay khi chính NUSD thấy oracle định giá được: ở mọi lệnh mint, redeem, phát hành thặng dư, và ở mọi lần chuyển NUSD được gửi kèm đủ gas cho một lần đọc giá (trong lúc có báo cáo, mỗi lần chuyển thử đọc giá một lần, lần đọc đó được cấp tối đa 200.000 gas). `oracleFailureExitAt()` trả về thời điểm lối thoát mở nếu báo cáo còn đứng tới lúc đó.
- **Ngưỡng phát hành đo trên nguồn cung bền.** NUSD đã redeem vẫn được tính là nguồn cung trong 7 đến 14 ngày khi xét ngưỡng 3,3× (`surplusSupplyBasis()`). Redeem rồi mint lại ngay không ép được một đợt phát hành. Burn thường (phí bị đốt) vẫn tính ngay.
- **Mỗi đợt phát hành là một nấc.** Một lệnh `releaseSurplus` mint tối đa 10% nguồn cung đang có (ở 3,3× trên 3,0×), đúng phần mà một đợt phát hành ngay tại ngưỡng sẽ mint. Thặng dư lớn hơn thì ra dần, mỗi tuần một nấc. Việc phát hành không đi qua hạn mức mint theo giờ, nên đây là thứ chặn một vòng giá sai-cao (hoặc một đỉnh giá chớp nhoáng) mint ra cả phần thặng dư ảo trong một lệnh. Nấc tính theo nguồn cung đang có, không theo nguồn cung được nhớ; khi nguồn cung bằng 0 thì không có đợt phát hành nào.
- **Đợt phát hành không vừa dưới trần cung thì chờ.** Nếu khoảng trống dưới trần nhỏ hơn nấc, không có gì được mint và tuần đó không bị tính; đợt phát hành ra nguyên vẹn khi đã vừa, không bao giờ bị cắt nhỏ. Nó nâng trần đúng lúc một lệnh mint 1 wei nâng được: khi nguồn cung đang có đã dùng tới 80% trần và đã đủ 7 ngày từ lần nâng trước, chính đợt phát hành nhân đôi trần. Ở tỉ lệ mặc định, nấc không vừa nghĩa là nguồn cung đã quá 90% trần, nên đợt phát hành chờ nhiều nhất tới hạn nâng trần kế tiếp và không cần ai mint trước. Nếu admin đặt ngưỡng cao hơn sàn quá một phần tư của sàn thì điều đó không còn đúng: đợt phát hành có thể phải chờ các lệnh mint đưa nguồn cung lên 80% trần.
- **Tạm dừng mint cũng dừng phát hành thặng dư.** Ai có `PAUSER_ROLE` thì dừng được; chỉ admin mở lại được. Vì vậy đừng bao giờ bỏ quyền admin của NUSD khi còn địa chỉ nào giữ `PAUSER_ROLE`: không còn admin thì một lệnh tạm dừng là vĩnh viễn.

### Marketplace NFT

Mỗi listing gắn với một con số mà collection báo về (`listingEpoch`). Con số này đổi khi token được chuyển, khi địa chỉ được approve của token đổi, hoặc khi người bán cấp hay thu hồi quyền approve-tất-cả của marketplace. Listing có con số đã đổi thì không mua được nữa, chỉ gỡ được, và lệnh niêm yết mới của người bán sẽ thay thế nó. Token rời ví người bán rồi quay lại, hoặc người bán thu hồi approval rồi cấp lại, đều không làm listing cũ sống lại ở giá cũ. Đổi lại:

- collection muốn được niêm yết phải hỗ trợ `IListingEpoch` (0xPixel V2 bản mainnet có sẵn);
- đổi approval của một token đang niêm yết (approve cho địa chỉ khác, thu hồi rồi cấp lại) sẽ kết thúc listing đó; người bán niêm yết lại. Lặp lại một approval đang có thì không đổi gì.

Offer (lệnh đặt giá mua) cũng không còn bị dùng ngược lại người đặt. Trước đây một ví đặt giá mua 500 rồi mua chính token đó từ listing thì offer vẫn sống; khi ví đó bán lại thấp hơn 500, người mua bán ngược token cho họ ở 500 trong cùng một giao dịch. Giờ mỗi ví chỉ có một offer sống trên một token (`offerIdOf`, offer mới thay offer cũ), và một lần bán qua marketplace kết thúc offer mà người mua hoặc người bán còn để trên token đó; tiền ký quỹ của người mua được dùng trả luôn cho lần mua. Marketplace không thấy các lần chuyển token bên ngoài nó: ai nhận token rồi chuyển đi ngoài marketplace thì tự huỷ offer của mình. Một offer giữ chỗ trong `offerIdOf` cho tới khi bị huỷ, bị dọn sau khi hết hạn (`expireOffer`), bị thay hoặc kết thúc qua một lần bán; muốn biết nó còn nhận được không thì xem `expiresAt`. Tiền ký quỹ của offer bị thay hoặc kết thúc trở về dạng credit trong marketplace (rút bằng `withdrawNusd`), không tự về ví.

### Pump và AMM

- Market Pump có phí giao dịch 0 vẫn đạt READY (trước đây kẹt ở thiếu 1 wei).
- Cặp AMM chưa có thanh khoản thì không ai `sync` được, nên không ai khoá được cặp hay đặt trước tỉ giá bằng 1 wei. Người nạp đầu tiên vẫn tự chịu trách nhiệm về tỉ giá mình nạp: luôn đặt mức tối thiểu khi nạp vào một pool rỗng hoặc gần rỗng.
- Mở lại Pump sau khi tạm dừng (`setPumpPaused(false)` trên controller) không tự mở lại graduation nữa; graduation mở lại bằng lệnh riêng `setGraduationsPaused(false)`. Lệnh riêng đó chạy được cả khi Pump đang tạm dừng: Pump không tự giữ graduation, nên mở graduation lúc đó là cho các market READY graduate trong khi việc mua vẫn đóng.

### Synth, lending và LP locker

Các contract này không nâng cấp được và gắn với nhau một lần (token synth với vault, vault với reserve), nên những gì không an toàn được đóng ngay trong mã hoặc trong script:

- **Bảo trợ của Safety Reserve đóng hẳn.** Script tạm dừng `allocations` rồi bỏ quyền owner của Safety Reserve, nên không ai bật lại được. Mọi vị thế synth do người mint tự thế chấp đủ 150%. Đừng nạp NUSD vào Safety Reserve: nó không có hàm rút.
- **Pool lending chỉ nhận một loại tài sản thế chấp** (`MAX_COLLATERAL_ASSETS = 1`): WzkLTC. nBTC, nETH hay bất kỳ token nào khác không niêm yết thêm được, kể cả bởi owner. Muốn có pool cho tài sản khác thì deploy một pool khác.
- **Tạm dừng rút ở vault synth chỉ giữ tài khoản còn nợ, và chặn luôn việc mint.** Tài khoản không nợ, hoặc trả hết nợ trong cùng lệnh (`repayAndWithdraw`), luôn rút được tài sản thế chấp, giống pool lending. Trong lúc tạm dừng rút không ai mở được nợ mới, nên không ai trả hết, rút hết rồi mint lại trên ít thế chấp hơn. Owner gỡ một cờ (`setWithdrawPaused(false)`) là cả rút lẫn mint mở lại. Trong lúc đó người thanh lý cũng không mint được synth để thanh lý, nên cần có sẵn nBTC, nETH đang lưu hành. Lệnh tạm dừng là theo từng vault: khi nguyên nhân là NUSD chứ không phải một feed riêng, guardian tạm dừng cả hai vault và pool lending trong cùng một lô.
- **Pool lending không bao giờ giữ thế chấp trong khi vẫn cho vay.** Lệnh của guardian dừng nạp, vay và rút thế chấp cùng lúc. `setPauses` của owner từ chối cấu hình "dừng rút thế chấp nhưng vẫn cho vay", nên khi mở lại từng bước thì thứ tự là: nạp, rồi rút thế chấp, rồi vay.
- **Vị thế bụi ở vault thanh lý được.** Trước đây một ít bụi tài sản thế chấp để lại có chủ ý làm vị thế không thanh lý được và nợ xấu không bao giờ được ghi nhận.
- **LP locker có thêm `permanentLockedByToken`.** Giao diện nên hiển thị con số này là "đã khoá". `activeLockedByToken` tính cả khoá có thời hạn chưa rút, kể cả khoá một giây hay khoá đã hết hạn từ lâu.

### Deploy và quyền quản trị

- Controller graduation nhận quyền admin của Pump và của router graduation ngay trong script 0xFi. Sau 1 giờ, ai cũng mở được graduation; từ đó graduate một market READY không cần khoá nào.
- `MAINNET_GOVERNANCE` (multisig) là governance của controller và **không bao giờ đổi được**. Script 0xFi cũng đề nghị nó làm owner của factory, gauge factory, hai vault synth và lending; script core có bước `handover()` đề nghị nó nhận mọi quyền còn lại. Mọi bước chuyển đều là hai bước: governance phải tự nhận. Safety Reserve không có owner.
- `MAINNET_GUARDIAN` là khoá chỉ có quyền tạm dừng: của controller, của factory, gauge factory, Safety Reserve, hai vault synth và lending, và của việc mint NUSD. Nó không mở lại được thứ gì.
- Cả hai script có `verify()`: đọc lại trạng thái trên chain và so với manifest. Các kiểm tra bên trong `run()` chỉ thấy bản mô phỏng cục bộ, nên `verify()` mới là thứ xác nhận chain.

## Cách đặt tham số oracle

Lấy hai số từ thông số DIA công bố cho mainnet: heartbeat `H` (giây; nếu ba feed khác nhau thì lấy số dài nhất, vì cả ba adapter dùng chung một tuổi giá) và ngưỡng lệch giá `D` (bps) của feed LTC/USD. Script kiểm tra các dòng có ghi "bắt buộc".

| Biến | Giá trị |
| --- | --- |
| `MAINNET_FEED_HEARTBEAT_SECONDS`, `MAINNET_FEED_DEVIATION_BPS` | `H` và `D`. Chain không tự xác nhận được hai số này; khai `D` thấp hơn thật thì phí sẽ quá thấp. |
| `MAINNET_MINT_MAX_PRICE_AGE_SECONDS` | ≥ `H` (bắt buộc). Thị trường yên thì giá có thể cũ tới `H`; đặt thấp hơn thì mint bị chặn và redeem trả 2% trong một phần của mỗi chu kỳ. |
| `MAINNET_ORACLE_MAX_AGE_SECONDS` | ≥ tuổi giá khi mint (bắt buộc), và nên sát nó. Giá cũ hơn mức này thì oracle coi như chết: không mint, không redeem. |
| `MAINNET_MINT_FEE_BPS`, `MAINNET_REDEEM_FEE_BPS` | mỗi phí ≥ `D` (bắt buộc), tối đa 200. |
| `MAINNET_MINT_LIMIT_PER_HOUR_NUSD` | từ 1 đến 100.000, tức một phần mười trần cung (bắt buộc). Đây là số NUSD tối đa một giá sai có thể tạo ra cùng lúc. |

Script core còn từ chối: wrapped zkLTC không có 18 chữ số thập phân hoặc không nạp/rút đúng 1:1; feed không có giá; giá hiện tại nằm cách cận của adapter chưa tới hai lần (LTC 10–1.000, BTC 5.000–500.000, ETH 250–50.000 USD); một lần đọc giá tốn quá 40.000 gas khi storage đã ấm. NUSD giả định việc đọc giá là rẻ (trên LiteForge khoảng 23.000 gas cho lần đọc đầu): nếu một lần đọc tốn trên khoảng 100.000 gas thì có thể bị bỏ đói gas để báo cáo sai rằng oracle chết, và trên 200.000 gas thì lệnh chuyển NUSD không còn xoá được báo cáo. Nguồn giá thay thế sau này (`setSource`) cũng phải rẻ như vậy.

Feed LTC/USD của DIA trên testnet LiteForge, đo trong khoảng 36 giờ (56 lần cập nhật): khoảng cách giữa hai lần cập nhật từ 464 giây tới 20.186 giây (5,6 giờ), trung vị 3.023 giây; giá đổi nhiều nhất 144 bps giữa hai lần. Đây chỉ là số tham khảo của testnet; thông số mainnet phải lấy từ DIA.

## Kiểm thử

```bash
forge test --root 0xNothing-zkLTC-Mainnet/contracts
```

```bash
forge test --root 0xNothing-zkLTC-Mainnet/0xFi/contracts
```

Hoặc `npm run test:contracts:mainnet` ở gốc repo. Test của đợt audit nằm trong `test/audit/` của mỗi thư mục.

## Việc phải xong trước khi lên mainnet

1. **Dữ liệu chain:** chain ID, RPC, explorer của zkLTC mainnet; địa chỉ feed DIA LTC/USD, BTC/USD, ETH/USD (mô tả feed phải đúng `LTC/USD`, `BTC/USD`, `ETH/USD`) cùng heartbeat và ngưỡng lệch giá của chúng; có wrapped zkLTC chuẩn hay không. Nếu không có thì deploy `0xFi/contracts/script/DeployWzkLTC.s.sol`.
2. **Bổ sung test còn thiếu.** Các test sau ở testnet viết cho AMM/lending v1 nên chưa sao chép:
   - farming (GaugeFactory/LiquidityGauge);
   - ZeroXFiGraduationAdapter và PumpGraduationController trên factory V2;
   - bộ test riêng cho PooledNUSDLendingPoolV2;
   - invariant AMM và rủi ro.

   Cần viết lại cho bản V2. Đợt audit chỉ thêm test cho những gì nó tìm ra. Vòng rà thứ hai của đợt audit có viết khoảng 190 test loại này (đi ngẫu nhiên trên lending và vault, fuzz chuỗi thao tác AMM và gauge, cây trạng thái của listing, mô hình tham chiếu cho staking); chúng đang nằm ngoài Git ở `output/audit-2026-11/review2/` và có thể chuyển vào bộ test chính. Vòng rà thứ ba để lại thêm khoảng 1.090 test ở `output/audit-2026-11/review3/`, trong đó có một mô hình tham chiếu cho marketplace duyệt hết mọi chuỗi 5 thao tác; các vòng phản biện sau đó để lại test ở `review4/` và `review5/` cạnh đó, và kết quả phân tích tĩnh (Slither) ở `review6/`.
3. **Audit độc lập** toàn bộ `contracts/src` và `0xFi/contracts/src`. Đợt audit nội bộ trong `docs/AUDIT_2026-11.md` không thay thế việc này.
4. **Quản trị:** dùng ví deploy riêng; multisig cho `MAINNET_GOVERNANCE` phải có sẵn trên chain này trước khi chạy script 0xFi (không đổi lại được). Mô hình vẫn là "owner được tin cậy, không timelock": ai giữ governance thì lấy được tiền của người dùng theo nhiều cách (mục 8 của báo cáo). Muốn có độ trễ thì chính governance phải là một timelock.
5. **Hạn mức khởi đầu** (lending cap, debt ceiling synth, collateral cap) đang để bằng testnet và rất nhỏ. Xem lại trong `0xFi/contracts/script/Deploy0xFiMainnet.s.sol`.
6. **Hạ tầng:** subgraph Goldsky cho mainnet, cấu hình web/ví cho chain mới. Web cần biết: phí redeem 2% khi giá cũ; `oracleFailureExitAt`; listing kết thúc khi approval thực sự đổi; `listings()` của marketplace có thêm trường `epoch`; mỗi ví một offer trên một token (`offerIdOf`), offer tự kết thúc khi người đặt mua hoặc bán token đó qua marketplace, tiền ký quỹ của nó về dạng credit (hiện số credit và nút `withdrawNusd`), và offer hết hạn vẫn nằm trong `offerIdOf` cùng danh sách offer cho tới khi có người dọn (lọc theo `expiresAt`); `surplusMintCapacity()` của NUSD không xét tuổi giá và chỉ có nghĩa là "sẽ mint" khi `ready` là true; các hàm xem của vault synth (số rút được, số mint được) không xét lệnh tạm dừng, nên web và subgraph đọc thêm `mintPaused` và `withdrawPaused`, và coi mint là đóng khi một trong hai cờ bật (riêng `mintPaused` không còn đủ để biết mint có mở hay không); số "đã khoá" của LP lấy từ `permanentLockedByToken`; địa chỉ gauge đọc từ `gaugeForPair(pair)`, không có trong manifest; không còn chế độ mint synth 1:1.
7. **Keeper** (ai cũng chạy được, không cần quyền):
   - gọi `clearOracleFailure()` trên NUSD mỗi khi có báo cáo oracle chết mà oracle đang có giá;
   - gọi `RewardStaking.sync()` hằng ngày, để thu nhập được ghi nhận trước khi người mới vào chia phần. Lệnh này cũng thử phát hành thặng dư; nếu một đợt đã sẵn sàng mà pool chưa tự gọi được (hết gas dành cho harvest), gọi thẳng `releaseSurplus()` trên NUSD;
   - giữ sẵn một ít nBTC và nETH, để vẫn thanh lý và bù nợ xấu được trong lúc một vault tạm dừng rút (khi đó không ai mint được synth mới);
   - thanh lý vị thế ở lending và vault kể cả khi không có lãi (vị thế bụi);
   - mua phần còn thiếu rồi gọi `graduateReady` trong cùng một giao dịch khi một market READY bị đẩy về TRADING.
8. **Bảo trợ synth và tài sản thế chấp thứ hai** không bật được trên bản deploy này. Muốn có thì phải thiết kế lại (D-01, D-02, D-03, D-04 trong báo cáo) và deploy contract mới.

## Deploy (khi đã đủ điều kiện)

Các lệnh dưới đây viết cho PowerShell và chạy từ gốc repo. Trước hết nạp biến từ bản thật của `config/mainnet.env.example` (để ngoài Git) vào phiên PowerShell đang mở; dòng trống và dòng chú thích bị bỏ qua:

```powershell
Get-Content <đường dẫn tới file env> | Where-Object { $_ -match '^[A-Z0-9_]+=.' } | ForEach-Object { $name, $value = $_ -split '=', 2; Set-Item "Env:$name" $value }
```

Trong Git Bash thì nạp bằng `set -a; . <file env>; set +a` và thay `$env:MAINNET_RPC_URL` bằng `$MAINNET_RPC_URL`. Ba script từ chối chạy trên testnet 4441 và trên mọi chain khác `MAINNET_CHAIN_ID`.

Trước tiên diễn tập toàn bộ các bước dưới đây trên fork: chạy `anvil --fork-url <MAINNET_RPC_URL>`, dùng `--rpc-url http://127.0.0.1:8545` và đặt `MAINNET_MANIFEST_SUFFIX=.rehearsal`.

**1. Core.** Chạy rồi kiểm tra lại trên chain:

```powershell
forge script 0xNothing-zkLTC-Mainnet/contracts/script/DeployMainnetCore.s.sol:DeployMainnetCore --root 0xNothing-zkLTC-Mainnet/contracts --rpc-url $env:MAINNET_RPC_URL --broadcast --slow
```

```powershell
forge script 0xNothing-zkLTC-Mainnet/contracts/script/DeployMainnetCore.s.sol:DeployMainnetCore --sig "verify()" --root 0xNothing-zkLTC-Mainnet/contracts --rpc-url $env:MAINNET_RPC_URL
```

**2. 0xFi.** Điền `MAINNET_NUSD`, `MAINNET_PUMP`… từ `contracts/deployments/mainnet-core.json`, chạy rồi kiểm tra:

```powershell
forge script 0xNothing-zkLTC-Mainnet/0xFi/contracts/script/Deploy0xFiMainnet.s.sol:Deploy0xFiMainnet --root 0xNothing-zkLTC-Mainnet/0xFi/contracts --rpc-url $env:MAINNET_RPC_URL --broadcast --slow
```

```powershell
forge script 0xNothing-zkLTC-Mainnet/0xFi/contracts/script/Deploy0xFiMainnet.s.sol:Deploy0xFiMainnet --sig "verify()" --root 0xNothing-zkLTC-Mainnet/0xFi/contracts --rpc-url $env:MAINNET_RPC_URL
```

**3. Mở graduation.** Sau 1 giờ, điền `MAINNET_PUMP_GRADUATION_ADAPTER` từ `0xFi/contracts/deployments/mainnet-fi.json`. Hai lệnh trong script này ai cũng gọi được, nên chạy bằng khoá nào cũng được; chạy sớm thì script báo `NotOpenYet` kèm thời điểm mở:

```powershell
forge script 0xNothing-zkLTC-Mainnet/0xFi/contracts/script/ActivateGraduationMainnet.s.sol:ActivateGraduationMainnet --root 0xNothing-zkLTC-Mainnet/0xFi/contracts --rpc-url $env:MAINNET_RPC_URL --broadcast
```

**4. Đề nghị bàn giao quyền core.** Bước này chưa chuyển gì: khoá deploy vẫn giữ mọi quyền cho tới khi governance nhận, và NUSD tạm có hai admin.

```powershell
forge script 0xNothing-zkLTC-Mainnet/contracts/script/DeployMainnetCore.s.sol:DeployMainnetCore --sig "handover()" --root 0xNothing-zkLTC-Mainnet/contracts --rpc-url $env:MAINNET_RPC_URL --broadcast --slow
```

**5. Governance nhận quyền.** Mười hai lệnh, gửi từ `MAINNET_GOVERNANCE` (tên contract là khoá trong hai manifest):

| Contract | Lệnh |
| --- | --- |
| `ltcOracle`, `btcOracle`, `ethOracle`, `feeSplitter` | `acceptAdmin()` |
| `treasury`, `nusdMarketplace` | `acceptOwnership()` |
| `pump` | `acceptParamAdmin()` |
| `dexFactory`, `gaugeFactory`, `nBTCVault`, `nETHVault`, `lendingPool` | `acceptOwnership()` |

**6. Khoá deploy bỏ quyền NUSD.** Script từ chối chạy khi governance chưa nhận đủ quyền core:

```powershell
forge script 0xNothing-zkLTC-Mainnet/contracts/script/DeployMainnetCore.s.sol:DeployMainnetCore --sig "renounce()" --root 0xNothing-zkLTC-Mainnet/contracts --rpc-url $env:MAINNET_RPC_URL --broadcast --slow
```

**7. Kiểm tra trạng thái cuối.** Đặt biến rồi chạy lại hai lệnh `verify()` ở bước 1 và 2:

```powershell
$env:MAINNET_VERIFY_HANDOVER = "true"
```

Chúng chỉ qua khi governance giữ mọi quyền, không còn bước chuyển nào treo, khoá deploy không còn quyền gì, và graduation đang mở.

Sau đó:

- Nạp thanh khoản đầu cho ba cặp chính thức (WzkLTC/NUSD, nBTC/NUSD, nETH/NUSD) với mức tối thiểu đặt theo giá oracle. Cặp rỗng thì ai nạp trước người đó đặt giá. Nếu đã có người nạp bụi trước với tỉ giá sai, đừng dùng `router.addLiquidity` (nó theo tỉ giá bụi): chuyển cả hai token vào cặp rồi gọi `pair.mint` trong cùng một giao dịch gộp.
- Tự nạp khoản đầu tiên vào pool lending ngay sau deploy. Pool được tạo ở trạng thái mở và chưa có ai nạp; người nạp đầu quyết định độ mịn của giá share.
- Chỉ tài trợ thưởng cho một gauge sau khi đã có LP thật stake trong đó. Thưởng nạp vào gauge rỗng sẽ chờ người stake đầu tiên, dù người đó chỉ stake 1 wei.
- Đối chiếu ba địa chỉ feed trong `mainnet-core.json` với địa chỉ DIA công bố, và tham số `feedHeartbeatSeconds`, `feedDeviationBps` với thông số DIA công bố.
- Quét log `AdapterScheduled` và `AdapterActivated` của router graduation từ lúc deploy: chỉ được có adapter trong manifest. Adapter nào từng được kích hoạt thì dùng được mãi, không cần chờ lại 1 giờ, và `verify()` chỉ nhìn adapter chính thức.
- Địa chỉ gauge không nằm trong manifest (tạo gauge là lệnh mở cho mọi người, nên địa chỉ phụ thuộc thứ tự tạo): đọc `gaugeForPair(pair)` trên gauge factory.
- Khi mở lại sau `emergencyPause` của controller, governance gọi lần lượt: `setPumpPaused(false)`, `setGraduationsPaused(false)`, `scheduleRouterEnable()`, rồi sau 1 giờ ai cũng gọi được `enableRouter()`.
