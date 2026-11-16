# ADR-PROVIDER-SYNC-01: Kiến trúc tính năng đồng bộ danh sách model nhà cung cấp (R56)

- Trạng thái: PROPOSED
- Ngày: 2026-11-02
- Quyết định số: 2026-11-02-02
- Tác giả: RouterSync Team

## Bối cảnh

ROUND 55 chỉ ra rằng cả 9Router và OmniRoute đều có danh sách model không đồng bộ:
- 9Router lưu 74 NVIDIA model trong `enabledModels` nhưng catalog chỉ còn 35 model;
  combo dùng namespace `nvidia/deepseek-ai/...` trong khi catalog dùng `nvidia:...`.
- OmniRoute lưu `enabledModels=0` cho mọi connection; từ chối gọi nếu model không có
  trong live catalog; có model đã bị provider trả về 404 (`deepseek-v4.1-flash-free`).
- Chỉ 4/67 connection có catalog endpoint trực tiếp trong DB.

## Quyết định đề xuất

### 1. Nguồn danh mục hai tầng (Two-Tier Catalog Source)
- **Tầng 1 (File local)**: Với 9Router, đọc trực tiếp `%APPDATA%\9router\model-catalog.json`
  (tự động refresh hàng ngày, 5592 models, không tốn token, không cần key).
- **Tầng 2 (Keyed live probe)**: Với các provider có `baseUrl` (OmniRoute openai-compatible),
  chỉ thực hiện GET `/v1/models` khi có phê duyệt rõ ràng từ người dùng.
- **Tầng 3 (Fallback)**: Đọc từ public registry nếu cả hai tầng trên không áp dụng.

### 2. Chuẩn hóa Namespace Model
Quy định ánh xạ 3 chiều trước khi so sánh:
- `combo_format`: `<router-prefix>/<org>/<model>` (ví dụ: `nvidia/deepseek-ai/deepseek-v4.1-flash`)
- `provider_format`: `<org>/<model>` (ví dụ: `deepseek-ai/deepseek-v4.1-flash`)
- `catalog_key`: `<provider>:<model>` (ví dụ: `nvidia:deepseek-v4.1-flash`)
Bộ chuyển đổi namespace thuần túy (pure function) trong `@routersync/core`.

### 3. Quy trình Đồng bộ An toàn (R56)
- Bất biến I1–I8 giữ nguyên. Thêm:
  - **I9**: Không tự ý xóa model khỏi `enabledModels` nếu model đó đang nằm trong một combo.
  - **I10**: Model phát hiện `404` trong log phải trải qua thời gian ân hạn (quarantine) ≥ 3 lần
    quét độc lập trước khi bị đề xuất gỡ bỏ.
- Dry-run mặc định: chỉ tạo đề xuất thay đổi, không tự động ghi vào DB router.

## Hậu quả

- **Tích cực**: Combo không còn trỏ vào model đã chết; phát hiện sớm model mới miễn phí.
- **Hạn chế**: Cần bảo trì bảng ánh xạ namespace cho các nhà cung cấp có format dị biệt.
