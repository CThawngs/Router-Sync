# Báo cáo hoàn tất C50 — Bộ lọc bí mật 2 tầng `field-report` & Lịch Bậc 0

Trạng thái K1–K3 đạt đủ 4 tầng bằng chứng RACI (phục vụ `S9`, `S10`, nguyên tắc "key không rời RAM"; không đụng DB/API router hay cấu hình harness thật):

| Hạng mục | E1 (Red-First & Mut) | E2 (QA Strike-2 Độc lập) | E3 (PR & Main CI Lần 1) | E4 (`evidence/e6`) |
| :--- | :--- | :--- | :--- | :--- |
| **K1** Lọc bí mật 2 tầng độc lập (`28` định dạng × `4` nguồn + `apiKeys` + `note`) | PASS (`M1..M5` killed) | PASS (`GO`, Probes A–E `5/5`, `QM1..QM5` killed) | PASS (PR #88 & main `attempt=1`) | PASS (`18/18` test, SẠCH) |
| **K2** `FIELD-TEST-LADDER.md` (`77` dòng `<= 100`, lịch Bậc 0 `>= 15`p, soi mắt lần đầu) | PASS (doc-cli-sync PASS) | PASS (`0` P0/P1/P2, bỏ cờ `0` giả định) | PASS (PR #88 & main `attempt=1`) | PASS (`33/33` test, SẠCH) |
| **K3** Diễn tập cô lập `os.tmpdir()` (Run A + Run B chặn toàn cục) | PASS (Run A `0` rò rỉ, Run B `exit 1`) | PASS (quét byte ngoài + `0` echo bí mật) | PASS (PR #88 & main `attempt=1`) | PASS (`7` tệp `<= 10`, OK) |

- **Quyết định kiến trúc (Chọn Phương án B thay Phương án A):** `providers.json` không lưu nội dung lỗi HTTP gốc từ provider (`0` raw body); phần chẩn đoán cục bộ (`inbox.json`, `tick.log`, `freeze.json`, `config-shape.json`) được giữ lại để phục vụ phân tích sự cố Bậc 0–1 và bảo vệ bởi **2 tầng lọc hoàn toàn độc lập** (`0` import chung, Tầng 2 không chứa danh sách tiền tố nhà cung cấp), giữ `0` dương tính giả với `sha256`, `planHash`, UUID, `camelCase` và tên model dài.
- **Kết quả diễn tập K3 (`os.tmpdir()`):**
  - **Run A (2 tầng bình thường):** `exitCode = 0`, `writtenFiles = 8`, `redactedCount = 141`, quét byte độc lập toàn bộ `8` tệp = `0` rò rỉ (cả bản gốc lẫn mã hóa URL/RFC-3986 `%21%40`).
  - **Run B (tắt Tầng 1 để kiểm Tầng 2):** `exitCode = 1`, `0` tệp được ghi ra đĩa, `rejectedViolationsCount = 98` (`summary.json = 34`, `timeline.jsonl = 34`, `config-shape.json = 30`), không in ngược giá trị bí mật.
- **Cập nhật Runbook K2 (`docs/runbook/FIELD-TEST-LADDER.md`, `77` dòng):** gỡ khẳng định tuyệt đối không có đo đạc, thay bằng số liệu diễn tập `28 × 4` + quy tắc chủ dự án kiểm tra bằng mắt ở lần xuất đầu tiên; bổ sung `schedule install/status/uninstall` (`>= 15` phút) cho Bậc 0 và bỏ `--false-removals 0 --unplanned-interventions 0` ở Bậc 1.
- **PR, Main CI & Gói bằng chứng:** Nền `34190c9` -> [PR #88](https://github.com/CThawngs/Router-Sync/pull/88) (`275b6ba`, PR CI [`46094676709`](https://github.com/CThawngs/Router-Sync/actions/runs/46094676709) `18/18` `attempt=1`) -> squash-merge `0239c42458efded2749cf8bf02e330f9d4c66ad2` -> Main CI [`46096418131`](https://github.com/CThawngs/Router-Sync/actions/runs/46096418131) xanh **`18/18` ở `attempt=1`**; gói bằng chứng [`evidence/e6`](https://github.com/CThawngs/Router-Sync/tree/evidence/e6) (`7` tệp, `[skip ci]`, `verify-records` SẠCH, `verify-package` OK, `0` định danh cá nhân, `0` workflow CI kích hoạt).

READY_FOR_OWNER_FIELD_TEST
