# Báo cáo Tổng hợp Chương trình C44 — M3, M4, Chuẩn bị M5 & Track W (`9Router 0.5.123`)

- **Nhánh bằng chứng:** `evidence/c44` (`evidence/C44/`, đúng `10` tệp `<= 10`, `[skip ci]`, không PR)
- **Commit `main` cuối:** [`2ea12c44abae747d466a3b81a5f67eaec68dc87d`](https://github.com/CThawngs/Router-Sync/commit/2ea12c44abae747d466a3b81a5f67eaec68dc87d) (`2ea12c4`) — chuỗi `push on main` xanh lần 1 liên tiếp: **`5`** (`bc61436..2ea12c4`)
- **Ba nhánh bằng chứng C44:** `origin/evidence/m3` @ `9d82fec` · `origin/evidence/m4` @ `75d0e13` · `origin/evidence/c44` (`8aa0916` → bản hoàn tất tại nhánh này)

## 1. Bảng Tổng hợp 4 PR của C44 & 4 Bằng chứng RACI (1 dòng / PR)

| PR & Nhánh | Vé gom | PR CI (`attempt=1`) | Biên bản QA Độc lập | Merge SHA `main` | Push CI `main` (`attempt=1`) | Trạng thái |
|---|---|---|---|---|---|---|
| [PR #66](https://github.com/CThawngs/Router-Sync/pull/66) (`docs/c44-backlog-m3-m5`) | §4.1 (`docs/BACKLOG.md`) | [Run 45285059324](https://github.com/CThawngs/Router-Sync/actions/runs/45285059324) (`18/18`) | [Comment #7116630845](https://github.com/CThawngs/Router-Sync/pull/66#issuecomment-7116630845) (`docs-only`) | [`9261721`](https://github.com/CThawngs/Router-Sync/commit/9261721e508d9a941dc9c414535d61888a99b6d5) | [Run 45295047057](https://github.com/CThawngs/Router-Sync/actions/runs/45295047057) (`18/18`) | **XONG** |
| [PR #67](https://github.com/CThawngs/Router-Sync/pull/67) (`feat/c44-w2-stream-budget-track-w`) | `W-01` (`W2` + runner `W1/W3/W5`) | [Run 45300175790](https://github.com/CThawngs/Router-Sync/actions/runs/45300175790) (`18/18`) | [Comment #7117906886](https://github.com/CThawngs/Router-Sync/pull/67#issuecomment-7117906886) (`5/5` đột biến) | [`dd3407b`](https://github.com/CThawngs/Router-Sync/commit/dd3407b633e92ec9105d4eb4f5077d38e07b29ec) | [Run 45301005149](https://github.com/CThawngs/Router-Sync/actions/runs/45301005149) (`18/18`) | **XONG** |
| [PR #68](https://github.com/CThawngs/Router-Sync/pull/68) (`feat/m3-packaging-and-resource-variance`) | `M3-01` (`P4`) + `M3-02` (`P5`) | [Run 45302137884](https://github.com/CThawngs/Router-Sync/actions/runs/45302137884) (`18/18`) | [Comment #7118578897](https://github.com/CThawngs/Router-Sync/pull/68#issuecomment-7118578897) (`6/6` đột biến) | [`1c51c68`](https://github.com/CThawngs/Router-Sync/commit/1c51c680b48fa9a500b4bf717103b0e9b47258a5) | [Run 45303154883](https://github.com/CThawngs/Router-Sync/actions/runs/45303154883) (`18/18`) | **XONG** |
| [PR #69](https://github.com/CThawngs/Router-Sync/pull/69) (`feat/m4-docs-security-and-w4`) | `M4-01` (`P6`) + `M4-02` (`P7`) + `W-02` (`W4`) | [Run 45315408557](https://github.com/CThawngs/Router-Sync/actions/runs/45315408557) (`18/18`) | [Comment #7120782660](https://github.com/CThawngs/Router-Sync/pull/69#issuecomment-7120782660) (`7/7` đột biến) | [`2ea12c4`](https://github.com/CThawngs/Router-Sync/commit/2ea12c44abae747d466a3b81a5f67eaec68dc87d) | [Run 45317752224](https://github.com/CThawngs/Router-Sync/actions/runs/45317752224) (`18/18`) | **XONG** |

## 2. Kết quả Thực nghiệm Track W trên `9Router 0.5.123` (`records.jsonl`)

- **Ngân sách đã tiêu thụ (`đo được`):** **`6/30` request chat** (còn dư `24`) và **`3/3` lần `GET /v1/models`** (còn dư `0`), `0` lỗi HTTP `429`, `0` thao tác ghi DB/cấu hình router, `0` khởi động lại tiến trình (`pid=12680`, `processStart=2026-11-23T10:58:17.262Z`).
- **`W1` (`c44-w1.out.txt` — **đo được**):** Ba vòng cách nhau `60 s` trên `0.5.123` nguyên bản (`modelsBytes=426861`):
  - Vòng 1: `models=7533 ms` (`header=7523 ms`), chat đồng thời `header=6155 ms` (`total=6162 ms`).
  - Vòng 2: `models=7559 ms` (`header=7553 ms`), chat đồng thời `header=6332 ms` (`total=6333 ms`).
  - Vòng 3: `models=5891 ms` (`header=5887 ms`), chat đồng thời `header=4338 ms` (`total=4339 ms`).
  - Kết luận ba dạng: **`còn nghẽn`** (`W1_CONCLUSION=còn nghẽn`) → xếp `PATCH_V3` vào `chờ chủ dự án` (không tự áp). Đối chiếu usage: `sent=3`, `usageHistory=1`, `delta=2`.
- **`W2` ([PR #67](https://github.com/CThawngs/Router-Sync/pull/67), `dd3407b` — **XONG**):** Đếm `RequestBudget` và `SKIPPED-QUOTA` phía client theo request đã gửi (không phụ thuộc `usageHistory`), sửa lỗi regex khóa rỗng trong `combos-reliability.ts`, và in `reconcileSentVsUsage` (`sent`, `usageHistory`, `lệch`).
- **`W3` (`c44-w3.out.txt`, `0` cuộc gọi `GET /v1/models` — **đo được**):** Tại `ageHours=14.11` (`restarted=false`, `freeMemMB=1940`, `routerRssMB=92`, `routerCpuSec=98.8`, đạt mốc `~6h`): `3/3` request stream trên `9Router-Agent-1` trả `200 OK` (`headerMs = 811, 609, 777 ms`; `totalMs = 814, 610, 778 ms`; `0` treo; `sent=3, usageHistory=0, delta=3`). Hai mốc `~24h` và `~48h`: **`chưa đo`** (tiến trình mới `14.11h < 24h`).
- **`W4` ([PR #69](https://github.com/CThawngs/Router-Sync/pull/69), `2ea12c4` — **XONG**):** Cập nhật `docs/9router-combo-findings.md` (`C32–C44`, chiều `826` nhỏ hơn `2 900`, bỏ ngoại suy `14 868`/`~15 000+`, gắn `chưa phân biệt` cho 4 ứng viên mục 1.1, bổ sung mục `## 8.` Track W).
- **`W5` (`c44-w5.out.txt` — **chưa đo**):** `W5_RS_FAST=chưa đo reason=combo_not_in_db` (`0` HTTP request).

## 3. Tóm tắt Số liệu `P4`, `P5`, `P6`, `P7` & Hồ sơ M5 (`RELEASE-CANDIDATE.md`)

- **P4 (`origin/evidence/m3` @ `9d82fec`):** `8` tarball công bố sạch `.map`/secret/đường dẫn cá nhân, tổng **`485 321 B`** nén (`1 923 388 B` giải nén; `@routersync/cli=324 887 B`, `@routersync/core=65 662 B`, `@routersync/daemon=43 115 B`, `@routersync/mcp-server=20 200 B`, `@routersync/sources=10 388 B`, `@routersync/adapter-9router=9 775 B`, `@routersync/adapter-omniroute=7 677 B`, `@routersync/adapter-sdk=3 617 B`), `npm publish --dry-run` `8/8` PASS, `npm view` `8/8 unoccupied`.
- **P5 (`origin/evidence/m3` @ `9d82fec`, `n=7`, `freeMem=1562..1376 MB`):** CLI lạnh `2341.71 ± 1341.84 ms` (`1758.00–5381.25 ms`), RSS nghỉ `88.83 ± 0.28 MB`; Daemon lạnh `288.50 ± 56.13 ms` (`227.64–400.17 ms`), RSS nghỉ `67.10 ± 0.25 MB`. `ADR-SQLITE-01` chỉ đề xuất, giữ nguyên `better-sqlite3`.
- **P6 & P7 (`origin/evidence/m4` @ `75d0e13`):** `26/26` doc & CLI fixture tests PASS; kiểm toán bảo mật 5 bề mặt đạt `high=0 medium=0 low=0` (`ok=true`).
- **M5-01 (`evidence/C44/RELEASE-CANDIDATE.md`):** Đủ danh sách GO/NO-GO, đề xuất `0.1.0` + `CHANGELOG`, bảng dry-run/tarball, lệnh phát hành viết sẵn (không chạy), 17 mục sau `v0.1` và 7 mục `chờ chủ dự án`.

## 4. Danh mục Bản ghi trong `evidence/C44/records.jsonl`

1. `c44-w1`: `node tools/agent/c44-track-w.mjs w1 --yes-spend-tokens` (`exit=0`)
2. `c44-w3`: `node tools/agent/c44-track-w.mjs w3 --min-age-hours 5.5 --yes-spend-tokens` (`exit=0`)
3. `c44-w5`: `node tools/agent/c44-track-w.mjs w5 --yes-spend-tokens` (`exit=0`)
