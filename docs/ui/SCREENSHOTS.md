# Nội dung dự kiến của 14 ảnh viewport 1440x900 (chưa chụp)

> **Trạng thái:** `NOT RUN` (chưa chụp).  
> **Ghi chú:** Chưa có file PNG thật trong repo và chưa gửi cho chủ dự án. Bảng AT ghi nhận `NOT RUN` cho kiểm tra hồi quy hình ảnh cho tới khi có file PNG thật (nguồn `FIXTURE`) hoặc chạy tự động qua Playwright ở Phase 3.  
> Chi tiết các phép đo tương phản chính xác xem tại [CONTRAST.md](CONTRAST.md).

---

## 1. Overview Screen (Tổng quan)

### Running State (Đang chạy)
- **Light Theme (1440×900):** `cp1_overview_running_light.png`
  - Hero header tóm tắt trạng thái và liên kết trực tiếp tới các thay đổi chờ duyệt.
  - Dev switcher được loại bỏ khỏi hero; chuyển vào menu `DỮ LIỆU MẪU` và Cài đặt.
  - 4 metric tiles: nhà cung cấp hoạt động, model theo dõi, 0 yêu cầu tính phí, 2m heartbeat nền.
  - Danh sách việc cần làm (cổng duyệt #a41f, cảnh báo khóa, duyệt đặc tính lạ).
  - Thang 5 bước vận hành tương tác.
  - Đường ống 8 module với Module 8 (Verify) hiển thị nét đứt unverified kèm glyph `?`.
- **Dark Theme (1440×900):** `cp1_overview_running_dark.png`
  - Giao diện chế độ tối chuẩn token concept v5 (`--bg`, `--card`, `--text`).
  - Ranh giới thẻ phân tách rõ ràng với nền thông qua viền 1px (`--line`) và đổ bóng độ sâu (`--sh`).

### First-Run State (Lần đầu)
- **Light Theme (1440×900):** `cp1_overview_first_run_light.png`
  - Hero chào mừng với danh sách 4 bước thiết lập ban đầu (chỉ số tiến độ 0/4).
  - Khung tự kiểm tra môi trường máy cục bộ.
  - Khung 5 cam kết an toàn "Không bao giờ".
  - Thẻ kết nối trợ lý AI agent.
- **Dark Theme (1440×900):** `cp1_overview_first_run_dark.png`
  - Đồng bộ hiển thị trên bảng màu tối.

---

## 2. Changes Screen (Thay đổi)

- **Light Theme (1440×900):** `cp2_changes_light.png`
  - Tab Chờ duyệt với Cổng `#a41f` (hộp màu vàng alpha, huy hiệu phân cấp rõ ràng).
  - 5 hành động thay đổi với chip rủi ro thấp/vừa/cao sử dụng các token ink chuyên dụng.
  - Tab Lịch sử & Hoàn tác hiển thị danh sách snapshot bền vững.
  - Modal xem trước hoàn tác dry-run với checkbox xác nhận bắt buộc, nút Hủy mặc định nhận focus, và rào chắn kiểm tra daemon HTTP.
- **Dark Theme (1440×900):** `cp2_changes_dark.png`
  - Đồng bộ hiển thị với badge text độ tương phản cao trên nền tối.

---

## 3. Combos Screen (Combo & Live Builder)

- **View Combos Tab:**
  - **Light Theme (1440×900):** `cp2_combos_light.png`
  - **Dark Theme (1440×900):** `cp2_combos_dark.png`
  - 4 tab chọn combo (coding-fast, smart-fallback, vision-first, free-only).
  - Mô phỏng thang dự phòng với bộ điều khiển hỏng tương tác.
  - Bảng đối chiếu Desired vs Actual.
- **Builder Tab:**
  - **Light Theme (1440×900):** `cp2_builder_light.png`
  - **Dark Theme (1440×900):** `cp2_builder_dark.png`
  - 4 nút công thức nhanh (quick recipes).
  - Bộ chọn chiến lược (priority, round-robin, latency).
  - Bộ lọc đặc tính (freeOnly, vision, minContext 100k).
  - Danh sách xem trước model thời gian thực với gợi ý lý do phân loại (`ui0_builder_role_hint`).
  - Modal xem trước cấu hình YAML kiểm tra hợp lệ với CLI `ComboSpecSchema`.

---

## 4. Danh sách 14 ảnh dự kiến chụp (chưa chụp)

Các file ảnh viewport 1440×900 theo concept v5 dự kiến chụp khi có môi trường trình duyệt:
1. `cp1_overview_running_light.png`
2. `cp1_overview_running_dark.png`
3. `cp1_overview_first_run_light.png`
4. `cp1_overview_first_run_dark.png`
5. `cp2_changes_light.png`
6. `cp2_changes_dark.png`
7. `cp2_combos_light.png`
8. `cp2_combos_dark.png`
9. `cp2_builder_light.png`
10. `cp2_builder_dark.png`
11. `cp3_providers_targets_light.png`
12. `cp3_providers_targets_dark.png`
13. `cp3_health_settings_light.png`
14. `cp3_health_settings_dark.png`
