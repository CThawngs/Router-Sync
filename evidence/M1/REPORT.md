# Milestone M1 Closure Report — `evidence/m1` (GitHub-First cho Planner từ xa)

- **Kho mã:** https://github.com/CThawngs/Router-Sync (`<REPO>`)
- **Nhánh bằng chứng:** `evidence/m1` (tạo trực tiếp từ `main` tại `618c2338fc5983eba1f292ba8a29fba122b34d44`, commit `[skip ci]`, không mở PR, không merge vào `main`, `0` workflow CI chạy trên nhánh)
- **Ngày khóa gói:** `2026-11-23` (UTC `09:24Z–09:26Z`)
- **Phạm vi đóng mốc:** Toàn bộ `3/3` vé Milestone **M1** (`M1-01`, `M1-02`, `M1-03`) đã hoàn tất tuần tự theo quy trình `CTO → Engineer (Red-First + Mutation) → CI 5 OS xanh lần 1 → QA (Checkout sạch + Mutation độc lập) → Ops (Squash-Merge) → main Push CI xanh lần 1`.
- **Tác động lên router thật:** `0` request HTTP tới 9Router (`127.0.0.1:20128`) hoặc OmniRoute (`127.0.0.1:30128`), `0` thao tác ghi vào DB/cấu hình router thật (`100%` fixture SQLite tạm trong `os.tmpdir()` kèm bất biến `sha256` đọc-chỉ).

---

## (a) Tổng hợp kết quả hoàn tất `3/3` vé Milestone M1 trên `main`

### 1. Bảng chuỗi PR, Commit Merge, CI `5` Hệ điều hành & Biên bản QA Độc lập

