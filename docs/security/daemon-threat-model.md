# Mô Hình Đe Dọa Cho Daemon RouterSync (T3-DAEMON-SEC)

> **Trạng thái:** `PENDING_REVIEW (chờ chủ dự án xem xét duyệt)`  
> **Phiên bản:** v1.1 (Lát cắt S1: Daemon chỉ-đọc & P3b Token Verification)  
> **Ngày:** 2026-10-24  
> **Tài liệu liên quan:** `docs/adr/ADR-DAEMON-01.md`, `.agent/SPEC.md` (§31.8, §31.9), `docs/ui/API-CONTRACT.md`

---

## 1. Giới Thiệu & Phạm Vi (Scope)

Tài liệu này xác định mô hình đe dọa an ninh thông tin cho daemon HTTP cục bộ của RouterSync (`packages/daemon`).
Trong lát cắt S1 (Read-Only Daemon Slice), daemon đóng vai trò cầu nối dữ liệu chỉ-đọc (read-only) phục vụ Web UI cục bộ qua cổng loopback cố định (mặc định: `127.0.0.1:3128`).

### Tài Sản Cần Bảo Vệ (Protected Assets)
1. **Tính toàn vẹn của cơ sở dữ liệu router:** Các tệp SQLite của 9Router và OmniRoute không bị ghi đè, không phát sinh lock contention (`SQLITE_BUSY`), và không bị can thiệp trái phép.
2. **Khóa bí mật & Thông tin xác thực:** Giá trị API key (`OMNIROUTE_API_KEY`, `NINEROUTER_CLIENT_KEY`, v.v.) không bao giờ bị rò rỉ qua HTTP headers, response bodies, hay log file.
3. **An toàn ngữ cảnh của Agent (Agent Prompt Integrity):** Dữ liệu chuỗi từ router (tên combo, model ID, ghi chú) không chứa mã độc tiêm nhiễm prompt (`prompt injection`).
4. **Tài nguyên hệ thống cục bộ:** Ổn định socket, CPU, bộ nhớ, và file descriptors của máy tính người dùng.

---

## 2. Ranh Giới Tin Cậy & Tác Nhân Đe Dọa (Trust Boundaries & Threat Actors)

### 2.1. Phân định rõ ranh giới tin cậy (Trust Boundary Clarification)
- **Tiến trình cùng quyền người dùng (Same-user processes) và Agent có shell:** **KHÔNG** thuộc ranh giới phòng thủ của daemon. Một tiến trình chạy cùng user account hoặc một agent có quyền chạy terminal command vốn dĩ đã có quyền đọc tệp cục bộ và bộ nhớ tiến trình; daemon không thể và không đóng vai trò rào chắn chống lại cùng quyền người dùng đó.
- **Ranh giới an ninh thực sự của Daemon bao gồm:**
  1. **Trang web lạ chạy trong trình duyệt của người dùng (Malicious Web Origin via Browser).**
  2. **Mạng ngoài / Thiết bị khác trên mạng nội bộ (External / Local Network Interface).**
  3. **Dữ liệu đầu vào không tin cậy từ phía router hoặc tệp cấu hình (Untrusted Data Input).**

---

## 3. Các Mối Đe Dọa & Biện Pháp Giảm Thiểu (Threats & Mitigations)

