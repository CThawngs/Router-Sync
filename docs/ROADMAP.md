# RouterSync Roadmap

> Strategic architecture roadmap and delivery phases for RouterSync.

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

## Phase 3: Daemon & Fast Loop (Current Phase)
- [x] **S1 Slice: Read-Only Daemon Observation:**
  - Background `tick` cycle with 15-minute gatekeeper.
  - Automatic `runVerifyPhase` integration at cycle end with zero additional network requests.
  - Persistent `verify-status.json` and unified request accounting (`paidRequests=0`, `tokens=0`).
  - Inbox proposal and alert generation for newly discovered or deprecating models.
  - Read-only MCP server with 24 tools, each one reading a real state file, ledger, schema or documentation tree; a tool reports `missing`/`INVALID_JSON` instead of inventing a value.
- [x] **S2 Slice: Grant Lifecycle & Human Review:**
  - Interactive approval token exchange and grant lifecycle management (ADR-MAINTAIN-02).
  - Outbound webhook notifications for actionable alerts.
  - Serving-path read-back verification across all active routers.

---

## Phase 4: Production Hardening & Packaging
- [ ] Multi-OS verification on physical macOS and Linux environments. (Round C4i produced the three
      evidence sources that can be produced on one machine: platform-parameterised path helpers with
      unit tests for win32/darwin/linux, a CI matrix of ubuntu/macos/windows on Node 22 and 24, and
      an end-to-end suite that runs the same way on every platform. A physical macOS and Linux run is
      still outstanding and is the first thing to do after the first CI run.)
- [ ] Standalone tarball packaging and clean npm distribution (`@routersync/cli`, `@routersync/mcp-server`).
      (The packaging itself is done and covered by `pnpm e2e`: every workspace package is packed with
      `pnpm pack` and installed with npm into an empty project, and the installed binaries are driven.
      The publication to a public registry is still outstanding.)
- [ ] Automated safe-mode failover with hardware-enforced write locks.

---

## Phase 5: Multi-Harness Ecosystem
- [ ] Direct integration bridges for external agent harnesses (Hermes Agent, OpenClaw, DeepSeek Harness, Claude Code, Antigravity).
- [ ] Edge router synchronization across distributed gateways.

---

## Hoãn sau v1 (Deferred Post-v1)

Các mục dưới đây không thuộc phạm vi v0.0.1 và được ghi lại để tránh scope creep:

- **G5 — GUI đọc trạng thái:** Web UI đọc `status.json` và `inbox.json` ở chế độ xem (không ghi). Đã có skeleton; hoàn thiện sau v1.
- **G6 — BYOK Encrypted Key Bypass:** Biến môi trường `ROUTERSYNC_KEY_<PREFIX>` cho provider có cờ `key-encrypted`. Chờ thiết kế bảo mật.
- **Lịch BYOK qua web:** Cho phép chủ cấu hình lịch quét qua giao diện web, không phải chỉnh file thủ công.
- **Hợp nhất catalog:** `scan` và `tick` hiện dùng nguồn catalog riêng; thống nhất thành một pipeline duy nhất.
- **Chế độ auto-safe:** Tự động ghi combo khi tất cả model vẫn sống và không vượt trần shrink. Chờ kiểm thử nhiều chu kỳ trên môi trường thật.
- **Định dạng ngày trong L3:** `gemini-deprecations` và `openrouter-changelog` trả thông báo nhưng không kèm ngày; cần chuẩn hóa trước khi dùng để tính hạn ngừng.
- **`routersync undo`:** Khôi phục combo từ bản sao lưu mới nhất, nhưng chưa có test tự động; cần phủ test trước khi coi là đường hoàn tác chính thức.

---

## Biết trước (các vấn đề đã xác định, chưa xử lý trong v0.1)

