# 05 — 100% onchain & DePIN relay

Thiết kế gỡ điểm tập trung cuối cùng của 0xQuantum: **relayer**.

Đọc [04-DEV-GUIDE §2 Luật vàng](04-DEV-GUIDE.md) trước. Mọi thứ ở đây **cộng thêm**
vào ví hiện tại, không thay đổi contract ví đã deploy.

---

## 1. Điểm xuất phát: cái gì đã onchain rồi

Phải nói rõ trước khi thiết kế, vì nó quyết định phạm vi.

**Hai ràng buộc vật lý không thể lách:**

1. **Secret không bao giờ được lên chain.** Mọi thứ onchain đều công khai. Một WOTS
   secret nằm onchain = ai cũng ký được. Nên "100% onchain" chỉ có thể nghĩa là *toàn
   bộ thẩm quyền và kiểm chứng* nằm onchain, còn secret ở lại trên máy.
2. **Tx luôn cần người gửi có tiền.** EVM không có tx tự phát. Nhưng tập "người gửi"
   có thể chuyển từ *một server của dev* sang *một tập mở, có thưởng* — đó chính là DePIN.

**Ví HIỆN TẠI đã đạt ràng buộc 1.** Không admin, không upgrade, không owner. Thẩm quyền
là một cây hash. Cụ thể:

| Luật bảo vệ tiền user | Ở đâu |
|---|---|
| Chữ ký đúng cây Merkle của epoch hiện tại | `QuantumWallet._consumeLeaf` |
| Đúng nonce | `BadNonce` |
| Đúng epoch | `BadEpoch` |
| Leaf tiêu tuần tự, không tái dùng | `BadLeafIndex` |
| Leaf cuối dành cho rotate | `TreeExhausted` |
| Địa chỉ cố định qua rotate | CREATE2 salt trên root epoch-0 |

**`executeSigned` không hề đọc `msg.sender`.** Chữ ký buộc chặt wallet + chainId +
nonce + toàn bộ calls. Nghĩa là ví **đã sẵn sàng cho relay phi tập trung ở mức
contract — không cần sửa một dòng nào** để cho phép bất kỳ ai submit.

### Relayer hiện tại làm được và KHÔNG làm được gì

| | |
|---|---|
| ❌ Đổi người nhận, đổi số tiền | chữ ký commit vào digest |
| ❌ Giả chữ ký | không có secret |
| ❌ Tái dùng leaf | contract chặn |
| ❌ Tiêu tiền của ví | không phải owner; ví không có owner |
| ⚠️ **Từ chối gửi (censor)** | **đây là tác hại thật** |
| ⚠️ **Nhìn thấy intent trước khi lên chain** | front-run *nội dung* (vd: swap) |
| ⚠️ **Chết là ví kẹt** | đúng cái bug `Failed to fetch` đã gặp |

> **`policy.ts` bảo vệ SPONSOR, không bảo vệ USER.** `maxCallsPerOp`, rate limit,
> `validUntilMaxSkewSec` — tất cả chỉ để khỏi phí gas của dev. Luật bảo vệ tiền user
> đã nằm trong contract. Vì vậy **"đưa policy lên chain" phần lớn là sai hướng**; thứ
> cần lên chain là **kinh tế trả gas**, vì đó mới là lý do buộc phải tin một sponsor.

### Điều KHÔNG làm: fraud proof cho equivocation

Ký hai digest khác nhau trên cùng một leaf là có thể chứng minh onchain
(`HashSig.leafFromSignature` và `computeRoot` đều `internal pure`, một contract khác
verify độc lập được). Nhưng **bằng chứng đó vô dụng ở đây**: contract ép tiêu leaf
tuần tự, nên hai chữ ký cùng leaf **không bao giờ cùng lên chain được** — cái thứ hai
ăn `BadLeafIndex`. Bằng chứng chỉ tồn tại *sau khi* op giả đã lên chain, tức là đến quá
muộn để ngăn.

Phòng thủ thật vẫn là `withSignLock` + `writePending` phía client, thứ đã có.
**Đừng xây watchtower quanh ý tưởng này.**

---

## 2. Kiến trúc: ba tầng

