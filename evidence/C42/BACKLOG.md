# BACKLOG.md — Danh sách Vé Thực thi M1 & M2 cho RouterSync v0.1 RC (C42)

- **Chương trình:** C42 — Hiến chương chương trình RouterSync v0.1 Release Candidate
- **Đồng lập & rà soát:** Product Manager (PMO Lead) & CTO (thiết kế kỹ thuật), được CEO và COO kiểm chứng chéo
- **Trạng thái tại M0:** **CHỈ LẬP KẾ HOẠCH — CHƯA GIAO VIỆC** xuống Engineer, QA hay Ops cho tới khi kế hoạch C42 được người duyệt độc lập và Chủ dự án chấp thuận.
- **Ràng buộc chung cho mọi vé:**
  - Đủ **7 trường bắt buộc** (Mục 8.3): Mục tiêu · Tiêu chí chấp nhận (đỏ trước – xanh sau) · Người làm · Người xác minh độc lập · Tệp dự kiến · Rủi ro · Lệnh kiểm chứng.
  - Chạy `node tools/agent/preflight.mjs` đầu mỗi phiên; khi RAM trống `< 1.50 GiB` (`LIGHT-DEV`), tuân thủ nghiêm cổng `tools/agent/heavy.mjs` (không đặt `RS_FORCE_HEAVY=1` hay `CI=true`; chỉ chạy `pnpm lint`, `pnpm typecheck:changed`, `pnpm test:changed` hoặc test tệp đơn lẻ, để full suite cho GitHub Actions PR CI).
  - Tối đa **1 PR mở tại một thời điểm**; cấm commit trực tiếp lên `main`, cấm `--force`, cấm `git worktree` nối junction `node_modules` (sự cố C19), cấm gọi `/v1/models` định kỳ hay chạm router thật.
  - Chỉ merge bằng `gh pr merge --squash` (do **Ops** thực hiện duy nhất sau khi **QA** ký độc lập) khi head cuối xanh đủ **5 hệ điều hành** (`ubuntu-latest`, `ubuntu-24.04-arm`, `macos-latest`, `windows-latest`, `windows-11-arm`; ARM báo cáo tách riêng), sau đó chạy `ci-watch.mjs` theo dõi run `main` ở `attempt=1`.

---

## Cột mốc M1 — Sức khỏe CI (P1) & Known Issues 1 và 2 (P2)
- **Gói bằng chứng đích:** Nhánh `evidence/m1` (`evidence/M1/`, `[skip ci]`, không PR, không merge, tối đa 10 tệp).

---

### Vé `M1-01` — [P1] Sức khỏe CI: Điều tra `flake-hunt` & gắn cảnh báo tự động cho lỗi health daemon `e2e.test.ts`, làm sạch `ci-stats` và cập nhật `docs/CI.md`

1. **Mục tiêu:**
   - Xuất phát từ nền M0.2 đã đo thật (`m0-ci-stats`: `push` trên `main` xanh lần đầu `23/27`, chuỗi hiện hành **17 lần merge liên tiếp xanh ở `attempt=1`**, commit của đội `53/65 = 82%`, đỏ `code=4, infra=0, unknown=5`), kiểm tra khả năng tái hiện lỗi treo ở run `44788053023` (`verify (ubuntu-24.04-arm, node 22)` attempt 1 tại `test/e2e/e2e.test.ts:470`, nay là vùng dòng `453–504` / `diag()` dòng `503` sau khi `c28b7fb` đã thêm thu pipe `daemonOut`/`daemonErr`) thông qua `.github/workflows/flake-hunt.yml`.
   - Bổ sung bộ nhận diện & cảnh báo tự động `E2E-DAEMON-HEALTH-SIGNAL` trong `tools/agent/ci-watch.mjs` và `tools/agent/ci-stats-core.mjs` để khi chữ ký `daemon health failed; exited=` xuất hiện ở `attempt=1` thì báo cảnh báo định danh rõ ràng kèm `diag()` (không bị chìm vào `UNKNOWN STEP` hay nhầm với `infra`), đồng thời loại bỏ cảnh báo Node `[DEP0190]` ở stderr của `tools/agent/ci-stats.mjs` trên Windows và cập nhật bảng số liệu thực + số dòng tham chiếu trong `docs/CI.md` (§5, §8).