- **Đề xuất model mới chưa loại theo nhãn:** Đường `tick` chỉ lọc đề xuất `NEW-CANDIDATE` theo blacklist; nó không loại các model đã gắn nhãn `QUOTA` hoặc `SẮP-NGỪNG`. Nhãn `QUOTA`/`SẮP-NGỪNG` hiện chỉ được áp dụng ở đường `verify` (`packages/cli/src/verify/verifier.ts`), nên một model đang bị giới hạn lượt hoặc sắp ngừng vẫn có thể được đề xuất thêm vào combo.
- **9Router chỉ ghi lại request thành công, nên không đo được tỷ lệ lỗi:** Bảng `usageHistory` của 9Router chỉ có các request đã thành công. Vì vậy "sức khỏe 7 ngày" của 9Router hiện hiển thị *số request trong 7 ngày* chứ không phải tỷ lệ thành công/thất bại. OmniRoute thì có bảng `call_logs` với mã trạng thái nên hiển thị được tỷ lệ thành công. Cần tài liệu hoặc một bản 9Router mới hơn để đo được tỷ lệ lỗi của 9Router.
- **Đường dẫn database của 9Router trên macOS và Linux có nguồn tài liệu, chưa được kiểm chứng trên máy thật:** Đường dẫn Windows (`%APPDATA%\9router\db\data.sqlite`) lấy từ `docs/adapters/9router.md`; đường dẫn macOS/Linux (`~/.9router/db/data.sqlite`) dựa trên hai nguồn độc lập (2026-11-13): (1) tài liệu cài đặt `deepwiki.com/decolua/9router/2.1-installation` (dữ liệu ở `~/.9router` trên macOS/Linux, `%APPDATA%\9router` trên Windows; DB chính `${DATA_DIR}/db/data.sqlite`; `DATA_DIR` ghi đè); (2) mã nguồn 9Router `cli/hooks/sqliteRuntime.js` (win32 -> `%APPDATA%\9router`, khác -> `~/.9router`, `if (process.env.DATA_DIR) return process.env.DATA_DIR`). CI kiểm thử trên ba hệ điều hành. Người dùng có thể ghi đè bằng `ROUTERSYNC_9ROUTER_DB` hoặc khai báo `db.path` trong `routersync.yaml`.
- **Hai thư mục trạng thái riêng biệt cho `sync` và `tick`:** Hiện tại `tick` dùng `~/.routersync` còn `sync` dùng thư mục trạng thái nền tảng (`%LOCALAPPDATA%\routersync` trên Windows, `$XDG_STATE_HOME/routersync` trên macOS/Linux). Hai thư mục này sẽ được gộp thống nhất ở vòng sau.
- **Bảo vệ HTTP trong scanner nhà cung cấp so với safe-http (Phase 0):** `packages/cli/src/sync/providers.ts` hiện có 7 cơ chế bảo vệ: (1) phương thức `GET` duy nhất; (2) timeout qua `AbortSignal.timeout` (10s/15s); (3) trần model tối đa (`SCAN_MAX_MODELS = 5000`); (4) trần phân trang tối đa (`SCAN_MAX_PAGES = 20`); (5) trần kích thước phản hồi mỗi trang (`SCAN_MAX_BYTES_PER_PAGE = 10 MiB`); (6) chặn liên kết phân trang dẫn tới inference endpoint (`FORBIDDEN_INFERENCE_PATH_PATTERN`); (7) không log/in secret hoặc API token. Các biện pháp mở rộng (chặn chuyển hướng cross-host redirect sang mạng nội bộ, lọc SSRF dải IP riêng tư `10.0.0.0/8`, `192.168.0.0/16`, `169.254.169.254`, và allowlist host cứng) chưa được áp dụng cho toàn bộ provider tùy biến bởi người dùng, và được lên lịch trong Phase 4.
- **`routersync undo` chưa có test tự động:** Lệnh khôi phục danh sách bước từ bản sao lưu sync mới nhất vẫn là công cụ thủ công, chưa được phủ bởi test. Xem thêm mục "Hoãn sau v1".
- **Chưa kiểm chứng trên máy macOS và Linux vật lý:** Bằng chứng đa nền tảng hiện gồm mã không giả định nền tảng, test mô phỏng win32/darwin/linux trên một máy, và ma trận CI ba hệ điều hành. Xem mục Phase 4.

---

## K8: Repo tự mô tả cho AI Agent (ke hoach, chua khong dinh da lam)

Các mục dưới đây là kế hoạch cho vòng sau, không phải tính năng đã hoàn thành trong v0.0.1-prealpha:

- **Bộ chuyển đổi cho ứng dụng AI Agent:** Cấu hình nhà cung cấp và model của Hermes, OpenCode và các harness tương tự qua `packages/adapter-sdk`, bắt đầu bằng chế độ chỉ đọc (không ghi vào router hay ứng dụng AI).
- **Kênh cập nhật:** Thông báo bản mới trong `inbox` qua `tick`, phát hành theo thẻ phiên bản (lệnh cập nhật được lên kế hoạch, chưa triển khai trong v0.1).
- **Bộ kiểm thử ngẫu nhiên cho đường ghi:** Kế hoạch ngẫu nhiên trên database giả, kiểm tra các bất biến và hoàn tác khôi phục đúng từng byte.
- **Bảng độ phủ xác minh theo nhà cung cấp:** Nhà cung cấp nào có nguồn L1, L2, L3; nhà cung cấp nào chưa có.