| ID | Mối đe dọa | Tác nhân / Kịch bản | Biện pháp giảm thiểu (Mitigations) |
|---|---|---|---|
| **T-01** | **DNS Rebinding** | Trang web độc hại lừa trình duyệt gửi request đến `127.0.0.1:3128` bằng cách trỏ domain độc hại về loopback sau khi load. | **Kiểm tra Host Header nghiêm ngặt:** Chỉ chấp nhận `Host` là `127.0.0.1:${port}` hoặc `localhost:${port}`. Mọi host lạ bị từ chối bằng HTTP `403 Forbidden` hoặc `421 Misdirected Request` (AT-119). |
| **T-02** | **Cross-Site Request Forgery (CSRF)** | Trang web độc hại chạy ngầm script trong trình duyệt để truy vấn daemon. | **(1) Đa số endpoint chỉ hỗ trợ GET:** Các endpoint đọc trả về `405` với mọi method khác. Với endpoint `POST /api/v1/changes/approve` (đã thêm ở Phase 3b / AT-165):<br>- Chỉ chấp nhận payload JSON < 8KB mang `token` 64-hex ngẫu nhiên và `planHash` khớp trong RAM (5 phút TTL, single-use nonce).<br>- Endpoint KHÔNG thực hiện ghi DB hay ghi router (zero-write in S1).<br>- *Token generation & Gaps tồn tại*: Hàm `createApprovalToken` hiện chỉ có call-site trong acceptance tests (AT-165, AT-166); chưa có luồng phát hành token qua UI/CLI thật nên endpoint approve chưa thể gọi từ UI thật. Chưa có session token `X-RouterSync-Session`, chưa có pairing code, chưa có rate limit, chưa có audit log.<br>**(2) Kiểm tra Origin:** Nếu có header `Origin`, chỉ chấp nhận origin UI loopback thống nhất (`http://127.0.0.1:3100`, `http://localhost:3100`), daemon self-origin, hoặc `ROUTERSYNC_UI_ORIGIN`. Mọi origin lạ bị chặn bằng HTTP `403 Forbidden` (`invalid_origin`).<br>**(3) KHÔNG phát CORS:** Daemon không phát `Access-Control-Allow-Origin: *`. Web UI trong dev dùng proxy Vite (`changeOrigin: true`); bản build production do daemon phục vụ cùng origin. |
| **T-03** | **Lộ lọt qua mạng ngoài (External Exposure)** | Daemon vô tình bind `0.0.0.0` mở cổng cho thiết bị ngoài mạng LAN quét tới. | **Ràng buộc Loopback độc quyền (AT-37 / AT-119):** Daemon chỉ bind `127.0.0.1`. Nếu cấu hình hoặc tham số cố tình bind IP không-loopback, daemon lập tức từ chối khởi động và thoát với exit code lỗi. |
| **T-04** | **Rò rỉ khóa bí mật (Secret Leakage)** | Endpoint trả về cấu hình chứa chuỗi API key trần. | **Không trả giá trị khóa — payload S1 không chứa metadata khóa:** Trong payload daemon S1 hiện tại, các trường `keyName`/`keyScope` **không tồn tại** (bị lược bỏ như mọi trường chưa đo; bảng provenance trong `docs/ui/API-CONTRACT.md` không liệt kê chúng, và `/targets` chỉ trả `db`/`probe`). Giá trị khóa không bao giờ nạp vào response body hay HTTP response headers (AT-120 canary). Metadata khóa (`keyName`/`keyScope`) chỉ được cân nhắc bổ sung ở **P3a** cùng cổng credential. |
| **T-05** | **Tiêm nhiễm Prompt (Prompt Injection)** | Tên combo hoặc nhãn model chứa chuỗi điều khiển (`<system>`, `[INST]`, `<\|im_start\|>`) nhằm đánh lừa LLM khi UI kết nối harness. | **Làm sạch chuỗi đầu ra (AT-90 / AT-120):** Mọi chuỗi xuất xứ từ router được xử lý qua bộ khử prompt injection (MCP sanitize utility) trước khi gửi về client. |
| **T-06** | **Ghi đè DB router trái phép (Unauthorized Write)** | Lỗ hổng trong mã daemon vô tình kích hoạt ghi vào cơ sở dữ liệu router đang chạy. | **Cô lập mã nguồn & Read-Only Handlers (AT-118):**<br>- Mọi kết nối SQLite từ daemon được mở với cờ `readOnly: true`.<br>- Tách biệt kiến trúc: Gói `packages/daemon` không có đường import bắc cầu (transitive import) tới applier hay cờ `allowLiveDbWrite`. |
| **T-07** | **Từ chối dịch vụ / Lock DB (DoS & DB Lock)** | Client gửi dồn dập request đọc gây quá tải router hoặc nghẽn SQLite lock. | **(1) Cache ngắn hạn (chỉ probe):** Kết quả probe mạng được cache trong `CACHE_TTL_MS = 2500` ms (`packages/daemon/src/probe/reachability.ts`) để tránh spam socket I/O. Lưu ý: **đọc SQLite KHÔNG được cache** trong S1 — mỗi request đọc DB là một lần đọc thật.<br>**(2) Giới hạn kích thước:** `maxHeaderSize: 8192` (8 KB) trong `packages/daemon/src/server.ts` bảo vệ mọi request. Các endpoint `GET` không nhận request body (trả lỗi `405` nếu gọi method khác). Endpoint `POST /api/v1/changes/approve` kiểm soát kích thước body nghiêm ngặt với ngưỡng trần 8 KB (`rawBody.length > 8192` trả HTTP `413 Payload size limit exceeded`), giảm thiểu rủi ro cạn kiệt bộ nhớ tiến trình (RAM exhaustion DoS).<br>**(3) Xử lý khóa mềm dẻo (B-2):** Khi gặp `SQLITE_BUSY` hoặc `SQLITE_LOCKED`, daemon trả về `meta.source = 'unavailable'` và `reason = 'db_busy'`, không sập tiến trình hay quăng HTTP 500. |