2. **Tiêu chí chấp nhận (đỏ trước – xanh sau):**
   - **Đỏ trước:** Viết unit test trong `test/agent/ci-watch-classify.node.test.mjs` và `test/agent/ci-stats.node.test.mjs` cho mẫu log lỗi `daemon health failed; exited=` (kỳ vọng phát tín hiệu cảnh báo `E2E-DAEMON-HEALTH-SIGNAL` và phân loại `code`) cùng kiểm tra `ci-stats.mjs` chạy sạch `stderr` (`0` dòng `[DEP0190]`) — xác nhận test **đỏ** trên mã nền `c28b7fb`. Nếu `flake-hunt.yml` tái hiện được lỗi gốc trên `ubuntu-24.04-arm`, phải có test tái hiện đỏ trước khi sửa `daemon`/`e2e.test.ts`.
   - **Xanh sau:**
     - Toàn bộ unit test mới cho `ci-watch-classify` & `ci-stats` xanh; `ci-stats.mjs` xuất `0` cảnh báo `[DEP0190]` ở `stderr`.
     - Kết quả chạy `flake-hunt.yml` trên `ubuntu-24.04-arm` được ghi nhận trung thực (nếu tái hiện thì đã sửa xanh `red=0`; nếu `red=0` thì cảnh báo tự động `E2E-DAEMON-HEALTH-SIGNAL` đã sẵn sàng bắt ngay lần xuất hiện kế tiếp mà không dùng `continue-on-error`, không xóa test, không tăng timeout mù quáng).
     - `docs/CI.md` §5 & §8 khớp số liệu `ci-stats.mjs` mới nhất và dòng tham chiếu thực tế của `test/e2e/e2e.test.ts`.
     - PR xanh đủ **5 hệ điều hành** trên head cuối, Ops squash-merge, run CI `main` xanh ở `attempt=1` (duy trì chuỗi `>= 10` lần merge liên tiếp xanh lần đầu trên `main`).
3. **Người làm:** **Engineer** (sau khi **CTO** chốt thiết kế phân loại cảnh báo; **Ops** thực hiện `gh pr merge --squash` sau khi QA ký).
4. **Người xác minh độc lập:** **QA** (khác Engineer; tự kiểm tra bằng chứng đỏ-trước xanh-sau, kết quả `flake-hunt.yml`, chạy lại `verify-records.mjs` và `verify-package.mjs`).
5. **Tệp dự kiến:**
   - `<REPO>/tools/agent/ci-watch.mjs`
   - `<REPO>/tools/agent/ci-stats-core.mjs`
   - `<REPO>/tools/agent/ci-stats.mjs`
   - `<REPO>/test/e2e/e2e.test.ts` (và `<REPO>/packages/daemon/src/server.ts` chỉ khi `flake-hunt` tái hiện được race condition)
   - `<REPO>/test/agent/ci-watch-classify.node.test.mjs`
   - `<REPO>/test/agent/ci-stats.node.test.mjs`
   - `<REPO>/docs/CI.md`
6. **Rủi ro:**
   - Lỗi ARM không tất định có thể trả `red=0` trên `flake-hunt.yml` → giảm thiểu bằng cách không suy đoán nguyên nhân khi chưa tái hiện, giữ đầy đủ pipe `diag()` và khóa cảnh báo tự động ở `attempt=1`.
   - Sửa cách gọi `gh` trên Windows trong `ci-stats.mjs` dễ lỗi không tìm thấy `.exe` nếu thiếu đuôi lệnh → kiểm chứng trên cả Windows cục bộ và Linux/macOS/Windows trên PR CI.
7. **Lệnh kiểm chứng:**
   ```sh
   node tools/agent/preflight.mjs
   node --test test/agent/ci-watch-classify.node.test.mjs test/agent/ci-stats.node.test.mjs
   pnpm prepush
   RS_EVIDENCE_DIR=evidence/M1 node tools/agent/capture-evidence.mjs m1-01-ci-stats -- node tools/agent/ci-stats.mjs
   node tools/agent/ci-watch.mjs --sha <head-sha>
   node tools/agent/verify-records.mjs evidence/M1/records.jsonl evidence/M1
   node tools/agent/verify-package.mjs evidence/M1
   node tools/agent/scan-private-names.mjs evidence/m1
   ```

