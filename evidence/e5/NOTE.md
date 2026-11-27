# Báo cáo hoàn tất C49 — Field Report, Anomaly Detector & Runbook thực địa
Trạng thái T1–T5 qua đủ 4 bằng chứng RACI (không ghi DB/API router hay cấu hình harness thật):

| Hạng mục | E1 (Red-First & Mut) | E2 (QA Độc lập) | E3 (PR & Main CI Lần 1) | E4 (evidence/e5) |
| :--- | :--- | :--- | :--- | :--- |
| **T1** `field-report` (read-only, <=8 file, 2 tầng lọc) | PASS (Red->Green, M1–M6 killed) | PASS (Clean clone, P1–P4, QA-M1–M4 killed) | PASS (PR #86, #87 & main attempt=1) | PASS (capture + verify SẠCH) |
| **T2** `anomalies.json` (8 mã chuẩn, đối chiếu timeline) | PASS (Red->Green, M7–M9 killed) | PASS (Clean clone, P5, QA-M5–M7 killed) | PASS (PR #86, #87 & main attempt=1) | PASS (capture + verify SẠCH) |
| **T3** `FIELD-TEST-LADDER.md` (70 dòng, 4 bậc 0–3) | PASS (doc-cli-sync PASS) | PASS (PS/Bash + 5 mục/bậc PASS) | PASS (PR #86, #87 & main attempt=1) | PASS (capture + verify SẠCH) |
| **T4** `FIELD-FINDINGS.md` (58 dòng, 3 nhóm phân loại) | PASS (agent-docs PASS) | PASS (RACI + mẫu Red-First PASS) | PASS (PR #86, #87 & main attempt=1) | PASS (capture + verify SẠCH) |
| **T5** Diễn tập 7 ngày (`tmpdir`) & 10 mẫu bí mật + fix race | PASS (28 tick, M10–M11 & PR #87 M1–M2 killed) | PASS (P6, QA-M8–M9 & PR #87 QA-M1–M5 killed) | PASS (PR #86, #87 & main attempt=1) | PASS (capture + verify SẠCH) |

Kết quả diễn tập 7 ngày (`28` tick; Ngày 1 & Ngày 7 bình thường = `0` cảnh báo giả; `10/10` mẫu bí mật/định danh cá nhân = `0` rò rỉ, Stage-2 chặn `exit 1` / `0` file):

| Ngày | Sự cố cài đặt | Mã phát hiện trong `anomalies.json` | Bằng chứng `timeline.jsonl` & `sourceFile` |
| :--- | :--- | :--- | :--- |
| Ngày 2 | Model chập chờn ẩn rồi hiện lại | `MODEL_FLAPPING` | `evt-0001..evt-0003` (`tick-catalog.json`) |
| Ngày 3 | Provider trả lỗi HTTP `429` | `PROVIDER_ERROR_OR_UNVERIFIABLE_HIGH` (`429`) | `evt-0002..evt-0003` (`tick-catalog.json`) |
| Ngày 4 | Provider trả lỗi HTTP `405` kéo dài | `PROVIDER_ERROR_OR_UNVERIFIABLE_HIGH` (`405: 4`) | `evt-0001..evt-0004` (`tick-catalog.json`) |
| Ngày 5 | Tick chạy chậm vượt ngưỡng (`45000 ms`) | `TICK_DURATION_SLOW` | `evt-0003` (`tick.log`) |
| Ngày 6 | Trần giảm combo `10%` chặn gỡ model (`2/10`) | `COMBO_SHRINK_CAP_BLOCKED` | `evt-0001..evt-0004` (`plans/tick-plan.json`) |

- **PR & Merge**: [PR #86](https://github.com/CThawngs/Router-Sync/pull/86) (`d74b7b1`, PR CI [`45964971223`](https://github.com/CThawngs/Router-Sync/actions/runs/45964971223) `18/18` xanh lần 1; main CI [`45983429811`](https://github.com/CThawngs/Router-Sync/actions/runs/45983429811) lộ race test `tmpdir` cũ) -> vá dứt điểm tại [PR #87](https://github.com/CThawngs/Router-Sync/pull/87) (`34190c9`, PR CI [`45994407439`](https://github.com/CThawngs/Router-Sync/actions/runs/45994407439) `18/18` xanh lần 1).
- **Main CI & Evidence**: Main CI run [`45997626193`](https://github.com/CThawngs/Router-Sync/actions/runs/45997626193) trên `34190c9fbd290b6e76cbde154176b946046ab5cc` xanh `18/18` ở `attempt=1`; gói bằng chứng tại nhánh [`evidence/e5`](https://github.com/CThawngs/Router-Sync/tree/evidence/e5) (`7` file, `[skip ci]`, `verify-records` SẠCH, `verify-package` OK, `0` thông tin cá nhân, `0` workflow chạy); [Notion Task #70](https://app.notion.com/p/RouterSync-C49-Ki-m-th-th-t-b-ng-d-li-u-th-t-field-report-anomalies-ladder-4253c98ee3238183a3e1eabfb4c952a9) `Done`.

READY_FOR_OWNER_FIELD_TEST
