# Xuất Cấu Hình LiteLLM Proxy Cho Combo RouterSync

Tài liệu kỹ thuật hướng dẫn xuất cấu hình LiteLLM Proxy từ combo của RouterSync (`routersync export litellm`).

---

## 1. Mục Đích Và Phạm Vi

Tính năng xuất cấu hình LiteLLM chuyển đổi định nghĩa combo sang tệp YAML tương thích chuẩn LiteLLM Proxy.
Định dạng đầu ra cho phép người dùng chạy `litellm --config config.yaml` để đóng vai trò làm proxy chuyển tiếp.

Nguồn tham chiếu tài liệu chính thức: https://docs.litellm.ai/docs/proxy/config_settings

---

## 2. Cấu Trúc Đầu Ra YAML

Cấu hình xuất ra bao gồm hai khối chính theo chuẩn LiteLLM:

1. `model_list`: Danh sách các mô hình mục tiêu kèm tiền tố và tham chiếu khóa môi trường.
2. `router_settings`: Cấu hình định tuyến dự phòng với `fallbacks`.

Mẫu cấu hình xuất chuẩn:

```yaml
model_list:
  - model_name: test-3
    litellm_params:
      model: openrouter/google/gemini-2.0-flash-exp:free
      api_key: os.environ/OPENROUTER_API_KEY
  - model_name: test-3-fallback-1
    litellm_params:
      model: openrouter/meta-llama/llama-3.3-70b-instruct:free
      api_key: os.environ/OPENROUTER_API_KEY
router_settings:
  fallbacks:
    - test-3:
        - test-3-fallback-1
```

---

## 3. Quy Tắc Xử Lý Tiền Tố (litellmPrefix)

Mỗi nhà cung cấp trong `providers.json` hoặc cấu hình nguồn có thể định nghĩa thuộc tính `litellmPrefix`.
Nếu trường này được cung cấp:
- Bộ chuyển đổi sẽ ghép `litellmPrefix` phía trước tên định danh mô hình.
- Ví dụ: `litellmPrefix: "openrouter"` kết hợp cùng `google/gemini-2.0-flash-exp:free` tạo ra `openrouter/google/gemini-2.0-flash-exp:free`.
- Nếu không có `litellmPrefix`, giữ nguyên định danh mô hình gốc hoặc áp dụng quy tắc mặc định theo adapter.

---

## 4. Quản Lý Bí Mật Và Biến Môi Trường

1. Không bao giờ xuất khóa API thô dạng văn bản vào tệp cấu hình YAML.
2. Khóa xác thực luôn được định dạng dưới dạng tham chiếu biến môi trường LiteLLM:
   `api_key: os.environ/<PROVIDER_UPPER>_API_KEY`
3. Nhờ đó tệp cấu hình xuất ra có thể lưu trữ hoặc kiểm tra phiên bản mà không sợ rò rỉ khóa bí mật.

---

## 5. Danh Sách Dự Phòng (fallbacks)

Các bước mô hình trong combo được ánh xạ thành danh sách ưu tiên:
- Mô hình đầu tiên nhận vai trò mô hình chính ứng với `model_name` của combo (ví dụ `test-3`).
- Các mô hình tiếp theo được đặt tên kèm hậu tố thứ tự: `<combo>-fallback-<chỉ số>`.
- Khối `router_settings.fallbacks` khai báo chuỗi chuyển đổi khi mô hình chính gặp lỗi hoặc hết hạn mức.
- Quy tắc bảo toàn: combo cần giữ tối thiểu 2 bước (minSteps >= 2) để chuỗi fallback có hiệu lực.
