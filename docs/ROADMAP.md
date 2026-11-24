# RouterSync Roadmap

> Strategic architecture roadmap and delivery phases for RouterSync — aligned to the canonical C45 specification (`docs/SPEC.md`, `S1`–`S10`) targeting **`1.0.0`** (with `0.1.0` designated as an unreleased read-only diagnostic snapshot).

---

## Phase 1: Core Engine & Deterministic Foundation (Completed)
- [x] **Invariants I1–I8 Enforcement:**
  - I1: No fake/non-existent models in managed combos.
  - I2: Quarantined/dead models never enter top-N.
  - I3: Combos maintain minimum step counts (`minSteps`, default 2).
  - I4: Idempotent apply operations.
  - I5: Unmanaged and user-configured combos are never modified.
  - I6: FreeOnly combos never contain metered or unknown-tier models.
  - I7: Multi-provider redundancy (minimum 2 independent providers per combo).
  - I8: Strict write sequencing: Providers -> Models -> Combos -> Default slots.
- [x] **Dual Router Adapters:**
  - OmniRoute adapter with serving-path API reflection.
  - 9Router adapter with SQLite DB snapshotting and schema-fingerprint verification.
- [x] **Deterministic Planning:**
  - Zero LLM tokens required for diff calculation and dry-run synchronization plans.

---

## Phase 2: Live Verification & Discovery Ladder (Completed)
- [x] **Verification Ladder (L1 -> L2 -> L3):**
  - **L1:** Direct upstream provider model listing and status checks without inference calls.
  - **L2:** Secondary catalog cross-verification (`openrouter.ai`, `models.dev`, `litellm`) with TTL caching and ETag support. Live GET on 2026-11-12: 466 OpenRouter entries (20 with `expiration_date`, 0 with `deprecation_date`), 5,895 LiteLLM entries, 235 `models.dev` providers.
  - **L3:** Structured deprecation notice tracking across official provider documentation. Live GET on 2026-11-12 returned HTTP 200 for all 9 declared sources and yielded **≥210 notices total** (the count is truncated at the source page size; per-source: `openai-deprecations` 60 (35 model ids), `anthropic-deprecations` 60 (40), `groq-deprecations` 53 (40), `gemini-deprecations` 20 (7 ids, 0 dated), `openrouter-changelog` 17 (0 ids, 0 dated), plus remaining sources below the visible cutoff). The two zero-yield fields are reported as a limitation rather than treated as "no deprecations".
- [x] **Canonical Verification Labels:**
  - `ĐÃ-XÁC-NHẬN-CÒN`, `ĐÃ-XÁC-NHẬN-NGỪNG`, `SẮP-NGỪNG`, `NGHI-NGỪNG`, `CHƯA-XÁC-MINH`, `QUOTA`, `CHƯA-QUÉT`, `QUOTA-NO-LIST`.
- [x] **ABSENT-STABLE Qualification:**
  - Multi-cycle absence requirements, external catalog corroboration, and <= 10% combo shrink ceiling.
- [x] **Ranking Engine & Blacklist:**
  - Preference-based model interleaving, trait filtering, and regex-based blacklist patterns.

---

## Phase 3: Daemon, Fast Loop & Scoped Human-Gated Writes (Completed)
- [x] **S1 Slice: Read-Only Daemon Observation:**
  - Background `tick` cycle with 15-minute gatekeeper.
  - Automatic `runVerifyPhase` integration at cycle end with zero additional network requests.
  - Persistent `verify-status.json` and unified request accounting (`paidRequests=0`, `tokens=0`).
  - Inbox proposal and alert generation for newly discovered or deprecating models.
  - Read-only MCP server with 24 tools, each one reading a real state file, ledger, schema or documentation tree; a tool reports `missing`/`INVALID_JSON` instead of inventing a value.