```
        Tang 1                 Tang 2                    Tang 3
   ┌──────────────┐     ┌──────────────────┐     ┌────────────────────┐
   │ tu broadcast │     │ QuantumRelayHub  │     │ bang tin intent    │
   │ bang vi HD   │     │ hoan gas + tip   │     │ + node trong ext   │
   │ (loi thoat)  │     │ (ai relay cung   │     │ (user relay ho     │
   │              │     │  duoc, co thuong)│     │  nhau, an tip)     │
   └──────────────┘     └──────────────────┘     └────────────────────┘
    khong contract       1 contract moi          1 service + 1 worker
    user tra gas         user van 0 gas          user van 0 gas
```

Mỗi tầng độc lập hoạt động. Tầng 1 xong là ví đã hết phụ thuộc cứng vào relayer.

### Trạng thái — cả ba tầng đã viết xong code và đã kiểm chứng

| Tầng | File | Đã compile/test? |
|---|---|---|
| 1 | `apps/wallet/src/core/quantum/selfRelay.ts` | ✅ `tsc --noEmit` sạch (có nhánh `signMessage`, xem §3.1) |
| 2 | `contracts/src/QuantumRelayHub.sol` + `test/unit/QuantumRelayHub.t.sol` (21 test) | ✅ `forge build` sạch, 56/56 test xanh |
| 2 | `contracts/src/QuantumWalletFactory.sol` (đã live) | ✅ 8 test xanh |
| 2 | `contracts/src/HashSig.sol` + vector SDK | ✅ 12 test xanh (9 unit + 3 vector) |
| 3 | `relayer/src/board.ts` + `test/board.test.ts` | ✅ 20/20 test xanh (36 test trong relayer, 0 đỏ) |
| 3 | `apps/wallet/src/core/quantum/{boardClient,relayNode}.ts`, `ui/screens/settings/RelayNode.tsx` | ✅ `tsc --noEmit` sạch |

> **Đọc kỹ dòng này:** cả ba tầng **đã compile và test xanh** (`forge test` 56/56,
> `npm test` 36/36, `npm run typecheck` không lỗi). Nhưng **chưa có gì chạy trên testnet**:
> hub chưa deploy, `fixedOverhead` chưa hiệu chuẩn, và tỉ lệ thua đua thật chưa đo. Xanh ở
> đây nghĩa là *code đúng như thiết kế*, không phải *hệ thống đã chạy được*. Xem §7.

---

## 3. Tầng 1 — lối thoát tự broadcast

**Đã nối.** `apps/wallet/src/core/quantum/selfRelay.ts` gọi `manualBroadcast`
(`sdk/src/relay.ts:104`) bằng `walletClientFor` (`apps/wallet/src/core/rpc/client.ts:54`).

Khi intent treo mà relayer không gửi được, panel `quantum.pending` trong
`QuantumWallet.tsx` hiện **ba nút, theo đúng thứ tự đắt dần**:

| Nút | Ai trả gas | Đánh đổi |
|---|---|---|
| `quantum.retry` | sponsor | vô dụng nếu sponsor chết |
| `quantum.board` (Tầng 3) | node của người lạ | intent công khai sớm vài giây |
| `quantum.selfRelay` | **chính user** | luôn chạy được |

**Luật bắt buộc:** dùng **đúng bytes** trong `QuantumPending.request`, decode thành
calldata, **không bao giờ ký lại**. Đây vẫn là retry, chỉ đổi người gửi.
`walletCalldataFor` tự validate shape của record trên đĩa vì đây là đường duy nhất
**không có** relayer re-validate phía sau.

Đánh đổi: lần đó user trả gas. Đổi lại ví **không thể bị ví kẹt** vì relayer chết hay
từ chối. Tầng 2 làm cho khoản gas đó được hoàn lại.

### 3.1 Lỗ hổng đã bịt: `signMessage` bị bỏ quên

`walletCalldataFor` ban đầu chỉ xử lý `deploy` / `execute` / `rotate`. Nhưng
`signMessage` **cũng là một transaction thật** — nó tiêu một leaf và ghi hash để EIP-1271
đọc. Nghĩa là intent này có thể bị treo y hệt một `execute`, mà:

- relayer **có** nhận kind này (`relayer/src/server.ts:229`)
- board **có** nhận (`relayer/src/board.ts:318`)
- nhưng `walletCalldataFor` từ chối → **không ai broadcast được**: không user, không node.

Đã bổ sung nhánh `signMessage` (`selfRelay.ts:137`). Sửa **một lần ở validator dùng
chung** nên cả Tầng 1 lẫn Tầng 3 đều được vá — `relayNode.ts` import đúng hàm đó. Đây
chính là loại lệch pha mà comment "sharing one validator" được viết ra để ngăn.

