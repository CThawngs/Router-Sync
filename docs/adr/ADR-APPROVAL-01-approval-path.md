# ADR-APPROVAL-01: Kiến Trúc Đường Phê Duyệt Thay Đổi Và Vòng Đời Token

> **Trạng thái:** `PROPOSED` — Chuẩn bị cho Phase 3b/Phase 4
> **Ngày:** 2026-10-28
> **Tham chiếu Spec:** Spec §14, §15, §20, §31.8, §31.9
> **Tài liệu liên quan:** `docs/security/daemon-threat-model.md`, `ADR-MCP-CONNECT-01`

---

## 1. Bối Cảnh & Mô Hình Đe Dọa (Context & Threat Model)

RouterSync quản lý danh mục model và combo dự phòng của các router AI.
Bất biến cốt lõi: Chỉ con người trực tiếp phê duyệt thay đổi. Tiến trình nền và agent MCP không bao giờ tự cấp quyền ghi.
Tương tác với ADR-MCP-CONNECT-01: Agent kết nối qua MCP (dù qua stdio, HTTP hay OAuth) chỉ mang phạm vi đọc (`routersync:read`), không bao giờ có quyền phê duyệt hoặc kích hoạt lệnh ghi.

---

## 2. Phân Tích Các Phương Án Kiến Trúc

### Phương Án A: Phê Duyệt Thuần Túy Bằng Dòng Lệnh (CLI-Only Approval)
- **Cơ chế:** Web UI chỉ hiển thị diff chỉ đọc. Thao tác ghi bắt buộc chạy tại terminal có TTY thực (`routersync apply --write`). Cờ `--yes` bị từ chối.
- **Bảng mối đe dọa (Threat Matrix):**

| Mối đe dọa | Cách chặn | Rủi ro còn lại |
|---|---|---|
| Tiến trình cục bộ khác | Yêu cầu TTY tương tác trực tiếp; không mở socket ghi | Tiến trình chiếm quyền terminal |
| CSRF | Không có endpoint HTTP ghi trên mạng hay loopback | Không có (zero HTTP mutation) |
| DNS rebinding | Daemon chỉ phục vụ API đọc; từ chối cờ ghi | Không có rủi ro ghi qua web |
| Trang web gọi 127.0.0.1 | Trình duyệt chỉ đọc được dữ liệu nếu CORS mở; cấm ghi | Rò rỉ thông tin đọc nếu thiếu Origin check |
| Agent giả danh người | CLI từ chối `--yes` và từ chối stdin non-TTY | Agent có quyền shell thực thi lệnh |
| Đánh cắp token / replay | Không dùng token; xác nhận tại chỗ mỗi phiên | Không có token để đánh cắp |

- **Ánh xạ bất biến I1–I8:** CLI chạy `validatePlanInvariants()` kiểm tra đủ I1 (không trỏ model thiếu), I2 (quarantine), I3 (minSteps), I4 (idempotent), I5 (không đụng unmanaged), I6 (freeOnly), I7 (≥2 provider) trước khi hỏi xác nhận TTY; ghi theo đúng I8 (providers -> models -> combos -> slots).

---

### Phương Án B: Daemon Ghi Kèm Token Phê Duyệt Ngắn Hạn (Opt-In Daemon + Ephemeral Token)
- **Cơ chế:** Daemon mặc định chỉ đọc (S1). Ghi chỉ bật khi có cờ `--allow-apply`. Mỗi lần ghi cần Approval Token ngắn hạn (TTL 300s, dùng 1 lần, gắn với SHA256 của plan).
- **Bảng mối đe dọa (Threat Matrix):**

