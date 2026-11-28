# Lộ Trình Thử Nghiệm Thực Địa 4 Bậc (`FIELD-TEST-LADDER`)

- **Phục vụ:** `S9`, `S10` — Áp dụng sau khi nhánh chính xanh CI và dừng cứng ở `READY_FOR_OWNER_FIELD_TEST`; **chỉ chủ dự án** trực tiếp chạy trên dữ liệu thật.
- **Nguyên tắc bất biến:** Mọi gói `field-report` xuất ra ngoài `<STATE_DIR>`, tối đa `8` tệp (`0` ghi vào `<STATE_DIR>`), qua `2` tầng lọc độc lập (Tầng 1 khử theo giá trị biến môi trường, entropy và tiền tố; Tầng 2 từ chối toàn cục theo giá trị, entropy và PII — đã diễn tập `28` định dạng bí mật × `4` nguồn văn bản tự do `inbox.json`, `tick.log`, `freeze.json`, `config-shape.json` với `0` rò rỉ).
- **Kiểm tra bắt buộc:** Ở **lần xuất đầu tiên**, chủ dự án phải tự mở thư mục `field-report` và kiểm tra **bằng mắt** toàn bộ các tệp trước khi gửi gói báo cáo cho bất kỳ ai.

## Bậc 0 — Quan sát thật, không ghi (`observe`, 3–7 ngày)
- **Việc cần làm:** Cài lịch nền định kỳ `15` phút (`schedule install --mode observe`), kiểm tra trạng thái lịch (`schedule status`) kèm `tick.log` tăng đều trong `3–7` ngày (`0` ghi DB/harness), tùy chọn chạy tay `tick --mode observe` để kiểm tra nhanh và cuối mỗi ngày xuất `field-report`.
```powershell
$env:ROUTERSYNC_STATE_DIR = "<STATE_DIR>"
routersync schedule install -c "<DUONG_DAN_ROUTERSYNC_YAML>" --state-dir "<STATE_DIR>" --mode observe --interval-minutes 15
routersync schedule status --state-dir "<STATE_DIR>" --json
routersync tick -c "<DUONG_DAN_ROUTERSYNC_YAML>" --mode observe --json
routersync field-report -c "<DUONG_DAN_ROUTERSYNC_YAML>" --state-dir "<STATE_DIR>" --out "<THU_MUC_XUAT>/bac0-ngay1" --json
routersync schedule uninstall --state-dir "<STATE_DIR>"
```
```bash
export ROUTERSYNC_STATE_DIR="<STATE_DIR>"
routersync schedule install -c "<DUONG_DAN_ROUTERSYNC_YAML>" --state-dir "<STATE_DIR>" --mode observe --interval-minutes 15
routersync schedule status --state-dir "<STATE_DIR>" --json
routersync tick -c "<DUONG_DAN_ROUTERSYNC_YAML>" --mode observe --json
routersync field-report -c "<DUONG_DAN_ROUTERSYNC_YAML>" --state-dir "<STATE_DIR>" --out "<THU_MUC_XUAT>/bac0-ngay1" --json
routersync schedule uninstall --state-dir "<STATE_DIR>"
```
- **Dữ liệu cần xuất:** Trọn gói `<= 8` tệp `field-report` mỗi ngày (`summary.json`, `timeline.jsonl`, `providers.json`, `models.json`, `anomalies.json`, `resources.json`, `config-shape.json`, `README.md`).
- **Điều kiện lên bậc:** Tối thiểu `3` ngày liên tiếp lịch `observe` chạy đều, không còn `ROUTERSYNC_BUG` mở (theo `docs/runbook/FIELD-FINDINGS.md`), `tokens = 0`.
- **Dấu hiệu dừng:** Xuất hiện `MODEL_FLAPPING` dẫn tới đề xuất gỡ sai, `TICK_DURATION_SLOW` lặp lại liên tục, hoặc lỗi cấu hình vòng lặp.
- **Quay lại bậc trước:** Chạy `routersync schedule uninstall --state-dir "<STATE_DIR>"` khi tạm dừng/chuyển bậc, giữ nguyên `observe` cho tới khi xử lý dứt điểm bất thường.

## Bậc 1 — Thí điểm cô lập trên `rs-pilot` (2 ngày)
- **Việc cần làm:** Thực hiện thí điểm cô lập `rs-pilot` trong `2` ngày theo `docs/runbook/OWNER-CHECKLIST.md`, kết hợp xuất `pilot-report` và `field-report` (hai cờ `--false-removals` và `--unplanned-interventions` là số đo do chủ dự án tự quan sát thực tế và tự truyền vào, tuyệt đối không điền sẵn số giả định).
```powershell
routersync pilot-report -c "<DUONG_DAN_ROUTERSYNC_YAML>" --state-dir "<STATE_DIR>" --router-target "router:<ID_ROUTER>/rs-pilot" --json
routersync field-report -c "<DUONG_DAN_ROUTERSYNC_YAML>" --state-dir "<STATE_DIR>" --out "<THU_MUC_XUAT>/bac1-pilot" --json
```
```bash
routersync pilot-report -c "<DUONG_DAN_ROUTERSYNC_YAML>" --state-dir "<STATE_DIR>" --router-target "router:<ID_ROUTER>/rs-pilot" --json
routersync field-report -c "<DUONG_DAN_ROUTERSYNC_YAML>" --state-dir "<STATE_DIR>" --out "<THU_MUC_XUAT>/bac1-pilot" --json
```
- **Dữ liệu cần xuất:** Kết quả `pilot-report` (`status: "PASS"` sau khi truyền số đếm quan sát thật) và gói `field-report` của phiên `rs-pilot` (`timeline.jsonl`, `anomalies.json`).
- **Điều kiện lên bậc:** Đạt đủ `5/5` tiêu chí `S9` (`0` loại nhầm quan sát thật, hoàn tác khớp tuyệt đối, `tokens = 0`, `0` can thiệp ngoài kế hoạch) sau `2` ngày.
- **Dấu hiệu dừng:** `readBackVerified: false`, hoàn tác lệch thứ tự model, hoặc phát sinh `ROUTERSYNC_BUG` trong `anomalies.json`.
- **Quay lại bậc trước:** Chạy `routersync rollback "<SNAPSHOT_ID>" --write`, thu hồi quyền ghi bằng `routersync consent revoke --all` và lùi về **Bậc 0** (`observe`).