---

## 4. Tầng 2 — `QuantumRelayHub.sol`

Vault do dev nạp, **ai broadcast cũng rút được**. Dev vẫn bỏ tiền nhưng **mất quyền
chặn**. User vẫn trả 0 gas.

```solidity
function relay(address wallet, bytes calldata data) external nonReentrant {
    uint256 g0 = gasleft();
    if (!sponsored[wallet]) revert NotSponsored(wallet);   // KHONG dung isWallet
    _consumeQuota(wallet);
    (bool ok, ) = wallet.call{gas: MAX_OP_GAS}(data);      // gas CO TRAN
    if (!ok) revert OpFailed();
    uint256 price  = _min(tx.gasprice, block.basefee + MAX_PRIORITY);
    uint256 refund = _min((g0 - gasleft() + FIXED_OVERHEAD) * price + TIP_WEI, MAX_REFUND_WEI);
    _payout(msg.sender, refund);
}
```

### 4.1 Những chỗ dễ mất tiền — và cách chặn

Đây là phần quan trọng nhất của contract này. Một vault "hoàn gas cho bất kỳ ai" là
mục tiêu tấn công kinh tế; nếu làm ngây thơ nó sẽ bị rút cạn.

**(a) `factory.isWallet` KHÔNG đáng tin — đừng dùng để gác vault.**

`isWallet` chỉ staticcall `candidate.factory()` rồi tin câu trả lời
(`QuantumWalletFactory.sol:57`). **Bất kỳ contract nào cũng giả được**:

```solidity
contract Fake { address public factory = 0xC23e…; fallback() external { /* dot gas */ } }
```

`isWallet(fake)` trả `true`. Nếu hub tin nó, kẻ tấn công gọi `relay(fake, …)`, contract
giả đốt sạch gas được forward, hub hoàn lại toàn bộ → **vault chảy máu, kẻ tấn công
hoà vốn cộng tip**.

> Đây **chưa** phải bug hiện tại: `isWallet` mới chỉ dùng trong test và ABI, chưa có
> consumer bảo mật nào. Nhưng nó sẽ thành lỗ hổng nghiêm trọng ngay khi hub tin nó.

**Cách chặn:** hub tự ghi sổ. `relayDeploy` gọi factory, lấy địa chỉ **factory trả về**
và set `sponsored[wallet] = true`. Tập đó không giả được vì nó do chính hub tạo ra.
Ví deploy bởi người khác không được tài trợ — họ vẫn dùng Tầng 1 được.

**(b) Trần gas cho op.** `wallet.call{gas: MAX_OP_GAS}(data)` chặn mọi kịch bản "op đốt
gas vô hạn". Kết hợp với `MAX_REFUND_WEI`, thiệt hại mỗi lần gọi là **có trần cứng**.

**(c) Kế toán refund — hướng nguy hiểm là hoàn THỪA.**

`g0 - gasleft()` **không thấy**: 21000 intrinsic, gas calldata, chi phí của chính lệnh
chuyển tiền hoàn lại, và **phí L1 data availability của L2** (`gasleft()` hoàn toàn mù
với khoản này). Vì vậy `FIXED_OVERHEAD` phải được **đo trên chain thật** rồi chỉnh
**thấp hơn** con số đo được một chút: hoàn thiếu thì relayer chịu vài phần trăm, hoàn
thừa thì vault bị rút. Cách đo: §7.2.

> **Không hiệu chuẩn bằng `forge test --gas-report`.** Chế độ đó chạy suite trong một
> môi trường khác hẳn: cùng bytecode mà số gas khác (`test_isWallet` 5938846 so với
> 5533318), và `tx.gasprice` đọc vào bằng **0**, nên mọi khoản hoàn bằng 0
> (`emit Relayed(..., refund: 0)` nằm ngay trong trace) và 5-6 test đỏ. Đỏ ở đó **không**
> phải bằng chứng contract sai. Bằng chứng đầy đủ: §7.2.

`FIXED_OVERHEAD` là hằng số chứ không suy từ `data.length` vì **calldata gần như cố
định**: `bytes32[67]` WOTS + `bytes32[10]` path ≈ 2.6 KB mọi lần.

Chi phí ước tính mỗi `executeSigned`: **~150k gas** (≈41k calldata + ~500 lần keccak
cho WOTS + Merkle), tức khoảng 5× một lần chuyển ERC-20. **Con số này phải được đo
lại, không được tin.**

