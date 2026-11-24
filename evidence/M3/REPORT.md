# Báo cáo Gói Bằng chứng Milestone M3 (`P4` Đóng gói 5-OS & `P5` Phương sai Tài nguyên + `ADR-SQLITE-01`)

- **Nhánh bằng chứng:** `evidence/m3` (`evidence/M3/`, `9` tệp `<= 10`)
- **Commit `main` neo:** [`1c51c680b48fa9a500b4bf717103b0e9b47258a5`](https://github.com/CThawngs/Router-Sync/commit/1c51c680b48fa9a500b4bf717103b0e9b47258a5) (`1c51c68`)
- **PR gộp (`M3-01` + `M3-02`):** [PR #68](https://github.com/CThawngs/Router-Sync/pull/68) (`feat/m3-packaging-and-resource-variance`)

## 1. Bảng RACI 4 Bằng chứng cho Milestone M3

| Vé | PR | PR HEAD SHA & PR CI (`attempt=1`) | Biên bản QA Độc lập (Đột biến) | Merge SHA trên `main` | Push CI `main` (`attempt=1`) | Chuỗi `main` xanh liên tiếp | Trạng thái |
|---|---|---|---|---|---|---|---|
| **M3-01 (`P4`) + M3-02 (`P5`)** | [PR #68](https://github.com/CThawngs/Router-Sync/pull/68) | `4965c9d` ([Run 45299374501](https://github.com/CThawngs/Router-Sync/actions/runs/45299374501)) & `e967c46` ([Run 45302137884](https://github.com/CThawngs/Router-Sync/actions/runs/45302137884)) — `18/18` GREEN | [Comment #7118578897](https://github.com/CThawngs/Router-Sync/pull/68#issuecomment-7118578897) (`M1..M3` + `Q1..Q3`: `6/6` bị bắt) | [`1c51c68`](https://github.com/CThawngs/Router-Sync/commit/1c51c680b48fa9a500b4bf717103b0e9b47258a5) | [Run 45303154883](https://github.com/CThawngs/Router-Sync/actions/runs/45303154883) — `18/18` GREEN (`attempt=1`) | **`4`** (`firstSha=bc61436 lastSha=1c51c68`) | **XONG** |

## 2. Kết quả `M3-01` (`P4` — Kiểm Đóng gói Tarball, Dry-Run, Registry & Smoke 5-OS)

Nguồn **đo được** (`evidence/M3/m3-p4-pack-verify.out.txt`, chạy `node tools/agent/pack-verify.mjs --check-registry` trên `1c51c68`):

| Gói công bố (`0.1.0`) | Số tệp | Kích thước tarball (`B`) | Giải nén (`B`) | `.map` / secret / đường dẫn cá nhân | `npm publish --dry-run` | `npm view` registry |
|---|---:|---:|---:|---|---:|---|
| `@routersync/adapter-sdk` | `7` | `3 617` | `10 875` | `0 / 0 / 0` | PASS | `unoccupied` (`E404`) |
| `@routersync/core` | `49` | `65 662` | `271 083` | `0 / 0 / 0` | PASS | `unoccupied` (`E404`) |
| `@routersync/adapter-9router` | `3` | `9 775` | `38 515` | `0 / 0 / 0` | PASS | `unoccupied` (`E404`) |
| `@routersync/adapter-omniroute` | `3` | `7 677` | `34 173` | `0 / 0 / 0` | PASS | `unoccupied` (`E404`) |
| `@routersync/sources` | `29` | `10 388` | `44 029` | `0 / 0 / 0` | PASS | `unoccupied` (`E404`) |
| `@routersync/daemon` | `63` | `43 115` | `164 489` | `0 / 0 / 0` | PASS | `unoccupied` (`E404`) |
| `@routersync/cli` | `175` | `324 887` | `1 281 404` | `0 / 0 / 0` | PASS | `unoccupied` (`E404`) |
| `@routersync/mcp-server` | `15` | `20 200` | `78 820` | `0 / 0 / 0` | PASS | `unoccupied` (`E404`) |
| **Tổng cộng (`8` gói)** | **`344`** | **`485 321`** | **`1 923 388`** | **`0 / 0 / 0`** | **`8/8` PASS** | **`8/8` `unoccupied`** |

- **đo được** (`m3-p4-pack-verify.out.txt`): Cài đặt sạch cả `8` tarball vào thư mục tạm ngoài repo trên `win32/x64` đạt `ok=true`, `installMs=10596`, `nodeGyp=false`, `routersync --version` = `0.1.0`, `doctor --json` = `true`, `combos stale --router 9router` exit `0`, `verify` exit `0`.
- **đo được** (CI [Run 45303154883](https://github.com/CThawngs/Router-Sync/actions/runs/45303154883)): Bước `Pack & Tarball Smoke` chạy xanh trên đủ `5` hệ điều hành CI (`ubuntu-latest`, `ubuntu-24.04-arm`, `macos-latest`, `windows-latest`, `windows-11-arm`) x Node `22`/`24`.
- **suy luận**: Cả `8` tên dưới scope `@routersync/*` đều chưa bị chiếm trên npm (`E404`), nhưng việc đăng ký tổ chức/scope `@routersync` trên npm khi phát hành thật thuộc quyền chủ dự án → đưa vào hàng đợi `chờ chủ dự án`.

## 3. Kết quả `M3-02` (`P5` — Đo Tài nguyên Có Phương sai `n=7` & `ADR-SQLITE-01`)

Nguồn **đo được** (`evidence/M3/m3-p5-resource-variance.out.txt`, `platform=win32/x64`, `node=v24.18.0`, `runs=7`, `idleMs=250`, `totalMemMB=16086`, `freeMemStartMB=1562`, `freeMemMinMB=1376`, `freeMemEndMB=1376`, `0` đụng cổng `20128`/`30128`/`3128`):

| Chỉ số | `n` | Trung bình (`mean`) | Độ lệch chuẩn (`stddev`) | Nhỏ nhất (`min`) | Lớn nhất (`max`) | Đơn vị |
|---|---:|---:|---:|---:|---:|---|
| `cli_cold_start_ms` | `7` | `2 341.71` | `1 341.84` | `1 758.00` | `5 381.25` | `ms` |
| `cli_idle_rss_mb` | `7` | `88.83` | `0.28` | `88.45` | `89.23` | `MB` |
| `cli_idle_heap_mb` | `7` | `16.38` | `0.00` | `16.38` | `16.38` | `MB` |
| `daemon_cold_start_ms` | `7` | `288.50` | `56.13` | `227.64` | `400.17` | `ms` |
| `daemon_idle_rss_mb` | `7` | `67.10` | `0.25` | `66.68` | `67.43` | `MB` |
| `daemon_idle_heap_mb` | `7` | `8.16` | `0.00` | `8.16` | `8.16` | `MB` |

- **đo được**: `docs/adr/ADR-SQLITE-01-better-sqlite3-vs-node-sqlite.md` (`Status: Proposed — chờ chủ dự án`) đối chiếu `better-sqlite3@13.0.3` (prebuilt binary trên đủ `5` hệ điều hành CI x Node `22`/`24`, `nodeGyp=false`) với `node:sqlite` (`ExperimentalWarning` trên Node `22.x`); **không thay đổi phụ thuộc** trong `v0.1.0` khi chưa có quyết định của chủ dự án.
- **đo được** (`m3-ci-stats.out.txt`): `push on main (CI workflow) green first attempt: 29/33`, `consecutive green first attempt: 4 (firstSha=bc61436 lastSha=1c51c68)`, `our commits green first attempt: 66/76 (87%)`.

## 4. Danh mục Bản ghi trong `evidence/M3/records.jsonl`

1. `m3-p4-pack-verify`: `node tools/agent/pack-verify.mjs --check-registry` (`exit=0`)
2. `m3-p5-resource-variance`: `node tools/agent/resource-variance.mjs --runs 7` (`exit=0`)
3. `m3-ci-stats`: `node tools/agent/ci-stats.mjs` (`exit=0`)