## Bậc 2 — Đề xuất và duyệt tay từng combo thật (`propose`)
- **Việc cần làm:** Mở từng combo thật một (`1` combo mỗi đợt), cấp quyền `propose`, chủ dự án tự kiểm tra kế hoạch, gõ `chay` trên TTY khi áp dụng và xuất `field-report` ngay sau mỗi lần `apply`.
```powershell
routersync consent grant --target "router:<ID_ROUTER>/<TEN_COMBO>" --level propose --state-dir "<STATE_DIR>"
routersync apply -c "<DUONG_DAN_ROUTERSYNC_YAML>" --state-dir "<STATE_DIR>" --write
routersync field-report -c "<DUONG_DAN_ROUTERSYNC_YAML>" --state-dir "<STATE_DIR>" --out "<THU_MUC_XUAT>/bac2-sau-apply" --json
```
```bash
routersync consent grant --target "router:<ID_ROUTER>/<TEN_COMBO>" --level propose --state-dir "<STATE_DIR>"
routersync apply -c "<DUONG_DAN_ROUTERSYNC_YAML>" --state-dir "<STATE_DIR>" --write
routersync field-report -c "<DUONG_DAN_ROUTERSYNC_YAML>" --state-dir "<STATE_DIR>" --out "<THU_MUC_XUAT>/bac2-sau-apply" --json
```
- **Dữ liệu cần xuất:** Gói `field-report` xuất tức thì sau từng lệnh `apply` (kiểm tra biên nhận `apply` trong `timeline.jsonl` và `anomalies.json`).
- **Điều kiện lên bậc:** Combo thật vận hành ổn định qua ít nhất `2` chu kỳ duyệt `propose` thành công (`readBackVerified: true`, `0` loại nhầm, `0` lỗi `COMBO_MODEL_MISSING_FROM_CATALOGS`).
- **Dấu hiệu dừng:** Đề xuất gỡ nhầm model đang phục vụ tốt, vướng `COMBO_SHRINK_CAP_BLOCKED` bất thường hoặc đọc lại sau ghi thất bại.
- **Quay lại bậc trước:** Hoàn tác ngay combo vừa áp bằng `routersync rollback "<SNAPSHOT_ID>" --write`, thu hồi consent combo đó và quay về **Bậc 1** (`rs-pilot`).

## Bậc 3 — Tự động an toàn trên các combo đã qua Bậc 2 (`auto-safe`, 7 ngày)
- **Việc cần làm:** Chỉ nâng lên `auto-safe` cho đúng các combo đã vượt qua **Bậc 2**, theo dõi `7` ngày liên tục với cầu dao khẩn cấp `routersync freeze` luôn sẵn sàng kích hoạt tức thì.
```powershell
routersync consent grant --target "router:<ID_ROUTER>/<TEN_COMBO>" --level auto-safe --state-dir "<STATE_DIR>"
routersync tick -c "<DUONG_DAN_ROUTERSYNC_YAML>" --state-dir "<STATE_DIR>" --mode auto-safe --json
routersync freeze --state-dir "<STATE_DIR>" --reason "khan-cap-bac-3"
```
```bash
routersync consent grant --target "router:<ID_ROUTER>/<TEN_COMBO>" --level auto-safe --state-dir "<STATE_DIR>"
routersync tick -c "<DUONG_DAN_ROUTERSYNC_YAML>" --state-dir "<STATE_DIR>" --mode auto-safe --json
routersync freeze --state-dir "<STATE_DIR>" --reason "khan-cap-bac-3"
```
- **Dữ liệu cần xuất:** Gói `field-report` hằng ngày suốt `7` ngày (`day-1` .. `day-7`) kèm đối chiếu biên nhận `auto-safe` và tài nguyên trong `resources.json`.
- **Điều kiện lên bậc:** Hoàn tất trọn `7` ngày `auto-safe` với `0` loại nhầm, `0` sự cố tự hoàn tác khẩn cấp (`AUTO-ROLLBACK`), `tokens = 0` — đủ điều kiện nghiệm thu vận hành dài hạn.
- **Dấu hiệu dừng:** Cầu dao tự ngắt `FROZEN`, loại nhầm model, hoặc tỷ lệ lỗi provider vượt ngưỡng kéo dài gây sai lệch danh mục.
- **Quay lại bậc trước:** Chạy ngay `routersync freeze --state-dir "<STATE_DIR>" --reason "ha-bac"`, hoàn tác snapshot gần nhất nếu cần, hạ quyền mục tiêu về `--level propose` (**Bậc 2**) trước khi `routersync unfreeze`.
