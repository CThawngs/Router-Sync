# M3 (`P4`, `P5`) — Tóm tắt Bàn giao (`<= 40` dòng)

- **Trạng thái vé:**
  - `M3-01` (`P4` — Kiểm đóng gói tarball, `npm publish --dry-run`, kiểm registry `npm view`, smoke sạch 5 hệ điều hành CI): **XONG**.
  - `M3-02` (`P5` — Đo phương sai tài nguyên `n=7` kèm RAM trống + `ADR-SQLITE-01` đề xuất): **XONG**.
- **Bốn bằng chứng RACI:**
  - PR gộp: `https://github.com/CThawngs/Router-Sync/pull/68` (`feat/m3-packaging-and-resource-variance`), PR CI `45299374501` & `45302137884` (`18/18` xanh `attempt=1`).
  - Biên bản QA độc lập (`6/6` đột biến bị bắt: `M1..M3` + `Q1..Q3`): `https://github.com/CThawngs/Router-Sync/pull/68#issuecomment-7118578897`.
  - Merge SHA trên `main`: `1c51c680b48fa9a500b4bf717103b0e9b47258a5` (`1c51c68`).
  - Push CI `main` lần 1: Run `45303154883` (`18/18` xanh, `attempt=1`, chuỗi `main` xanh liên tiếp = `4`).
- **Số liệu `đo được` — `P4` Tarball (`m3-p4-pack-verify.out.txt`):**
  - `8` gói công bố (`0` `.map`, `0` secret, `0` đường dẫn cá nhân), tổng nén **`485 321 B`** (`1 923 388 B` giải nén): `adapter-sdk` `3 617 B`, `core` `65 662 B`, `adapter-9router` `9 775 B`, `adapter-omniroute` `7 677 B`, `sources` `10 388 B`, `daemon` `43 115 B`, `cli` `324 887 B`, `mcp-server` `20 200 B`.
  - `npm publish --dry-run`: `8/8` PASS; `npm view`: `8/8` `unoccupied` (`E404`); smoke cài sạch ngoài repo: `ok=true` (`installMs=10596`, `nodeGyp=false`).
- **Số liệu `đo được` — `P5` Tài nguyên `n=7` (`m3-p5-resource-variance.out.txt`, `freeMemStartMB=1562`, `freeMemMinMB=1376`):**
  - CLI khởi động lạnh: `mean=2341.71 ms`, `stddev=1341.84 ms`, `min=1758.00 ms`, `max=5381.25 ms`; RSS nghỉ: `mean=88.83 MB`, `stddev=0.28 MB` (`88.45–89.23 MB`).
  - Daemon khởi động lạnh: `mean=288.50 ms`, `stddev=56.13 ms`, `min=227.64 ms`, `max=400.17 ms`; RSS nghỉ: `mean=67.10 MB`, `stddev=0.25 MB` (`66.68–67.43 MB`).
- **Hàng đợi `chờ chủ dự án` phát sinh ở M3:**
  1. Đăng ký tổ chức/scope `@routersync` trên npm trước khi phát hành thật (`8/8` tên gói hiện `unoccupied`).
  2. Quyết định `ADR-SQLITE-01` (giữ `better-sqlite3` cho `v0.1.0` hay chuyển sang `node:sqlite` ở phiên bản sau).