---

### Vé `M1-02` — [P2] Known Issue 1: Hợp nhất model hoạt động từ `combos.data.models` vào `readRouterModelState` của OmniRoute & đồng bộ `apps drift`

1. **Mục tiêu:**
   - Khắc phục triệt để Known Issue 1 trong `docs/known-issues.md`: trong `<REPO>/packages/core/src/domain/model-state.ts`, nhánh `isOmniRoute` (vùng dòng `715–720`) hiện chưa hợp nhất `comboModels` vào `availableModels` khi `!options.excludeComboModelsFromAvailability` (trong khi nhánh `is9Router` dòng `538–542` đã có), dẫn tới DB OmniRoute có model trong `combos.data.models` nhưng trống `syncedAvailableModels` bị trả `availableModels=0` mâu thuẫn với `routersync doctor`.
   - Đồng bộ `<REPO>/packages/cli/src/apps/drift.ts` (vùng dòng `340–392`) để nhánh OmniRoute đối chiếu đầy đủ `view.availableIds`, `view.comboIds` và `view.disabledIds` nhất quán với trạng thái thực, không báo `MISSING` sai cho model hợp lệ của OmniRoute.
2. **Tiêu chí chấp nhận (đỏ trước – xanh sau):**
   - **Đỏ trước:** Tạo unit/integration test trên fixture DB OmniRoute có model hoạt động trong `combos.data.models` và không có `syncedAvailableModels` trong `key_value`, kiểm tra: (i) `readRouterModelState(db)` trả `availableModels.size > 0` khớp tập model trong combo; (ii) `readRouterModelState(db, { excludeComboModelsFromAvailability: true })` vẫn giữ `availableModels.size === 0` để không phá `combos stale`; (iii) `apps drift` phân loại model OmniRoute hợp lệ là `OK` thay vì `MISSING` — xác nhận test **đỏ** trên `c28b7fb`.
   - **Xanh sau:**
     - Bộ test mới và toàn bộ test hiện hữu của `@routersync/core` và `drift` đều xanh.
     - Bất biến của `combos stale` (combo không tự chứng thực độ tươi cho chính nó khi cờ `excludeComboModelsFromAvailability` bật) được giữ nguyên 100%; fixture DB không bị ghi đè (`sha256` không đổi).
     - PR xanh đủ **5 hệ điều hành** trên head cuối, Ops squash-merge, CI `main` `attempt=1` xanh.
3. **Người làm:** **Engineer** (**CTO** duyệt hợp nhất thiết kế ranh giới cờ `excludeComboModelsFromAvailability`; **Ops** chạy `gh pr merge --squash` sau khi QA ký).
4. **Người xác minh độc lập:** **QA** (khác Engineer; kiểm chứng đỏ-trước xanh-sau, kiểm tra không hồi quy `combos stale` và `doctor`, chạy `verify-records.mjs` & `verify-package.mjs`).
5. **Tệp dự kiến:**
   - `<REPO>/packages/core/src/domain/model-state.ts` (vùng dòng `250–298` và `611–730`)
   - `<REPO>/packages/cli/src/apps/drift.ts` (vùng dòng `194–225` và `340–392`)
   - `<REPO>/packages/core/test/model-state-omniroute.test.ts` (hoặc mở rộng `<REPO>/packages/core/test/model-tiers.test.ts`)
   - `<REPO>/packages/cli/test/drift.test.ts`
6. **Rủi ro:**
   - Nếu hợp nhất `comboModels` bất kể cờ `excludeComboModelsFromAvailability`, lệnh `combos stale` sẽ coi mọi bước trong combo OmniRoute là đang sẵn sàng → giảm thiểu bằng bài test bắt buộc cho cả 2 giá trị của cờ.
   - Dữ liệu JSON `combos.data.models` dị dạng (chuỗi rỗng, phần tử null, object thiếu tên model) → xử lý phòng vệ, bỏ qua mục hỏng không ném ngoại lệ.
