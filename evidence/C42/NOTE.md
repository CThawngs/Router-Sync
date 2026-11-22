# C42 — Tóm tắt Kế hoạch RouterSync v0.1 RC (`evidence/c42`, `[skip ci]`, không PR, 0 sửa mã)
- **Nền `main`:** `c28b7fb` (PR `#56`, CI `45049049310` attempt `1` `success`, `17` merge gần nhất xanh lần 1; `m0-ci-stats`: `main` `23/27`, đội `53/65 = 82%`, `232` tệp test).
- **1. `PLAN.md` — XONG (kế hoạch M0):** Chốt `P1–P7`, khóa 17 mục ngoài phạm vi `"chờ chủ dự án"`, lộ trình `M1–M5` (`evidence/m1..m5`, ước tính `390–785` req LLM / `15–28` phiên ±25–45%).
- **2. `RACI.md` — XONG (kế hoạch M0):** Bật `Exec` + `Tech` (`Designer` tắt, `Data-AI` bật khi cần số liệu) + `Ops`; tắt 7 vai còn lại; khóa 3 quy tắc phân vai & nhãn `"CHƯA XÁC NHẬN"`.
- **3. `BACKLOG.md` — XONG (kế hoạch M0):** Đủ 6 vé 7 trường cho `M1` (`M1-01..03`) & `M2` (`M2-01..03`); để trống `M3–M5` có lý do; mã nguồn `P1–P7`: `CHƯA LÀM` (chờ duyệt).
- **4. `RISKS.md` — XONG (kế hoạch M0):** 12 rủi ro (`R-01..R-12`: bước treo, quota `429`, `LIGHT-DEV < 1.5 GiB`, nghẽn router, tự chấm bài, lộ tên riêng/khóa, phình phạm vi, cấm `worktree` junction).
- **5. `CAPACITY.md` — XONG (kế hoạch M0):** Đo M0.3 trên `9Router-Agent-1` (2 luồng chạm `HEADER_TIMEOUT_60S` dù `usageHistory` ghi `ok` ở `1.66 s`) → hạ 9Router xuống `1` luồng tuần tự, trần `120` req/ngày, chỉ gán `rs-max`/`rs-fast` (`0` `HANG`).
- **6. `REPORT.md`, `NOTE.md`, `records.jsonl` (+ `.out/.err`) — XONG:** Đúng `10` tệp; `verify-records` `SẠCH: 1 dòng`, `verify-package` `OK`, `scan-private-names` = `0` khớp.
- **Chưa biết/chưa đo:** Lý do nội bộ 9Router treo header ở 2 luồng; `p50/max` của `rs-fast`/`rs-max` (chưa tạo); căn nguyên `e2e.test.ts` run `44788053023`; phương sai tài nguyên M3.
- **Cần Chủ dự án quyết (`OQ-01..07`):** (1) Duyệt gói `evidence/c42` để mở M1; (2) Giữ đội bot chạy Sub (`<=2` luồng) hay chuyển sang 9Router sau khi tự tạo `rs-fast`/`rs-max` trên dashboard; (3) Xác nhận giữ 17 mục ngoài phạm vi và cổng `npm publish` tại M5.
