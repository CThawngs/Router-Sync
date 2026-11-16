# ADR-DAEMON-01: Kiến Trúc Daemon HTTP Chỉ-Đọc (S1) Bằng node:http

> **Trạng thái:** `CONFIRMED (ủy quyền, an toàn trước, chủ dự án có thể đảo ngược)` — ủy quyền của chủ dự án ngày 2026-10-19  
> **Ngày:** 2026-10-17  
> **Người đề xuất:** Antigravity (Phase 3b — Lát cắt S1)  
> **Tham chiếu Spec:** Spec §31.8 (P3b), §31.9 (mục ④ Daemon), §34.1 (Web UI)  
> **Tài liệu liên quan:** `docs/security/daemon-threat-model.md`

---

## 1. Bối Cảnh (Context)

Người dùng cần Web UI (`packages/ui`) có thể kết nối ngay tới dữ liệu thực tế của các router (OmniRoute và 9Router) mà không cần chờ đến khi hoàn thành toàn bộ Cổng X và Phase 3a.
Để phục vụ nhu cầu này an toàn, lát cắt S1 (Read-Only Slice) của Daemon được triển khai với vai trò máy chủ API HTTP chỉ-đọc cục bộ, giao tiếp với Web UI.

Các yêu cầu an toàn cốt lõi theo Spec §31.8 & §31.9:
1. **Không có đường tới applier:** Daemon hoàn toàn không có khả năng ghi vào router DB hay gọi các hàm applier.
2. **0 external npm dependency:** Sử dụng thư viện chuẩn tích hợp `node:http`, không thêm framework bên ngoài (như Express, Fastify, Hono...). Daemon phụ thuộc duy nhất **một** package workspace `@routersync/core` nhưng **chỉ được import từ entrypoint chỉ-đọc `@routersync/core/readonly`** (R9-8 / DECISIONS 2026-10-17-11) — không có đường bắc cầu nào tới applier hay `allowLiveDbWrite` (AT-118).
3. **Cứng hóa mạng:** Chỉ bind `127.0.0.1`, chặn DNS rebinding, kiểm tra Origin (cho phép origin UI loopback thống nhất **3100**), không phát CORS.

---

## 2. Quyết Định Thiết Kế (Decisions)

### 2.1. Cấu trúc Package & Phụ thuộc Runtime
- Tạo package mới `@routersync/daemon` đặt tại `packages/daemon`.
- Sử dụng module chuẩn của Node.js: `node:http`.

| Phụ thuộc (Dependency) | Phiên bản | Giấy phép | Vai trò |
|---|---|---|---|
| `node:http`, `node:url`, `node:fs`, `node:path`, `node:os` | Built-in Node >= 22.12 | MIT (Node.js) | Máy chủ HTTP, xử lý URL, I/O |
| `@routersync/core` (workspace) | 0.1.0-alpha.1 | MIT | **Chỉ import `@routersync/core/readonly`** — driver SQLite đọc-chỉ (`better-sqlite3` bọc trong interface, `readonly: true` + `fileMustExist: true` ép cứng; R9-8: `node:sqlite` đã bị loại bỏ hoàn toàn khỏi daemon) |

**Tổng số external npm dependency thêm mới:** **0**. Số dependency workspace: **1** (`@routersync/core`, dùng duy nhất entrypoint `/readonly`).

### 2.2. Cổng Mạng Mặc Định (Port Specification)
- Daemon lắng nghe cố định tại cổng **`3128`** (`http://127.0.0.1:3128`).
- Cho phép cấu hình qua cờ `--port <number>` hoặc biến môi trường `ROUTERSYNC_DAEMON_PORT`.
- Cấm tuyệt đối bind địa chỉ không phải loopback (AT-37 / AT-119).

### 2.3. Tách Biệt Đường Đọc / Ghi (Read/Write Path Separation)
- **Đường Ghi (Write Path) trong `@routersync/core`:** Bao gồm `planCombos`, `applyMultiRouterSafe`, `applyPlan`, và cờ `allowLiveDbWrite`. Toàn bộ nhóm này bị cấm xuất hiện trong đồ thị import của `packages/daemon`.
- **Đường Đọc (Read Path) trong `@routersync/daemon`:**
  - Mọi kết nối tới cơ sở dữ liệu router được mở ở chế độ `readOnly: true`.
  - Khi adapter thực hiện thao tác đọc, nếu gặp lỗi khóa SQLite (`SQLITE_BUSY`, `SQLITE_LOCKED`), daemon bắt lỗi và trả về phản hồi suy thoái nhẹ (`meta.source = 'unavailable'`, `reason = 'db_busy'`), không làm sập tiến trình hoặc ném mã lỗi 500.

