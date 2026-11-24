# RELEASE-CANDIDATE.md — Hồ sơ Sẵn sàng Cổng Phát hành RouterSync `v0.1.0` (M5 Prep — C44 §4.4)

- ** Kho lưu trữ:** `https://github.com/CThawngs/Router-Sync`
- **Commit `main` ứng viên phát hành (RC HEAD):** [`2ea12c44abae747d466a3b81a5f67eaec68dc87d`](https://github.com/CThawngs/Router-Sync/commit/2ea12c44abae747d466a3b81a5f67eaec68dc87d) (`2ea12c4`)
- **Trạng thái cổng M5:** **CHUẨN BỊ XONG HỒ SƠ — CHỜ CHỦ DỰ ÁN QUYẾT ĐỊNH GO/NO-GO** *(Đội tuyệt đối KHÔNG chạy `npm publish`, KHÔNG tạo tag phát hành, KHÔNG áp bản vá hay sửa DB router).*

---

## 1. Danh sách kiểm GO / NO-GO tới Cổng Phát hành `v0.1.0`

| # | Hạng mục kiểm tra | Trạng thái | Bằng chứng xác minh độc lập / Điều kiện mở |
|---|---|---|---|
| 1 | **P1 — Sức khỏe CI & tín hiệu `E2E-DAEMON-HEALTH-SIGNAL` (`M1-01`)** | **Đủ bằng chứng** | [PR #57](https://github.com/CThawngs/Router-Sync/pull/57) (`52b8894`), `origin/evidence/m1` @ `987da9c`; `m4-ci-stats` tại `2ea12c4`: `push on main` xanh lần đầu `29/33`, chuỗi xanh liên tiếp hiện tại **`5`** (`bc61436..2ea12c4`), commit của đội `67/77 (87%)`. |
| 2 | **P2 — Đóng Known Issues 1 & 2 trên OmniRoute & `apps drift` (`M1-02`, `M1-03`)** | **Đủ bằng chứng** | [PR #58](https://github.com/CThawngs/Router-Sync/pull/58) (`1520e0f`), [PR #59](https://github.com/CThawngs/Router-Sync/pull/59) (`618c233`), `origin/evidence/m1` @ `987da9c` (`SẠCH: 3 dòng`). |
| 3 | **P3 — Phase 3 S2: Grant `ADR-MAINTAIN-02`, Outbound Webhook, Read-Back 2 router (`M2-01..M2-03`)** | **Đủ bằng chứng** | [PR #62](https://github.com/CThawngs/Router-Sync/pull/62) (`7abfd74`), [PR #64](https://github.com/CThawngs/Router-Sync/pull/64) (`8ca92f8`), [PR #65](https://github.com/CThawngs/Router-Sync/pull/65) (`bc61436`), `origin/evidence/m2` @ `4acc7c4` (`SẠCH: 3 dòng`). |
| 4 | **P4 — Đóng gói 8 tarball sạch `.map`, smoke cài sạch 5 hệ điều hành CI & `npm publish --dry-run` (`M3-01`)** | **Đủ bằng chứng** | [PR #68](https://github.com/CThawngs/Router-Sync/pull/68) (`1c51c68`), CI `main` [Run 45303154883](https://github.com/CThawngs/Router-Sync/actions/runs/45303154883) (`18/18` `attempt=1`), QA [Comment #7118578897](https://github.com/CThawngs/Router-Sync/pull/68#issuecomment-7118578897) (`6/6` đột biến), `origin/evidence/m3` @ `9d82fec`. |
| 5 | **P4 — Khởi tạo/sở hữu scope `@routersync` trên npm registry** | **Chờ chủ dự án** | Kiểm chỉ đọc `npm view` (`m3-p4-pack-verify.out.txt`): cả `8/8` gói `@routersync/*` trả `unoccupied` (`E404`); chủ dự án cần tạo org/scope `@routersync` trước khi chạy `npm publish`. |
| 6 | **P5 — Đo tài nguyên có phương sai (`n=7`) & `ADR-SQLITE-01` (`M3-02`)** | **Đủ bằng chứng (mã) / Chờ chủ dự án (ADR)** | Số đo `n=7` kèm `freeMemMB` lưu trong `origin/evidence/m3` @ `9d82fec`; `docs/adr/ADR-SQLITE-01-better-sqlite3-vs-node-sqlite.md` giữ nguyên `better-sqlite3@13.0.3` cho `v0.1.0`, chờ chủ dự án chốt lộ trình dài hạn. |
| 7 | **P6 — Nhất quán tài liệu, Quickstart chỉ đọc người mới & test CLI fixture (`M4-01`)** | **Đủ bằng chứng** | [PR #69](https://github.com/CThawngs/Router-Sync/pull/69) (`2ea12c4`), CI `main` [Run 45317752224](https://github.com/CThawngs/Router-Sync/actions/runs/45317752224) (`18/18` `attempt=1`), `origin/evidence/m4` @ `75d0e13` (`26/26` doc & fixture tests PASS). |
| 8 | **P7 — Kiểm toán bảo mật 5 bề mặt, 3 cổng ghi router & `SECURITY.md` (`M4-02`)** | **Đủ bằng chứng** | `m4-p7-security-audit.out.txt` (`origin/evidence/m4` @ `75d0e13`): `high=0 medium=0 low=0` trên `main` (`650` tệp), `evidence/*` (`759` blobs), `8` tarball, `4` log CI và `12/12` bài kiểm cổng ghi; QA [Comment #7120782660](https://github.com/CThawngs/Router-Sync/pull/69#issuecomment-7120782660) (`7/7` đột biến). |
| 9 | **Track R & Track W (`9Router 0.5.123`: `W1..W5`)** | **Đủ bằng chứng (`W1..W4`) / Chờ chủ dự án (`PATCH_V3`, `rs-fast`)** | `W2` merged tại [PR #67](https://github.com/CThawngs/Router-Sync/pull/67) (`dd3407b`, CI `main` [Run 45301005149](https://github.com/CThawngs/Router-Sync/actions/runs/45301005149) `18/18` `attempt=1`); `W1`=`còn nghẽn`, `W3` (`14.11h`)=`3/3 OK`, `W4` merged tại `2ea12c4`, `W5`=`chưa đo` (`combo_not_in_db`). Quyết định áp `PATCH_V3` và tạo `rs-fast` thuộc `chờ chủ dự án`. |
| 10 | **Kiểm thử trên máy macOS/Linux vật lý, gắn tag & chạy `npm publish` (`M5`)** | **Chờ chủ dự án** | Ma trận CI 5 OS (`ubuntu-latest`, `ubuntu-24.04-arm`, `macos-latest`, `windows-latest`, `windows-11-arm`) đã xanh `18/18`; việc thử máy vật lý, gắn tag và publish thuộc thẩm quyền riêng của chủ dự án. |

---

## 2. Đề xuất Số Phiên bản & Dự thảo `CHANGELOG`

### 2.1 Đề xuất số phiên bản
- **Khuyến nghị chính:** **`0.1.0`** (khớp chính xác trường `"version": "0.1.0"` hiện có trong cả 8 `packages/*/package.json` mà không cần thêm commit đổi số phiên bản).
- **Phương án thay thế nếu muốn thử nghiệm trước trên máy macOS/Linux vật lý:** Phát hành bản thử **`0.1.0-rc.1`** dưới dist-tag `next` (`npm publish --tag next --access public`), sau khi nghiệm thu vật lý thì nâng lên `0.1.0` (`latest`).

### 2.2 Dự thảo `CHANGELOG.md` cho `0.1.0`

```markdown
## [0.1.0] - 2026-11-24

### Added
- Deterministic multi-router sync, verification ladder (L1/L2/L3), ranking engine, and read-only MCP server (`24` tools) across `@routersync/adapter-sdk`, `@routersync/core`, `@routersync/adapter-9router`, `@routersync/adapter-omniroute`, `@routersync/sources`, `@routersync/daemon`, `@routersync/cli`, and `@routersync/mcp-server`.
- Phase 3 S2 human-gated write controls: `ADR-MAINTAIN-02` scrypt/HMAC grant lifecycle (`maintain authorize`, `grant-status`, `revoke-grant`), single-use HMAC daemon approval tokens (`AT-165`), validated redacted outbound webhook notifications, and HTTP serving-path read-back verification (`api-verified`, `existence-only`, `db-only`) on both 9Router and OmniRoute.
- Client-side `RequestBudget`, `SKIPPED-QUOTA`, and `reconcileSentVsUsage` accounting in `combos probe` so streaming probes remain accurate even when `9router@0.5.123` omits `usageHistory` rows (`W2`).
- Release & security verification tooling: 5-OS tarball hygiene & clean-install smoke (`tools/agent/pack-verify.mjs`), variance-aware cold-start/RSS benchmark (`tools/agent/resource-variance.mjs`), `ADR-SQLITE-01` (`better-sqlite3` vs `node:sqlite` analysis), and zero-leak 5-surface security auditor (`tools/agent/security-audit.mjs`).
- Step-by-step read-only new-user onboarding guide (`docs/SETUP.md`, `README.md`) and expanded v0.1 data-minimization contract (`SECURITY.md`).

### Fixed
- Merged active `combos.data.models` into OmniRoute `readRouterModelState` when `excludeComboModelsFromAvailability` is unset and added `comboNames` classification to `apps drift` (Known Issues #1 & #2).
- Fixed empty-key regex redaction corruption in `combos-reliability.ts` and `#<attempt>` suffix matching in `recentQuotaSteps`.
- Excluded `.js.map` and `.d.ts.map` source maps from all 8 publishable npm tarballs (`"files": ["dist", "!dist/**/*.map"]`).
```

---

## 3. Kết quả `npm publish --dry-run`, Kích thước Tarball (`P4`) & Tài nguyên (`P5`)

### 3.1 Bảng kích thước tarball & `npm publish --dry-run` — nhãn **đo được** (`evidence/M3/m3-p4-pack-verify.out.txt`)

| Thứ tự publish | Tên gói (`0.1.0`) | Số tệp | Tarball nén (`B`) | Giải nén (`B`) | `.map` / secret / đường dẫn cá nhân | `npm publish --dry-run` | `npm view` registry |
|---:|---|---:|---:|---:|---|---|---|
| 1 | `@routersync/adapter-sdk` | `7` | `3 617` | `10 875` | `0 / 0 / 0` | PASS | `unoccupied` (`E404`) |
| 2 | `@routersync/core` | `49` | `65 662` | `271 083` | `0 / 0 / 0` | PASS | `unoccupied` (`E404`) |
| 3 | `@routersync/adapter-9router` | `3` | `9 775` | `38 515` | `0 / 0 / 0` | PASS | `unoccupied` (`E404`) |
| 4 | `@routersync/adapter-omniroute` | `3` | `7 677` | `34 173` | `0 / 0 / 0` | PASS | `unoccupied` (`E404`) |
| 5 | `@routersync/sources` | `29` | `10 388` | `44 029` | `0 / 0 / 0` | PASS | `unoccupied` (`E404`) |
| 6 | `@routersync/daemon` | `63` | `43 115` | `164 489` | `0 / 0 / 0` | PASS | `unoccupied` (`E404`) |
| 7 | `@routersync/cli` | `175` | `324 887` | `1 281 404` | `0 / 0 / 0` | PASS | `unoccupied` (`E404`) |
| 8 | `@routersync/mcp-server` | `15` | `20 200` | `78 820` | `0 / 0 / 0` | PASS | `unoccupied` (`E404`) |
| — | **Tổng cộng (`8` gói)** | **`344`** | **`485 321`** | **`1 923 388`** | **`0 / 0 / 0`** | **`8/8` PASS** | **`8/8` `unoccupied`** |

*(Ghi chú: trên runner CI Linux/macOS/Windows sạch từ `git clone`, `@routersync/cli` đạt `323 948 B` và tổng 8 gói đạt `484 382 B` do chuẩn hóa ký tự xuống dòng LF).*

### 3.2 Bảng tài nguyên có phương sai `n=7` — nhãn **đo được** (`evidence/M3/m3-p5-resource-variance.out.txt`)
- Môi trường đo: `win32/x64`, `node=v24.18.0`, `runs=7`, `idleMs=250`, `totalMemMB=16086`, **`freeMemStartMB=1562`, `freeMemMinMB=1376`, `freeMemEndMB=1376`**.
- `cli_cold_start_ms`: `mean = 2 341.71 ms`, `stddev = 1 341.84 ms`, `min = 1 758.00 ms`, `max = 5 381.25 ms`.
- `cli_idle_rss_mb`: `mean = 88.83 MB`, `stddev = 0.28 MB`, `min = 88.45 MB`, `max = 89.23 MB` (`heap = 16.38 MB`).
- `daemon_cold_start_ms`: `mean = 288.50 ms`, `stddev = 56.13 ms`, `min = 227.64 ms`, `max = 400.17 ms`.
- `daemon_idle_rss_mb`: `mean = 67.10 MB`, `stddev = 0.25 MB`, `min = 66.68 MB`, `max = 67.43 MB` (`heap = 8.16 MB`).

---

## 4. Bộ Lệnh Chủ dự án Tự gõ để Gắn Tag & Phát hành (VIẾT SẴN — ĐỘI KHÔNG CHẠY)

> **Cảnh báo an toàn:** Chỉ thực thi sau khi Chủ dự án đã tạo scope `@routersync` trên npm, đăng nhập `npm login`, và chốt quyết định **GO** tại cổng M5. Đẩy từng tag phiên bản tường minh (`git push origin v0.1.0`).

```bash
# 1. Đồng bộ đúng commit ứng viên phát hành trên main và kiểm tra sạch kho
git checkout main
git pull --ff-only origin main
git rev-parse HEAD   # kỳ vọng: 2ea12c44abae747d466a3b81a5f67eaec68dc87d

# 2. Build sạch, kiểm toán đóng gói & bảo mật lần cuối trước khi gắn tag
pnpm install --frozen-lockfile
pnpm build
node tools/agent/pack-verify.mjs --check-registry
node tools/agent/security-audit.mjs

# 3. Gắn tag chú thích đơn lẻ và đẩy tường minh đúng tag v0.1.0 lên GitHub
git tag -a v0.1.0 -m "Release v0.1.0"
git push origin v0.1.0

# 4. Xuất bản lần lượt 8 gói theo đúng thứ tự phụ thuộc (pnpm tự chuyển workspace:* -> 0.1.0)
pnpm --filter @routersync/adapter-sdk publish --access public --no-git-checks
pnpm --filter @routersync/core publish --access public --no-git-checks
pnpm --filter @routersync/adapter-9router publish --access public --no-git-checks
pnpm --filter @routersync/adapter-omniroute publish --access public --no-git-checks
pnpm --filter @routersync/sources publish --access public --no-git-checks
pnpm --filter @routersync/daemon publish --access public --no-git-checks
pnpm --filter @routersync/cli publish --access public --no-git-checks
pnpm --filter @routersync/mcp-server publish --access public --no-git-checks

# 5. Kiểm tra chỉ đọc sau phát hành trên npm registry
npm view @routersync/cli version dist.tarball
npm view @routersync/mcp-server version dist.tarball
```

---

## 5. Phần Mở rộng Sau `v0.1` — 17 Hạng mục Ngoài Phạm vi (Ngăn Phình Phạm vi)

1. Kiểm thử trên máy macOS và Linux vật lý.
2. Phát hành lên npm công khai (`npm publish`) và gắn tag phát hành chính thức (thuộc cổng M5 của Chủ dự án).
3. `G5` — Hoàn thiện giao diện web (`packages/ui`) đọc trạng thái đầy đủ.
4. `G6` — Cơ chế BYOK Encrypted Key Bypass (`ROUTERSYNC_KEY_<PREFIX>`).
5. Chế độ `auto-safe` & tự động failover có khóa ghi phần cứng (Phase 4).
6. Các cầu nối trực tiếp cho agent harness ngoài của Phase 5 (Hermes Agent, OpenClaw, DeepSeek Harness, Claude Code, Antigravity) và đồng bộ edge router phân tán.
7. Ghi vào router thật / sửa cấu hình ứng dụng của chủ dự án / dừng hoặc khởi động lại router / tạo `rs-fast`, `rs-max`, cập nhật `9Router-Agent-1`, tự kiểm các bước `huggingface` `404`, `opencode` `429`, `cohere` `405`.
8. Cấu hình lịch quét BYOK qua giao diện web.
9. Hợp nhất nguồn catalog giữa `scan` và `tick` thành một pipeline duy nhất.
10. Chuẩn hóa định dạng ngày trong nguồn L3 (`gemini-deprecations`, `openrouter-changelog`).
11. Phủ kiểm thử tự động hoàn chỉnh cho lệnh `routersync undo` để nâng lên đường hoàn tác chính thức.
12. Lọc đề xuất `NEW-CANDIDATE` trong `tick` theo nhãn `QUOTA` và `SẮP-NGỪNG`.
13. Đo tỷ lệ lỗi 7 ngày của 9Router (bảng `usageHistory` hiện chỉ lưu request thành công).
14. Kiểm chứng thực tế đường dẫn cơ sở dữ liệu 9Router trên macOS/Linux vật lý (`~/.9router/db/data.sqlite`).
15. Gộp thống nhất hai thư mục trạng thái riêng biệt của `sync` và `tick`.
16. Mở rộng bảo vệ HTTP trong scanner nhà cung cấp tùy biến (chặn cross-host redirect nội bộ, lọc SSRF dải IP riêng tư, allowlist host cứng ngoài 7 cơ chế hiện có).
17. Nhóm `K8` ("Repo tự mô tả cho AI Agent"): adapter AI Agent qua `packages/adapter-sdk`, kênh tự cập nhật theo tag, fuzz/property test cho đường ghi và bảng độ phủ xác minh L1/L2/L3 theo từng nhà cung cấp.

---

## 6. Hàng đợi `chờ chủ dự án` Đánh số Liên tục (Đã gom đủ OQ)

1. **Đăng ký tổ chức/scope `@routersync` trên npmjs.org:** Cả `8/8` gói `@routersync/*` hiện trả `E404 unoccupied`; chủ dự án cần tạo scope `@routersync` trước khi phát hành.
2. **Quyết định `ADR-SQLITE-01` (`better-sqlite3` vs `node:sqlite`):** Xác nhận giữ `better-sqlite3@13.0.3` cho `v0.1.0` (đã có prebuilt binary `nodeGyp=false` trên đủ 5 OS CI × Node 22/24) hay lên lộ trình chuyển `node:sqlite` ở nhánh sau khi bỏ Node 22.
3. **Quyết định áp `PATCH_V3` cho `9router@0.5.123` (từ kết quả `W1`):** `W1` kết luận **`còn nghẽn`** (`GET /v1/models` `426 861 B` mất `5 891–7 559 ms`, kéo trễ chat đồng thời lên `4 338–6 332 ms`). Nếu muốn áp bản vá, chủ dự án tự chạy: `RS_OWNER_CONFIRMED=chạy node tools/agent/nine-router-patch.mjs apply --yes-write-router`.
4. **Quyết định tạo combo `rs-fast` (và cập nhật `9Router-Agent-1` / `rs-max`) trên 9Router:** `W5` hiện ở trạng thái **`chưa đo`** (`reason=combo_not_in_db`); sau khi chủ dự án tạo `rs-fast` có thể chạy `node tools/agent/c44-track-w.mjs w5 --yes-spend-tokens`.
5. **Quyết định đo tiếp mốc tuổi tiến trình `~24h` và `~48h` của `W3`:** Tại thời điểm đóng C44, tiến trình `9router@0.5.123` đạt `14.11` giờ tuổi (đã đo sạch mốc `~6h`: `3/3` `200 OK`, `609–811 ms`, `0` treo); hai mốc `~24h` và `~48h` đang `chưa đo`.
6. **Quyết định kiểm thử trên máy macOS và Linux vật lý** trước hoặc sau bản `0.1.0` / `0.1.0-rc.1`.
7. **Quyết định cổng M5 (GO / NO-GO):** Chốt số phiên bản (`0.1.0` hoặc `0.1.0-rc.1`), tự gắn tag `v0.1.0` và thực thi các lệnh `publish` tại Mục 4.