- [x] **S2 Slice: Grant Lifecycle, HMAC Approval Tokens & Honest Read-Back (`M1`–`M2`, `W2`):**
  - Scoped `GrantFile` (`ROUTERSYNC_GRANT_SECRET` scrypt + HMAC-SHA256) and non-TTY refusal gates (`docs/adr/ADR-MAINTAIN-02-apply-grant-lifecycle.md`).
  - Daemon single-use HMAC-SHA256 `ApprovalToken` (`<nonceHex>.<sigHex>`), `planHash` binding, and loopback `Origin` allowlist (`docs/security/daemon-threat-model.md`).
  - Outbound webhook notifications for actionable inbox alerts.
  - Honest serving-path read-back verification (`live-api` vs `db-only (degraded)`) across active routers.
  - Client-side probe `RequestBudget`, `SKIPPED-QUOTA`, and `reconcileSentVsUsage` (`packages/cli/src/commands/combos-budget.ts`) independent of missing `9router@0.5.123` `stream=true` `usageHistory` rows.

---

## Phase 4: `0.1.0` Read-Only Diagnostic Snapshot Hardening (Completed — Unreleased)
> **Trạng thái `0.1.0`:** Bản `0.1.0` được định danh là **bản chẩn đoán chỉ đọc (Read-Only Diagnostic Snapshot — không phát hành lên npm)**. Theo quyết định của chủ dự án trong chương trình C45 (`docs/SPEC.md`, `docs/RELEASE-CANDIDATE.md`), dự án bỏ qua phát hành `0.1.0` và đi thẳng tới phát hành **`1.0.0`** sau khi hoàn tất đầy đủ đặc tả `S1`–`S10` và vượt qua thí điểm chạy thật ở `WP9` (có tùy chọn đưa `1.0.0-rc.1` lên dist-tag `next` sau `WP9`).

- [x] **5-OS Tarball Hygiene, Resource Variance & Multi-Surface Security Audit (`M3`–`M4`):**
  - Automated publishable tarball allowlist, `npm publish --dry-run`, and clean-install CLI smoke across 5 OS runners (`tools/agent/pack-verify.mjs`).
  - 5-run RSS/wall-clock variance harness (`tools/agent/resource-variance.mjs`) and SQLite driver evaluation (`docs/adr/ADR-SQLITE-01-better-sqlite3-vs-node-sqlite.md`, retaining `better-sqlite3` pending owner decision in `chờ chủ dự án`).
  - Multi-surface security auditor and programmatic router write-gate checklist (`tools/agent/security-audit.mjs`, `SECURITY.md`).
- [x] **1.0.0 Release Preparation Tooling (`WP0`):**
  - Release target specification and checklist in `docs/RELEASE-CANDIDATE.md` plus dry-run-by-default workspace version helper (`tools/release/prepare-v1-release.mjs`) ready for owner-executed `1.0.0-rc.1` / `1.0.0` release (always pushing an explicit single tag such as `git push origin v1.0.0`).
- [ ] Multi-OS verification on physical macOS and Linux hardware (5-OS GitHub Actions CI matrix — `ubuntu-latest`, `ubuntu-24.04-arm`, `macos-latest`, `windows-latest`, `windows-11-arm` — is active; physical macOS/Linux validation remains open).

---

## Phase 5: Full-Spec `1.0.0` Multi-Harness & Controlled `auto-safe` Automation (Active Primary Workstream — C45 `WP0`–`WP9`)
> **Trọng tâm hiện tại:** Phase 5 và chế độ `auto-safe` không còn nằm trong danh sách hoãn sau v1; đây là luồng công việc chính để đạt đặc tả `S1`–`S10` trong `docs/SPEC.md` và danh sách vé `docs/BACKLOG.md` trước khi phát hành `1.0.0`. Mọi thao tác ghi ở bất kỳ bậc nào đều giữ bất biến `backup -> atomic write -> read-back -> auto-rollback`.