| Mối đe dọa | Cách chặn | Rủi ro còn lại |
|---|---|---|
| Tiến trình cục bộ khác | Token sinh ngẫu nhiên 256-bit trong RAM, không ghi đĩa | Tiến trình cùng user đọc bộ nhớ process |
| CSRF | Yêu cầu header tùy biến `X-RouterSync-Token` và Origin check | Lỗ hổng CORS cấu hình sai |
| DNS rebinding | Chặn Host header lạ; chỉ nhận loopback 127.0.0.1 | Tấn công cấp hệ điều hành cục bộ |
| Trang web gọi 127.0.0.1 | Preflight OPTIONS từ chối origin ngoài danh sách | Tiện ích trình duyệt độc hại tiêm mã |
| Agent giả danh người | Token chỉ cấp trên giao diện người dùng sau thao tác bấm | Agent chụp màn hình hoặc điều khiển chuột |
| Đánh cắp token / replay | Token dùng 1 lần (nonce consumed), gắn chặt SHA256 plan | Token bị bắt trộm trong khoảng 300s |

- **Ánh xạ bất biến I1–I8:** Endpoint `POST /api/v1/changes/approve` thẩm định I1–I7 trước khi chấp nhận token. Quá trình áp dụng thực thi atomic write theo đúng thứ tự I8 và rollback nếu read-back thất bại.

---

### Phương Án C: Yêu Cầu Từ Web UI Kèm Xác Nhận Trên TTY (UI Request + TTY Confirmation)
- **Cơ chế:** Web UI đưa yêu cầu vào hàng đợi chờ duyệt; daemon hiển thị prompt chờ người dùng gõ xác nhận trên TTY của tiến trình daemon.
- **Bảng mối đe dọa (Threat Matrix):**

| Mối đe dọa | Cách chặn | Rủi ro còn lại |
|---|---|---|
| Tiến trình cục bộ khác | Yêu cầu xác nhận phím tại console của daemon | Trực tiếp thao tác bàn phím |
| CSRF | Gửi yêu cầu chỉ tạo hàng đợi, không tự động áp dụng | Kẻ tấn công tạo rác trong hàng đợi |
| DNS rebinding | Không cho phép thực thi tự động qua HTTP | Gây nghẽn hàng đợi duyệt |
| Trang web gọi 127.0.0.1 | Yêu cầu xác nhận TTY để mở khóa thao tác | Bị spam thông báo duyệt |
| Agent giả danh người | Thao tác TTY yêu cầu nhập chuỗi ngẫu nhiên hiển thị | Agent có quyền pty giả lập gõ phím |
| Đánh cắp token / replay | Không dùng token qua mạng | Giả mạo chuỗi xác nhận trên terminal |

- **Ánh xạ bất biến I1–I8:** Daemon hiển thị tóm tắt vi phạm I1–I8 trên terminal; nếu vi phạm bất biến I1–I7, tiến trình từ chối đưa ra prompt xác nhận; ghi tuân thủ I8.

---

## 3. Khuyến Nghị Lộ Trình (Recommendation)

1. **Phase 3b:** Duy trì **Phương án A (CLI-only)**. Web UI thuần túy hiển thị và hướng dẫn lệnh CLI.
2. **Phase 4:** Phát triển **Phương án B (Ephemeral Token)** với xác thực nguồn gốc nghiêm ngặt và rào chắn chống replay.

---

## 4. Kế Hoạch Test Đỏ (Red Test Plan)

1. `test_reject_without_tty`: Lệnh apply không có TTY tương tác phải bị từ chối; cờ `--yes` bị từ chối lập tức.
2. `test_token_replay_rejected`: Gửi lại cùng một approval token lần thứ hai phải nhận lỗi `token_already_consumed`.
3. `test_token_plan_mismatch`: Thay đổi 1 byte trong plan khiến token bị từ chối do lệch SHA256.
4. `test_dns_rebinding_rejected`: Host header khác loopback phải bị từ chối ở tầng HTTP daemon.
5. `test_invariant_i1_i8_enforced`: Kế hoạch vi phạm I1 hoặc I8 phải bị hủy trước bước ghi thực tế.

---

## 5. Câu Hỏi Mở (Open Questions)

1. Thời gian sống (TTL) của approval token có nên cấu hình được trong `routersync.yaml` hay giữ cố định 300 giây?
2. Có cần hỗ trợ kênh ký duyệt token ngoại tuyến qua khóa SSH/GPG của quản trị viên trong tương lai không?
