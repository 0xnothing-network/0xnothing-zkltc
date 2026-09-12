# 02 — Mô hình mối đe doạ & vì sao đây là phương án an toàn nhất

> Mục tiêu của tài liệu này: chứng minh **từng quyết định** đều đi qua một mô hình mối đe doạ tường minh, và **khai báo trung thực** những gì thiết kế KHÔNG bảo vệ được (không có "viên đạn bạc" tuyệt đối trên EVM).

---

## 1. Ai là kẻ tấn công mà ta thiết kế để chống lại?

| Kẻ tấn công | Khả năng | Thiết kế chống bằng |
|---|---|---|
| **QTM tương lai** (máy tính lượng tử mật mã liên quan) | Shor phá ECDSA/RSA từ public key | Khoá chữ ký **hash-based**; không ECDSA trong đường bảo mật chính (chế độ quantum) |
| **QTM tương lai** | Grover làm tiền ảnh hash ~1/2 | Secret 256 bit ⇒ còn ~128 bit an toàn; checksum ngăn sai lệch |
| Kẻ **đánh cắp ciphertext** (dữ liệu rest/extension storage rò rỉ) | brute-force offline | Secret 256 bit + AES-GCM-256 + KDF có công sức ⇒ bất khả thi; khối mã hoá **không chứa** dữ liệu dùng được |
| Kẻ **đánh cắp secret icon** (keylogger/phishing người dùng chép sai) | chiếm toàn bộ quyền ký | Đây là "private key" của user — mọi hệ chữ ký đều thua nếu secret lộ. Giảm thiểu: checksum bắt lỗi gõ, cảnh báo "không nhập secret vào website", secret chỉ nhập trên thiết bị tin cậy. |
| **Relayer lừa đảo / bị chiếm** | thay calldata, không trả gas, chặn tx | Relayer không ký thay, không thấy secret; **không thể tạo intent hợp lệ**. User có nút broadcast thủ công dự phòng. Gas: relayer chỉ có thể **từ chối**, không thể **ăn cắp** (mọi giá trị đi qua calldata đã ký). |
| **Replay intent** (bắt lại op cũ gửi lại) | double-spend | `nonce` tăng tuần tự trong contract, gắn `wallet` + `validUntil` |
| **Reuse khoá một lần (WOTS)** | dùng lại lá = lộ secret của lá đó | Contract chỉ nhận **leafIndex tuần tự kế tiếp**; ký 2 op = lá khác nhau |
| **Front-run deploy CREATE2** | chiếm địa chỉ chưa deploy | `salt`/`commitment` bắt nguồn từ secret; trước deploy salt không tồn tại on-chain; initCode khác ⇒ địa chỉ khác |
| **Reentrancy / call ngoài độc hại** | token callback tấn công | nonce tăng + reentrancy guard trước khi gọi ngoài; core immutable, không upgrade hook |
| **Xoay khoá trái phép** | attacker có 1 lá tạm chiếm epoch | root chỉ đổi bằng lá hợp lệ của cây hiện tại (rotating forward); (tuỳ chọn) timelock + guardian 2 chữ ký |
| **Phishing chữ ký dữ liệu tuỳ ý** | user ký op "tưởng vô hại" | Approval window ký — user đọc rõ calls/value/to trước khi duyệt (giữ nguyên luồng `askUser` của ví hiện tại) |
| **DoS relayer (spam op vô nghĩa)** | đốt gas của dev | Policy: ví phải có số dư zkLTC > 0, daily cap/ví, rate-limit, pre-check revert |

---

## 2. Lập luận "an toàn nhất" theo từng lớp

### Lớp tài sản
Tài sản nằm ở **địa chỉ contract** = `CREATE2(factory, salt, initCode)`. Địa chỉ này **không phụ thuộc bất kỳ private key ECDSA nào** (khác EOA: khoá = quyền). Vì vậy:
- Đánh mất/đổi khoá chữ ký **không bao giờ** thay đổi nơi tài sản đứng.
- Kể cả khi "tất cả ECDSA trên đời" bị phá, tài sản trong ví quantum vẫn chỉ chuyển khi **đủ chữ ký hash-based hợp lệ** (cần biết preimage = biết secret) — không có key nào ngoài vòng đó.

### Lớp chữ ký (quan trọng nhất)
- ECDSA: public key nằm trên chuỗi (địa chỉ) ⇒ QTM dùng Shor rút private key. **Không cứu được** bằng entropy hay "icon". ⇒ phải loại khỏi đường bảo mật.
- Hash-based signature (Merkle–Winternitz): xác minh = keccak256. QTM chỉ Grover (preimage ~1/2) ⇒ 256-bit còn ~128-bit. Đây là họ chữ ký kháng lượng tử duy nhất **xác minh rẻ trên EVM hiện nay**.
- Một lần dùng được xử bằng **cây + leafIndex tuần tự** ⇒ không có trạng thái "khoá yếu" bị tái sử dụng. Khi cây gần cạn ⇒ **xoay root** tự động; xoay là thao tác an toàn (dùng lá cuối của cây cũ để ký root mới).