**(d) Thao túng `gasprice`.** Relayer tự đặt gasprice cao → refund cao. Chặn bằng
`min(tx.gasprice, block.basefee + MAX_PRIORITY)`. Trên L2 basefee có thể gần 0 nên
`MAX_PRIORITY` phải là hằng số nhỏ, không được suy từ basefee.

**(e) Tự tiêu thụ (self-dealing).** Kẻ tấn công tạo ví quantum của chính mình, ký op
rỗng, tự relay, ăn `TIP_WEI` mỗi lần. Lãi = tip. Chặn nhiều lớp:

- quota mỗi ví mỗi cửa sổ (vd 20 op / 24h) → giới hạn mỗi ví
- `relayDeploy` **tip = 0** → tạo ví sybil không có lãi, chỉ miễn phí
- **trần chi tiêu toàn cục mỗi ngày** → đây mới là chốt chặn thật: dù sybil bao nhiêu,
  máu chảy mỗi ngày là **có trần**
- `TIP_WEI` đủ nhỏ để sybil không bõ công, đủ để relay thật có động cơ

Phải thành thật: **trên testnet với vault do dev nạp, không có cách chống sybil hoàn
hảo.** Mục tiêu đúng là *chặn trên mức chảy máu, và giám sát được* — không phải *loại
trừ*.

**(f) Nút tắt KHÔNG làm ví thành custodial.** Hub có owner chỉnh tham số và tạm dừng
**hoàn tiền**. Điều đó **không bao giờ** chặn được `executeSigned`, vốn vẫn gọi trực
tiếp được bởi bất kỳ ai (Tầng 1). Tách bạch này là cố ý: owner kiểm soát *trợ cấp*,
không kiểm soát *thẩm quyền*.

**(g) Reentrancy.** Op chạy call tuỳ ý nên có thể gọi ngược vào `relay`. Dùng
`ReentrancyGuard` đã có sẵn tại `contracts/src/common/ReentrancyGuard.sol`.

### 4.2 Test suite — 21 test, `test/unit/QuantumRelayHub.t.sol`

> **Bẫy đã sập một lần, đừng tái tạo.** Foundry bản này so **toàn bộ revert data**, không so
> `bytes4`. `vm.expectRevert(SomeError.selector)` chỉ đúng khi error **không có tham số**
> (`DailyCapReached()`, `BadParam()`, `IsPaused()`, `NotOwner()` — cả bốn đang dùng đúng kiểu
> này). Với error **có tham số** phải dùng `abi.encodeWithSelector(selector, ...args)`.
> `test_vaultEmpty_reverts` từng đỏ vì lý do đó (`VaultEmpty(uint256 want, uint256 have)` mà
> chỉ truyền selector). Vì `want` phụ thuộc gas nên không viết cứng được — cách sửa là ghim
> `maxRefundWei` xuống `0.0001 ether`, thấp hơn nhiều so với chi phí deploy thật (~1.3e15 wei
> ở 1 gwei), nên phép tính bị **clamp** và `want` trở thành một hằng số đặt tên được.

Hai test **không được phép đỏ**, vì chúng chốt đúng hai tính chất khiến hub không
biến ví thành custodial:

| Test | Chốt điều gì |
|---|---|
| `test_hubIsNotAGate_directExecuteAlwaysWorks` | tắt hub **không** tắt được ví |
| `test_paused_stopsSubsidy_notSpending` | owner tắt được *trợ cấp*, không tắt được *user* |
| `test_spoofedWallet_cannotBeRelayed` | `isWallet` giả được → hub phải tự ghi sổ (§4.1a) |

Hai mock đi kèm: `test/mocks/FakeQuantumWallet.sol` (trả về địa chỉ factory rồi **đốt
sạch gas** — chứng minh (a) là lỗ hổng thật), `test/mocks/RelayReenterProbe.sol` (gọi
ngược vào hub **từ trong chính lệnh hoàn gas**, rồi nuốt lỗi để test quan sát được).

> Test contract có `receive() external payable {}`. **Thiếu nó là cả suite pass sai
> lý do**: mọi `_refund` sẽ kết thúc bằng `RefundFailed` chứ không phải hoàn tiền thật.

---

## 5. Tầng 3 — bảng tin intent + node trong extension

### 5.1 Bảng tin — `relayer/src/board.ts`

