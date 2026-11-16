# ADR-TRACK-01: Kiến Trúc Bộ Theo Dõi Model Zero-Token (Zero-Token Model Tracking)

> **Trạng thái:** `CONFIRMED (Cập nhật Round 51 — 8 loại sự kiện, ghi nguyên tử và TRACK-04)`
> **Ngày:** 2026-11-01
> **Tác giả:** RouterSync Team (Pha 3b — Model Tracking Engine)
> **Phạm vi:** packages/cli/src/commands/track.ts, packages/cli/src/commands/track-discover.ts, docs/track/
> **Tham chiếu Spec:** Spec §23.2 R12 (Zero-token ping invariant), Spec §31.9 (Daemon architecture)

---

## 1. Bối cảnh & Yêu cầu (Context)

Người dùng cần theo dõi danh mục model được cung cấp bởi các nhà cung cấp LLM upstream (như OpenRouter, Groq, Ollama, OpenAI...) với các điều kiện:
1. **Không tốn chi phí token:** Không được gọi endpoint suy luận tính phí (như `/v1/chat/completions` hay `/v1/embeddings`).
2. **Cô lập kiến trúc:** Bộ theo dõi chạy ở **tiến trình riêng**, không nhét logic ghi hoặc polling nặng vào daemon. Daemon giữ nguyên bản chất chỉ-đọc (read-only), 0 route POST.
3. **Chống rung giật & bảo vệ catalog:** Khi nhà cung cấp gặp sự cố tạm thời, mất kết nối, hoặc danh mục bị co rút đột ngột, hệ thống không được xóa nhầm model trong router.

---

## 2. Quyết định kiến trúc (Decisions)

### 2.1. Giao thức zero-token thuần túy
- Bộ theo dõi chỉ sử dụng duy nhất phương thức HTTP `GET /v1/models` đối với từng provider.
- Cấm thao tác gọi inference/completion/embedding hoặc gửi request POST. Mọi request kiểm tra sức sống đều là probe mức HTTP GET hoặc metadata.
- Trường hợp nhà cung cấp không hỗ trợ endpoint liệt kê, trạng thái được đánh dấu rõ ràng là `không phát hiện được` hoặc `UNVERIFIED`, không tự suy đoán.
- Tất cả các trường thông tin model đều được trích xuất trực tiếp từ thuộc tính `id` trong mảng `data` của phản hồi JSON.

### 2.2. Tiến trình độc lập & Autostart
- Bộ theo dõi chạy độc lập thông qua nhóm lệnh `routersync track once|watch|status|autostart`.
- Daemon HTTP (`routersync daemon`) không thực hiện chu kỳ quét model nền hay thêm endpoint POST nào.
- Việc chạy ngầm định kỳ được giao cho cơ chế tự khởi động hệ thống (`autostart`) như Windows Task Scheduler, systemd user service, launchd plist, hoặc crontab.
- Cung cấp lệnh `routersync track autostart --print` để xuất cấu hình mẫu hướng dẫn người dùng thiết lập dịch vụ tự khởi động an toàn mà không tác động trực tiếp vào hệ điều hành.

### 2.3. Sàn tần suất quét (Floor Interval) 300 giây
- Khoảng cách giữa hai lần quét liên tiếp tối thiểu là `300` giây (5 phút).
- Lệnh `routersync track watch` từ chối khởi chạy nếu `intervalSec < 300` nhằm chống quét dồn dập (thao túng DoS provider), trừ khi biến môi trường thử nghiệm `ROUTERSYNC_TEST_FAST=1` được thiết lập.