| Vé | PR GitHub & Nhánh nguồn | Head SHA trước Merge | PR CI `5` OS (`attempt=1`) | Biên bản QA Độc lập | Squash-Merge Commit trên `main` | `main` Push CI (`attempt=1`) | Chuỗi xanh `main` liên tiếp |
|---|---|---|---|---|---|---|---|
| **M1-01** | [PR #57](https://github.com/CThawngs/Router-Sync/pull/57) (`feat/m1-01-ci-stats-streak-health`) | `295910d1578f52555ec83fccd4063eecaea4faac` (`295910d`) | [Run 45125018561](https://github.com/CThawngs/Router-Sync/actions/runs/45125018561) — `18/18` GREEN (`attempt=1`) | [Comment 7093718880](https://github.com/CThawngs/Router-Sync/pull/57#issuecomment-7093718880) — **APPROVED** | [`52b8894`](https://github.com/CThawngs/Router-Sync/commit/52b8894df18479dae7ee5cc4e6dd77b2c5e93e05) (`52b8894df18479dae7ee5cc4e6dd77b2c5e93e05`) | [Run 45127403030](https://github.com/CThawngs/Router-Sync/actions/runs/45127403030) — `18/18` GREEN (`attempt=1`) | `18` |
| **M1-02** | [PR #58](https://github.com/CThawngs/Router-Sync/pull/58) (`fix/m1-02-omniroute-available-drift`) | `dc0e4e6c1056f71d9df7304b19d45fa795f59c27` (`dc0e4e6`) | [Run 45132021927](https://github.com/CThawngs/Router-Sync/actions/runs/45132021927) — `18/18` GREEN (`attempt=1`) | [Comment 7094900305](https://github.com/CThawngs/Router-Sync/pull/58#issuecomment-7094900305) — **SIGNED OFF** | [`1520e0f`](https://github.com/CThawngs/Router-Sync/commit/1520e0fb8d7e0e9eb272d9974588ed92781303e2) (`1520e0fb8d7e0e9eb272d9974588ed92781303e2`) | [Run 45136155961](https://github.com/CThawngs/Router-Sync/actions/runs/45136155961) — `18/18` GREEN (`attempt=1`) | `19` |
| **M1-03** | [PR #59](https://github.com/CThawngs/Router-Sync/pull/59) (`fix/m1-03-combo-names-drift`) | `495f8052810a8a9c38c34acf70c1e194e21cba52` (`495f805`) | [Run 45141177557](https://github.com/CThawngs/Router-Sync/actions/runs/45141177557) — `18/18` GREEN (`attempt=1`) | [Comment 7096238817](https://github.com/CThawngs/Router-Sync/pull/59#issuecomment-7096238817) — **SIGNED OFF** | [`618c233`](https://github.com/CThawngs/Router-Sync/commit/618c2338fc5983eba1f292ba8a29fba122b34d44) (`618c2338fc5983eba1f292ba8a29fba122b34d44`) | [Run 45144970898](https://github.com/CThawngs/Router-Sync/actions/runs/45144970898) — `18/18` GREEN (`attempt=1`) | **`20`** (`đo được (evidence/m1:m1-01-ci-stats)`) |

> **Nguồn xác nhận CI:** Tất cả `6/6` lượt chạy CI trên GitHub Actions (`3` PR + `3` `main` push) đều đạt `18/18` job `conclusion=success` ở `attempt=1` (`0` lần rerun, `0` sự cố hạ tầng) trên đủ `5` hệ điều hành (`ubuntu-latest`, `ubuntu-24.04-arm`, `macos-latest`, `windows-latest`, `windows-11-arm`, Node `22` & `24`).

---

### 2. Chi tiết kỹ thuật, Bằng chứng Red-First & Kiểm thử Đột biến (Engineer + QA Độc lập)

#### 2.1 `M1-01` — [PR #57](https://github.com/CThawngs/Router-Sync/pull/57) → [`52b8894`](https://github.com/CThawngs/Router-Sync/commit/52b8894df18479dae7ee5cc4e6dd77b2c5e93e05)
- **Phạm vi hoàn thành:**
  - Thêm `computePushMainStreak()` và `formatStreakLine()` trong `tools/agent/ci-stats-core.mjs` + in dòng chuỗi xanh liên tiếp trên `main` (`push on main consecutive green first attempt: <count> (firstSha=<sha> lastSha=<sha>)`) trong `tools/agent/ci-stats.mjs`.
  - Thêm bộ phát hiện `[E2E-DAEMON-HEALTH-SIGNAL]` (`detectDaemonHealthSignal`) vào `tools/agent/ci-watch.mjs` và `tools/agent/ci-stats-core.mjs` (gắn nhãn `kind=code` cho log chứa `daemon health failed; exited=` trước các luật infra/unknown; giữ `masked` cho job `continue-on-error`). Báo cáo trung thực dữ liệu `flake-hunt` hiện có trên `ubuntu-24.04-arm` (`run 44911108149`: `100` vòng, `red=0`; không tự sửa timeout hay bật `continue-on-error`).
  - Xóa `shell: process.platform === 'win32'` bằng `ghExecutable()` + `ghSpawnOptions()` trong `ci-watch.mjs` & `ci-stats.mjs`, đưa cảnh báo `[DEP0190]` trên Windows Node `24` về `stderr = 0` byte (`đo được (evidence/m1:m1-01-ci-stats)`).
  - Cập nhật `docs/CI.md` §5 (chỉ ghi số từ `ci-stats.mjs`) và §8 (dẫn chiếu `test/e2e/e2e.test.ts:503` & marker `[E2E-DAEMON-HEALTH-SIGNAL]`), cùng `test/agent/ci-doc.node.test.mjs`.
  - Xác minh cổng cứng C43A §4 (`origin/evidence/c43` có đủ tệp mục `3.1` và verifier `SẠCH`/`OK`) trước khi QA ký và Ops merge.
- **Red-First → Green-After (PR #57):** Trên nền `c28b7fb` + test mới: `19/38` đỏ (`19` test mới đều đỏ: streak `7/7`, health signal `8/8`, no-shell `4/4`) và `ci-doc` `1/5` đỏ → sau triển khai: `38/38` + `5/5` xanh (`43/43` pass).
- **Đột biến Engineer (`10/10` RED → khôi phục byte-identical theo `sha256`):** `M1–M10` phủ đủ nhánh streak (`break→continue`, đảo `firstSha`/`lastSha`, bỏ `run_attempt===1`, ẩn dòng CLI), health signal (tắt detector, bỏ khỏi `summarize`/`classifyRed`), và no-shell (`DEP0190` quay lại, bypass helper, sai tên thực thi Windows).
- **Đột biến độc lập QA (`QA-M1` — [Comment 7093718880](https://github.com/CThawngs/Router-Sync/pull/57#issuecomment-7093718880)):** Nới lỏng ranh giới regex `DAEMON_HEALTH_SIGNAL_RE` trong `tools/agent/ci-watch.mjs` (cho phép bỏ `exited=`) → `exit=1` (`42` pass / `1` fail tại `test/agent/ci-watch-classify.node.test.mjs:160`) → hoàn tác khớp `sha256` `ad97c3b058b125fad6cd36fe503fbfbe1f542d0bc323b7dbcec5547e7f18e4a8` → `43/43` GREEN.

#### 2.2 `M1-02` — [PR #58](https://github.com/CThawngs/Router-Sync/pull/58) → [`1520e0f`](https://github.com/CThawngs/Router-Sync/commit/1520e0fb8d7e0e9eb272d9974588ed92781303e2)
- **Phạm vi hoàn thành (giải quyết Known Issue 1):**
  - Trong `packages/core/src/domain/model-state.ts`: hợp nhất `comboModels` đang hoạt động vào `availableModels` ở nhánh `isOmniRoute` khi `!options.excludeComboModelsFromAvailability` (có chuẩn hóa tiền tố `models/`), đặt **trước** bước loại `disabledModels` và đồng bộ `enabledModels`; giữ nguyên bất biến `availabilityProviders` (`evidenceProviders`) không bị nhiễu bởi provider chỉ xuất hiện trong combo và giữ nguyên `excludeComboModelsFromAvailability: true` cho `routersync combos stale`; chặn step lỗi cấu trúc (`null`, `""`, `{}`, thiếu `model`/`providerId`).
  - Trong `packages/cli/src/apps/drift.ts`: căn chỉnh `classifyModelDrift` cho OmniRoute theo thứ tự đối xứng `DISABLED → OK (availableIds || comboIds) → MISSING`.
- **Red-First → Green-After (PR #58):** Trên nền `52b8894` + test mới: `3/3` tệp test lỗi (`4` failed / `36` passed trên `40` test) → sau triển khai: `3/3` tệp (`40/40` test) xanh; bộ mở rộng `6/6` tệp (`61/61` test) xanh.
- **Đột biến Engineer (`4/4` RED → khôi phục byte-identical theo `sha256`):** `M1` (bỏ qua `excludeComboModelsFromAvailability`: `4` fail), `M2` (xóa `disabledModels` trước khi gộp `comboModels`: `1` fail), `M3a` (bỏ `disabledIds` ở OmniRoute: `2` fail), `M3b` (bỏ `availableIds` ở OmniRoute: `2` fail).
- **Đột biến độc lập QA (`QA-M1` — [Comment 7094900305](https://github.com/CThawngs/Router-Sync/pull/58#issuecomment-7094900305)):** Cố tình gây ô nhiễm `evidenceProviders.add(prov)` từ bước combo trong `packages/core/src/domain/model-state.ts:292` → `exit=1` (`2` tệp lỗi, `5` assertion fail chứng minh hàng rào `UNVERIFIABLE` vs `ABSENT` bị bắt chặt) → hoàn tác khớp `sha256` `2db11d99ac0053cd604d15d0158393e0802f19007987f20c36f78988391f9985` → `5/5` tệp (`52/52` test) GREEN.

#### 2.3 `M1-03` — [PR #59](https://github.com/CThawngs/Router-Sync/pull/59) → [`618c233`](https://github.com/CThawngs/Router-Sync/commit/618c2338fc5983eba1f292ba8a29fba122b34d44)
- **Phạm vi hoàn thành (giải quyết Known Issue 2 & cập nhật tài liệu):**
  - Trong `packages/core/src/domain/model-state.ts`: thêm `comboNames: Set<string>` vào `RouterModelState` (cả `9router` và `omniroute`), thêm `comboNames?: Iterable<string> | undefined` vào `RouterModelStateOptions`, export `ReadRouterModelStateOptions`, đọc từ `options?.comboNames` và bảng SQLite `combos` (`row.name`, `parsed.name` không phải mảng, fallback `row.id` khi thiếu tên).
  - Trong `packages/cli/src/apps/drift.ts`: cập nhật `buildRouterView` để gộp `state?.comboNames` vào `view.comboNames`; cập nhật `driftKindOf` hỗ trợ cả tên combo trần và có tiền tố router (`9router/...`, `omniroute/...`); cập nhật `classifyModelDrift` phân loại combo hợp lệ thành `status: 'OK', kind: 'combo'` **trước** `disabledIds` (nhưng sau `UNKNOWN` / `versionMismatch`); cập nhật `checkIdFormatMismatch` tránh cảnh báo sai trên app chỉ cấu hình combo.
  - Cập nhật `docs/known-issues.md` đánh dấu **Resolved** cho cả Known Issue 1 (`M1-02`) và Known Issue 2 (`M1-03`) bằng tiếng Anh kèm đường dẫn bộ test hồi quy.
- **Red-First → Green-After (PR #59):** Trên nền `1520e0f` + test mới: `3/3` tệp lỗi (`5` failed / `41` passed) → sau triển khai: `7/7` tệp (`77/77` test) GREEN.
- **Đột biến Engineer (`4/4` RED → khôi phục byte-identical theo `sha256`):** `M1` (bỏ nạp `comboNames` trong `model-state.ts`: `3` tệp / `4` test fail), `M2` (bỏ nhánh `view.comboNames` trong `classifyModelDrift`: `2` test fail), `M3` (đẩy `disabledIds` lên trên `view.comboNames`: `1` test fail), `M4` (bỏ bảo vệ `view.comboNames` trong `checkIdFormatMismatch`: `1` test fail).
- **Đột biến độc lập QA (`QA-M1` — [Comment 7096238817](https://github.com/CThawngs/Router-Sync/pull/59#issuecomment-7096238817)):** Xóa đoạn gộp `state?.comboNames` vào `view.comboNames` trong `buildRouterView` (`packages/cli/src/apps/drift.ts`) → `exit=1` (`2/35` test fail tại `packages/cli/test/drift.test.ts:371` và `:429`) → hoàn tác khớp `sha256` `e324a5a5e9b4f444e4686a230ffce85d7b8f8070bd6f45886da795934c371e20` → `7/7` tệp (`77/77` test) GREEN.

---

### 3. Bằng chứng đo thực tế tại `main` @ `618c233` (`3` bản ghi trong `evidence/M1/records.jsonl`)

Toàn bộ `3` bản ghi được chụp trực tiếp trên `main` @ `618c2338fc5983eba1f292ba8a29fba122b34d44` sau khi build sạch `@routersync/core` và `@routersync/cli` (`tsc`, `exit=0`), qua `RS_EVIDENCE_DIR=evidence/M1 node tools/agent/capture-evidence.mjs` (không sửa tay `records.jsonl` hay `.out.txt`/`.err.txt`, không bật `RS_FORCE_HEAVY` hay `CI=true`).

| ID Bản ghi | Lệnh chạy thật | Exit / Thời lượng | `stdout` (`dòng` / `byte` / `sha256` đầu 12) | `stderr` (`dòng` / `byte`) | Tài nguyên `sys` & Ẩn danh `masked` | Kết quả chính (`đo được`) |
|---|---|---|---|---|---|---|
| `m1-01-ci-stats` | `node tools/agent/ci-stats.mjs` | `0` / `68 690 ms` | `17` dòng / `1 446` B / `b1de0a04984a` | `0` dòng / **`0` B** | `freeMemStart=1 394 MB`, `min=963 MB`, `privateNamesLoaded=12`, `masked.privateName=0` | `push on main consecutive green first attempt: 20 (firstSha=009d5b4 lastSha=618c233)`; `push on main: 25/28`; `our commits: 56/65 (86%)`; `pending=0`; `red runs: code=5 infra=0 unknown=3` (gồm `[E2E-DAEMON-HEALTH-SIGNAL]` trên `44880559648` & `44871175326`) — `đo được (evidence/m1:m1-01-ci-stats)` |
| `m1-02-omniroute` | `pnpm test:file packages/core/test/model-state-omniroute.test.ts packages/cli/test/combos-stale-omniroute.test.ts packages/cli/test/drift.test.ts` | `0` / `11 553 ms` | `19` dòng / `1 353` B / `e004e18a4964` | `0` dòng / **`0` B** | `freeMemStart=850 MB`, `min=436 MB`, `privateNamesLoaded=12`, `masked.privateName=2`, `homePath=2` | `Test Files 3 passed (3)`, `Tests 44 passed (44)` (`model-state-omniroute.test.ts`: `3`, `combos-stale-omniroute.test.ts`: `6`, `drift.test.ts`: `35`; Vitest `5.89s`) — `đo được (evidence/m1:m1-02-omniroute)` |
| `m1-03-combonames` | `pnpm test:file packages/core/test/model-tiers.test.ts packages/cli/test/apps-drift-y2.test.ts test/docs/agent-docs.test.ts test/docs/agent-ci-rules.test.ts` | `0` / `10 913 ms` | `20` dòng / `1 445` B / `7fb719ca4f1a` | `0` dòng / **`0` B** | `freeMemStart=778 MB`, `min=357 MB`, `privateNamesLoaded=12`, `masked.privateName=2`, `homePath=2` | `Test Files 4 passed (4)`, `Tests 33 passed (33)` (`apps-drift-y2.test.ts`: `6`, `model-tiers.test.ts`: `8`, `agent-ci-rules.test.ts`: `7`, `agent-docs.test.ts`: `12`; Vitest `7.51s`) — `đo được (evidence/m1:m1-03-combonames)` |

- **Tổng hợp kiểm thử M1 trên `main` @ `618c233`:** `7/7` tệp test, **`77/77` test xanh**, `stderr = 0` byte trên cả `3/3` bản ghi (`đo được (evidence/m1:m1-01-ci-stats)`, `đo được (evidence/m1:m1-02-omniroute)`, `đo được (evidence/m1:m1-03-combonames)`).
- **Tăng trưởng chỉ số CI so với mốc C42 (`evidence/c42:m0-ci-stats`):**
  - `push on main (CI workflow) green first attempt`: `23/27` → **`25/28`** (`đo được (evidence/m1:m1-01-ci-stats)`)
  - `push on main consecutive green first attempt`: `17` (`c28b7fb`) → **`20`** (`firstSha=009d5b4 lastSha=618c233` — `đo được (evidence/m1:m1-01-ci-stats)`)
  - `our commits green first attempt`: `53/65 (82%)` → **`56/65 (86%)`** (`đo được (evidence/m1:m1-01-ci-stats)`)

---

### 4. Danh sách đầy đủ `9` tệp trong `evidence/M1/` (`9 <= 10` tệp — đạt trần gói)

| STT | Tệp trong `evidence/M1/` | Vai trò |
|---:|---|---|
| `1` | `REPORT.md` | Báo cáo đóng mốc M1 tự đủ cho Planner đọc từ xa trên GitHub |
| `2` | `NOTE.md` | Bản tóm tắt điều hành ngắn gọn cho mốc M1 & xác nhận mở cổng M2 |
| `3` | `records.jsonl` | `3` dòng bản ghi kiểm chứng chuẩn `capture.mjs` v3 kèm `sha256`, `sys`, `masked` |
| `4` | `m1-01-ci-stats.out.txt` | Đầu ra chuẩn `node tools/agent/ci-stats.mjs` (`17` dòng, `1 446` byte — `đo được (evidence/m1:m1-01-ci-stats)`) |
| `5` | `m1-01-ci-stats.err.txt` | `stderr` rỗng `0` byte (`đo được (evidence/m1:m1-01-ci-stats)`) |
| `6` | `m1-02-omniroute.out.txt` | Đầu ra chuẩn Vitest `M1-02` (`3/3` tệp, `44/44` test — `đo được (evidence/m1:m1-02-omniroute)`) |
| `7` | `m1-02-omniroute.err.txt` | `stderr` rỗng `0` byte (`đo được (evidence/m1:m1-02-omniroute)`) |
| `8` | `m1-03-combonames.out.txt` | Đầu ra chuẩn Vitest `M1-03` & docs (`4/4` tệp, `33/33` test — `đo được (evidence/m1:m1-03-combonames)`) |
| `9` | `m1-03-combonames.err.txt` | `stderr` rỗng `0` byte (`đo được (evidence/m1:m1-03-combonames)`) |

---

## (b) Ghi chú minh bạch, hạng mục ngoài phạm vi M1 & điều chưa kiểm

1. **Ghi chú không chặn (FYI từ QA PR #59 — [Comment 7096238817](https://github.com/CThawngs/Router-Sync/pull/59#issuecomment-7096238817)):** Trong biên bản QA #59 có ghi chú ngoài phạm vi `M1-03` về biểu ngữ stdout cũ `EXPERIMENTAL: kết quả chưa đáng tin (OmniRoute chưa đọc được combo; tên combo chưa tra).` (QA dẫn chiếu `packages/cli/src/commands/drift.ts:276`; kiểm tra trực tiếp mã nguồn trên `main` @ `618c233` cho thấy chuỗi biểu ngữ này nằm tại `packages/cli/src/commands/drift.ts:338`). Vì `packages/cli/src/commands/drift.ts` nằm ngoài `ALLOWED_SCOPE` của `M1-03`, chuỗi thông báo này được giữ nguyên có chủ đích và sẽ dọn dẹp ở vé đầu ra CLI phù hợp khi `commands/drift.ts` thuộc phạm vi.
2. **Môi trường máy chạy local (Windows 11):** RAM trống khi đo nằm ở ngưỡng `LIGHT-DEV` (`1,29 GiB` khi preflight; `freeMemMinMB` từ `357 MB` đến `963 MB` — `đo được (evidence/m1:m1-01-ci-stats..m1-03-combonames)`). Toàn bộ full suite build + test + e2e trên `5` hệ điều hành đã được kiểm chứng đầy đủ trên GitHub Actions CI (`18/18` GREEN `attempt=1` trên `main` @ `618c233`, [Run 45144970898](https://github.com/CThawngs/Router-Sync/actions/runs/45144970898)); kiểm thử máy vật lý macOS/Linux vẫn giữ nguyên ngoài phạm vi theo mục `2` của `evidence/C43/PLAN.md`.
3. **Track R (`R0 → R2 → R1`) chạy song song, không chặn M1/M2:** Báo cáo Track R tiếp tục cập nhật độc lập trên nhánh `origin/evidence/c43` theo đúng ranh giới C43/C43A.

---

## (c) Xác nhận cổng C43 §3.5 — Đủ điều kiện mở khóa tự động Milestone M2

Đối chiếu toàn bộ tiêu chí đóng mốc M1 và điều kiện chuyển tiếp tự động sang M2 tại `evidence/C43/PLAN.md` mục `3` & `4` (C43 §2, §3.4, §3.5):

- [x] Toàn bộ `3/3` vé `M1-01` (#57), `M1-02` (#58), `M1-03` (#59) đã squash-merge tuần tự vào `main` (`618c233`), mỗi lúc chỉ `1` PR mở.
- [x] Tất cả `6/6` lượt CI (`3` PR + `3` `main` push) đạt `18/18` GREEN ở `attempt=1`; chuỗi `push on main` xanh liên tiếp đạt **`20`** (`009d5b4..618c233` — `đo được (evidence/m1:m1-01-ci-stats)`).
- [x] Mỗi PR đều có biên bản **QA độc lập** trên checkout sạch kèm đột biến `QA-M1` đỏ-trước-xanh-sau và khôi phục `sha256` trùng khớp.
- [x] Gói `evidence/M1/` có đúng **`9` tệp** (`<= 10`), vượt qua `verify-records.mjs` (`SẠCH: 3 dòng`), `verify-package.mjs` (`OK`), `scan-private-names.mjs` (`0` khớp trên `9/9` tệp và `0` khớp mới so với `origin/main`), commit `[skip ci]`, `0` CI run trên nhánh `evidence/m1`.
- [x] Không kích hoạt bất kỳ điều kiện dừng khẩn cấp nào trong `6` điều kiện dừng của C43 mục `2`.

**Kết luận Cổng C43 §3.5:** **ĐẠT TOÀN BỘ — MỞ KHÓA MILESTONE M2** (`M2-01` grant lifecycle `ADR-MAINTAIN-02` → `M2-02` outbound webhook đích giả → `M2-03` read-back HTTP `2` router). Theo đúng C43 §3.5, đội tiếp tục chuyển thẳng sang M2 và chỉ dừng chờ Chủ dự án duyệt mở M3 sau khi khóa xong cả `evidence/m1`, `evidence/m2` và `evidence/c43`.