7. **Lệnh kiểm chứng:**
   ```sh
   node tools/agent/preflight.mjs
   pnpm test:changed
   pnpm prepush
   RS_EVIDENCE_DIR=evidence/M1 node tools/agent/capture-evidence.mjs m1-02-omniroute -- pnpm lint
   node tools/agent/ci-watch.mjs --sha <head-sha>
   node tools/agent/verify-records.mjs evidence/M1/records.jsonl evidence/M1
   node tools/agent/verify-package.mjs evidence/M1
   node tools/agent/scan-private-names.mjs evidence/m1
   ```

---

### Vé `M1-03` — [P2] Known Issue 2: Bổ sung tập `comboNames` vào `RouterModelState` & nhánh phân loại của `apps drift`, cập nhật `docs/known-issues.md`

1. **Mục tiêu:**
   - Khắc phục triệt để Known Issue 2 trong `docs/known-issues.md`: xuất tập `comboNames: Set<string>` rõ ràng từ `readRouterModelState` (`@routersync/core`) và cập nhật hàm `classifyModelDrift` trong `<REPO>/packages/cli/src/apps/drift.ts` (vùng dòng `285–407`) để đối chiếu `view.comboNames` (cho cả tên trần `9Router-Coder-1`, `OmniRoute-Coder-1` và dạng có tiền tố router `9router/9Router-Coder-1`), trả về `status: 'OK'` với `kind: 'combo'` thay vì rơi xuống `MISSING`.
   - Cập nhật `<REPO>/docs/known-issues.md` để ghi nhận cả Known Issue 1 (`M1-02`) và Known Issue 2 (`M1-03`) đã được giải quyết kèm tham chiếu test kiểm chứng.
2. **Tiêu chí chấp nhận (đỏ trước – xanh sau):**
   - **Đỏ trước:** Viết bài test tái hiện ứng dụng (`hermes`, `dsh`, `opencode`) trỏ tới tên combo `9Router-Coder-1` và `OmniRoute-Coder-1` (cả có tiền tố lẫn không tiền tố) và ca âm tính (`9Router-Khong-Ton-Tai` vẫn phải là `MISSING`) — xác nhận test **đỏ** trên `c28b7fb` (do hiện trả `MISSING`).
   - **Xanh sau:**
     - Mọi tham chiếu tới tên combo tồn tại trên 9Router hoặc OmniRoute đều trả `status: 'OK'`, `kind: 'combo'`; tên combo không tồn tại vẫn trả `status: 'MISSING'`; không ảnh hưởng tới `apps drift-model` (OpenMausBot) đã có từ C41.
     - `docs/known-issues.md` được cập nhật đúng thực trạng và vượt qua `test/docs/`.
     - PR xanh đủ **5 hệ điều hành** trên head cuối, Ops squash-merge, CI `main` `attempt=1` xanh; gói `evidence/m1` sạch toàn bộ verifier.
3. **Người làm:** **Engineer** (**CTO** duyệt thay đổi kiểu `RouterModelState`; **PM** rà soát `docs/known-issues.md`; **Ops** chạy `gh pr merge --squash` sau khi QA ký).
4. **Người xác minh độc lập:** **QA** (khác Engineer; kiểm chứng đỏ-trước xanh-sau trên cả 9Router & OmniRoute fixture, đối chiếu `docs/known-issues.md`, chạy `verify-records.mjs` & `verify-package.mjs`).
5. **Tệp dự kiến:**
   - `<REPO>/packages/core/src/domain/model-state.ts`
   - `<REPO>/packages/cli/src/apps/drift.ts`
   - `<REPO>/packages/cli/test/drift.test.ts`
   - `<REPO>/packages/cli/test/apps-drift-y2.test.ts`
   - `<REPO>/docs/known-issues.md`
6. **Rủi ro:**
   - Xung đột khi tên combo trùng tên một model đơn đã bị `DISABLED` hoặc khác biệt cắt tiền tố provider → định nghĩa rõ thứ tự ưu tiên đối chiếu `comboNames` và phủ test cả 2 dạng định danh.