Intent **tự xác thực** — chữ ký commit wallet + chainId + nonce + toàn bộ calls — nên
bảng tin độc hại chỉ có thể **chặn**, **lộ**, **làm người khác mất tiền**, hoặc **bị
flood**. Không thể sửa một byte. Vì vậy nó **không cần tin cậy**.

Ba route mới trên relayer hiện tại, dùng lại `validateRequest` (`policy.ts`),
`RateLimiter` và `readWalletState` — cộng thêm `boardLimiter` **riêng** để một lượt post
không tiêu quota của `/relay` sponsored:

| Route | Việc |
|---|---|
| `POST /intents` | nhận intent đã ký. 429 khi quá rate |
| `GET /intents?limit=N` | trả tối đa 50, cấp *lease mềm*, tăng `serves` |
| `POST /intents/settle` | xoá intent đã chết. **409 nếu nó vẫn còn landable** |

**Ý tưởng chốt của tầng này: `landable` làm điều kiện kết nạp.** Một execute chỉ gửi
được khi `op.walletNonce == nonce onchain` **và** `sig.leafIndex == leafIndex onchain`.
Nghĩa là **chain tự ép mỗi ví chỉ có ĐÚNG MỘT intent sống trên bảng**. Một hàm giải ba
bài toán cùng lúc:

1. **Không có gas trap** — node không bao giờ được giao việc chắc chắn revert.
2. **Giới hạn mỗi ví miễn phí** — flood tốn *một ví đã deploy mỗi slot*, không phải một
   HTTP request mỗi slot.
3. **`settle` an toàn để mở công khai** — chỉ intent thật sự chết mới xoá được; nếu
   không, `settle` không xác thực sẽ trở thành **công cụ censor**.

Hai quyết định dễ làm sai:

- **Đầy thì TỪ CHỐI, không evict-để-nhận.** Evict-để-nhận đưa công cụ censor cho bất kỳ
  ai có `curl`.
- **`landable` chạy TRƯỚC nhánh duplicate**, để client không thể giữ một intent đã chết
  sống mãi làm bẫy.

`cachedChain` cache **promise** (không phải kết quả) nên nhiều entry cùng một ví gộp
thành một lượt RPC; TTL ≈ một block, vì cache sống lâu hơn một block có thể kết nạp lại
đúng cái gas trap vừa loại.

`GET /intents` chỉ verify **đúng số entry sắp trả về**, không verify cả bảng: yêu cầu là
*không bao giờ phục vụ đồ cũ*, chứ không phải *không bao giờ lưu đồ cũ*. Entry cũ mà
không ai đọc thì tự hết hạn theo `maxAgeMs`.

### 5.2 Node relayer trong extension — `core/quantum/relayNode.ts`

Vòng lặp mỗi tick: poll bảng → `hubCallFor` → `hub.quote(wallet)` → `estimateGas` →
`sendTransaction` → `waitForTransactionReceipt` → ghi sổ.

**Sổ là NET LOSS, không phải gross spend.** Đây là chỗ thiết kế đầu tiên dễ sai: hub
hoàn lại gần hết số node tiêu, nên "trần chi tiêu" gần như vô nghĩa. Cái user thật sự
chịu là **phần dư**: đua thua + **phí L1 data availability của L2** (`gasleft()` mù với
khoản này nên hub cũng không hoàn được).

Vì vậy sổ đo bằng **delta số dư ví** trước/sau mỗi tx, không phải
`gasUsed * effectiveGasPrice` — công thức đó bỏ sót đúng khoản mà hub cũng bỏ sót.

**Ba lượt kiểm tra MIỄN PHÍ trước khi tiêu một đồng:**

1. `hub.quote(wallet)` → trả lời cùng lúc "sponsored?", "còn quota?", "còn budget?",
   "vault còn tiền?". Bỏ qua bước này không làm relay fail — nó làm relay fail **sau
   khi** node đã trả tiền.
2. `estimateGas` → **chính là kiểm tra đua**. Node khác đã landing rồi thì leaf đã đổi,
   hub revert `OpFailed(BadNonce…)`, và estimate nói ra điều đó với giá 0.
3. `built.tx.to === intent.wallet` → bắt bảng tin nói dối trong envelope.

Revert ở bước 2 thì node gọi `POST /intents/settle` để **node sau không bị đẩy vào cùng
bức tường**. `decodeRevertData` unwrap `OpFailed(bytes)` để phân biệt "`BadNonce` —
người khác đã gửi, bỏ đi" với "`CallFailed` — op này hỏng".