---

## 4. Nguyên Tắc Ngôn Từ An Ninh

Tài liệu này và mã nguồn daemon tuân thủ nguyên tắc kỹ thuật:
- Sử dụng thuật ngữ **"giảm thiểu" (mitigate)** thay cho "chặn hoàn toàn" (completely prevent), bởi an ninh là sự phòng thủ nhiều lớp (defense-in-depth), không có sự bảo đảm tuyệt đối khi môi trường runtime bị xâm phạm từ mức hệ điều hành.

---

## 5. Danh Mục Tiêu Chí Chấp Nhận (AT References)
- **AT-118:** Bất biến chỉ-đọc (cấm import applier, SQLite readonly, non-GET -> 405).
- **AT-119:** Cứng hóa mạng (loopback bind, Host allowlist, Origin check với cổng UI 3100, No CORS).
- **AT-120:** Không rò rỉ bí mật (canary secrecy, prompt injection sanitization).
- **AT-121:** Tính trung thực dữ liệu (phản ánh đúng router reachability, phân tách rõ ràng live / sample / unavailable).
- **AT-122:** Kiểm chứng chỉ-đọc trên DB router thực tế (băm sha256 của tệp DB trước và sau bằng nhau).
- **AT-123:** Đảm bảo zero sample data, zero Vietnamese text, zero free-form sentences trong payload daemon (chu kỳ đột biến red-green).
- **AT-125:** Phân loại probe router trung thực (200 -> up, 404 + /v1/models 200 -> up, refused/timeout -> down, 5xx/401 -> unknown); ca R11-3 xác nhận `/targets` router UP không phát khóa `applyState`.
- **AT-126:** Kiểm thử E2E UI Vite proxy (`changeOrigin: true`) và từ chối Host/Origin lạ bằng HTTP 403.
- **AT-127 (R11-0.3):** Guard test kín (hermetic): ném lỗi nếu đường dẫn DB phân giải không nằm dưới `os.tmpdir()`, URL probe có cổng 20128/30128, hoặc config không phải file tmp — ngăn test tự động đụng DB/router thật (DECISIONS 2026-10-14-04).
- **AT-165:** Mô hình đe dọa daemon & vòng đời approval token (bắt buộc token 64-hex hợp lệ, ràng buộc planHash, TTL 5 phút, single-use, từ chối token giả mạo/hết hạn, zero-write).
- **AT-166:** Tích hợp E2E UI và daemon cho luồng duyệt thay đổi (giao diện gọi POST approve, xử lý 401 khi token sai, xác nhận không ghi DB khi duyệt).