7. **Lệnh kiểm chứng:**
   ```sh
   node tools/agent/preflight.mjs
   pnpm test:changed
   pnpm prepush
   RS_EVIDENCE_DIR=evidence/M1 node tools/agent/capture-evidence.mjs m1-03-combonames -- pnpm lint
   node tools/agent/ci-watch.mjs --sha <head-sha>
   node tools/agent/verify-records.mjs evidence/M1/records.jsonl evidence/M1
   node tools/agent/verify-package.mjs evidence/M1
   node tools/agent/scan-private-names.mjs evidence/m1
   ```

---

## Cột mốc M2 — Phase 3 S2: Grant Lifecycle (`ADR-MAINTAIN-02`), Outbound Webhook & Đọc lại Đường Phục vụ (P3)
- **Gói bằng chứng đích:** Nhánh `evidence/m2` (`evidence/M2/`, `[skip ci]`, không PR, không merge, tối đa 10 tệp).
- **Điều kiện mở khóa M2:** Chỉ bắt đầu viết mã sau khi cổng M1 (`evidence/m1`) đạt trạng thái `XONG` và CTO duyệt thiết kế từng vé.

---

### Vé `M2-01` — [P3.1] Kiểm chứng toàn diện & khép kín vòng đời Grant theo `ADR-MAINTAIN-02` và trao đổi Approval Token tương tác

1. **Mục tiêu:**
   - Đối chiếu mã đã có trong `<REPO>/packages/cli/src/maintain/grant.ts`, `<REPO>/packages/cli/src/commands/maintain.ts` (`authorize`, `grant-status`, `revoke-grant`, `secret-selftest`, `validateGrantFile`, `checkGrantScope`) và luồng approval token phía daemon (`packages/daemon/src/handlers/approval.ts`, `packages/daemon/src/security/approval-token.ts`) với toàn bộ yêu cầu của `ADR-MAINTAIN-02` để lấp kín mọi khe hở kiểm tra hoặc thông điệp lỗi chưa khớp đặc tả.
   - Xây dựng bộ test hợp đồng tự động đầy đủ cho vòng đời grant & approval token tương tác, đồng thời cập nhật `docs/adr/ADR-MAINTAIN-02-apply-grant-lifecycle.md` (xóa tham chiếu lỗi thời tới `tools/maintain/test-apply-grant.mjs` không tồn tại, trỏ tới bộ test Vitest thật chạy trên 5 OS) và giữ nguyên tuyên bố trung thực về giới hạn PTY ở mục 4.
2. **Tiêu chí chấp nhận (đỏ trước – xanh sau):**
   - **Đỏ trước:** Viết bộ test kiểm tra toàn bộ ma trận từ chối & vòng đời (`no-tty`, `yes-flag`, `only-pattern` `^test-\d+(,test-\d+)*$`, `hours-range` `1..8`, `agents-invalid`, `grant-invalid`, `grant-expired`, `grant-scope`, thu hồi `revoke-grant`, dùng lại approval token một lần / hết hạn / sai chữ ký, không rò rỉ khóa HMAC ra stdout/stderr) và test tài liệu kiểm tra đường dẫn tệp test nêu trong `ADR-MAINTAIN-02` phải tồn tại thật — xác nhận test **đỏ** trước khi cập nhật mã & ADR.
   - **Xanh sau:**
     - Toàn bộ bộ test vòng đời grant & approval token xanh trong môi trường kín (`os.tmpdir()`), không thêm cờ bypass `--yes`, không chạm router thật.
     - `ADR-MAINTAIN-02` khớp 100% đường dẫn tệp test thật và giữ nguyên mục 4 về giới hạn PTY.
     - PR xanh đủ **5 hệ điều hành** trên head cuối, Ops squash-merge, CI `main` `attempt=1` xanh.