**Luật an toàn — đã cài, không phải dự định:**

| Luật | Cài ở đâu |
|---|---|
| Mặc định TẮT; record hỏng cũng TẮT | `parseSettings`: `enabled: v.enabled === true` |
| Không bao giờ chạm secret quantum | không có primitive ký nào reachable; dùng chung `walletCalldataFor` |
| `relayDeploys` mặc định tắt | `relayDeploy` **tip = 0** → sybil không có lãi |
| Không relay cho ví quantum của chính mình | `skipWallets` từ `useRelayNode` |
| Chạm trần lỗ là tự tắt | `updateRelayNode({ enabled: false })` |

**Cố ý KHÔNG dùng `chrome.alarms`.** Node chỉ ký được khi vault đang mở, nên alarm
trong service worker sẽ dành phần lớn số lần thức dậy để phát hiện là nó không làm được
gì — và phiên bản *làm được* trong background là phiên bản giữ **hot key ngoài vault**.
Đánh đổi tính chất bảo mật chính của ví để lấy thêm vài lượt relay là sai giá. Node vì
vậy sống bằng `setInterval` trong `useRelayNode` (mount ở App root): **chạy khi ví đang
mở và đã unlock, chết cùng lúc ví lock**.

Interval chạy *dù node bật hay tắt*, và `runRelayNodeTick` đọc lại công tắc mỗi lần —
tốn một lượt đọc storage mỗi tick, đổi lấy: bật/tắt trong Settings có hiệu lực ở tick
sau, chứ không phải ở lần unlock sau. **Không có gì chạm mạng trước khi user opt-in.**

UI: `ui/screens/settings/RelayNode.tsx` (bật/tắt, trần lỗ, op mỗi tick, `relayDeploys`,
và sổ net/relayed/lost/last-tick).

**Đua nhau relay vẫn là vấn đề thật, chỉ giảm được.** `estimateGas` + lease mềm + settle
loại phần lớn lãng phí ở trường hợp thường. Lease **không ép được** — bảng tin không có
thẩm quyền. Vì vậy cột `relay.lost` trong UI không phải số liệu trang trí: **phải đo tỉ
lệ thua thật trước khi mở rộng số node.**

---

## 6. Những thứ KHÔNG thể phi tập trung

Nói thẳng để không ai kỳ vọng sai:

| | Vì sao |
|---|---|
| Secret trên máy user | onchain = công khai = mất ví |
| Việc tính chữ ký | phải ở client; chỉ root lên chain |
| Ai đó phải trả gas | EVM không có tx tự phát; chỉ mở rộng được *tập* người trả |
| Riêng tư mempool | intent lộ nội dung trước khi lên chain |
| Nguồn tiền vault | dev vẫn nạp; đã bỏ quyền *chặn*, chưa bỏ được *chi phí* |

---

## 7. Việc còn lại — theo đúng thứ tự

Không được đảo thứ tự. Mỗi bước là điều kiện của bước sau.

### 7.1 Compile & test — ĐÃ XANH

- `forge test` → **56/56 pass**, 5 suite. Gồm `test_spoofedWallet_cannotBeRelayed` (chống giả
  `isWallet`), `test_hubIsNotAGate_directExecuteAlwaysWorks` và
  `test_paused_stopsSubsidy_notSpending` (hai tính chất không được phép vỡ).
- `npm test` (relayer) → **36/36 pass**, 0 đỏ. Gồm **20 test `board.ts`** chạy offline trên
  `BoardChain` giả: `re-checks landability BEFORE the duplicate branch`, `rejects when full
  instead of evicting to admit`, `refuses to remove an intent that is still landable`.
- `npm run typecheck` (apps/wallet) → **không lỗi**.

> **Tại sao vẫn phải chạy `npm run typecheck` dù `npm test` đã xanh:**
> `node --experimental-strip-types` **xoá type chứ không kiểm tra**. Cả bộ test relayer có
> thể xanh trong khi extension có lỗi type thật — đúng như đã xảy ra: `tsc` bắt được
> `LITVM_NETWORK.symbol` không tồn tại (đúng phải là `nativeCurrency.symbol`), thứ mà
> không test nào chạm tới.

Xanh ở bước này **không** có nghĩa hệ thống đã chạy được. Ba bước dưới vẫn là bắt buộc.