- [x] **`WP0` (`S10`):** Ban hành `docs/SPEC.md` nguyên văn `S1`–`S10`, bảng khoảng trống có dẫn `file:line`, cập nhật `docs/ROADMAP.md`, `docs/RELEASE-CANDIDATE.md`, `CHANGELOG.md`, `docs/BACKLOG.md` và `tools/release/prepare-v1-release.mjs`.
- [ ] **`WP1` (`S2, S3, S6`):** Ma trận năng lực harness có kiểm chứng bậc A/B/C (Hermes, Claude Code, Codex, Antigravity, OpenCode, Cursor, Grok bot, OpenMausBot) làm nguồn dữ liệu chung cho `routersync mcp install` và `routersync schedule install`.
- [ ] **`WP2` (`S3`):** Adapter ghi đầy đủ cho harness (`inspect`, `plan`, `apply`, `rollback`, `read-back`) đối với các harness có tệp cấu hình sửa được ở bậc A/B — chỉ sửa danh sách model của provider đã có key, bảo toàn chú thích/định dạng (YAML, TOML, JSONC) với test khứ hồi bảo toàn byte.
- [ ] **`WP3` (`S1, S3, S7`):** Vòng nghiên cứu thời gian thực 2 tầng: Tầng 0 chạy định kỳ 0-token (L1/L2/L3 + changelog chính thức); Tầng 1 agent harness dùng tìm kiếm web nộp bằng chứng qua công cụ MCP mới `submit_research` (kiểm miền nguồn chính chủ, không ghi trực tiếp router/harness, trần co 10%, ghi độ trễ phát hiện).
- [ ] **`WP4` (`S3, S4, S9`):** Tự động hóa có kiểm soát: sự đồng ý đứng (`standing consent`, mặc định 30 ngày) thay thế giới hạn cứng `^test-\d+$`, công cụ MCP `apply_plan` gắn `planHash`, chế độ 3 bậc theo mục tiêu (`propose` / `auto-safe` / `off`, yêu cầu 1 lần áp `propose` + read-back khớp trước khi lên `auto-safe`), lệnh khóa ghi khẩn cấp `freeze`, mở rộng `routersync status` hiển thị bậc từng mục tiêu, và phủ test tự động cho đường hoàn tác trên bản sao tạm.
- [ ] **`WP5` (`S4`):** Bộ chọn chiến lược routing và combo cá nhân hóa từ hồ sơ người dùng và khả năng từng router (`list_strategies`), xếp bước theo độ ổn định đo được (trần 12–15 bước, loại HANG/DEAD, xen kẽ provider), cùng adapter LiteLLM hoàn chỉnh (hoặc ghi rõ bằng chứng giới hạn nếu để lại xuất tệp).
- [ ] **`WP6` (`S5`):** Kịch bản phỏng vấn thích ứng tối đa 12 câu (phát hành dạng MCP prompt/skill và hướng dẫn theo từng harness), dùng ví dụ đời thường cho người không rành kỹ thuật, ghi rõ giả định vào `profile.yaml`, không bịa dữ liệu hồ sơ.
- [ ] **`WP7` (`S6`):** Thang lịch chạy 4 bậc theo từng harness: (1) cron gốc không qua LLM → (2) bộ lập lịch hệ điều hành qua `routersync schedule install` (kiểm thử chạy khô CI 5 OS) → (3) tick theo yêu cầu qua MCP `tick_if_due` (cổng 15 phút, khóa tệp) → (4) daemon; nâng cấp `routersync doctor` báo bậc đang dùng và cảnh báo khi tick cũ hơn 2× chu kỳ.
- [ ] **`WP8` (`S7`):** Sổ cái token phân tách `tick` (`tokens=0` + số request mạng theo miền) với phiên nghiên cứu agent (số lượt gọi công cụ, lượng văn bản, trần tuần), công cụ MCP `cost_report`, và kiểm thử chứng minh mã sản phẩm 0 lời gọi LLM.
- [ ] **`WP9` (`S9`):** Sẵn sàng chạy thật: tài liệu vận hành thí điểm chạy thật v2 và công cụ `live-check` kiểm tra tiền điều kiện, quy trình chọn 1 combo + 1 tệp harness thí điểm qua `propose` → `auto-safe`, cùng 5 tiêu chí đạt đo được; đội dừng ở trạng thái sẵn sàng chờ chủ dự án tự chạy thật và tự thực hiện phát hành `1.0.0` (hoặc `1.0.0-rc.1` trên `next`).