### 2.4. Danh Mục Endpoint Cho Lát Cắt S1
Mọi endpoint chỉ chấp nhận phương thức **`GET`**. Tất cả phương thức khác (`POST`, `PUT`, `DELETE`, `PATCH`) nhận mã lỗi **`405 Method Not Allowed`** với payload `{ error: 'read_only_slice' }`.

1. `GET /api/v1/health`: Báo cáo sức khỏe daemon, phiên bản, `uptime` đo động (`process.uptime()`), và trạng thái probe kết nối tới các router.
2. `GET /api/v1/overview`: Bộ đếm đo thật (`routers: { upCount, probedCount }` và `trackedModels`), `billableRequestsToday` chỉ có `code: 'by_design_zero_inference'`, không có mảng `todoItems`/`recentEvents` kiểu cũ và không có câu văn tự do (D1 `{code, params}`). `activeProviders` không tồn tại trong payload S1 (R14-6.1: S1 đo độ phản hồi của router, không đo hoạt động của provider).
3. `GET /api/v1/targets`: Thông tin các router được cấu hình, mức đọc lại thực tế (`readBackLevel: 'db-only'`, `derivedFrom: 'no_key_in_s1'`), tách **hai khối `db`** (SQLite) và **`probe`** (mạng) với metadata nguồn riêng. **Không phát `applyState`** (R11-3: S1 không ghi gì nên không bao giờ tuyên bố `verified` — xem DECISIONS 2026-10-18-01) và **không có metadata khóa** (`keyName`/`keyScope` không có trong payload S1, chờ P3a).
4. `GET /api/v1/combos`: Danh sách combo đọc từ SQLite của router; trả mảng rỗng trung thực khi DB không có combo; không tự chế dữ liệu mẫu.
5. `GET /api/v1/doctor`: Kết quả chẩn đoán c1..c6 đo thật (c1 so Node với ngưỡng từ `engines`; c4 kiểm **schema fingerprint** của SQLite), c7..c9 trả `not_checked` + `reason: 'needs_p3a'`; thông báo dạng `{code, params}`.
6. `GET /api/v1/settings`: Đọc `policyMode` thật từ `routersync.yaml`; lược bỏ `scanSchedule`/`maxDailyRequests`/`mcpClients` (S1 không đo).
7. Các màn hình cần dữ liệu Phase 3a/3b (`/providers`, `/models`, `/changes`, `/changes/pending`, `/changes/history`, `/heartbeat`): Trả về envelope `{ meta: { source: 'unavailable', reason: 'needs_p3a' }, code: 'slice_s1_deferred_to_p3a', resource, data: [] }`, đảm bảo UI hiển thị giao diện nét đứt xám trung thực, không bịa số liệu và không gây lỗi 404.

Nguồn gốc từng trường payload được phân định chi tiết trong `docs/ui/API-CONTRACT.md` §4 (measured / derived / static-capability / omitted).

---

## 3. Hệ Quả & Đánh Giá (Consequences)

### Tích cực:
- Cung cấp dữ liệu thực tế cho Web UI ngay lập tức, đáp ứng mong đợi của chủ dự án.
- Không rủi ro ghi đè dữ liệu vì tính chất chỉ-đọc được bảo đảm ở tầng mạng, tầng mã nguồn, và tầng cơ sở dữ liệu.
- Không phát sinh dependency nặng, giữ mã nguồn tinh gọn và khởi động tức thì (<50ms).

### Hạn chế & Ranh giới:
- Chưa hỗ trợ ghi/apply từ UI (các nút ghi trên UI sẽ bị vô hiệu hóa có chủ đích với thông báo "cần daemon P3b/P4").
- Chưa có vòng lặp quét nền tự động định kỳ (Fast Loop) hay daemon supervisor (sẽ hoàn thiện ở S2/Phase 3b).
- Không phát `applyState` (R11-3): S1 không thực hiện thao tác ghi nào nên không thể tuyên bố `verified`/`written-pending-reload`; trường này trở lại cùng lát P3b applier — khoảng trống enum đang chờ Chủ dự án (DECISIONS 2026-10-18-01).
- Kiểm thử nghiệm thu daemon phải kín (hermetic, R11-0): mọi test khởi daemon dùng `test/harness/daemon-fixture.ts` (AT-127 guard) — không đọc DB thật, không probe cổng thật 20128/30128.