### 7.2 Hiệu chuẩn `fixedOverhead` và `maxPriority` — TRƯỚC khi nạp tiền vào vault

Hai hằng số này sai thì **vault chảy máu** hoặc **node lỗ mỗi lần thắng**. Cả hai đều
phải đo **trên chain thật**. Đây là lý do bước này đứng trước bước nạp tiền, không phải
sau.

> **`forge test --gas-report` không dùng được để hiệu chuẩn.** Hai lần chạy cùng một
> bytecode, một lần có cờ đó một lần không, cho kết quả khác nhau — và khác ở cả hai
> tầng:
>
> 1. **Cùng test, khác gas.** `test_isWallet` 5938846 so với 5533318;
>    `test_constants` 43099 so với 11599; `test_badNonce_rejected` 1331108 so với
>    1272132. `HashSigVectors` thì lại giống hệt nhau ở cả hai lượt. Một phép đo cho ra
>    số khác nhau tuỳ cờ thì không phải phép đo.
> 2. **`tx.gasprice` đọc vào bằng 0.** Trace in `emit Relayed(..., refund: 0)` ngay cả ở
>    `test_maxRefundWei_clampsPayout`, nơi `setParams` vừa đặt `maxPriority = 2 gwei`,
>    `maxRefundWei = 1000 wei`, `tipWei = 0`, rồi `vm.fee(0)` + `vm.txGasPrice(2 gwei)`.
>    Nhìn vào `_refund`: `amount = (số dương) * price + 0`, nên `amount == 0` **chỉ** xảy
>    ra khi `price == 0`, mà `price = min(tx.gasprice, 0 + 2 gwei)` ⇒ `tx.gasprice == 0`.
>    Mọi trần tính bằng wei (`dailyCapWei = 1 wei`, `deployCapWei = 1 wei`) vì thế không
>    bao giờ bị chạm, và 5-6 test đỏ.
>
> Suy ra: contract cư xử **đúng** ở giá 0 — hoàn 0, không phạm trần nào. Cái sai là môi
> trường. Chạy `forge test` thường thì 56/56 xanh, hai lần liên tiếp.

**(a) `fixedOverhead` — đo bằng một lệnh `hub.relay` thật.**

Đọc receipt của chính giao dịch `relay`: `gasUsed`, `effectiveGasPrice`. Đọc event
`Relayed` để lấy `refund`. Đọc `hub.tipWei()` và `hub.fixedOverhead()`.

Gọi `U` là lượng gas mà phép tính của hub **không thấy** (21000 intrinsic + calldata
thật + phần gas tiêu sau lần `gasleft()` cuối, trừ đi phần `16 * msg.data.length` đã thu
hộ). Từ `amount = ((g0 - gasleft()) + fixedOverhead + 16L) * price + tip`:

```
U = gasUsed − (refund − tipWei) / effectiveGasPrice + fixedOverhead
```

Rồi đặt `fixedOverhead := U − vài nghìn gas`. **Thấp hơn, không cao hơn.**

Ba điều kiện phải giữ, không thì đẳng thức trên vô hiệu:

- **`refund` không bị kẹp** bởi `maxRefundWei` — kiểm bằng cách so `refund` với
  `hub.maxRefundWei()`. Ở gas price cao, `maxRefundWei = 0.01 ether` sẽ kẹp và phép đo
  cho ra số vô nghĩa. Đo lúc gas price thấp, hoặc nâng tạm `maxRefundWei`.
- **`tx.gasprice ≤ block.basefee + maxPriority`**, tức relayer không tự đặt giá vượt
  trần. Vượt thì `price` bị kẹp và `refund` không còn phản ánh giá thật đã trả.
- **`relay` phải là giao dịch cấp cao nhất.** Trong test Foundry, `hub.relay(...)` là
  call lồng trong tx của hàm test: nó không trả 21000 intrinsic, và `msg.data` là calldata
  của chính hàm test chứ không phải của `relay`. Đo trong test là **đo nhầm đại lượng** —
  đó là lý do thứ hai, độc lập với cờ `--gas-report`, để không hiệu chuẩn trong Foundry.

**(b) `maxPriority` — trần tuyệt đối, và chưa dòng code node nào đọc nó.**

`price = min(tx.gasprice, block.basefee + maxPriority)`. Trên L2 basefee có thể gần 0, nên
trần này trên thực tế là **`maxPriority`** (đang là `2 gwei`).