---

## Hoãn sau 1.0.0 (Deferred Post-1.0.0)

Các mục dưới đây không nằm trong phạm vi cốt lõi `S1`–`S10` của bản `1.0.0` và được tách riêng để tránh scope creep (lưu ý: **hệ sinh thái adapter harness**, **chế độ `auto-safe` có kiểm soát**, và **kiểm thử tự động đường hoàn tác** đã được đưa lên **Phase 5 — công việc chính cho `1.0.0`**):

- **G5 — GUI đọc trạng thái:** Web UI đọc `status.json` và `inbox.json` ở chế độ xem (không ghi). Đã có skeleton; hoàn thiện sau `1.0.0`.
- **G6 — BYOK Encrypted Key Bypass:** Biến môi trường `ROUTERSYNC_KEY_<PREFIX>` cho provider có cờ `key-encrypted`. Chờ thiết kế bảo mật.
- **Lịch BYOK qua web:** Cho phép chủ cấu hình lịch quét qua giao diện web, không phải chỉnh file thủ công.
- **Hợp nhất catalog:** `scan` và `tick` hiện dùng nguồn catalog riêng; thống nhất thành một pipeline duy nhất.
- **Định dạng ngày trong L3:** `gemini-deprecations` và `openrouter-changelog` trả thông báo nhưng không kèm ngày; cần chuẩn hóa trước khi dùng để tính hạn ngừng.
- **Đồng bộ phân tán đa gateway:** Edge router synchronization across distributed gateways.

---

## Biết trước (các vấn đề đã xác định trên nền `0.1.0` — bản chẩn đoán chỉ đọc)