3. **Người làm:** **Engineer** (**CTO** duy nhất hợp nhất thiết kế contract; **Ops** chạy `gh pr merge --squash` sau khi QA ký).
4. **Người xác minh độc lập:** **QA** (khác Engineer; audit độc lập các đường biên từ chối bảo mật và chạy `verify-records.mjs` & `verify-package.mjs`).
5. **Tệp dự kiến:**
   - `<REPO>/packages/cli/src/maintain/grant.ts`
   - `<REPO>/packages/cli/src/commands/maintain.ts`
   - `<REPO>/packages/daemon/src/handlers/approval.ts`
   - `<REPO>/packages/daemon/src/security/approval-token.ts`
   - `<REPO>/packages/cli/test/maintain-grant-lifecycle.test.ts`
   - `<REPO>/test/acceptance/at-165-daemon-threat-model-approval.test.ts`
   - `<REPO>/test/docs/agent-docs.test.ts`
   - `<REPO>/docs/adr/ADR-MAINTAIN-02-apply-grant-lifecycle.md`
6. **Rủi ro:**
   - Khác biệt kiểm tra `process.stdin.isTTY` trên runner CI Windows/Linux/macOS → tiêm trừu tượng luồng TTY trong test thay vì phụ thuộc PTY hệ điều hành.
   - Rò rỉ chuỗi bí mật HMAC hoặc token trong thông báo lỗi → có assertion quét sạch stdout/stderr trong mọi ca lỗi.
7. **Lệnh kiểm chứng:**
   ```sh
   node tools/agent/preflight.mjs
   pnpm test:changed
   pnpm prepush
   RS_EVIDENCE_DIR=evidence/M2 node tools/agent/capture-evidence.mjs m2-01-grant -- pnpm lint
   node tools/agent/ci-watch.mjs --sha <head-sha>
   node tools/agent/verify-records.mjs evidence/M2/records.jsonl evidence/M2
   node tools/agent/verify-package.mjs evidence/M2
   node tools/agent/scan-private-names.mjs evidence/m2
   ```

---

### Vé `M2-02` — [P3.2] Hoàn thiện Outbound Webhook gửi thông báo cảnh báo hành động (dùng đích giả trong test)

1. **Mục tiêu:**
   - Nâng cấp đoạn gửi webhook thô 12 dòng tại `<REPO>/packages/cli/src/commands/tick.ts:1165–1177` thành mô-đun thông báo outbound webhook hoàn chỉnh cho các cảnh báo cần hành động (đề xuất mới trong inbox, model ngừng/sắp ngừng hoạt động, cảnh báo xác minh cần người xem xét), hỗ trợ cấu hình hợp lệ trong schema + biến môi trường, kiểm tra scheme URL an toàn (`http`/`https`), áp timeout cứng, lọc sạch mọi bí mật/đường dẫn cá nhân/tên riêng, và xử lý lỗi kiểu non-fatal.
   - Viết bộ test tự động hoàn chỉnh sử dụng **đích HTTP giả cục bộ (`127.0.0.1` cổng ngẫu nhiên)** — tuyệt đối không gọi ra Internet và tốn `0` token LLM.
2. **Tiêu chí chấp nhận (đỏ trước – xanh sau):**
   - **Đỏ trước:** Lập bộ test `webhook-notify.test.ts` với máy chủ HTTP giả cục bộ kiểm chứng 5 kịch bản: (i) nhận đúng JSON payload chuẩn khi phát sinh cảnh báo hành động; (ii) không gửi khi không có cảnh báo hoặc chưa cấu hình webhook; (iii) từ chối URL không hợp lệ (`file://`, `ftp://`, chuỗi rỗng); (iv) đích giả trả `500` hoặc treo quá timeout → lệnh chính vẫn thoát sạch (non-fatal) và ghi nhận trạng thái gửi thất bại trung thực; (v) payload không chứa key, đường dẫn cá nhân hay tên riêng — xác nhận **đỏ** trên `c28b7fb`.
   - **Xanh sau:**
     - Toàn bộ bộ test webhook với đích giả xanh trên đủ **5 hệ điều hành** trong CI và vượt qua guard hermetic (`at-127`, `at-170`).
     - PR xanh đủ **5 hệ điều hành** trên head cuối, Ops squash-merge, CI `main` `attempt=1` xanh.
