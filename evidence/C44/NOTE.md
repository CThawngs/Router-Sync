# Báo cáo Đóng Chương trình C44 — M3, M4, Chuẩn bị M5 & Track W

**1. Trạng thái vé & 4 PR trên `main` ([`2ea12c4`](https://github.com/CThawngs/Router-Sync/commit/2ea12c44abae747d466a3b81a5f67eaec68dc87d), chuỗi `main` xanh lần 1 liên tiếp = `5`, verifier SẠCH):**
- Nền trước C44 (`M1-01..M1-03`, `M2-01..M2-03`): **XONG** (`evidence/m1` @ `987da9c`, `evidence/m2` @ `4acc7c4`).
- `§4.1 BACKLOG.md`: **XONG** — [PR #66](https://github.com/CThawngs/Router-Sync/pull/66), SHA [`9261721`](https://github.com/CThawngs/Router-Sync/commit/9261721e508d9a941dc9c414535d61888a99b6d5), CI `main` lần 1 [45295047057](https://github.com/CThawngs/Router-Sync/actions/runs/45295047057) (`18/18`), [QA #7116630845](https://github.com/CThawngs/Router-Sync/pull/66#issuecomment-7116630845).
- `W-01` (`W2` + runner `W1/W3/W5`): **XONG** — [PR #67](https://github.com/CThawngs/Router-Sync/pull/67), SHA [`dd3407b`](https://github.com/CThawngs/Router-Sync/commit/dd3407b633e92ec9105d4eb4f5077d38e07b29ec), CI `main` lần 1 [45301005149](https://github.com/CThawngs/Router-Sync/actions/runs/45301005149) (`18/18`), [QA #7117906886](https://github.com/CThawngs/Router-Sync/pull/67#issuecomment-7117906886) (`5/5` đột biến).
- `M3-01` (`P4`) & `M3-02` (`P5`): **XONG** — [PR #68](https://github.com/CThawngs/Router-Sync/pull/68), SHA [`1c51c68`](https://github.com/CThawngs/Router-Sync/commit/1c51c680b48fa9a500b4bf717103b0e9b47258a5), CI `main` lần 1 [45303154883](https://github.com/CThawngs/Router-Sync/actions/runs/45303154883) (`18/18`), [QA #7118578897](https://github.com/CThawngs/Router-Sync/pull/68#issuecomment-7118578897) (`6/6` đột biến).
- `M4-01` (`P6`), `M4-02` (`P7`) & `W-02` (`W4`): **XONG** — [PR #69](https://github.com/CThawngs/Router-Sync/pull/69), SHA [`2ea12c4`](https://github.com/CThawngs/Router-Sync/commit/2ea12c44abae747d466a3b81a5f67eaec68dc87d), CI `main` lần 1 [45317752224](https://github.com/CThawngs/Router-Sync/actions/runs/45317752224) (`18/18`), [QA #7120782660](https://github.com/CThawngs/Router-Sync/pull/69#issuecomment-7120782660) (`7/7` đột biến; kiểm toán `P7` 5 bề mặt `high=0 medium=0 low=0`).
- `M5-01` (`RELEASE-CANDIDATE.md` trên `origin/evidence/c44`): **XONG**. Cổng phát hành `M5` (tag `v0.1.0` & `npm publish` thật): **CHƯA XÁC NHẬN** (`chờ chủ dự án` — đội không mở M5 thay chủ dự án).

**2. Ba nhánh bằng chứng (`<= 10` tệp, `[skip ci]`, không PR, `gh run list` rỗng `[]`, verifier SẠCH, `verify-package` OK, `0` khớp tên riêng):**
- `origin/evidence/m3` @ `9d82fecb948ff71b3ba498897ac9f3902115e277` (`9` tệp) · `origin/evidence/m4` @ `75d0e131356a01ceb1d62f60f2333d8fb0cbc4f6` (`9` tệp) · `origin/evidence/c44` (`HEAD` nhánh này, fast-forward trên `8aa091632f1a8afd9fed83a9e60c8fed781b327e`, `10` tệp).

**3. Kết quả Track W trên `9router@0.5.123` (`6/30` chat, `3/3` `GET /v1/models`, `0` lỗi `429`, `0` ghi/khởi động lại router):**
- `W1` (`đo được`): 3 vòng cách `60 s` (`426 861 B`): `GET /v1/models = 7533, 7559, 5891 ms`; chat đồng thời `header = 6155, 6332, 4338 ms` → **`còn nghẽn`** (`PATCH_V3` xếp vào `chờ chủ dự án`, không tự áp; `sent=3, usageHistory=1, delta=2`).
- `W2`: **XONG** (`PR #67`, `dd3407b`) — đếm `RequestBudget` & `SKIPPED-QUOTA` phía client, sửa regex khóa rỗng, in `reconcileSentVsUsage`.
- `W3` (`đo được`, `0` lần `GET /v1/models`): tại `ageHours=14.11` (`restarted=false`, `freeMem=1940 MB`, `routerRss=92 MB`, `cpu=98.8 s`, mốc `~6h`): `3/3` stream `9Router-Agent-1` `200 OK` (`header = 811, 609, 777 ms`, `0` treo, `sent=3, usageHistory=0, delta=3`); mốc `~24h` & `~48h`: **`chưa đo`** (`14.11h < 24h`).
- `W4`: **XONG** (`PR #69`, `2ea12c4`) — cập nhật `docs/9router-combo-findings.md` (`0.5.123`, sửa chiều `826 < 2 900`, bỏ `14 868`/`~15 000+`, gắn `chưa phân biệt` cho 4 ứng viên mục 1.1).
- `W5`: **`chưa đo`** (`reason=combo_not_in_db`, `0` HTTP request).

**4. Số liệu `đo được` về kích thước tarball (`P4`) và tài nguyên có phương sai (`P5`):**
- `P4` (`8` gói sạch `.map`/secret, `8/8` `publish --dry-run` PASS, `8/8` `npm view` `unoccupied`), tổng nén **`485 321 B`** (`1 923 388 B` giải nén): `cli=324 887 B`, `core=65 662 B`, `daemon=43 115 B`, `mcp-server=20 200 B`, `sources=10 388 B`, `adapter-9router=9 775 B`, `adapter-omniroute=7 677 B`, `adapter-sdk=3 617 B`.
- `P5` (`n=7`, `freeMem=1562..1376 MB`): CLI lạnh `2341.71 ± 1341.84 ms` (`min=1758.00, max=5381.25 ms`), RSS nghỉ `88.83 ± 0.28 MB` (`88.45–89.23 MB`); Daemon lạnh `288.50 ± 56.13 ms` (`min=227.64, max=400.17 ms`), RSS nghỉ `67.10 ± 0.25 MB` (`66.68–67.43 MB`).

**5. Hàng đợi `chờ chủ dự án`:**
1. Tạo/sở hữu scope `@routersync` trên npmjs.org (`8/8` tên gói hiện `unoccupied`).
2. Chốt `ADR-SQLITE-01` (giữ `better-sqlite3` cho `v0.1.0` hay lộ trình `node:sqlite` về sau).
3. Quyết định áp `PATCH_V3` cho `9router@0.5.123` (`W1=còn nghẽn`; lệnh sẵn: `RS_OWNER_CONFIRMED=chạy node tools/agent/nine-router-patch.mjs apply --yes-write-router`).
4. Tạo combo `rs-fast` trên 9Router nếu muốn đo `W5`.
5. Quyết định có đo tiếp mốc `~24h` và `~48h` của `W3` khi tiến trình đạt đủ tuổi hay không.
6. Quyết định kiểm thử bổ sung trên máy macOS & Linux vật lý trước hoặc sau phát hành.
7. Quyết định cổng M5 GO/NO-GO, chốt phiên bản (`0.1.0` / `0.1.0-rc.1`), tự gắn tag `v0.1.0` và chạy lệnh phát hành viết sẵn tại `RELEASE-CANDIDATE.md` §4.
