# Đặc Tả Kiến Trúc: Bộ Ghi Model Hẹp (Narrow Model Writer)

Tài liệu thiết kế bộ ghi model hẹp phục vụ thao tác kích hoạt (`ENABLE_MODEL`), vô hiệu hóa (`DISABLE_MODEL`), và thêm model tùy chỉnh (`ADD_MODEL`) vào router cục bộ.

---

## 1. Mục tiêu và Phạm vi

Khác với bộ lập kế hoạch combo (`sync --apply` hay `rank --apply` vốn chỉ thay đổi danh sách bước trong các combo định tuyến), bộ ghi model hẹp nhắm vào cấu hình nội bộ của từng router để:
1. **Bật một model đã bị tắt:** Gỡ model khỏi danh sách `disabledModels` (9Router).
2. **Tắt một model gặp lỗi / vắng mặt:** Thêm model vào danh sách `disabledModels` (9Router); với OmniRoute chưa có cơ chế đã xác minh.
3. **Thêm model tùy chỉnh:** Đăng ký model mới vào danh mục `customModels` (9Router); với OmniRoute chưa có cơ chế đã xác minh.

Hàm ghi hiện chỉ chạy trong test trên bản sao; việc đưa vào chuỗi áp dụng 7 bước là việc chưa làm.

---

## 2. Các Bất Biến An Toàn Cốt Lõi (Safety Invariants)

1. **Rào chắn chống ghi trực tiếp vào Router Live (`LIVE-DB-SAFETY`):**
   - Mọi hàm ghi BẮT BUỘC gọi `assertNotLiveRouterDb(dbPath)` ở dòng đầu tiên.
   - Nếu `dbPath` trùng với đường dẫn cơ sở dữ liệu đang chạy của 9Router (`%APPDATA%/9router/db/data.sqlite`) hoặc OmniRoute (`~/.omniroute/storage.sqlite`), hệ thống lập tức ném lỗi ngoại lệ và dừng lại.
2. **Nguyên tử & Có khả năng hoàn tác (Transactional & Rollback-Ready):**
   - Mọi thao tác ghi phải thực hiện trong giao dịch SQLite (`BEGIN TRANSACTION ... COMMIT`).
   - Hàm trả về trạng thái ban đầu (`previousState`) và cung cấp hàm hoàn tác tương ứng (`rollback...`) để khôi phục trạng thái từng byte một khi phát hiện lỗi hoặc người dùng yêu cầu undo.
3. **Chế độ Chạy Thử (`dryRun`):**
   - Mặc định tham số `{ dryRun: true }` nếu không được truyền tường minh.
   - Khi ở chế độ `dryRun`, mã nguồn đọc dữ liệu, tính toán thay đổi dự kiến, trả về báo cáo nhưng KHÔNG thực thi bất kỳ câu lệnh `UPDATE` hay `INSERT` nào.
4. **Kiểm tra tính hợp lệ của tham số:**
   - `provider` và `modelId` phải là chuỗi không rỗng, không chứa ký tự điều khiển hoặc dấu phân cách độc hại.
5. **Kiểm chứng sau ghi (Read-Back Verification):**
   - Sau khi `COMMIT`, bộ ghi thực hiện truy vấn `SELECT` lại chính dòng vừa sửa đổi để xác nhận giá trị mới đã được lưu chính xác vào đĩa.

---

## 3. Chi tiết Đột Biến Dữ Liệu theo Router

### 3.1. 9Router
Dựa trên kết quả khảo sát chỉ đọc vòng C4r (`survey-model-tiers.md`):
1. **Kích hoạt model (`enableModel9Router`):**
   - Bảng đích: `kv`.
   - Điều kiện: `scope = 'disabledModels'` VÀ `key = ?` (provider, ví dụ `'gemini'`).
   - Hành động: Lấy mảng JSON hiện tại, lọc bỏ `modelId`.
   - Nếu mảng thay đổi: Ghi lại JSON mới vào cột `value`.
2. **Vô hiệu hóa model (`disableModel9Router`):**
   - Bảng đích: `kv`.
   - Điều kiện: `scope = 'disabledModels'` VÀ `key = ?`.
   - Hành động: Thêm `modelId` vào mảng JSON nếu chưa tồn tại.
   - Ghi lại JSON mới vào cột `value`.
3. **Thêm model tùy chỉnh (`addCustomModel9Router`):**
   - Bảng đích: `kv`.
   - Cột `scope`: `'customModels'`.
   - Cột `key`: `<provider>|<model_id>|llm`.
   - Cột `value`: JSON `{ "providerAlias": provider, "id": model_id, "type": "llm", "name": name || model_id }`.
4. **Hoàn tác (`rollback9RouterDisabled`):**
   - Khôi phục nguyên trạng mảng `originalDisabled` vào bảng `kv`.

