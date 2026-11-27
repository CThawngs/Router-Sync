# Sổ Tay Phân Loại & Xử Lý Phát Hiện Thực Địa (`FIELD-FINDINGS`)

- **Phục vụ:** `S9`, `S10` — Quy trình chuẩn tiếp nhận, phân loại và chuyển hóa dữ liệu từ gói `routersync field-report` thành vé sửa lỗi có kiểm chứng.

## 1. Quy trình phối hợp 4 bước (`Owner -> Data-AI -> Engineer -> QA -> Ops`)

1. **Chia sẻ gói dữ liệu đã khử nhạy cảm (`Owner`):**
   - Chủ dự án xuất gói báo cáo ra thư mục ngoài `<STATE_DIR>` và gửi đường dẫn hoặc tệp nén của thư mục xuất (tối đa `8` tệp) cho đội phụ trách:
   ```bash
   routersync field-report -c "<DUONG_DAN_ROUTERSYNC_YAML>" --state-dir "<STATE_DIR>" --out "<THU_MUC_XUAT>/dot-kiem-tra" --json
   ```
2. **Phân loại bắt buộc 3 nhóm (`Data-AI`):**
   - `Data-AI` đọc `summary.json`, `anomalies.json`, `providers.json`, `models.json` và đối chiếu từng mã bằng chứng `evt-XXXX` trong `timeline.jsonl`.
   - Mọi mục trong `anomalies.json` **bắt buộc** được xếp vào đúng **1 trong 3 nhóm**:
     - `ROUTERSYNC_BUG` — Lỗi logic, tính toán sai ngưỡng, phân tích sai trạng thái hoặc rò rỉ/hiệu năng của chính RouterSync.
     - `UPSTREAM_PROVIDER_OR_ROUTER` — Lỗi từ phía nhà cung cấp hoặc router (ví dụ: giới hạn `429`, từ chối phương thức `405`, danh mục router chưa đồng bộ kịp).
     - `UNDOCUMENTED_VALID_BEHAVIOR` — Hành vi bảo vệ đúng thiết kế của hệ thống (ví dụ: chặn gỡ tự động khi vượt trần co rút `10%` `COMBO_SHRINK_CAP_BLOCKED`) nhưng cần bổ sung giải thích vào sổ tay vận hành.
3. **Mở vé sửa lỗi theo chuẩn Red-First từ dòng dữ liệu thật (`Data-AI -> Engineer`):**
   - Mọi mục mang nhãn `ROUTERSYNC_BUG` phải mở thành vé riêng kèm trích dẫn nguyên văn bản ghi `evt-XXXX` từ `timeline.jsonl` / `anomalies.json`.
   - **Engineer** viết bài kiểm thử **Red-First** tái hiện lỗi trực tiếp từ dòng dữ liệu thực địa đó (chứng minh test đỏ trước khi sửa, xanh sau khi sửa, kèm kiểm thử đột biến).
4. **Kiểm toán độc lập & đóng vòng RACI (`Engineer -> QA -> Ops`):**
   - **Engineer (`R`):** Tái hiện Red-First từ dữ liệu `field-report`, sửa tối thiểu đúng phạm vi, chạy đủ cổng kiểm chứng phát hành.
   - **QA (`V`):** Checkout sạch độc lập, chạy bộ kiểm thử đối kháng và đột biến độc lập xác nhận lỗi không tái phát.
   - **Ops (`O`):** Theo dõi CI nhánh chính xanh ngay lần đầu và cập nhật trạng thái đợt thử nghiệm để chủ dự án quyết định giữ bậc hay lên bậc theo `docs/runbook/FIELD-TEST-LADDER.md`.

---

## 2. Mẫu Bảng Tổng Hợp Phát Hiện (`Findings Summary Table`)

| Đợt / Ngày | Mã sự kiện (`timeline.jsonl`) | Mã bất thường (`anomalies.json`) | Đối tượng (`subject`) | Phân loại (`Data-AI`) | Hành động / Mã vé | Trạng thái |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `bac0-ngay2` | `evt-0006`, `evt-0007` | `MODEL_FLAPPING` | `model:openai/model-x` | `UPSTREAM_PROVIDER_OR_ROUTER` | Giữ cổng chờ 24h & 3 chu kỳ; theo dõi thêm | Đã xác minh |
| `bac0-ngay4` | `evt-0013` .. `evt-0016` | `PROVIDER_ERROR_OR_UNVERIFIABLE_HIGH` | `provider:custom-gw` | `UPSTREAM_PROVIDER_OR_ROUTER` | Gateway trả `405`; giữ nguyên `UNVERIFIABLE != ABSENT` | Đã xác minh |
| `bac2-lan1` | `evt-0022` | `COMBO_SHRINK_CAP_BLOCKED` | `combo:omni/rs-main` | `UNDOCUMENTED_VALID_BEHAVIOR` | Trần 10% hoạt động đúng; chủ dự án duyệt tay nếu muốn gỡ | Hoàn tất |
| `bac2-lan2` | `evt-0025` | `PROVIDER_ROUTER_LIST_MISMATCH` | `provider:openai` | `ROUTERSYNC_BUG` | Mở vé `RS-FIELD-01` (tái hiện Red-First) | Đang xử lý |

---

## 3. Mẫu Vé Sửa Lỗi `ROUTERSYNC_BUG` (Kèm Khối Tái Hiện Red-First)

```markdown
### [RS-FIELD-<SO_THU_TU>] <Tóm tắt ngắn gọn lỗi thực địa>

- **Phân loại (`Data-AI`):** `ROUTERSYNC_BUG`
- **Gói báo cáo nguồn:** `<ten-thu-muc-field-report>` (đã khử nhạy cảm 2 tầng)
- **Tệp nguồn & Mã bằng chứng:** `<sourceFile>` / `timeline.jsonl` (`<evt-XXXX>`)
- **Mức độ nghiêm trọng:** `<critical | high | warn>`
- **Chuỗi RACI:** `Data-AI (Phân loại) -> Engineer (Thực thi Red-First) -> QA (Kiểm toán độc lập) -> Ops (CI & Đóng vé)`

#### Dữ liệu thực địa trích xuất (Đã khử nhạy cảm)
- Dòng `timeline.jsonl`: `<dán nguyên văn dòng JSON evt-XXXX>`
- Mục `anomalies.json`: `<dán nguyên văn object bất thường tương ứng>`

#### Yêu cầu kiểm thử Red-First bắt buộc
1. Nạp trực tiếp dòng dữ liệu `<evt-XXXX>` ở trên làm fixture đầu vào trong `os.tmpdir()`.
2. Chứng minh bài kiểm thử thất bại (Red) trước khi sửa mã nguồn.
3. Sửa lỗi tối thiểu, chứng minh bài kiểm thử xanh (Green) và diệt đột biến hồi quy.
```