### Lớp secret
- "Mật khẩu" thật = **random 256 bit**, mã hoá thành 25 icon + checksum.
- Dẫn xuất mọi thứ (seed cây, salt, khoá wrap) từ secret bằng HKDF. Secret **không lên chuỗi**, không vào log, không vào relayer.
- Trên đĩa chỉ có ciphertext AES-GCM. Nếu extension storage bị rò rỉ toàn bộ, kẻ tấn công vẫn **không ký được** — cần secret.
- Rotating secret: chỉ cần bọc lại state dưới khoá mới + (tuỳ chọn) xoay epoch để "quên" cây cũ. **Địa chỉ không đổi.**

### Lớp chi phí/tin cậy (sponsor)
- User không bao giờ giữ gas, không bao giờ ký raw tx ECDSA ở chế độ quantum.
- Relayer không phải là trusted party **cho quyền kiểm soát tài sản** — chỉ là người trả gas. Niềm tin tối thiểu hoá: nếu relayer biến mất, vẫn broadcast thủ công được.

---

## 3. Giới hạn trung thực (KHÔNG được giấu)

1. **Không có phần mềm nào chống lại việc user tự làm lộ secret.** Phishing/đánh cắp secret icon = mất ví, như mọi private key. UX phải dạy đúng.
2. **Cây WOTS hữu hạn.** 4 096 lá/cây. Nếu client lỗi không xoay kịp hoặc mất trạng thái `leafIndex`, cần cơ chế khôi phục (secret tái sinh cây; guardian 2-chữ-ký nếu bật). Test thật kỹ đường "cạn cây".
3. **Kháng lượng tử = giả định hash an toàn.** keccak256 coi như random oracle. Không có chứng minh hình thức; đây là giả định chuẩn ngành (như mọi hệ mật mã).
4. **EIP-1271 không phổ biến như ECDSA.** Một số dApp kiểm tra `ecrecover` cứng sẽ không hiểu ví contract. Phần tương thích là việc của từng dApp (0xPump/0xFi có thể cần nhỏ để hỗ trợ).
5. **Chain/relayer tập trung hoá.** LitVM LiteForge là testnet của Caldera; relayer là hạ tầng dev. Đây là **testnet/dev-tài-trợ** — chưa phải mô hình phi tập trung mainnet. Trước mainnet phải: relayer phi tập trung/không-giám-hộ, giới hạn gas thật, audit độc lập, có policy deficit.
6. **Kích thước & gas.** Chữ ký ~2.5 KB calldata mỗi op. Sponsor trên testnet ổn; trên mainnet cần tối ưu (WOTS+, cây to hơn, hoặc STARK khi verifier chín muồi).
7. **Trạng thái Merkle phải nhất quán giữa client & contract.** Mọi op đều "tiêu 1 lá". Nếu client build 2 nhánh cùng lúc (multi-device cùng secret) → xung đột nonce/lá. Mặc định **1 thiết bị chủ + secret dự phòng**, không chạy song song 2 thiết bị ký cùng lúc (sẽ cảnh báo; có thể thêm epoch+thiết bị sau).

---

## 4. So sánh nhanh với phương án khác (để bạn tự kiểm)

| Tiêu chí | EOA hiện tại | Ví quantum (thiết kế này) | Safe/argent (không có PQ) |
|---|---|---|---|
| Kháng lượng tử (khoá chữ ký) | ❌ | ✅ hash-based | ❌ ECDSA |
| Xoay khoá không đổi địa chỉ | ❌ | ✅ | ✅ |
| User không trả gas | ❌ | ✅ (relayer sponsor) | ⚠️ tuỳ (paymaster 4337) |
| Gửi mọi token / dùng như ví thường | ✅ | ✅ | ✅ |
| Tài sản tách khỏi khoá | ❌ (khoá = ví) | ✅ | ✅ |
| Chi phí gas/op | thấp | trung bình (~2.5 KB sig) | trung bình |
| Tương thích dApp đời cũ | cao nhất | cần EIP-1271 | cần EIP-1271 |

---

## 5. Kết luận an toàn

Thiết kế được chọn tối đa hoá bảo mật theo **thứ tự ưu tiên đúng**: (1) tài sản tách khỏi khoá → (2) khoá kháng lượng tử thật sự → (3) secret entropy cao chỉ ở client → (4) relayer tối thiểu tin cậy. Các giới hạn còn lại là **giới hạn vật lý của EVM 2026** (không precompile PQ, EIP-1271 chưa phổ biến), không phải thiếu sót thiết kế — và đều có đường nâng cấp đã ghi rõ (WOTS+ cây lớn, STARK verifier, EIP-7702-type khi chain hỗ trợ).