### 3.2. OmniRoute (Trạng thái: CHƯA LÀM / CHƯA XÁC MINH)
1. **Khảo sát cấu trúc thực tế:**
   - Cơ sở dữ liệu OmniRoute live (`~/.omniroute/storage.sqlite`) có tổng cộng 132 bảng (131 bảng ứng dụng + `sqlite_sequence`).
   - Bảng `radar_local_model_state` có đúng 0 dòng dữ liệu.
   - Cơ chế bật/tắt model trực tiếp qua database của OmniRoute chưa được xác minh ("CHƯA XÁC MINH").
2. **Quy tắc an toàn (Fail-Safe Gate):**
   - Hàm `setOmniRouteModelStatus` được khóa lại với trạng thái **CHƯA LÀM**.
   - Mọi lượt gọi tới `setOmniRouteModelStatus` sẽ bị chặn và lập tức ném ngoại lệ:
     `'OmniRoute model status write is unsupported: radar_local_model_state has 0 rows and model toggling is unverified.'`
   - Tuyệt đối không giả định cấu trúc ghi của OmniRoute khi chưa có môi trường live được xác minh đầy đủ.

---

## 4. Phương Pháp Kiểm Thử Hộp Cát (Sandbox Testing)

Tất cả kiểm thử của bộ ghi model phải tuân thủ nghiêm ngặt:
- Khởi tạo thư mục tạm cô lập (`os.tmpdir()`).
- Tạo bản sao cơ sở dữ liệu mẫu hoặc mock SQLite schema tương ứng với 9Router/OmniRoute.
- Thực thi các thao tác ghi và đối soát tính toàn vẹn.
- Kiểm tra tính năng rollback đưa dữ liệu về đúng trạng thái ban đầu.
- Kiểm thử cụ thể chứng minh hàm `assertNotLiveRouterDb(dbPath)` chặn đứng việc gọi tới đường dẫn cơ sở dữ liệu router đang chạy (ném lỗi ngoại lệ ngay dòng đầu tiên).
---

## 5. Trạng Thái Tích Hợp Vào Chuỗi Áp Dụng An Toàn (Safety Chain Integration: CHƯA LÀM)

> **CẢNH BÁO QUAN TRỌNG:**  
> Toàn bộ các hàm trong `model-writer.ts` hiện tại là **bản mẫu độc lập (STANDALONE PROTOTYPE)**.  
> Chúng **CHƯA ĐƯỢC KẾT NỐI (CHƯA LÀM)** vào chuỗi áp dụng an toàn của RouterSync (`packages/cli/src/sync/write.ts`, `packages/core/src/applier/index.ts`).

### 5.1. Chuỗi Áp Dụng An Toàn Tiêu Chuẩn của RouterSync (The 7-Step Safety Chain)
Một thao tác ghi vào Router chỉ được coi là đạt chuẩn an toàn của RouterSync khi đi qua đầy đủ chuỗi 7 bước:
1. **Lập kế hoạch & Dry-run mặc định:** Tính toán diff rõ ràng, hiển thị bảng kế hoạch cho người vận hành.
2. **Băm kế hoạch (Plan Hash & Fingerprint):** Tạo mã băm cryptographic trên kế hoạch và trạng thái router hiện tại.
3. **Từ khóa xác nhận thủ công (Manual TTY Confirmation Word):** Yêu cầu người dùng tự tay gõ từ xác nhận (`chạy` / `chay`) trên terminal tương tác; cấm AI agent tự động điền.
4. **Lưu ảnh chụp trước khi ghi (Pre-write Snapshot):** Tạo bản snapshot đầy đủ (`saveSnapshot`) vào ledger an toàn.
5. **Ghi nguyên tử trong giao dịch (Atomic SQLite Transaction):** Thực hiện ghi qua bản sao hoặc staging, cấm ghi đè bừa bãi.
6. **Kiểm chứng đọc lại (Read-Back Verification):** Đọc lại dữ liệu trên đĩa, so khớp từng byte với trạng thái mong muốn.
7. **Khôi phục tự động khi lỗi (Rollback & Undo):** Tự động khôi phục nếu verification thất bại hoặc qua lệnh `routersync undo`.

### 5.2. Trạng Thái Hiện Tại của `model-writer.ts`
- Các hàm `enableModel9Router`, `disableModel9Router`, `addCustomModel9Router`, `rollback9RouterDisabled` đã được viết và kiểm thử đơn vị với rào chắn `assertNotLiveRouterDb`.
- Tuy nhiên, **CHƯA CÓ** lệnh CLI nào (như `routersync model enable/disable`) đưa chúng qua chuỗi 7 bước trên.
- Do đó, trạng thái tích hợp vào chuỗi an toàn thực thi của RouterSync được đánh dấu chính thức là: **CHƯA LÀM**.
- Bất kỳ thao tác thay đổi model thực tế nào trên router hiện nay vẫn phải do người dùng thực hiện thủ công trên giao diện của router tương ứng.