### 2.4. Lưu trữ trạng thái bền vững & Ghi tập tin nguyên tử (Round 51)
- Trạng thái quét được ghi vào tệp `tracker-state.json` và dòng sự kiện được ghi vào `track-events.jsonl`.
- Thư mục lưu trữ ưu tiên biến môi trường `ROUTERSYNC_STATE_DIR`, mặc định trỏ về `~/.routersync`.
- Bí mật (API key) đọc trực tiếp từ biến môi trường của môi trường thực thi, không bao giờ được ghi vào `tracker-state.json`, stdout, hay stderr.
- **Ghi nguyên tử bằng tệp tạm:** Nhằm chống rủi ro hỏng tệp khi tiến trình bị ngắt đột ngột, việc ghi `track-events.jsonl`, `tracker-state.json` và `mcp-clients.json` được thực hiện qua tệp tạm cùng thư mục rồi đổi tên (`renameSync`). Tệp sự kiện được giới hạn trần 2000 dòng hoặc 5 MB.

### 2.5. Hệ thống 8 loại sự kiện theo dõi (Round 51)
Bộ theo dõi phát sinh 8 loại sự kiện chuẩn vào `track-events.jsonl` với cấu trúc `{timestamp, type, provider, models?, count?, detail?, run}`:
1. `baseline`: Thiết lập mốc danh mục ban đầu ở chu kỳ đầu tiên của provider.
2. `model_added`: Phát hiện model mới xuất hiện so với chu kỳ trước.
3. `model_pending`: Model vắng mặt ở 1 chu kỳ quét (bắt đầu thời gian ân hạn).
4. `model_removed`: Model tiếp tục vắng mặt liên tiếp 2 chu kỳ quét (chính thức loại bỏ).
5. `model_recovered`: Model từng bị `model_pending` nay xuất hiện trở lại trong phản hồi.
6. `provider_frozen`: Danh mục của provider co rút đột ngột > 30%, ghi kèm `count` trước/sau trong `detail`.
7. `provider_auth_error`: Lỗi xác thực HTTP 401 hoặc 403 từ endpoint upstream.
8. `provider_unreachable`: Lỗi mạng, timeout hoặc lỗi máy chủ 5xx từ phía provider.

Cùng một provider chỉ phát một sự kiện trạng thái khi trạng thái thay đổi, không phát lặp lại ở mỗi chu kỳ nếu trạng thái giữ nguyên.

### 2.6. Nhiệm vụ TRACK-04: Khóa mã hóa trong OmniRoute
Khi phát hiện provider trong OmniRoute có API key được lưu dưới dạng chuỗi mã hóa (`encrypted`), bộ theo dõi không cố giải mã nhằm bảo vệ bí mật. Provider được gán trạng thái `key-encrypted` và hiển thị trong danh sách `SKIPPED` với lý do `key-encrypted`. Nhiệm vụ `TRACK-04` được ghi nhận để chờ cơ chế tiếp nhận khóa an toàn từ chủ dự án trong tương lai.

---

## 3. Giao Diện & Tương Tác Người Dùng (UI / UX)

1. Màn hình Nhà cung cấp (ProvidersScreen) bổ sung khối thông tin về tiến trình theo dõi zero-token, hiển thị lần quét gần nhất và nút lệnh `Chạy theo dõi` (sao chép lệnh `routersync track watch`).
2. Màn hình Model (ModelsScreen) hiển thị các huy hiệu trạng thái vòng đời model:
   - `Mới phát hiện`: Model vừa được thêm vào danh mục sau chu kỳ baseline.
   - `Sắp bị loại`: Model vắng mặt chu kỳ đầu tiên và đang trong thời gian ân hạn.
   - `Bị loại`: Model vắng mặt liên tiếp 2 chu kỳ và đã bị loại khỏi danh mục hoạt động.
3. Thao tác sao chép lệnh tuân thủ nguyên tắc COPY-CMD, không tự ý kích hoạt lệnh ghi ngầm từ phía giao diện web.

---

## 4. Hệ quả & Đánh giá (Consequences)

- Đảm bảo nguyên tắc zero-token bất biến của RouterSync: không phát sinh cước phí token ngoài ý muốn.
- Tách rời khỏi daemon HTTP, giữ cho daemon nhẹ, an toàn và chỉ-đọc.
- Chống rung giật và bảo vệ danh mục model với cơ chế ân hạn hai chu kỳ và đóng băng sụt giảm bất thường.