- **Đề xuất model mới chưa loại theo nhãn:** Đường `tick` chỉ lọc đề xuất `NEW-CANDIDATE` theo blacklist; nó không loại các model đã gắn nhãn `QUOTA` hoặc `SẮP-NGỪNG`. Nhãn `QUOTA`/`SẮP-NGỪNG` hiện chỉ được áp dụng ở đường `verify` (`packages/cli/src/verify/verifier.ts`), nên một model đang bị giới hạn lượt hoặc sắp ngừng vẫn có thể được đề xuất thêm vào combo.
- **9Router chỉ ghi lại request thành công (và đường `stream=true` trên `0.5.123` có thể thiếu dòng `usageHistory`):** Bảng `usageHistory` của 9Router chỉ có các request thành công và trên `9router@0.5.123` các request `stream=true` thường không ghi dòng mới (đã được giảm thiểu phía client cho `combos probe` ở vòng `W2` qua `RequestBudget` và `reconcileSentVsUsage`; xem `docs/known-issues.md`). OmniRoute có bảng `call_logs` kèm mã trạng thái nên hiển thị được tỷ lệ thành công.
- **Đường dẫn database của 9Router trên macOS và Linux có nguồn tài liệu, chưa được kiểm chứng trên máy thật:** Đường dẫn Windows (`%APPDATA%\9router\db\data.sqlite`) lấy từ `docs/adapters/9router.md`; đường dẫn macOS/Linux (`~/.9router/db/data.sqlite`) dựa trên hai nguồn độc lập (2026-11-13): (1) tài liệu cài đặt `deepwiki.com/decolua/9router/2.1-installation` (dữ liệu ở `~/.9router` trên macOS/Linux, `%APPDATA%\9router` trên Windows; DB chính `${DATA_DIR}/db/data.sqlite`; `DATA_DIR` ghi đè); (2) mã nguồn 9Router `cli/hooks/sqliteRuntime.js` (win32 -> `%APPDATA%\9router`, khác -> `~/.9router`, `if (process.env.DATA_DIR) return process.env.DATA_DIR`). CI kiểm thử trên năm môi trường hệ điều hành. Người dùng có thể ghi đè bằng `ROUTERSYNC_9ROUTER_DB` hoặc khai báo `db.path` trong `routersync.yaml`.
- **Hai thư mục trạng thái riêng biệt cho `sync` và `tick`:** Hiện tại `tick` dùng `~/.routersync` còn `sync` dùng thư mục trạng thái nền tảng (`%LOCALAPPDATA%\routersync` trên Windows, `$XDG_STATE_HOME/routersync` trên macOS/Linux). Hai thư mục này sẽ được gộp thống nhất ở vòng sau.
- **Bảo vệ HTTP trong scanner nhà cung cấp so với safe-http (Phase 0):** `packages/cli/src/sync/providers.ts` hiện có 7 cơ chế bảo vệ: (1) phương thức `GET` duy nhất; (2) timeout qua `AbortSignal.timeout` (10s/15s); (3) trần model tối đa (`SCAN_MAX_MODELS = 5000`); (4) trần phân trang tối đa (`SCAN_MAX_PAGES = 20`); (5) trần kích thước phản hồi mỗi trang (`SCAN_MAX_BYTES_PER_PAGE = 10 MiB`); (6) chặn liên kết phân trang dẫn tới inference endpoint (`FORBIDDEN_INFERENCE_PATH_PATTERN`); (7) không log/in secret hoặc API token. Các biện pháp mở rộng (chặn chuyển hướng cross-host redirect sang mạng nội bộ, lọc SSRF dải IP riêng tư `10.0.0.0/8`, `192.168.0.0/16`, `169.254.169.254`, và allowlist host cứng) chưa được áp dụng cho toàn bộ provider tùy biến bởi người dùng, và được tiếp tục siết chặt trong vòng `WP3`/`WP8`.
- **Phủ test tự động cho đường hoàn tác (`routersync undo` / `rollback`):** Lệnh khôi phục từ bản sao lưu trên nền `0.1.0` trước đây thiếu test tự động; trong Phase 5 (`WP2`, `WP4`, `WP9`), đường hoàn tác khôi phục khớp từng byte là tiêu chí bắt buộc trên bản sao tạm cho cả router và harness.
- **Chưa kiểm chứng trên máy macOS và Linux vật lý:** Bằng chứng đa nền tảng hiện gồm mã không giả định nền tảng, test mô phỏng win32/darwin/linux trên một máy, và ma trận CI năm môi trường hệ điều hành. Xem mục Phase 4.

---

## K8: Repo tự mô tả cho AI Agent (tiến trình chuyển giao sang Phase 5)

Các mục dưới đây được kế hoạch từ K8 và tích hợp trực tiếp vào chuỗi gói việc Phase 5 (`WP1`–`WP9`):

- **Bộ chuyển đổi cho ứng dụng AI Agent:** Khởi đầu bằng chế độ chỉ đọc qua `packages/adapter-sdk` (`0.1.0`), nay mở rộng thành ma trận năng lực (`WP1`) và adapter ghi có hoàn tác (`WP2`) cho các harness sửa được cấu hình.
- **Kênh cập nhật:** Thông báo bản mới trong `inbox` qua `tick`, phát hành theo thẻ phiên bản.
- **Bộ kiểm thử ngẫu nhiên cho đường ghi:** Kế hoạch ngẫu nhiên trên bản sao database tạm, kiểm tra các bất biến và hoàn tác khôi phục đúng từng byte (`WP4`/`WP9`).
- **Bảng độ phủ xác minh theo nhà cung cấp:** Nhà cung cấp nào có nguồn L1, L2, L3; nhà cung cấp nào cần vòng nghiên cứu Tầng 1 (`WP3`).