3. **Người làm:** **Engineer** (**CTO** duyệt schema payload & quy tắc kiểm URL; **Ops** chạy `gh pr merge --squash` sau khi QA ký).
4. **Người xác minh độc lập:** **QA** (khác Engineer; xác minh test dùng 100% đích giả cục bộ, kiểm tra lọc dữ liệu nhạy cảm, chạy `verify-records.mjs` & `verify-package.mjs`).
5. **Tệp dự kiến:**
   - `<REPO>/packages/core/src/notify/webhook.ts` (hoặc mô-đun thông báo dùng chung)
   - `<REPO>/packages/cli/src/commands/tick.ts`
   - `<REPO>/packages/cli/src/config/schema.ts`
   - `<REPO>/packages/daemon/src/loop/fast-loop.ts`
   - `<REPO>/packages/cli/test/webhook-notify.test.ts`
   - `<REPO>/packages/daemon/test/daemon.test.ts`
6. **Rủi ro:**
   - Môi trường chạy test có sẵn biến `ROUTERSYNC_WEBHOOK_URL` làm rò request ra ngoài → xóa/cô lập biến môi trường trong từng test case và ràng buộc guard mạng cục bộ.
   - Treo socket làm chậm test → dùng `AbortSignal.timeout` ngắn trong test và đóng server giả trong `afterEach`.
7. **Lệnh kiểm chứng:**
   ```sh
   node tools/agent/preflight.mjs
   pnpm test:changed
   pnpm prepush
   RS_EVIDENCE_DIR=evidence/M2 node tools/agent/capture-evidence.mjs m2-02-webhook -- pnpm lint
   node tools/agent/ci-watch.mjs --sha <head-sha>
   node tools/agent/verify-records.mjs evidence/M2/records.jsonl evidence/M2
   node tools/agent/verify-package.mjs evidence/M2
   node tools/agent/scan-private-names.mjs evidence/m2
   ```

---

### Vé `M2-03` — [P3.3] Xác minh đọc lại đường phục vụ (Serving-Path Read-Back) trên cả 9Router và OmniRoute

1. **Mục tiêu:**
   - Khắc phục chỗ lệch phát hiện ở M0.2 trong `<REPO>/packages/cli/src/commands/maintain.ts` (dòng `793, 1015–1034` hiện mới đọc lại SQLite DB rồi in cứng `READBACK ok=yes`) và chuẩn hóa hợp đồng đọc lại đường phục vụ HTTP trên **cả hai router (`adapter-9router` và `adapter-omniroute`)** xuyên suốt `applier`, `maintain`, `status` và daemon `targets`.
   - Đảm bảo báo cáo trung thực `ReadBackLevel` (`api-verified`, `existence-only`, `db-only`) kèm `degradedReason` khi đường phục vụ phản ánh ngay, phản ánh trễ trong hạn `servingWaitMs`, hết hạn chờ (`staleDetected`), hoặc không kết nối được HTTP; cập nhật dấu hoàn tất S2 trong `docs/ROADMAP.md` sau khi đóng đủ P3.1–P3.3.
2. **Tiêu chí chấp nhận (đỏ trước – xanh sau):**
   - **Đỏ trước:** Viết bộ test hợp đồng đối xứng cho **cả 9Router và OmniRoute** trên `fake-router.ts` + fixture SQLite DB kiểm tra: (i) `maintain apply`/`create` và `applier` thực sự gọi xác minh đường phục vụ HTTP thay vì in cứng `READBACK ok=yes` khi HTTP trả dữ liệu cũ hoặc lỗi `503`; (ii) đủ 5 kịch bản (khớp ngay, khớp sau vài nhịp poll trong `servingWaitMs`, quá hạn `staleDetected`, mất kết nối suy giảm về `db-only` có lý do, và chế độ cô lập không gọi mạng) — xác nhận **đỏ** trên `c28b7fb`.
   - **Xanh sau:**
     - Toàn bộ bộ test đọc lại đường phục vụ trên cả 9Router và OmniRoute xanh (`0` cuộc gọi tới cổng `20128`/`30128` thật; toàn bộ test hermetic `at-98`, `at-113`, `at-127`, `at-157` xanh).
     - PR xanh đủ **5 hệ điều hành** trên head cuối, Ops squash-merge, CI `main` `attempt=1` xanh; gói `evidence/m2` đạt sạch mọi verifier.