Kiểm tra toàn bộ `quantum-wallet`: `maxPriority` **không xuất hiện ở một dòng TypeScript
nào**. Hai chỗ ký giao dịch đều không biết đến nó —
`relayer/src/server.ts:250` gửi bằng `gasPrice = eth_gasPrice`, còn
`sdk/src/relay.ts:115` để viem tự điền fee.

Hệ quả: nếu `eth_gasPrice` của LitVM lớn hơn `basefee + 2 gwei`, **mọi lần relay thắng đều
bị hoàn thiếu**, và node lỗ trên chính những lần nó thắng. Nguy hiểm hơn `fixedOverhead`
vì nó cắn **mỗi lần**, không phải vài phần trăm.

Việc phải làm: đo `eth_gasPrice` và `basefee` thật của LiteForge, rồi hoặc nâng
`maxPriority` cho khớp, hoặc bắt node kẹp fee xuống `min(eth_gasPrice, basefee +
maxPriority)` trước khi gửi.

### 7.3 Deploy hub

```bash
cd quantum-wallet/contracts
QW_FACTORY=0xC23e270707B636101C4B43882dE38A840037BaCe \
  forge script script/DeployRelayHub.s.sol:DeployRelayHub \
  --rpc-url "$RPC" --broadcast --slow
```

> **KHÔNG BAO GIỜ chạy lại `DeployFactory`.** Factory đã live tại
> `0xC23e270707B636101C4B43882dE38A840037BaCe`; deploy lại là đổi địa chỉ CREATE2 của
> **mọi ví đã tồn tại**. `ScriptBase._recordAs` ghi hub sang file `-relayhub.json`
> riêng đúng để không ghi đè record của factory.

### 7.4 Nối địa chỉ hub vào hai nơi

| Biến | File | Ai đọc |
|---|---|---|
| `QW_RELAY_HUB` | `relayer/.env` | `/health` → node tự phát hiện |
| `VITE_QUANTUM_RELAY_HUB` | build env của `apps/wallet` | `QUANTUM_RELAY_HUB` |

Cả hai đều **optional**, và `null` được handle ở mọi consumer — nhưng node **từ chối
bật** khi không có hub (`relay.noHub`), vì node trỏ vào hư không sẽ trả gas cho người
lạ mà không được hoàn đồng nào.

### 7.5 Còn thiếu (biết là thiếu, không phải bỏ sót)

- **Test cho `board.ts` đã xanh (20/20).** `relayer/test/board.test.ts`, trên một `BoardChain`
  giả được inject: dedupe qua `intentId`, đầy-thì-từ-chối, không-evict-để-nhận, entry cũ
  không bao giờ được phục vụ, `settle` từ chối intent còn landable, `cachedChain` gộp promise.
  Hai test trong đó là **điều kiện không thương lượng** — nếu chúng đỏ thì thiết kế sai,
  không phải test sai: từ chối-khi-đầy (evict = tiếp tay flood) và
  `settle`-từ-chối-intent-còn-landable (xoá entry còn sống = mở lại đường flood).
- **Chưa đo tỉ lệ thua đua thật** trên testnet với ≥2 node. Con số này quyết định
  `relay.maxPerTick` và loss budget mặc định nên chỉnh thế nào.
- **`isWallet` của factory vẫn spoofable.** Hub đã tự phòng bằng sổ `sponsored` riêng
  (§4.1), nhưng bất kỳ consumer tương lai nào tin `factory.isWallet` sẽ dính lỗ hổng
  tương tự. Xem §4.1. Cách sửa tận gốc: factory nên trả về `address(0)` cho ví chưa
  deploy thay vì staticcall rồi tin câu trả lời.
- **`fixedOverhead` và `maxPriority` chưa hiệu chuẩn** — xem §7.2. Đây là hai bước chặn
  việc nạp tiền. Cả hai đều phải đo trên chain thật; **`forge test --gas-report` không
  dùng được** vì nó chạy suite trong một môi trường khác (số gas khác, `tx.gasprice` đọc
  vào bằng 0), và đỏ ở đó không phải bằng chứng contract sai.
- **Node chưa kẹp fee xuống `maxPriority`.** Không code nào đọc hằng số đó, nên nếu
  `eth_gasPrice` của LitVM vượt `basefee + 2 gwei` thì node hoàn thiếu ở mọi lần thắng.
  Xem §7.2(b).