3. **Người làm:** **Engineer** (**CTO** duy nhất hợp nhất hợp đồng `ReadBackLevel` giữa 2 adapter, `applier` và `maintain`; **Ops** chạy `gh pr merge --squash` sau khi QA ký).
4. **Người xác minh độc lập:** **QA** (khác Engineer; kiểm chứng đối xứng trên cả 9Router & OmniRoute fake router, xác nhận 0 truy cập router thật, chạy `verify-records.mjs` & `verify-package.mjs`).
5. **Tệp dự kiến:**
   - `<REPO>/packages/adapter-9router/src/index.ts`
   - `<REPO>/packages/adapter-omniroute/src/index.ts`
   - `<REPO>/packages/core/src/applier/index.ts`
   - `<REPO>/packages/cli/src/commands/maintain.ts`
   - `<REPO>/packages/cli/src/commands/status.ts`
   - `<REPO>/packages/daemon/src/handlers/targets.ts`
   - `<REPO>/test/harness/fake-router.ts`
   - `<REPO>/packages/adapter-9router/test/ninerouter.test.ts`
   - `<REPO>/packages/adapter-omniroute/test/omniroute.test.ts`
   - `<REPO>/packages/cli/test/maintain-readback.test.ts`
   - `<REPO>/docs/ROADMAP.md`
6. **Rủi ro:**
   - Hạn chờ mặc định `servingWaitMs` (`60 s`) làm chậm test nếu dùng giá trị mặc định → truyền `servingWaitMs` ngắn (vài trăm ms) trong test giả lập, giữ nguyên mặc định sản phẩm.
   - Khác biệt phản hồi giữa `/v1/models` của 9Router và `/api/combos` + `/v1/models` của OmniRoute → CTO khóa bảng ánh xạ `ReadBackLevel` thống nhất trước khi lập mã.
7. **Lệnh kiểm chứng:**
   ```sh
   node tools/agent/preflight.mjs
   pnpm test:changed
   pnpm prepush
   RS_EVIDENCE_DIR=evidence/M2 node tools/agent/capture-evidence.mjs m2-03-readback -- pnpm lint
   node tools/agent/ci-watch.mjs --sha <head-sha>
   node tools/agent/verify-records.mjs evidence/M2/records.jsonl evidence/M2
   node tools/agent/verify-package.mjs evidence/M2
   node tools/agent/scan-private-names.mjs evidence/m2
   ```

---

## Cột mốc M3, M4, M5 — ĐỂ TRỐNG CÓ LÝ DO (Theo Mục 8.3)

Chưa tạo vé chi tiết cho **M3 (Đóng gói & Tài nguyên thấp)**, **M4 (Tài liệu & Bảo mật)** và **M5 (Cổng phát hành)** ở vòng lập kế hoạch C42 vì 4 lý do sau:

1. **Tuân thủ Mục 8.3 & chống phình phạm vi sớm:** Tách vé trước nhiều cột mốc khi mã nguồn M1–M2 chưa hợp nhất sẽ dẫn tới giả định sai về tệp sửa đổi và phát sinh vé thừa ngoài phạm vi.
2. **Cần dữ liệu vận tốc thực tế từ M1–M2:** Hiện số request LLM/vé và số phiên thực tế đang là `CHƯA ĐO`; việc chia cỡ vé M3–M4 sẽ chính xác hơn sau khi COO và PM thu được số đo thực từ `evidence/m1` và `evidence/m2`.
3. **Phép đo P4 & P5 ở M3 phụ thuộc nền mã sau khi đóng S2 (M2):** Đo lặp khởi động lạnh, bộ nhớ rảnh có phương sai và kiểm chứng tarball 5 OS phải thực hiện trên mã nguồn đã có đầy đủ tính năng Phase 3 S2 để không phải đo lại hai lần.
4. **M4 phụ thuộc trạng thái cuối của M1–M3 và M5 thuộc thẩm quyền Chủ dự án:** Tài liệu (P6) & kiểm toán bảo mật cuối (P7) chốt trên bản ứng viên hoàn chỉnh, còn cổng phát hành npm ở M5 do Chủ dự án trực tiếp quyết định và thực hiện.
