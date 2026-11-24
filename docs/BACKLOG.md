# BACKLOG.md — Danh sách Vé Thực thi Chương trình C45 (Lộ trình 1.0.0) & Lưu trữ C44

- **Nguồn sự thật duy nhất:** `docs/SPEC.md` (đặc tả `S1`–`S10` và bảng khoảng trống trên `main` @ `2ea12c4`)
- **Mục tiêu phát hành:** `1.0.0` đầy đủ đặc tả (tùy chọn `1.0.0-rc.1` trên dist-tag `next` sau `WP9`); `0.1.0` là **bản chẩn đoán chỉ đọc (không phát hành)** — xem `docs/RELEASE-CANDIDATE.md`
- **Điều phối:** CEO điều phối · Product Manager (PMO Lead) · CTO (kiến trúc) · COO (vận hành & ngân sách) · Researcher · Data-AI · Engineer · QA · Ops

---

## Chương trình C45 — Lộ trình 1.0.0 Đầy đủ Đặc tả S1–S10 (WP0–WP9)

> **Cổng S10 bắt buộc:** Mọi vé và mọi Pull Request đều phải ghi rõ **`Phục vụ: S#`** (`S1`–`S10`). **PM từ chối mọi vé hoặc PR thiếu trường `Phục vụ: S#`.** Mọi hạng mục ngoài `S1`–`S9` chỉ được thực hiện khi chặn trực tiếp một gói `WP` và phải nêu rõ lý do chặn.

### Ràng buộc C45 áp dụng cho toàn bộ WP0–WP9
- **Đủ 7 trường chuẩn + `Phục vụ: S#`** cho mọi vé: `Phục vụ` · `1. Mục tiêu` · `2. Tiêu chí chấp nhận` · `3. Người làm` · `4. Người xác minh độc lập` · `5. Tệp dự kiến` · `6. Rủi ro` · `7. Lệnh kiểm chứng`.
- **Chế độ thật 3 bậc theo mục tiêu:** `propose` (mặc định) / `auto-safe` / `off`; chỉ nâng lên `auto-safe` sau khi 1 lần áp `propose` thành công và `read-back` khớp.
- **Bất biến ghi mọi bậc:** `backup → atomic write → read-back → auto-rollback`.
- **Bản sao tạm & quyền hạn:** Đội chỉ thử ghi trên bản sao trong `os.tmpdir()`; tuyệt đối không ghi vào router thật hay cấu hình harness thật của chủ dự án (chỉ chủ dự án chạy ở `WP9`); đội không `npm publish`, không tạo/đẩy tag phát hành.
- **Kỷ luật 0 token sản phẩm:** Mã sản phẩm RouterSync không gọi LLM.
- **Ba nhánh bằng chứng (`[skip ci]`, <= 10 tệp, không PR, verifier chuẩn SẠCH):** `evidence/d1` (`WP0`–`WP3`), `evidence/d2` (`WP4`–`WP6`), `evidence/d3` (`WP7`–`WP9`).

### Bảng tổng quan gói việc C45 (WP0–WP9)

| Gói việc | Phục vụ | Nội dung chính | Nhánh bằng chứng đích | Chủ trì | Xác minh độc lập |
|---|---|---|---|---|---|
| **`WP0`** | `Phục vụ: S10` (nền tảng `S1–S9`) | Đặc tả chuẩn `docs/SPEC.md`, bảng khoảng trống `file:line`, lộ trình `1.0.0`, `RELEASE-CANDIDATE.md`, `prepare-v1-release.mjs`, `BACKLOG.md` | `evidence/d1` | Product Manager | QA |
| **`WP1`** | `Phục vụ: S2, S3, S6` | Ma trận năng lực harness (bậc bằng chứng A/B/C) xuất `harness-matrix.md` & `harness-matrix.json` cho `mcp install` / `schedule install` | `evidence/d1` | Researcher + Engineer | QA |
| **`WP2`** | `Phục vụ: S3` | Adapter ghi đầy đủ cho harness (`inspect`, `plan`, `apply`, `rollback`, `read-back`, bảo toàn byte định dạng/chú thích) | `evidence/d1` | Engineer (CTO duyệt) | QA |
| **`WP3`** | `Phục vụ: S1, S3, S7` | Vòng nghiên cứu thời gian thực 2 tầng: Tầng 0 lịch 0-token + Tầng 1 MCP `submit_research` kiểm miền chính chủ + đo độ trễ phát hiện | `evidence/d1` | Engineer + Data-AI | QA |
| **`WP4`** | `Phục vụ: S3, S4, S9` | Tự động hóa có kiểm soát: `standing consent` 30 ngày, MCP `apply_plan`, 3 bậc `propose/auto-safe/off`, bỏ khóa cứng `^test-\d+$`, lệnh `freeze` & `status` | `evidence/d2` | Engineer (CTO duyệt) | QA |
| **`WP5`** | `Phục vụ: S4` | Bộ chọn chiến lược routing & combo cá nhân hóa (trần 12–15 bước, xếp theo độ ổn định, loại HANG/DEAD) + adapter LiteLLM | `evidence/d2` | Engineer + Data-AI | QA |
| **`WP6`** | `Phục vụ: S5` | Kịch bản phỏng vấn thích ứng <= 12 câu (MCP prompt/skill + hướng dẫn theo harness, ví dụ đời thường, ghi giả định vào `profile.yaml`) | `evidence/d2` | Product Manager + Engineer | QA |
| **`WP7`** | `Phục vụ: S6` | Thang lịch chạy 4 bậc theo từng harness (cron gốc 0-LLM → OS scheduler CI 5 OS → MCP `tick_if_due` → daemon) + `doctor` báo bậc & tuổi tick | `evidence/d3` | Engineer (CTO duyệt) | QA |
| **`WP8`** | `Phục vụ: S7` | Sổ cái token (`tokens=0` + request theo miền cho tick; phiên nghiên cứu agent + trần tuần), MCP `cost_report`, test 0 lời gọi LLM | `evidence/d3` | Engineer + Data-AI | QA |
| **`WP9`** | `Phục vụ: S9` | Sẵn sàng chạy thật: runbook `LIVE-E2E-v2.md` + lệnh `live-check`, tiêu chí đo thí điểm `propose` → `auto-safe` chờ chủ dự án tự chạy | `evidence/d3` | Engineer + Product Manager | QA |

---

### Vé `WP0` — Đặc tả chuẩn `SPEC.md`, bảng khoảng trống `S1`–`S10`, lộ trình `1.0.0` & chuẩn bị cắt bản

- **Phục vụ: S10** (nền tảng truy xuất cho `S1`–`S9`)
- **Nhánh bằng chứng đích:** `evidence/d1`

1. **Mục tiêu:** Ban hành nguồn sự thật duy nhất `docs/SPEC.md` (chép nguyên văn `S1`–`S10`, lập bảng khoảng trống có kiểm chứng `file:line` trên `main` @ `2ea12c4` bao gồm đính chính 4 app của `apps inspect`, ghi đủ quy tắc an toàn C45); nâng Phase 5 và `auto-safe` ra khỏi danh sách hoãn trong `docs/ROADMAP.md`; định danh lại `0.1.0` thành "bản chẩn đoán chỉ đọc — không phát hành" trong `docs/RELEASE-CANDIDATE.md` và `CHANGELOG.md`; cung cấp `tools/release/prepare-v1-release.mjs` mặc định `--dry-run`; cập nhật `docs/BACKLOG.md` đủ vé `WP0`–`WP9`.
2. **Tiêu chí chấp nhận:**
   - `docs/SPEC.md` chứa nguyên văn `S1`–`S10`, bảng khoảng trống dẫn tệp/dòng thực tế đã kiểm chứng và 5 quy tắc C45 §3.
   - `docs/ROADMAP.md` đưa Phase 5 & `auto-safe` lên công việc chính `1.0.0`, vượt qua 100% `test/docs/agent-docs.test.ts`.
   - `docs/RELEASE-CANDIDATE.md`, `CHANGELOG.md` và `tools/release/prepare-v1-release.mjs` sẵn sàng cho chủ dự án cắt `1.0.0` / `1.0.0-rc.1` (giữ `package.json` tại `0.1.0` để `at-167` xanh); không có chuỗi git cấm K6.2.
   - `test/docs/c45-wp0-spec.test.ts`, toàn bộ guard bảo mật và `scan-private-names.mjs` (delta = 0) đều xanh.
3. **Người làm:** **Product Manager** (PMO Lead); **Ops** squash-merge sau khi QA ký.
4. **Người xác minh độc lập:** **QA** (đọc diff, kiểm chứng dẫn dòng `SPEC.md`, chạy lại test docs & guards).
5. **Tệp dự kiến:**
   - `<REPO>/docs/SPEC.md`
   - `<REPO>/docs/ROADMAP.md`
   - `<REPO>/docs/RELEASE-CANDIDATE.md`
   - `<REPO>/docs/BACKLOG.md`
   - `<REPO>/CHANGELOG.md`
   - `<REPO>/tools/release/prepare-v1-release.mjs`
   - `<REPO>/test/docs/c45-wp0-spec.test.ts`
6. **Rủi ro:** Viết nhầm lệnh CLI chưa tồn tại hoặc đường dẫn tệp chưa tồn tại vào `docs/ROADMAP.md` làm đỏ `agent-docs.test.ts`, hoặc vô tình chèn chuỗi git cấm K6.2 → giảm thiểu bằng chạy trực tiếp `agent-docs.test.ts` và `c45-wp0-spec.test.ts` trước khi đẩy nhánh.
7. **Lệnh kiểm chứng:**
   ```sh
   pnpm build
   pnpm test:file test/docs/agent-docs.test.ts test/docs/c45-wp0-spec.test.ts
   pnpm typecheck:changed
   node tools/guard/no-secrets.mjs
   node tools/guard/no-personal-paths.mjs
   node tools/guard/no-evidence-in-main.mjs
   node tools/agent/scan-private-names.mjs origin/main HEAD
   ```

---

### Vé `WP1` — Ma trận năng lực harness có kiểm chứng (A/B/C) & nguồn dữ liệu chung cho `mcp install` / `schedule install`

- **Phục vụ: S2, S3, S6**
- **Nhánh bằng chứng đích:** `evidence/d1`

1. **Mục tiêu:** Khảo sát bằng tài liệu chính thức (kèm URL và ngày tra) và quan sát chỉ đọc trên máy chủ dự án (nếu đã cài) cho toàn bộ danh sách harness trong S2 (Hermes, Claude Code, Codex, Antigravity, OpenCode, Cursor, Grok bot, OpenMausBot). Xác minh 5 tiêu chí: (a) định dạng & vị trí cấu hình MCP + lệnh cài; (b) lịch chạy gốc và khả năng chạy script không qua LLM; (c) vị trí/định dạng danh sách provider & model, khả năng người dùng sửa tệp và nhu cầu nạp lại; (d) khả năng agent chạy lệnh shell; (e) bậc bằng chứng (A/B/C; ghi `CHƯA-XÁC-MINH` khi thiếu bằng chứng, tuyệt đối không đoán). Xuất `docs/harness-matrix.md` và `harness-matrix.json` làm nguồn dữ liệu trực tiếp cho `mcp install` và `schedule install`.
2. **Tiêu chí chấp nhận:**
   - Đủ cả 8 harness trong S2 với đầy đủ 5 tiêu chí (a)–(e), có URL + ngày kiểm chứng; harness chỉ chỉnh model qua UI được đánh dấu rõ "hướng A chỉ báo cáo & hướng dẫn, không ghi".
   - Schema của `harness-matrix.json` có kiểm thử hợp đồng (Red-First); `mcp install` và `schedule install` đọc cấu hình từ `harness-matrix.json` thay vì danh sách cứng rời rạc.
   - Không làm rò rỉ đường dẫn cá nhân, tên riêng hay secret từ quá trình quan sát chỉ đọc trên host; CI 5 OS xanh và QA ký độc lập.
3. **Người làm:** **Researcher** (tra cứu chính thức + quan sát chỉ đọc), **Engineer** (JSON schema + nối `mcp install` / `schedule install`), **CTO** duyệt schema.
4. **Người xác minh độc lập:** **QA** (kiểm tra từng URL/bậc A-B-C, chạy test hợp đồng & quét mẫu cá nhân).
5. **Tệp dự kiến:**
   - `<REPO>/docs/harness-matrix.md`
   - `<REPO>/registry/harness-matrix.json` (hoặc vị trí chuẩn do CTO chốt)
   - `<REPO>/packages/cli/src/commands/mcp-install.ts`
   - `<REPO>/packages/cli/src/commands/schedule.ts`
   - `<REPO>/test/docs/harness-matrix.test.ts`
6. **Rủi ro:** Quan sát trên host dễ kéo đường dẫn cá nhân hoặc suy đoán cấu hình cho harness chưa cài → giảm thiểu bằng kiểm tra chỉ đọc qua placeholder chuẩn, gán `CHƯA-XÁC-MINH` (bậc C) khi thiếu bằng chứng và chạy `no-personal-paths.mjs` + `scan-private-names.mjs`.
7. **Lệnh kiểm chứng:**
   ```sh
   pnpm build
   pnpm test:changed
   pnpm typecheck:changed
   pnpm lint
   node tools/agent/scan-private-names.mjs origin/main HEAD
   ```

---

### Vé `WP2` — Adapter ghi đầy đủ cho harness (`inspect`, `plan`, `apply`, `rollback`, `read-back`)

- **Phục vụ: S3**
- **Nhánh bằng chứng đích:** `evidence/d1`

1. **Mục tiêu:** Dựa trên ma trận `WP1`, xây dựng adapter ghi đầy đủ (`inspect`, `plan`, `apply`, `rollback`, `read-back`) cho các harness có tệp cấu hình model sửa được ở bậc A hoặc B, ưu tiên các harness chủ dự án đang dùng (Hermes, OpenMausBot, OpenCode, Codex nếu xác minh được). Tuân thủ nghiêm hợp đồng: chỉ sửa danh sách model của provider đã có key; không đụng key, base URL hay slot model mặc định (nếu model mặc định bị loại chỉ đề xuất, không tự đổi); bảo toàn chú thích và định dạng YAML/TOML/JSONC; nhận biết app đang chạy và cảnh báo cần nạp lại.
2. **Tiêu chí chấp nhận:**
   - **Đỏ trước – xanh sau:** Có test vòng khứ hồi bảo toàn từng byte (byte-preserving round-trip) cho phần không đổi và chú thích trên YAML/TOML/JSONC; test chứng minh không đụng key/base URL/default slot; test mô phỏng sai lệch `read-back` kích hoạt `auto-rollback` khôi phục khớp SHA-256 từng byte trong `os.tmpdir()`.
   - Đủ kiểm thử đột biến của Engineer và QA cho mã ghi cấu hình harness và bảo vệ secret.
   - CI 5 OS xanh; 0 thao tác lên cấu hình thật của chủ dự án.
3. **Người làm:** **Engineer** (**CTO** duyệt thiết kế AST/CST bảo toàn định dạng và giao diện `@routersync/adapter-sdk`).
4. **Người xác minh độc lập:** **QA** (chạy kiểm thử đột biến riêng, xác minh khứ hồi byte & rollback trên bản sao tạm).
5. **Tệp dự kiến:**
   - `<REPO>/packages/adapter-sdk/src/agent-app.ts`
   - `<REPO>/packages/cli/src/apps/inspect.ts`
   - `<REPO>/packages/cli/src/apps/write-*.ts` (adapter ghi từng harness bậc A/B)
   - `<REPO>/packages/cli/test/apps-write-roundtrip.test.ts`
6. **Rủi ro:** Parser JSON/YAML/TOML thông thường làm mất comment hoặc đảo thứ tự key dẫn tới hỏng cấu hình người dùng → giảm thiểu bằng bộ chỉnh sửa bảo toàn định dạng (CST/patch tối thiểu) kèm bài test khứ hồi byte bắt buộc.
7. **Lệnh kiểm chứng:**
   ```sh
   pnpm build
   pnpm test:changed
   pnpm typecheck:changed
   pnpm lint
   node tools/agent/scan-private-names.mjs origin/main HEAD
   ```

---

### Vé `WP3` — Vòng nghiên cứu thời gian thực 2 tầng & công cụ MCP `submit_research`

- **Phục vụ: S1, S3, S7**
- **Nhánh bằng chứng đích:** `evidence/d1`

1. **Mục tiêu:** Hoàn thiện vòng phát hiện model 2 tầng: (1) **Tầng 0** chạy bằng lịch, 0 token — quét danh sách model provider bằng key trong RAM, trang/changelog chính thức và catalog thứ cấp, so với model đang cấu hình ở từng mục tiêu, ghi kế hoạch và hộp thư; (2) **Tầng 1** chỉ kích hoạt khi hàng đợi nghiên cứu có mục cần phán đoán (provider không có API liệt kê, thông báo ngừng mơ hồ, model mới cần phân loại miễn phí/trả phí, tên khác nhau giữa các nguồn) — agent harness tự dùng công cụ tìm web rồi nộp kết quả qua công cụ MCP mới `submit_research` (URL nguồn, trích dẫn, ngày; hệ thống kiểm miền nguồn chính chủ, nguồn thứ cấp bắt buộc gắn nhãn). `submit_research` chỉ ghi vào sổ bằng chứng của RouterSync, tuyệt đối không ghi vào router hay harness. Giữ luật loại model (cần bằng chứng chính thức hoặc vắng mặt ổn định nhiều chu kỳ, trần co 10%, `UNVERIFIABLE` không bị coi là vắng) và ghi độ trễ phát hiện vào nhật ký.
2. **Tiêu chí chấp nhận:**
   - **Đỏ trước – xanh sau:** Test xác nhận `submit_research` kiểm chặt miền nguồn chính chủ, từ chối URL giả/không hợp lệ, gắn nhãn nguồn thứ cấp, không ghi DB router/harness, giữ trần co <= 10% và không coi `UNVERIFIABLE` là vắng.
   - Nhật ký ghi được độ trễ phát hiện (từ mốc nguồn thay đổi tới mốc sinh kế hoạch).
   - Đủ kiểm thử đột biến Engineer & QA cho bộ kiểm miền và luật loại model; cập nhật số lượng công cụ MCP trong tài liệu & test đồng bộ; CI 5 OS xanh.
3. **Người làm:** **Engineer** + **Data-AI** (**CTO** duyệt danh sách miền nguồn chính chủ và schema sổ bằng chứng).
4. **Người xác minh độc lập:** **QA** (kiểm thử đột biến kiểm miền, kiểm tra độ trễ phát hiện và không vượt quyền ghi).
5. **Tệp dự kiến:**
   - `<REPO>/packages/mcp-server/src/server.ts`
   - `<REPO>/packages/cli/src/commands/tick.ts`
   - `<REPO>/packages/core/src/research/*` (sổ bằng chứng & kiểm miền nguồn chính chủ)
   - `<REPO>/registry/providers.yaml`
   - `<REPO>/packages/mcp-server/test/submit-research.test.ts`
6. **Rủi ro:** Tấn công giả mạo URL/subdomain nguồn chính chủ hoặc injection trong trích dẫn nghiên cứu → giảm thiểu bằng parser URL chặt theo allowlist miền, bộ lọc chuỗi không tin cậy (AT-90) và test đột biến bảo mật.
7. **Lệnh kiểm chứng:**
   ```sh
   pnpm build
   pnpm test:changed
   pnpm typecheck:changed
   pnpm lint
   node tools/agent/scan-private-names.mjs origin/main HEAD
   ```

---

### Vé `WP4` — Tự động hóa có kiểm soát: `standing consent`, MCP `apply_plan`, 3 bậc `propose/auto-safe/off` & lệnh `freeze`

- **Phục vụ: S3, S4, S9**
- **Nhánh bằng chứng đích:** `evidence/d2`

1. **Mục tiêu:** Xây dựng sự đồng ý đứng (`standing consent`) — tệp chính sách người dùng tạo 1 lần bằng xác nhận tương tác, có hạn mặc định 30 ngày, phạm vi theo từng mục tiêu ghi và bậc (`propose` / `auto-safe` / `off`), thay thế việc gõ xác nhận mỗi lần và thay giới hạn cứng `^test-\d+$` bằng phạm vi lấy từ chính sách (mặc định rỗng). Thêm công cụ MCP `apply_plan` chỉ chạy khi có sự đồng ý đứng còn hạn hoặc approval token của daemon và chỉ áp kế hoạch khớp `planHash`. Thực thi cổng thăng bậc bắt buộc (chỉ lên `auto-safe` sau 1 lần áp `propose` thành công + `read-back` khớp), luật `auto-safe` giữ bất biến `I1`–`I8` + thông báo hộp thư/webhook, lệnh khẩn cấp `freeze` (khóa mọi đường ghi ngay), mở rộng `status` hiển thị bậc từng mục tiêu, và phủ test tự động cho đường hoàn tác trên bản sao tạm.
2. **Tiêu chí chấp nhận:**
   - **Đỏ trước – xanh sau:** Test chứng minh từ chối ghi khi phạm vi mặc định rỗng, khi chính sách hết hạn, khi `planHash` lệch, khi chưa qua 1 lần `propose` + `read-back` khớp mà đòi bật `auto-safe`, hoặc khi đã kích hoạt `freeze`.
   - Test chứng minh chuỗi `backup → atomic write → read-back → auto-rollback` chạy đủ ở cả `propose` và `auto-safe` trên bản sao tạm trong `os.tmpdir()`, kèm test hồi quy cho `undo` / `rollback`.
   - Đủ kiểm thử đột biến của Engineer và QA cho cổng `standing consent`, `apply_plan`, `freeze` và kiểm tra `planHash`; CI 5 OS xanh.
3. **Người làm:** **Engineer** (**CTO** duyệt mô hình đe dọa & định dạng tệp `standing consent`).
4. **Người xác minh độc lập:** **QA** (kiểm thử đột biến bảo mật riêng trên toàn bộ cổng ghi, xác nhận `security-audit.mjs` sạch).
5. **Tệp dự kiến:**
   - `<REPO>/packages/core/src/policy/standing-consent.ts`
   - `<REPO>/packages/cli/src/maintain/grant.ts`
   - `<REPO>/packages/cli/src/commands/maintain.ts`
   - `<REPO>/packages/cli/src/commands/freeze.ts`
   - `<REPO>/packages/cli/src/commands/status.ts`
   - `<REPO>/packages/mcp-server/src/server.ts`
   - `<REPO>/test/security/standing-consent-apply-plan.test.ts`
6. **Rủi ro:** Mở khóa khỏi `^test-\d+$` nếu cấu hình mặc định không rỗng có thể gây ghi ngoài ý muốn → giảm thiểu bằng mặc định phạm vi rỗng tuyệt đối (fail-closed), xác thực HMAC/chữ ký chính sách, cổng `freeze` tức thời và kiểm thử đột biến 2 lớp.
7. **Lệnh kiểm chứng:**
   ```sh
   pnpm build
   pnpm test:changed
   node --test test/agent/security-audit.node.test.mjs
   pnpm typecheck:changed
   pnpm lint
   node tools/agent/scan-private-names.mjs origin/main HEAD
   ```

---

### Vé `WP5` — Bộ chọn chiến lược routing cá nhân hóa, bộ sinh combo theo độ ổn định & adapter LiteLLM

- **Phục vụ: S4**
- **Nhánh bằng chứng đích:** `evidence/d2`

1. **Mục tiêu:** Xây bộ chọn chiến lược routing từ hồ sơ người dùng (`WP6`) và năng lực thực tế của từng router (`list_strategies`), giữ xoay vòng tài khoản ở cấp provider và dùng `fallback` ở cấp combo khi phù hợp. Combo do RouterSync sinh có trần số bước (mặc định 12–15), xếp theo độ ổn định đo được từ `combos reliability` (loại bỏ bước `HANG` và `DEAD`), xen kẽ provider và loại bỏ model chuyên dụng không phải chat. Triển khai adapter LiteLLM (đọc, kế hoạch, ghi vào tệp cấu hình, hoàn tác) hoặc ghi rõ bằng chứng kỹ thuật nếu chưa khả thi và giữ phương án xuất tệp.
2. **Tiêu chí chấp nhận:**
   - **Đỏ trước – xanh sau:** Test xác minh combo sinh ra luôn <= trần bước (12–15), không chứa bước `HANG`/`DEAD` hay model không phải chat, xen kẽ provider (giữ `I7`) và giữ nguyên `I1`–`I8`.
   - Chiến lược routing thay đổi nhất quán theo từng app và hồ sơ người dùng.
   - Adapter LiteLLM có test vòng đời `read → plan → apply → read-back → rollback` trên tệp cấu hình tạm trong `os.tmpdir()` (hoặc báo cáo bằng chứng kỹ thuật rõ ràng nếu giới hạn ở chế độ xuất tệp); CI 5 OS xanh.
3. **Người làm:** **Engineer** + **Data-AI** (**CTO** duyệt kiến trúc adapter LiteLLM & thuật toán chọn chiến lược).
4. **Người xác minh độc lập:** **QA** (kiểm chứng bất biến combo, kiểm thử đột biến cho đường ghi tệp LiteLLM).
5. **Tệp dự kiến:**
   - `<REPO>/packages/core/src/planner/strategy-selector.ts`
   - `<REPO>/packages/core/src/planner/index.ts`
   - `<REPO>/packages/cli/src/commands/combos-reliability.ts`
   - `<REPO>/packages/adapter-litellm/*` hoặc `<REPO>/packages/cli/src/export/litellm.ts`
   - `<REPO>/packages/core/test/strategy-selector.test.ts`
6. **Rủi ro:** Tệp cấu hình LiteLLM thực tế đa dạng cấu trúc YAML/biến môi trường → giảm thiểu bằng kiểm chứng trên bộ fixture chuẩn, bảo toàn biến môi trường `os.environ/...` (không bao giờ giải mã hay ghi key trần) và kiểm thử rollback khứ hồi.
7. **Lệnh kiểm chứng:**
   ```sh
   pnpm build
   pnpm test:changed
   pnpm typecheck:changed
   pnpm lint
   node tools/agent/scan-private-names.mjs origin/main HEAD
   ```

---

### Vé `WP6` — Kịch bản phỏng vấn thích ứng <= 12 câu & đóng gói prompt/skill theo từng harness

- **Phục vụ: S5**
- **Nhánh bằng chứng đích:** `evidence/d2`

1. **Mục tiêu:** Thay thế danh sách 12 câu hỏi cố định bằng kịch bản phỏng vấn thích ứng phát hành dưới dạng MCP prompt/skill và tệp hướng dẫn cho từng harness trong ma trận `WP1`. Bao phủ đầy đủ: mục tiêu sử dụng, các harness và router đang dùng, provider đã có key, ngân sách (chỉ miễn phí hay có trả phí), ưu tiên (tốc độ, chất lượng, ngữ cảnh dài), mức tự động mong muốn (3 bậc `propose` / `auto-safe` / `off`), lịch cập nhật. Tối đa 12 câu; câu trả lời mơ hồ thì áp mặc định hợp lý và ghi rõ giả định vào `profile.yaml` để người dùng sửa; người dùng không rành kỹ thuật thì hỏi bằng ví dụ đời thường; tuyệt đối không tự bịa dữ liệu hồ sơ.
2. **Tiêu chí chấp nhận:**
   - **Đỏ trước – xanh sau:** Test xác minh luồng hỏi thích ứng tối đa 12 câu cho cả 2 nhánh (người dùng kỹ thuật vs người dùng mơ hồ/không rành kỹ thuật), kiểm tra trường `assumptions` ghi rõ mọi mặc định vào `profile.yaml` và từ chối tự bịa trường chưa hỏi/chưa cung cấp.
   - Đóng gói prompt/skill MCP + hướng dẫn đồng bộ với danh sách harness từ `WP1`; CI 5 OS xanh.
3. **Người làm:** **Product Manager** (soạn kịch bản hỏi thích ứng & ví dụ đời thường) + **Engineer** (schema `profile.yaml` + MCP prompt/skill).
4. **Người xác minh độc lập:** **QA** (kiểm thử cả luồng mơ hồ, luồng chi tiết, kiểm tra không bịa dữ liệu và đồng bộ tài liệu).
5. **Tệp dự kiến:**
   - `<REPO>/packages/core/src/profile/questions.ts`
   - `<REPO>/packages/cli/src/profile/interview.ts`
   - `<REPO>/packages/mcp-server/src/server.ts`
   - `<REPO>/docs/ai/skill-routersync.md`
   - `<REPO>/packages/cli/test/adaptive-interview.test.ts`
6. **Rủi ro:** Câu hỏi rẽ nhánh phức tạp vượt trần 12 câu hoặc ghi đè tùy chỉnh cũ trong `profile.yaml` → giảm thiểu bằng bài test chặn cứng số câu <= 12 và chế độ merge không phá hủy trường người dùng đã xác nhận.
7. **Lệnh kiểm chứng:**
   ```sh
   pnpm build
   pnpm test:changed
   pnpm typecheck:changed
   pnpm lint
   node tools/agent/scan-private-names.mjs origin/main HEAD
   ```

---

### Vé `WP7` — Thang lịch chạy 4 bậc, MCP `tick_if_due` & chẩn đoán độ trễ trong `doctor`

- **Phục vụ: S6**
- **Nhánh bằng chứng đích:** `evidence/d3`

1. **Mục tiêu:** Triển khai thang lịch chạy 4 bậc cho mọi harness trong ma trận `WP1`: (1) lịch gốc của harness chạy script không qua LLM nếu đã xác minh; (2) bộ lập lịch hệ điều hành qua `routersync schedule install` (Task Scheduler, launchd, systemd timer, cron) có kiểm thử chế độ chạy khô trên CI 5 OS; (3) tick theo yêu cầu khi MCP khởi động hoặc agent gọi công cụ mới `tick_if_due` (chạy nền nếu quá hạn, giữ cổng 15 phút + khóa tệp chống chạy chồng); (4) daemon. Nâng cấp `routersync doctor` báo bậc lịch đang dùng cho từng harness và tuổi tick gần nhất, cảnh báo khi tick cũ hơn gấp đôi chu kỳ, kèm một tài liệu quyết định cho người dùng.
2. **Tiêu chí chấp nhận:**
   - **Đỏ trước – xanh sau:** Test `schedule install` chạy khô qua cả 5 OS trong CI; test `tick_if_due` tôn trọng cổng 15 phút và khóa tệp (không chạy đúp song song); test `doctor` xuất đúng bậc lịch và phát cảnh báo khi `tickAge > 2 * interval`.
   - Có tài liệu hướng dẫn quyết định chọn bậc lịch rõ ràng; CI 5 OS xanh.
3. **Người làm:** **Engineer** (**CTO** duyệt cơ chế khóa tệp đa nền tảng & thang ưu tiên bậc lịch).
4. **Người xác minh độc lập:** **QA** (xác minh test chạy khô trên đủ 5 OS, test tranh chấp khóa tệp & cảnh báo `doctor`).
5. **Tệp dự kiến:**
   - `<REPO>/packages/cli/src/commands/schedule.ts`
   - `<REPO>/packages/cli/src/commands/doctor.ts`
   - `<REPO>/packages/mcp-server/src/server.ts`
   - `<REPO>/docs/schedule-decision-guide.md`
   - `<REPO>/packages/cli/test/schedule-ladder.test.ts`
6. **Rủi ro:** Khác biệt đường dẫn & cơ chế khóa tệp giữa Windows/macOS/Linux hoặc sinh tiến trình mồ côi khi chạy nền từ MCP → giảm thiểu bằng bài test đa nền tảng trên CI 5 OS và cơ chế khóa tệp có kiểm PID/stale-lock.
7. **Lệnh kiểm chứng:**
   ```sh
   pnpm build
   pnpm test:changed
   pnpm typecheck:changed
   pnpm lint
   node tools/agent/scan-private-names.mjs origin/main HEAD
   ```

---

### Vé `WP8` — Sổ cái token, trần nghiên cứu theo tuần, MCP `cost_report` & kiểm chứng 0 lời gọi LLM

- **Phục vụ: S7**
- **Nhánh bằng chứng đích:** `evidence/d3`

1. **Mục tiêu:** Xây dựng sổ cái token bền vững: mỗi lần `tick` ghi `tokens=0` và số request mạng chi tiết theo từng miền; mỗi phiên nghiên cứu của agent (`submit_research`) ghi số lần gọi công cụ và lượng văn bản trả về; bổ sung công cụ MCP `cost_report` tóm tắt chi phí/lượt dùng theo tuần; thêm cấu hình trần số phiên nghiên cứu mỗi tuần (mặc định thấp). Bổ sung bộ test chứng minh mã sản phẩm RouterSync không gọi bất kỳ endpoint LLM nào và chỉ gửi request tới các miền trong danh sách cho phép.
2. **Tiêu chí chấp nhận:**
   - **Đỏ trước – xanh sau:** Test xác minh sổ cái ghi tách bạch `tick` (`tokens=0` + đếm request theo miền) với phiên nghiên cứu, chặn vượt trần số phiên/tuần, `cost_report` tổng hợp đúng theo tuần.
   - Test chặn mạng chứng minh 100% đường chạy sản phẩm không gọi endpoint LLM và từ chối miền ngoài allowlist.
   - Đủ kiểm thử đột biến Engineer & QA cho bộ đếm trần và lọc allowlist miền; CI 5 OS xanh.
3. **Người làm:** **Engineer** + **Data-AI** (**COO** xác nhận ngưỡng trần mặc định và báo cáo tuần).
4. **Người xác minh độc lập:** **QA** (kiểm thử đột biến cho trần tuần & kiểm tra cô lập mạng 0-LLM).
5. **Tệp dự kiến:**
   - `<REPO>/packages/core/src/ledger/token-ledger.ts`
   - `<REPO>/packages/cli/src/commands/tick.ts`
   - `<REPO>/packages/mcp-server/src/server.ts`
   - `<REPO>/test/security/zero-llm-and-allowlist.test.ts`
6. **Rủi ro:** Bỏ sót một nhánh HTTP phụ gọi ngoài allowlist hoặc đếm trùng request khi retry → giảm thiểu bằng interceptor mạng tập trung trong test tích hợp và ghi nhận chính xác từng lượt gọi thực tế.
7. **Lệnh kiểm chứng:**
   ```sh
   pnpm build
   pnpm test:changed
   pnpm typecheck:changed
   pnpm lint
   node tools/agent/scan-private-names.mjs origin/main HEAD
   ```

---

### Vé `WP9` — Sẵn sàng chạy thật: runbook `LIVE-E2E-v2.md` & công cụ `live-check`

- **Phục vụ: S9**
- **Nhánh bằng chứng đích:** `evidence/d3`

1. **Mục tiêu:** Soạn runbook chạy thật `docs/runbook/LIVE-E2E-v2.md` và xây công cụ CLI `live-check` kiểm tra danh sách tiền điều kiện trước khi chạy thật (chỉ đọc, không tự ghi vào hệ thống thật): kiểm tra trạng thái `standing consent`, sao lưu/hoàn tác sẵn sàng, bậc mục tiêu (bắt đầu từ 1 combo router + 1 tệp cấu hình harness do chủ dự án chọn), quy trình từng bước `propose` → xác minh `read-back` → thăng bậc `auto-safe`, và 5 chỉ số đạt đo được (số model loại sai = 0, hoàn tác khớp từng byte, độ trễ phát hiện, token đã dùng, số lần phải can thiệp tay). Đội dừng tại trạng thái **"sẵn sàng chạy thật"** và bàn giao cho chủ dự án tự chạy; đội tuyệt đối không tự chạy chế độ thật.
2. **Tiêu chí chấp nhận:**
   - **Đỏ trước – xanh sau:** Test `live-check` trên môi trường bản sao tạm trong `os.tmpdir()` xác nhận báo PASS khi đủ tiền điều kiện và báo FAIL rõ nguyên nhân khi thiếu sao lưu, thiếu chính sách, hoặc đang bật `freeze`, với 0 byte thay đổi trên DB/cấu hình.
   - `docs/runbook/LIVE-E2E-v2.md` đầy đủ danh sách kiểm, lệnh cụ thể, tiêu chí đạt lượng hóa và phương án dừng khẩn cấp (`freeze` + `rollback`).
   - Toàn bộ gói `evidence/d3` đạt verifier SẠCH, CI 5 OS xanh, bàn giao rõ hàng đợi `chờ chủ dự án` (thí điểm thật + quyết định cắt `1.0.0` / `1.0.0-rc.1`).
3. **Người làm:** **Engineer** (CLI `live-check`) + **Product Manager** (runbook `LIVE-E2E-v2.md` & bảng tiêu chí đạt); **Ops** kiểm đóng gói & squash-merge.
4. **Người xác minh độc lập:** **QA** (kiểm chứng `live-check` không ghi vào mục tiêu, rà soát runbook với toàn bộ bất biến C45).
5. **Tệp dự kiến:**
   - `<REPO>/docs/runbook/LIVE-E2E-v2.md`
   - `<REPO>/packages/cli/src/commands/live-check.ts`
   - `<REPO>/packages/cli/src/index.ts`
   - `<REPO>/packages/cli/test/live-check.test.ts`
6. **Rủi ro:** `live-check` vô tình chạm cổng router thật hoặc ghi tệp cấu hình thật trong lúc kiểm tra tiền điều kiện → giảm thiểu bằng chỉ đọc tuyệt đối (so sánh SHA-256 trước/sau trong test) và từ chối mọi thao tác ghi.
7. **Lệnh kiểm chứng:**
   ```sh
   pnpm build
   pnpm test:changed
   pnpm verify:release
   node tools/agent/pack-verify.mjs
   node tools/agent/scan-private-names.mjs origin/main HEAD
   ```

---

## Lưu trữ lịch sử — Chương trình C44 (M1–M5 & Track W, nền 0.1.0 đã hoàn tất trên main @ 2ea12c4)

- **Chương trình:** C44 — Nhiệm vụ lớn một lần: M3, M4, chuẩn bị M5 tới cổng phát hành, kèm Track W về `9Router 0.5.123` (tiếp nối Hiến chương C42 và Track R C43/C43A)
- **Đồng lập & rà soát:** Product Manager (PMO Lead) & CTO (thiết kế kỹ thuật); CEO điều phối; COO theo dõi ngân sách & vận hành
- **Đích xuất bản:** `<REPO>/docs/BACKLOG.md` trên `main` (qua PR #1 `docs-only`) và bản sao tại `evidence/C44/BACKLOG.md` trên nhánh `origin/evidence/c44` (`[skip ci]`, không PR)
- **Nền đối chiếu hiện tại (`2026-11-24`):**
  - `main` HEAD: `bc61436` (`bc614368b2becbbb4309265d8822f8dee813003f`)
  - Nhánh bằng chứng đã xác nhận độc lập (verifier chuẩn SẠCH):
    - `origin/evidence/c43` @ `f2486bb` (`f2486bbc3524aeab39c238a586a622050a29e730`) — 2 dòng SẠCH (Track R: PR `#60` `7170958`, PR `#61` `f0e8534`, PR `#63` `5b39320`; không làm lại theo C44 §1)
    - `origin/evidence/m1` @ `987da9c` (`987da9c8c652946dabd29a0a33d09e08a105ff8d`) — 3 dòng SẠCH (M1: PR `#57` `52b8894`, PR `#58` `1520e0f`, PR `#59` `618c233`)
    - `origin/evidence/m2` @ `4acc7c4` (`4acc7c45e8aa7989f0a2dcf4baba9972bf8dcd06`) — 3 dòng SẠCH (M2: PR `#62` `7abfd74`, PR `#64` `8ca92f8`, PR `#65` `bc61436`)
  - Hiện trạng `9Router` cục bộ (kiểm chỉ đọc lúc `2026-11-23T22:15Z`, `0` cuộc gọi HTTP/TCP): `version=0.5.123`, `patchV1=false`, `patchV2=false`, `patchV3=false`, `loaded=true`, `processStart=2026-11-23T10:58:17.262Z` (tiến trình đang chạy liên tục, chưa bị khởi động lại)
  - Kiểm chỉ đọc registry `npm view` (`2026-11-23T22:19Z`): toàn bộ `8` gói công bố có scope `@routersync/*` (`0.1.0`, `private: false`) đều trả `E404 Not Found` (chưa bị chiếm; việc tạo/sở hữu scope `@routersync` trên npm xếp vào hàng đợi `chờ chủ dự án`). Gói gốc `routersync` (`private: true`) và `@routersync/ui` (`private: true`) không công bố ra npm (tên trần `routersync` trên registry ở trạng thái `404 Unpublished`).

---

## Ràng buộc chung & Kế hoạch gom PR tiết kiệm chi phí (C44 §2–§3)

### 1. Ràng buộc chung cho mọi vé

- **Đủ 7 trường bắt buộc cho mỗi vé:** `1. Mục tiêu` · `2. Tiêu chí chấp nhận` · `3. Người làm` · `4. Người xác minh độc lập` · `5. Tệp dự kiến` · `6. Rủi ro` · `7. Lệnh kiểm chứng`.
- **Tài nguyên cục bộ:** Chạy `node tools/agent/preflight.mjs` đầu mỗi phiên; khi RAM trống `< 1.50 GiB` (`LIGHT-DEV`), tuân thủ nghiêm cổng `tools/agent/heavy.mjs` (không ép `RS_FORCE_HEAVY=1` hay `CI=true`; chỉ chạy `pnpm lint`, `pnpm typecheck:changed`, `pnpm test:changed` hoặc test tệp đơn lẻ, để full suite cho GitHub Actions PR CI).
- **Quy tắc PR & chất lượng (C44 §2):**
  - Tối đa **2 PR mở cùng lúc**, chỉ khi 2 PR hoàn toàn **không chung tệp**; tối đa **2 bot gọi LLM đồng thời** (kênh Sub). **Ops** merge theo thứ tự xanh bằng `gh pr merge --squash` sau khi **QA** ký độc lập.
  - PR `docs-only` không cần kiểm thử đột biến (QA đọc diff và chạy verifier); mọi mã chạm bảo mật, cổng ghi router, token, cấu hình, bộ đếm ngân sách, hoặc kiểm đóng gói giữ đủ **Red-First + đột biến của Engineer + đột biến riêng của QA**.
  - **4 bằng chứng RACI bắt buộc để nhận nhãn `XONG`:** (1) PR đã squash-merge bởi Ops, (2) SHA commit trên `main`, (3) CI `main` xanh đủ **5 hệ điều hành** (`ubuntu-latest`, `ubuntu-24.04-arm`, `macos-latest`, `windows-latest`, `windows-11-arm`) ở `attempt=1`, (4) gói bằng chứng trên nhánh `evidence/*` (`<= 10` tệp, `[skip ci]`, không PR, `gh run list --branch` rỗng) đạt verifier SẠCH (`verify-records.mjs`, `verify-package.mjs`, `scan-private-names.mjs` = `0`).
- **Ràng buộc cứng bảo mật & git:**
  - Tuyệt đối không đưa đường dẫn máy cá nhân, tên người dùng hệ điều hành, email, tên máy chủ, bí mật/token, hay tên nhà cung cấp riêng vào tệp tracked hoặc `evidence/*`; luôn dùng `<REPO>/...` hoặc `<USER_DIR>/...`.
  - Tuyệt đối không track thư mục `evidence/` trên `main`, không đẩy ép lịch sử, không dùng nhánh `master` mặc định cũ hay đẩy hàng loạt nhánh/tag (lệnh gắn và đẩy tag phát hành phải ghi tường minh tên tag đơn lẻ, ví dụ `git push origin v0.1.0`).
- **Quy tắc router & điều kiện dừng (C44 §3):**
  - Không ghi DB hay cấu hình router thật, không bật/tắt/khởi động lại router, không tự áp bản vá, không tạo hoặc sửa combo, không chạy `npm publish`, không tạo tag phát hành.
  - Ngoại lệ có hạn duy nhất thuộc Track W: tối đa **`3` lần `GET /v1/models`** (chỉ trong `W1`) và tổng trần cứng **`30` request chat** cho toàn Track W (`W1` + `W3` + `W5`).
  - **Dừng toàn bộ và báo ngay** nếu gặp một trong các sự cố: CI `main` đỏ ở `attempt=1` do lỗi mã (không phải lỗi cấp runner có bằng chứng), verifier không SẠCH, quét tên riêng hoặc mẫu cá nhân có khớp (`> 0`), vượt ngân sách request, `3` lần HTTP `429` liên tiếp, hoặc lộ key/token ở bất kỳ đâu.
  - Vé cần quyết định của chủ dự án được xếp vào hàng đợi **`chờ chủ dự án`** và đội tiếp tục các vé độc lập khác, không dừng cả chương trình.

### 2. Kế hoạch gom PR tiết kiệm chi phí (C44 §2)

| Thứ tự PR | Nhánh đề xuất | Vé gom trong PR | Chế độ kiểm chứng | Nhánh bằng chứng đích |
|---|---|---|---|---|
| **PR #1** | `docs/c44-backlog-m3-m5` | C44 §4.1 (`docs/BACKLOG.md`) | `docs-only` (QA đọc diff + lint/guard, không cần đột biến) | Đẩy ngay `evidence/C44/BACKLOG.md` lên `origin/evidence/c44` (`[skip ci]`) |
| **PR #2** | `feat/c44-w2-stream-budget-track-w` | **`W-01`** (`W2` sửa bộ đếm ngân sách & `SKIPPED-QUOTA` + runner có cổng kiểm soát cho `W1`, `W3`, `W5`) | Không chung tệp với PR #1; giữ đủ Red-First + đột biến Engineer & QA cho `W2` | Kết quả chạy `W1`, `W3`, `W5` đưa vào `origin/evidence/c44` |
| **PR #3** | `feat/m3-packaging-and-resource-variance` | Gom **`M3-01`** (`P4` kiểm đóng gói tarball 5 OS, bỏ `.map`, `npm publish --dry-run`) + **`M3-02`** (`P5` đo tài nguyên có phương sai `>= 7` lần + `ADR-SQLITE-01`) | Red-First + test tự động 5 OS + đột biến Engineer & QA cho `pack-verify`/`resource-variance` | Phát hành gói `origin/evidence/m3` (`<= 10` tệp, `[skip ci]`) |
| **PR #4** | `feat/m4-docs-security-and-w4` | Gom **`M4-01`** (`P6` nhất quán tài liệu & hướng dẫn người dùng mới) + **`M4-02`** (`P7` kiểm toán bảo mật, cổng ghi router, `SECURITY.md`) + **`W-02`** (`W4` cập nhật `docs/9router-combo-findings.md`) | Red-First + test docs/fixture + đột biến Engineer & QA cho `M4-02` (bảo mật/cổng ghi) | Phát hành gói `origin/evidence/m4` và hoàn tất `origin/evidence/c44` (kèm **`M5-01`** `RELEASE-CANDIDATE.md`, `REPORT.md <= 120` dòng, `NOTE.md <= 40` dòng) |

### 3. Bảng tổng quan trạng thái các vé (M1–M5 & Track W)

| Mã vé | Cột mốc / Track | Hạng mục | PR | SHA `main` | Gói bằng chứng | Trạng thái |
|---|---|---|---|---|---|---|
| `M1-01` | M1 (`P1`) | Sức khỏe CI, tín hiệu `E2E-DAEMON-HEALTH-SIGNAL`, `ci-stats` sạch `[DEP0190]`, `docs/CI.md` | `#57` | `52b8894` | `evidence/m1` @ `987da9c` | **XONG** |
| `M1-02` | M1 (`P2`) | Known Issue 1: hợp nhất `comboModels` OmniRoute vào `readRouterModelState` & `apps drift` | `#58` | `1520e0f` | `evidence/m1` @ `987da9c` | **XONG** |
| `M1-03` | M1 (`P2`) | Known Issue 2: xuất `comboNames` vào `RouterModelState`, phân loại combo drift, `docs/known-issues.md` | `#59` | `618c233` | `evidence/m1` @ `987da9c` | **XONG** |
| `M2-01` | M2 (`P3.1`) | Khép kín vòng đời Grant (`ADR-MAINTAIN-02`) & Approval Token tương tác | `#62` | `7abfd74` | `evidence/m2` @ `4acc7c4` | **XONG** |
| `M2-02` | M2 (`P3.2`) | Hoàn thiện Outbound Webhook cảnh báo hành động (đích HTTP giả cục bộ) | `#64` | `8ca92f8` | `evidence/m2` @ `4acc7c4` | **XONG** |
| `M2-03` | M2 (`P3.3`) | Xác minh đọc lại đường phục vụ (Serving-Path Read-Back) trên 9Router & OmniRoute | `#65` | `bc61436` | `evidence/m2` @ `4acc7c4` | **XONG** |
| `M3-01` | M3 (`P4`) | Đóng gói tarball 5 OS, allowlist loại `.map`/`.agent`/`evidence`, `npm publish --dry-run` & `npm view` | PR #3 | — | `evidence/m3` | **SẴN SÀNG** |
| `M3-02` | M3 (`P5`) | Đo tài nguyên có phương sai (`n >= 7`) CLI + daemon & `ADR-SQLITE-01` (chỉ đề xuất) | PR #3 | — | `evidence/m3` | **SẴN SÀNG** |
| `M4-01` | M4 (`P6`) | Nhất quán tài liệu, hướng dẫn người dùng mới, số liệu từ công cụ, test `--help`/fixture | PR #4 | — | `evidence/m4` | **SẴN SÀNG** |
| `M4-02` | M4 (`P7`) | Kiểm toán bảo mật `main`/`evidence/*`/CI/tarball, test cổng ghi router, cập nhật `SECURITY.md` | PR #4 | — | `evidence/m4` | **SẴN SÀNG** |
| `M5-01` | M5 | Chuẩn bị `RELEASE-CANDIDATE.md` & hàng đợi `chờ chủ dự án` (KHÔNG publish, KHÔNG tag) | Không PR (`evidence/c44`) | — | `evidence/c44` | **SẴN SÀNG (sau M3–M4)** |
| `W-01` | Track W (`W2` + `W1/W3/W5`) | Sửa bộ đếm ngân sách & `SKIPPED-QUOTA` phía client + đối chiếu `usageHistory`, runner `W1/W3/W5` | PR #2 | — | `evidence/c44` | **SẴN SÀNG** |
| `W-02` | Track W (`W4`) | Cập nhật `docs/9router-combo-findings.md` mục `0.5.123`, sửa chiều `826 < 2 900`, bỏ ngoại suy, nhãn `chưa phân biệt` | PR #4 | — | `evidence/c44` | **SẴN SÀNG (sau W1/W3/W5)** |

---

## Cột mốc M1 — Sức khỏe CI (P1) & Known Issues 1 và 2 (P2) — `XONG`

- **Trạng thái thực tế:** **`XONG`** (`main` chứa đủ PR `#57` `52b8894`, PR `#58` `1520e0f`, PR `#59` `618c233`; gói bằng chứng `origin/evidence/m1` @ `987da9c8c652946dabd29a0a33d09e08a105ff8d` đạt verifier SẠCH 3 dòng, đã được người duyệt độc lập xác nhận).

---

### Vé `M1-01` — [P1] Sức khỏe CI: Điều tra `flake-hunt` & gắn cảnh báo tự động cho lỗi health daemon `e2e.test.ts`, làm sạch `ci-stats` và cập nhật `docs/CI.md` — **`XONG` (PR `#57`, `52b8894`, `evidence/m1` @ `987da9c`)**

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

### Vé `M1-02` — [P2] Known Issue 1: Hợp nhất model hoạt động từ `combos.data.models` vào `readRouterModelState` của OmniRoute & đồng bộ `apps drift` — **`XONG` (PR `#58`, `1520e0f`, `evidence/m1` @ `987da9c`)**

1. **Mục tiêu:**
   - Khắc phục triệt để Known Issue 1 trong `docs/known-issues.md`: trong `<REPO>/packages/core/src/domain/model-state.ts`, nhánh `isOmniRoute` (vùng dòng `715–720`) khi chưa hợp nhất `comboModels` vào `availableModels` lúc `!options.excludeComboModelsFromAvailability` (trong khi nhánh `is9Router` dòng `538–542` đã có) dẫn tới DB OmniRoute có model trong `combos.data.models` nhưng trống `syncedAvailableModels` bị trả `availableModels=0` mâu thuẫn với `routersync doctor`.
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

### Vé `M1-03` — [P2] Known Issue 2: Bổ sung tập `comboNames` vào `RouterModelState` & nhánh phân loại của `apps drift`, cập nhật `docs/known-issues.md` — **`XONG` (PR `#59`, `618c233`, `evidence/m1` @ `987da9c`)**

1. **Mục tiêu:**
   - Khắc phục triệt để Known Issue 2 trong `docs/known-issues.md`: xuất tập `comboNames: Set<string>` rõ ràng từ `readRouterModelState` (`@routersync/core`) và cập nhật hàm `classifyModelDrift` trong `<REPO>/packages/cli/src/apps/drift.ts` (vùng dòng `285–407`) để đối chiếu `view.comboNames` (cho cả tên trần `9Router-Coder-1`, `OmniRoute-Coder-1` và dạng có tiền tố router `9router/9Router-Coder-1`), trả về `status: 'OK'` với `kind: 'combo'` thay vì rơi xuống `MISSING`.
   - Cập nhật `<REPO>/docs/known-issues.md` để ghi nhận cả Known Issue 1 (`M1-02`) và Known Issue 2 (`M1-03`) đã được giải quyết kèm tham chiếu test kiểm chứng.
2. **Tiêu chí chấp nhận (đỏ trước – xanh sau):**
   - **Đỏ trước:** Viết bài test tái hiện ứng dụng (`hermes`, `dsh`, `opencode`) trỏ tới tên combo `9Router-Coder-1` và `OmniRoute-Coder-1` (cả có tiền tố lẫn không tiền tố) và ca âm tính (`9Router-Khong-Ton-Tai` vẫn phải là `MISSING`) — xác nhận test **đỏ** trên `c28b7fb` (do trả `MISSING`).
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

## Cột mốc M2 — Phase 3 S2: Grant Lifecycle (`ADR-MAINTAIN-02`), Outbound Webhook & Đọc lại Đường Phục vụ (P3) — `XONG`

- **Trạng thái thực tế:** **`XONG`** (`main` chứa đủ PR `#62` `7abfd74`, PR `#64` `8ca92f8`, PR `#65` `bc61436`; gói bằng chứng `origin/evidence/m2` @ `4acc7c45e8aa7989f0a2dcf4baba9972bf8dcd06` đạt verifier SẠCH 3 dòng, đã được người duyệt độc lập xác nhận).

---

### Vé `M2-01` — [P3.1] Kiểm chứng toàn diện & khép kín vòng đời Grant theo `ADR-MAINTAIN-02` và trao đổi Approval Token tương tác — **`XONG` (PR `#62`, `7abfd74`, `evidence/m2` @ `4acc7c4`)**

1. **Mục tiêu:**
   - Đối chiếu mã đã có trong `<REPO>/packages/cli/src/maintain/grant.ts`, `<REPO>/packages/cli/src/commands/maintain.ts` (`authorize`, `grant-status`, `revoke-grant`, `secret-selftest`, `validateGrantFile`, `checkGrantScope`) và luồng approval token phía daemon (`packages/daemon/src/handlers/approval.ts`, `packages/daemon/src/security/approval-token.ts`) với toàn bộ yêu cầu của `ADR-MAINTAIN-02` để lấp kín mọi khe hở kiểm tra hoặc thông điệp lỗi chưa khớp đặc tả.
   - Xây dựng bộ test hợp đồng tự động đầy đủ cho vòng đời grant & approval token tương tác, đồng thời cập nhật `docs/adr/ADR-MAINTAIN-02-apply-grant-lifecycle.md` (xóa tham chiếu lỗi thời tới `tools/maintain/test-apply-grant.mjs` không tồn tại, trỏ tới bộ test Vitest thật chạy trên 5 OS) và giữ nguyên tuyên bố trung thực về giới hạn PTY ở mục 4.
2. **Tiêu chí chấp nhận (đỏ trước – xanh sau):**
   - **Đỏ trước:** Viết bộ test kiểm tra toàn bộ ma trận từ chối & vòng đời (`no-tty`, `yes-flag`, `only-pattern` `^test-\d+(,test-\d+)*$`, `hours-range` `1..8`, `agents-invalid`, `grant-invalid`, `grant-expired`, `grant-scope`, thu hồi `revoke-grant`, dùng lại approval token một lần / hết hạn / sai chữ ký, không rò rỉ khóa HMAC ra stdout/stderr) và test tài liệu kiểm tra đường dẫn tệp test nêu trong `ADR-MAINTAIN-02` phải tồn tại thật — xác nhận test **đỏ** trước khi cập nhật mã & ADR.
   - **Xanh sau:**
     - Toàn bộ bộ test vòng đời grant & approval token xanh trong môi trường kín (`os.tmpdir()`), không thêm cờ bypass `--yes`, không chạm router thật.
     - `ADR-MAINTAIN-02` khớp 100% đường dẫn tệp test thật và giữ nguyên mục 4 về giới hạn PTY.
     - PR xanh đủ **5 hệ điều hành** trên head cuối, Ops squash-merge, CI `main` `attempt=1` xanh.
3. **Người làm:** **Engineer** (**CTO** duyệt hợp nhất thiết kế contract; **Ops** chạy `gh pr merge --squash` sau khi QA ký).
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

### Vé `M2-02` — [P3.2] Hoàn thiện Outbound Webhook gửi thông báo cảnh báo hành động (dùng đích giả trong test) — **`XONG` (PR `#64`, `8ca92f8`, `evidence/m2` @ `4acc7c4`)**

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
   - `<REPO>/packages/core/src/notify/webhook.ts`
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

### Vé `M2-03` — [P3.3] Xác minh đọc lại đường phục vụ (Serving-Path Read-Back) trên cả 9Router và OmniRoute — **`XONG` (PR `#65`, `bc61436`, `evidence/m2` @ `4acc7c4`)**

1. **Mục tiêu:**
   - Khắc phục chỗ lệch phát hiện ở M0.2 trong `<REPO>/packages/cli/src/commands/maintain.ts` (dòng `793, 1015–1034` khi mới đọc lại SQLite DB rồi in cứng `READBACK ok=yes`) và chuẩn hóa hợp đồng đọc lại đường phục vụ HTTP trên **cả hai router (`adapter-9router` và `adapter-omniroute`)** xuyên suốt `applier`, `maintain`, `status` và daemon `targets`.
   - Đảm bảo báo cáo trung thực `ReadBackLevel` (`api-verified`, `existence-only`, `db-only`) kèm `degradedReason` khi đường phục vụ phản ánh ngay, phản ánh trễ trong hạn `servingWaitMs`, hết hạn chờ (`staleDetected`), hoặc không kết nối được HTTP; cập nhật dấu hoàn tất S2 trong `docs/ROADMAP.md` sau khi đóng đủ P3.1–P3.3.
2. **Tiêu chí chấp nhận (đỏ trước – xanh sau):**
   - **Đỏ trước:** Viết bộ test hợp đồng đối xứng cho **cả 9Router và OmniRoute** trên `fake-router.ts` + fixture SQLite DB kiểm tra: (i) `maintain apply`/`create` và `applier` thực sự gọi xác minh đường phục vụ HTTP thay vì in cứng `READBACK ok=yes` khi HTTP trả dữ liệu cũ hoặc lỗi `503`; (ii) đủ 5 kịch bản (khớp ngay, khớp sau vài nhịp poll trong `servingWaitMs`, quá hạn `staleDetected`, mất kết nối suy giảm về `db-only` có lý do, và chế độ cô lập không gọi mạng) — xác nhận **đỏ** trên `c28b7fb`.
   - **Xanh sau:**
     - Toàn bộ bộ test đọc lại đường phục vụ trên cả 9Router và OmniRoute xanh (`0` cuộc gọi tới cổng `20128`/`30128` thật; toàn bộ test hermetic `at-98`, `at-113`, `at-127`, `at-157` xanh).
     - PR xanh đủ **5 hệ điều hành** trên head cuối, Ops squash-merge, CI `main` `attempt=1` xanh; gói `evidence/m2` đạt sạch mọi verifier.
3. **Người làm:** **Engineer** (**CTO** duyệt hợp nhất hợp đồng `ReadBackLevel` giữa 2 adapter, `applier` và `maintain`; **Ops** chạy `gh pr merge --squash` sau khi QA ký).
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

## Cột mốc M3 — Đóng gói phát hành (P4) & Đo tài nguyên có phương sai + ADR SQLite (P5)

- **Kế hoạch gom PR (C44 §2):** Gom **`M3-01`** + **`M3-02`** vào chung **PR #3** (`feat/m3-packaging-and-resource-variance`).
- **Gói bằng chứng đích:** Nhánh `origin/evidence/m3` (`evidence/M3/`, `[skip ci]`, không PR, không merge, tối đa `10` tệp, `gh run list --branch evidence/m3` rỗng).

---

### Vé `M3-01` — [P4] Kiểm đóng gói tarball 5 hệ điều hành, allowlist tệp (loại `.map`/`.agent`/`evidence`), `npm publish --dry-run` & kiểm `npm view` chỉ đọc

1. **Mục tiêu:**
   - Chuẩn hóa danh sách tệp đóng gói của cả **8 gói công bố** (`@routersync/adapter-sdk`, `@routersync/core`, `@routersync/adapter-9router`, `@routersync/adapter-omniroute`, `@routersync/sources`, `@routersync/daemon`, `@routersync/cli`, `@routersync/mcp-server`, `version: 0.1.0`, `private: false`; không công bố gói gốc `routersync` và `@routersync/ui` đang `private: true`) bằng cách cập nhật `"files": ["dist", "!dist/**/*.map"]` để vẫn giữ `"dist"` (thỏa `test/acceptance/at-168-package-hygiene.test.ts`) nhưng loại sạch tệp bản đồ nguồn `.js.map` / `.d.ts.map` không cần thiết khỏi tarball.
   - Xây dựng công cụ kiểm chứng đóng gói `<REPO>/tools/agent/pack-verify.mjs` (và tích hợp bước kiểm trong `.github/workflows/ci.yml` trên đủ **5 hệ điều hành**): chạy `npm pack` cho từng gói công bố, kiểm tra allowlist nghiêm ngặt trên từng tarball thô (chỉ cho phép `package/package.json`, `package/README.md` / `package/LICENSE` nếu có, và `package/dist/**`; tuyệt đối không chứa `.map`, `evidence/`, `.agent/`, `.env`, tệp cấu hình riêng hay đường dẫn cá nhân), chạy `npm publish --dry-run` (chỉ dry-run, không publish thật) và lưu kích thước tarball `đo được` của từng gói vào gói bằng chứng `evidence/m3`.
   - Cài đặt bộ tarball đã đóng gói vào một thư mục sạch hoàn toàn tách khỏi workspace trên đủ **5 hệ điều hành của CI** (`ubuntu-latest`, `ubuntu-24.04-arm`, `macos-latest`, `windows-latest`, `windows-11-arm`; xử lý liên kết `workspace:*` qua staging tarball cục bộ như mô hình `tools/ci/footprint.mjs`), sau đó chạy xác minh trực tiếp `routersync --version`, `routersync doctor` và một lệnh chỉ đọc trên fixture (`routersync combos stale` hoặc `routersync verify`).
   - Ghi nhận kết quả kiểm tra chỉ đọc trên npm registry bằng `npm view` cho cả 8 gói công bố (đối chiếu lúc `2026-11-23T22:19Z`: cả 8 gói `@routersync/*` trả `E404 Not Found` — chưa bị chiếm; yêu cầu tạo/sở hữu scope `@routersync` trên npm xếp vào hàng đợi `chờ chủ dự án`; nếu ở thời điểm chạy lại phát hiện tên nào bị chiếm thì ghi rõ vào hàng đợi `chờ chủ dự án`).
2. **Tiêu chí chấp nhận (đỏ trước – xanh sau):**
   - **Đỏ trước:** Viết bộ test `<REPO>/test/agent/pack-verify.node.test.mjs` kiểm tra: (i) allowlist từ chối `.js.map` / `.d.ts.map`, `evidence/`, `.agent/`, `.env`, tệp cấu hình riêng; (ii) đối chiếu tarball đóng gói hiện tại từ `main` @ `bc61436` (vốn đang chứa `.map` do `tsconfig.base.json` bật `sourceMap`/`declarationMap` và `"files": ["dist"]`) — xác nhận test **đỏ** trước khi cập nhật `"files"` ở 8 `package.json`.
   - **Xanh sau:**
     - Toàn bộ `8/8` gói công bố đạt `npm pack` + kiểm tra allowlist SẠCH (`0` tệp `.map`, `0` tệp ngoài danh sách cho phép) và `npm publish --dry-run` thoát mã `0` (lưu đầu ra vào `evidence/M3/`).
     - Cài đặt bộ tarball vào thư mục sạch và chạy thành công `routersync --version`, `routersync doctor`, cùng lệnh chỉ đọc trên fixture trên đủ **5 hệ điều hành trong CI** (`ubuntu-latest`, `ubuntu-24.04-arm`, `macos-latest`, `windows-latest`, `windows-11-arm`).
     - Có đột biến của Engineer và đột biến riêng của QA chứng minh bộ kiểm allowlist bắt được tệp `.map` / `.env` / `evidence/` khi cố tình tiêm vào tarball giả.
     - Test hiện hữu `test/acceptance/at-168-package-hygiene.test.ts` vẫn xanh; PR #3 xanh đủ **5 hệ điều hành**, Ops squash-merge, CI `main` xanh ở `attempt=1`, gói `origin/evidence/m3` đạt verifier SẠCH.
3. **Người làm:** **Engineer** (**CTO** duyệt chiến lược xử lý `workspace:*` trong cài thử tarball và allowlist đóng gói; **Ops** thực hiện `gh pr merge --squash` và xuất bản nhánh `evidence/m3` sau khi QA ký).
4. **Người xác minh độc lập:** **QA** (khác Engineer; tự xác minh đỏ-trước xanh-sau, chạy đột biến riêng trên allowlist tarball, đối chiếu log cài tarball sạch trên đủ 5 OS, chạy `verify-records.mjs`, `verify-package.mjs`, `scan-private-names.mjs`).
5. **Tệp dự kiến:**
   - `<REPO>/packages/adapter-sdk/package.json`
   - `<REPO>/packages/core/package.json`
   - `<REPO>/packages/adapter-9router/package.json`
   - `<REPO>/packages/adapter-omniroute/package.json`
   - `<REPO>/packages/sources/package.json`
   - `<REPO>/packages/daemon/package.json`
   - `<REPO>/packages/cli/package.json`
   - `<REPO>/packages/mcp-server/package.json`
   - `<REPO>/tools/agent/pack-verify.mjs` *(mới)*
   - `<REPO>/test/agent/pack-verify.node.test.mjs` *(mới)*
   - `<REPO>/.github/workflows/ci.yml`
6. **Rủi ro:**
   - Tham chiếu `workspace:*` trong `package.json` khiến `npm install <tarball>` trực tiếp báo lỗi `EUNSUPPORTEDPROTOCOL` → giải quyết bằng cách viết lại bản sao staging tạm (như `tools/ci/footprint.mjs`) thành đường dẫn `file:` tới đúng 8 tarball vừa đóng gói trong thư mục tạm sạch, giữ nguyên tệp gốc trong repo.
   - `better-sqlite3` cần biên dịch native trên môi trường không có prebuild (đặc biệt ARM/Windows) khi cài tarball sạch trong CI → tận dụng cache/toolchain chuẩn của runner CI và ghi nhận thẳng bất kỳ chi phí cài đặt nào làm đầu vào thực chứng cho `M3-02` (`ADR-SQLITE-01`).
   - Nhầm lẫn chạy `npm publish` thật thay vì `--dry-run` → khóa cứng cờ `--dry-run` trong `pack-verify.mjs`, không đăng nhập npm token trong môi trường chạy, và có unit test khẳng định lệnh gọi luôn chứa `--dry-run`.
7. **Lệnh kiểm chứng:**
   ```sh
   node tools/agent/preflight.mjs
   node --test test/agent/pack-verify.node.test.mjs
   pnpm test:file test/acceptance/at-168-package-hygiene.test.ts
   RS_EVIDENCE_DIR=evidence/M3 node tools/agent/capture-evidence.mjs m3-01-pack-verify -- node tools/agent/pack-verify.mjs --dry-run
   pnpm prepush
   node tools/agent/ci-watch.mjs --sha <head-sha>
   node tools/agent/verify-records.mjs evidence/M3/records.jsonl evidence/M3
   node tools/agent/verify-package.mjs evidence/M3
   node tools/agent/scan-private-names.mjs evidence/m3
   ```

---

### Vé `M3-02` — [P5] Đo tài nguyên có phương sai (`n >= 7` lần) cho CLI & daemon qua `capture-evidence.mjs` và lập `ADR-SQLITE-01` (chỉ đề xuất)

1. **Mục tiêu:**
   - Xây dựng công cụ đo tài nguyên lặp có thống kê phương sai `<REPO>/tools/agent/resource-variance.mjs` (kèm unit test `<REPO>/test/agent/resource-variance.node.test.mjs`), chạy trực tiếp qua `tools/agent/capture-evidence.mjs` để thu thập số liệu `đo được` trung thực trên máy hiện tại:
     - **Khởi động lạnh (`ms`)** của `routersync` CLI (`--version` và một lệnh chỉ đọc nhẹ) và của `daemon` (từ khi spawn tới `/health` sẵn sàng trên cổng cục bộ ngẫu nhiên).
     - **Bộ nhớ nghỉ (`MB` — RSS và heap)** của `routersync` CLI và của `daemon` ở trạng thái rảnh ổn định.
     - Tối thiểu **`n >= 7` lần đo độc lập** cho mỗi mục, tính và báo cáo đầy đủ: `n`, trung bình (`mean`), độ lệch chuẩn mẫu (`stddev`), nhỏ nhất (`min`), lớn nhất (`max`), kèm **RAM trống lúc đo (`freeMemMB`)** cho từng lần đo.
   - Lập đề xuất kiến trúc `<REPO>/docs/adr/ADR-SQLITE-01-better-sqlite3-vs-node-sqlite.md` so sánh **`better-sqlite3`** với **`node:sqlite`** trên đủ 4 tiêu chí bắt buộc: (1) chi phí cài đặt & build native, (2) mức độ tương thích trên đủ **5 hệ điều hành** (`ubuntu-latest`, `ubuntu-24.04-arm`, `macos-latest`, `windows-latest`, `windows-11-arm`) và **Node 22 / Node 24**, (3) kích thước cài đặt/tarball, (4) hiệu năng đọc đo được trên fixture DB.
   - **Ràng buộc phạm vi cứng:** `ADR-SQLITE-01` **chỉ là văn bản đề xuất**; tuyệt đối **không đổi phụ thuộc** trong `package.json` hay mã sản phẩm khi chưa có quyết định của chủ dự án (xếp quyết định chuyển đổi vào hàng đợi `chờ chủ dự án`).
2. **Tiêu chí chấp nhận (đỏ trước – xanh sau):**
   - **Đỏ trước:** Viết `<REPO>/test/agent/resource-variance.node.test.mjs` kiểm chứng: (i) công thức thống kê `mean`, `stddev`, `min`, `max` trên chuỗi mẫu biết trước; (ii) ràng buộc từ chối khi `runs < 7`; (iii) kiểm cấu trúc JSON/Markdown đầu ra bắt buộc có đủ `n >= 7`, `mean`, `stddev`, `min`, `max`, `freeMemMB`, và nhãn `đo được`; (iv) xác nhận test **đỏ** trước khi triển khai `resource-variance.mjs`.
   - **Xanh sau:**
     - `node --test test/agent/resource-variance.node.test.mjs` xanh; có đột biến Engineer và QA trên hàm tính thống kê & cổng `runs < 7`.
     - Chạy thật `resource-variance.mjs` qua `capture-evidence.mjs` ghi đủ `n >= 7` lần cho cả CLI và daemon, đầu ra nằm trong `evidence/M3/` và vượt qua `verify-records.mjs`.
     - `<REPO>/docs/adr/ADR-SQLITE-01-better-sqlite3-vs-node-sqlite.md` hoàn chỉnh đủ 4 trục so sánh với số liệu `đo được` gắn nguồn rõ ràng, không chạm `dependencies` trong bất kỳ `package.json` nào, và vượt qua `pnpm lint` + `scan-private-names.mjs` (`0` khớp).
     - PR #3 xanh đủ **5 hệ điều hành**, Ops squash-merge, CI `main` `attempt=1` xanh, gói `origin/evidence/m3` đạt verifier SẠCH.
3. **Người làm:** **Engineer** lập `resource-variance.mjs` + test + số đo; **CTO** chủ trì lập & ký kỹ thuật `ADR-SQLITE-01-better-sqlite3-vs-node-sqlite.md`; **Ops** chạy `gh pr merge --squash` và đẩy `origin/evidence/m3` sau khi QA ký.
4. **Người xác minh độc lập:** **QA** (khác Engineer; kiểm chứng đỏ-trước xanh-sau, đối chiếu số đo `n >= 7` trong `evidence/M3/` khớp đúng số trích dẫn trong `ADR-SQLITE-01` và `REPORT.md`, kiểm xác nhận `package.json` không đổi phụ thuộc SQLite, chạy `verify-records.mjs`, `verify-package.mjs`, `scan-private-names.mjs`).
5. **Tệp dự kiến:**
   - `<REPO>/tools/agent/resource-variance.mjs` *(mới)*
   - `<REPO>/test/agent/resource-variance.node.test.mjs` *(mới)*
   - `<REPO>/docs/adr/ADR-SQLITE-01-better-sqlite3-vs-node-sqlite.md` *(mới)*
   - `<REPO>/tools/agent/capture-evidence.mjs` *(chỉ đọc/sử dụng; sửa nhẹ nếu cần hỗ trợ truyền cờ)*
6. **Rủi ro:**
   - Máy chủ đo đang ở trạng thái RAM thấp (`LIGHT-DEV`, `< 1.50 GiB`) có thể gây phương sai cao ở thời gian khởi động lạnh → luôn ghi kèm `freeMemMB` tại từng lần đo, đóng sạch tiến trình daemon sau mỗi lần đo (`finally` + `kill`), không diễn giải vượt quá số đo.
   - `node:sqlite` trên Node 22 có cảnh báo thử nghiệm (`ExperimentalWarning`) và hành vi đóng/mở DB khác `better-sqlite3` → ghi nhận trung thực trong `ADR-SQLITE-01` theo đúng kết quả thử nghiệm thực tế trên Node 22 & Node 24, không kết luận thiếu chứng cứ.
7. **Lệnh kiểm chứng:**
   ```sh
   node tools/agent/preflight.mjs
   node --test test/agent/resource-variance.node.test.mjs
   RS_EVIDENCE_DIR=evidence/M3 node tools/agent/capture-evidence.mjs m3-02-resource-variance -- node tools/agent/resource-variance.mjs --runs 7
   pnpm lint
   pnpm prepush
   node tools/agent/ci-watch.mjs --sha <head-sha>
   node tools/agent/verify-records.mjs evidence/M3/records.jsonl evidence/M3
   node tools/agent/verify-package.mjs evidence/M3
   node tools/agent/scan-private-names.mjs evidence/m3
   ```

---

## Cột mốc M4 — Nhất quán tài liệu & Hướng dẫn người dùng mới (P6) + Kiểm toán bảo mật (P7)

- **Kế hoạch gom PR (C44 §2):** Gom **`M4-01`** + **`M4-02`** + **`W-02`** vào chung **PR #4** (`feat/m4-docs-security-and-w4`).
- **Gói bằng chứng đích:** Nhánh `origin/evidence/m4` (`evidence/M4/`, `[skip ci]`, không PR, không merge, tối đa `10` tệp, `gh run list --branch evidence/m4` rỗng).

---

### Vé `M4-01` — [P6] Nhất quán tài liệu, hướng dẫn cài đặt cho người dùng mới, số liệu chỉ lấy từ công cụ & test tự động `--help`/fixture

1. **Mục tiêu:**
   - Khớp hóa 100% giữa tài liệu và mã nguồn trên `README.md`, `docs/SETUP.md`, `docs/ROADMAP.md`, `docs/known-issues.md`, và `docs/CI.md`:
     - Sửa toàn bộ thông tin lạc hậu trong `<REPO>/docs/SETUP.md` (cập nhật `Node >= 22.12.0` thay cho `>= 20.0.0`, `pnpm >= 10.0.0` thay cho `>= 9.0.0`, `pnpm hooks:install` thay cho `git config core.hooksPath tools/guard`, rà khớp `.env.example`).
     - Bổ sung mục **Hướng dẫn cài đặt & dùng thử cho người dùng mới** (tối thiểu đủ 4 chặng: (1) cài đặt, (2) chạy `routersync doctor`, (3) chạy `routersync combos stale`, (4) chạy thử chế độ chỉ đọc với **9Router** và **OmniRoute**).
     - Cập nhật mọi bảng số liệu trong `<REPO>/docs/CI.md` (§5) và các tài liệu liên quan hoàn toàn từ đầu ra mới nhất của công cụ (`node tools/agent/ci-stats.mjs`, `pack-verify.mjs`, `resource-variance.mjs`), tuyệt đối không chép tay hay suy đoán số liệu.
     - Đồng bộ hiện trạng M1–M3 / Phase 3 S2 trong `<REPO>/docs/ROADMAP.md` và `<REPO>/docs/known-issues.md`.
   - Mở rộng bộ test tự động (`<REPO>/test/docs/agent-docs.test.ts` và/hoặc `<REPO>/test/docs/docs-cli-examples.test.ts`) để tự động kiểm tra mọi lệnh `routersync ...` được nêu trong `README.md` và `docs/` qua `--help` thật của CLI, đồng thời thực thi các lệnh ví dụ chỉ đọc trên fixture DB cô lập (`doctor`, `combos stale`, chạy thử chỉ đọc 9Router & OmniRoute).
2. **Tiêu chí chấp nhận (đỏ trước – xanh sau):**
   - **Đỏ trước:** Viết/mở rộng test tự động trong `test/docs/agent-docs.test.ts` (và `test/docs/docs-cli-examples.test.ts`) kiểm tra: (i) yêu cầu phiên bản Node/pnpm trong `docs/SETUP.md` khớp `package.json` `engines` và `.nvmrc`; (ii) lệnh cài hook dùng `pnpm hooks:install`; (iii) sự hiện diện của đủ 4 bước hướng dẫn người dùng mới (cài đặt, `doctor`, `combos stale`, chạy thử chỉ đọc 9Router & OmniRoute); (iv) chạy thật `--help` và ví dụ chỉ đọc trên fixture cho các lệnh nêu trong `README.md` và `docs/` — xác nhận test **đỏ** trên mã nền trước khi sửa tài liệu.
   - **Xanh sau:**
     - Toàn bộ `test/docs/` xanh trên đủ **5 hệ điều hành** (`0` cuộc gọi tới router thật hay Internet; fixture DB giữ nguyên `sha256`).
     - Số liệu trong `docs/CI.md` khớp chính xác đầu ra của `node tools/agent/ci-stats.mjs` lưu trong `evidence/M4/`.
     - `README.md`, `docs/SETUP.md`, `docs/ROADMAP.md`, `docs/known-issues.md`, `docs/CI.md` sạch `no-personal-paths`, `no-secrets`, `K6.2` và `scan-private-names.mjs` (`0` khớp).
     - PR #4 xanh đủ **5 hệ điều hành**, Ops squash-merge, CI `main` `attempt=1` xanh, gói `origin/evidence/m4` đạt verifier SẠCH.
3. **Người làm:** **PM** chủ trì nội dung hướng dẫn người dùng mới & rà soát `README.md`/`ROADMAP.md`/`known-issues.md`; **Engineer** viết test tự động `--help`/fixture và đồng bộ số liệu `docs/CI.md`/`docs/SETUP.md`; **CTO** duyệt nhất quán kỹ thuật; **Ops** thực hiện `gh pr merge --squash` sau khi QA ký.
4. **Người xác minh độc lập:** **QA** (khác Engineer; tự kiểm chứng đỏ-trước xanh-sau, tự chạy lại các bước hướng dẫn người dùng mới trên môi trường sạch/fixture, đối chiếu số liệu `docs/CI.md` với đầu ra `ci-stats.mjs`, chạy `verify-records.mjs` & `verify-package.mjs`).
5. **Tệp dự kiến:**
   - `<REPO>/README.md`
   - `<REPO>/docs/SETUP.md`
   - `<REPO>/docs/CI.md`
   - `<REPO>/docs/ROADMAP.md`
   - `<REPO>/docs/known-issues.md`
   - `<REPO>/test/docs/agent-docs.test.ts`
   - `<REPO>/test/docs/docs-cli-examples.test.ts` *(mới)*
6. **Rủi ro:**
   - `K8.6` (`DOC_PATH_RE` trong `test/docs/agent-docs.test.ts`) yêu cầu mọi đường dẫn dạng `docs/...`, `packages/...`, `tools/...`, `test/...` được nhắc trong các tài liệu đăng ký phải tồn tại thật trên repo → kiểm tra toàn bộ đường dẫn trích dẫn trước khi commit bằng `pnpm test:file test/docs/agent-docs.test.ts`.
   - Ví dụ trong hướng dẫn người dùng mới vô tình chạm router thật đang chạy trên máy → truyền biến môi trường trỏ tới fixture DB cô lập trong `os.tmpdir()` khi chạy test tự động và ghi rõ ví dụ minh họa dùng đường dẫn mẫu `<USER_DIR>/...`.
7. **Lệnh kiểm chứng:**
   ```sh
   node tools/agent/preflight.mjs
   pnpm test:file test/docs/agent-docs.test.ts test/docs/docs-cli-examples.test.ts
   RS_EVIDENCE_DIR=evidence/M4 node tools/agent/capture-evidence.mjs m4-01-ci-stats -- node tools/agent/ci-stats.mjs
   pnpm lint
   pnpm prepush
   node tools/agent/ci-watch.mjs --sha <head-sha>
   node tools/agent/verify-records.mjs evidence/M4/records.jsonl evidence/M4
   node tools/agent/verify-package.mjs evidence/M4
   node tools/agent/scan-private-names.mjs evidence/m4
   ```

---

### Vé `M4-02` — [P7] Kiểm toán bảo mật `main` / `evidence/*` / log CI / tarball, danh sách kiểm có test cho cổng ghi router & cập nhật `SECURITY.md`

1. **Mục tiêu:**
   - Xây dựng công cụ kiểm toán bảo mật có thể tái chạy `<REPO>/tools/agent/security-audit.mjs` (và unit test `<REPO>/test/agent/security-audit.node.test.mjs`) quét toàn bộ 4 bề mặt bắt buộc theo C44 §4.3:
     1. Nhánh **`main`** (toàn bộ tệp tracked),
     2. Các nhánh **`evidence/*`** đã phát hành (`evidence/c43`, `evidence/m1`, `evidence/m2`, `evidence/m3`, `evidence/c44` hiện có),
     3. **Log CI công khai gần nhất** (tải chỉ đọc qua `gh run view --log`),
     4. Toàn bộ **tarball đóng gói** của 8 gói công bố từ `M3-01`.
     Tìm kiếm: API key, bearer token, chuỗi bí mật/hash nhạy cảm, tên riêng, mẫu đường dẫn cá nhân, tệp `.env`, và chuỗi git bị cấm của `K6.2`.
   - Kiểm chứng toàn bộ các **cổng ghi router** (`grant`, `approval-token`, `--yes-write-router`) bằng một danh sách kiểm có test tự động (`<REPO>/test/acceptance/at-171-router-write-gates-audit.test.ts` hoặc mở rộng `<REPO>/test/acceptance/at-165-daemon-threat-model-approval.test.ts`), khẳng định mọi nhánh ghi đều fail-closed khi thiếu quyền/hết hạn/sai phạm vi/sai chữ ký/không TTY/thiếu xác nhận tường minh, không có lối tắt ẩn, và không rò rỉ bí mật ra stdout/stderr/log.
   - Cập nhật `<REPO>/SECURITY.md` cho người dùng cuối với đủ 3 phần tường minh: (i) cách báo lỗi bảo mật riêng tư, (ii) phạm vi áp dụng (bề mặt chỉ đọc so với bề mặt ghi có cổng xác nhận, hỗ trợ phiên bản `0.1.x`), và (iii) danh sách rõ ràng **những thứ RouterSync không bao giờ ghi ra đĩa** (API key, bearer token, khóa HMAC thô, thông tin định danh cá nhân/nhà cung cấp riêng trong log, báo cáo và tệp trạng thái).
   - Mọi phát hiện kiểm toán đều gắn mức độ (`Critical`/`High`/`Medium`/`Low`) và hướng xử lý trong báo cáo `evidence/M4/`; **mọi phát hiện mức Cao trở lên bắt buộc sửa ngay trong M4** (không trì hoãn sang sau v0.1).
2. **Tiêu chí chấp nhận (đỏ trước – xanh sau):**
   - **Đỏ trước:**
     - Viết test cho `security-audit.mjs` tiêm mẫu giả (key giả, đường dẫn cá nhân giả, `.env` giả trong tarball mẫu, tên riêng giả) → xác nhận bộ quét phát hiện chính xác và test **đỏ** trước khi hoàn thiện công cụ.
     - Viết bộ test danh sách kiểm cổng ghi router (`grant`, `approval-token`, `--yes-write-router`) và kiểm chứng nội dung `SECURITY.md` (phạm vi + danh sách thứ không ghi ra đĩa) → xác nhận test **đỏ** trên nền hiện tại trước khi hoàn thiện mã & `SECURITY.md`.
   - **Xanh sau:**
     - Kết quả chạy thật `security-audit.mjs` trên `main`, các nhánh `evidence/*`, log CI công khai gần nhất, và 8 tarball cho thấy **`0` phát hiện mức Cao/Nghiêm trọng tồn đọng** (nếu phát hiện lỗi mức Cao khi quét, đã sửa triệt để ngay trong PR #4 kèm test hồi quy; nếu lộ key/token thật thì kích hoạt ngay điều kiện dừng C44 §3).
     - Toàn bộ test danh sách kiểm cổng ghi router (`grant`, `approval-token`, `--yes-write-router`) xanh trên đủ **5 hệ điều hành**; có đủ **đột biến của Engineer và đột biến riêng của QA** chứng minh việc nới lỏng bất kỳ cổng ghi nào đều làm test đỏ ngay lập tức.
     - `<REPO>/SECURITY.md` đầy đủ cả 3 trụ cột và vượt qua `test/docs/` + `pnpm lint`.
     - PR #4 xanh đủ **5 hệ điều hành**, Ops squash-merge, CI `main` `attempt=1` xanh, gói `origin/evidence/m4` đạt verifier SẠCH.
3. **Người làm:** **Engineer** triển khai `security-audit.mjs`, bộ test cổng ghi router, bản vá cho phát hiện mức Cao (nếu có) và cập nhật `SECURITY.md`; **CTO** duyệt đánh giá mức độ rủi ro & thiết kế cổng ghi; **Ops** thực hiện `gh pr merge --squash` và đẩy `origin/evidence/m4` sau khi QA ký.
4. **Người xác minh độc lập:** **QA** (khác Engineer; kiểm chứng đỏ-trước xanh-sau, tự thực hiện đột biến riêng trên cổng ghi router & bộ quét bảo mật, đối chiếu biên bản kiểm toán 4 bề mặt, chạy `verify-records.mjs`, `verify-package.mjs`, `scan-private-names.mjs`).
5. **Tệp dự kiến:**
   - `<REPO>/SECURITY.md`
   - `<REPO>/tools/agent/security-audit.mjs` *(mới)*
   - `<REPO>/test/agent/security-audit.node.test.mjs` *(mới)*
   - `<REPO>/test/acceptance/at-171-router-write-gates-audit.test.ts` *(mới)*
   - `<REPO>/packages/cli/src/commands/apply.ts` *(chỉ sửa nếu kiểm toán phát hiện khe hở ở `--yes-write-router`)*
   - `<REPO>/packages/cli/src/maintain/grant.ts` *(chỉ sửa nếu kiểm toán phát hiện khe hở)*
   - `<REPO>/packages/daemon/src/security/approval-token.ts` *(chỉ sửa nếu kiểm toán phát hiện khe hở)*
6. **Rủi ro:**
   - Test kiểm toán bảo mật có thể tạo chuỗi giả giống token khiến `tools/guard/no-secrets.mjs` báo động giả → dựng mẫu kiểm thử động trong code test hoặc chú thích lý do hợp lệ trong thư mục `test/`, không lưu chuỗi thật ở bất cứ đâu.
   - Bản ghi log CI công khai rất dài dễ làm tràn ngữ cảnh hoặc quá thời gian tải → giới hạn quét theo các run gần nhất của `main` và PR M1–M3, chỉ lưu bản tóm tắt đếm vi phạm (không in nguyên văn giá trị nhạy cảm nếu gặp) vào `evidence/M4/`.
7. **Lệnh kiểm chứng:**
   ```sh
   node tools/agent/preflight.mjs
   node --test test/agent/security-audit.node.test.mjs
   pnpm test:file test/acceptance/at-171-router-write-gates-audit.test.ts
   RS_EVIDENCE_DIR=evidence/M4 node tools/agent/capture-evidence.mjs m4-02-security-audit -- node tools/agent/security-audit.mjs
   pnpm lint
   pnpm prepush
   node tools/agent/ci-watch.mjs --sha <head-sha>
   node tools/agent/verify-records.mjs evidence/M4/records.jsonl evidence/M4
   node tools/agent/verify-package.mjs evidence/M4
   node tools/agent/scan-private-names.mjs evidence/m4
   ```

---

## Cột mốc M5 — Chuẩn bị tới cổng phát hành (KHÔNG phát hành)

- **Nguyên tắc thẩm quyền (C44 §3, §4.4–§4.5):** Đội chỉ chuẩn bị đầy đủ hồ sơ tới ngay trước cổng phát hành trên nhánh `origin/evidence/c44`. **Đội TUYỆT ĐỐI KHÔNG chạy `npm publish`, KHÔNG tạo tag phát hành, KHÔNG mở M5 thay chủ dự án.**

---

### Vé `M5-01` — [M5] Chuẩn bị `RELEASE-CANDIDATE.md` trong `evidence/c44` tới cổng phát hành & tổng hợp hàng đợi `chờ chủ dự án`

1. **Mục tiêu:**
   - Sau khi `M3` (`origin/evidence/m3`), `M4` (`origin/evidence/m4`) và toàn bộ Track W (`W1–W5`) đã có kết quả đã xác minh, biên soạn tệp `evidence/C44/RELEASE-CANDIDATE.md` trên nhánh `origin/evidence/c44` (không tạo PR, không merge vào `main`) đầy đủ 6 nội dung bắt buộc của C44 §4.4:
     1. **Danh sách kiểm GO/NO-GO** có đánh dấu trạng thái từng hạng mục (`đủ bằng chứng` kèm dẫn chiếu PR, SHA `main`, CI `attempt=1`, nhánh `evidence/*`; hoặc `chờ chủ dự án`).
     2. **Đề xuất số phiên bản** (`0.1.0` hoặc `0.1.0-rc.1` kèm phân tích rõ điều kiện) và **bản dự thảo `CHANGELOG`** tổng hợp đúng các thay đổi đã merge từ M1–M4 và Track R/W.
     3. **Tóm tắt kết quả `npm publish --dry-run`** và bảng kích thước tarball `đo được` của cả 8 gói công bố (`M3-01`) cùng số đo tài nguyên `đo được` (`M3-02`).
     4. **Bộ lệnh phát hành viết sẵn để chủ dự án tự gõ** (gắn tag đơn lẻ và đẩy tag tường minh như `git tag -a v0.1.0 -m "v0.1.0"` và `git push origin v0.1.0`, kèm lệnh xuất bản npm từng gói; tuyệt đối không dùng lệnh đẩy hàng loạt tag hay đẩy nhánh `master` cũ; **đội không thực thi các lệnh này**).
     5. **Phần mở rộng sau `v0.1`:** liệt kê đầy đủ **17 mục ngoài phạm vi** đã chốt từ `docs/ROADMAP.md` và kế hoạch chương trình để ngăn phình phạm vi trước cổng phát hành.
     6. **Hàng đợi `chờ chủ dự án` đánh số liên tục:** gom toàn bộ câu hỏi mở (OQ) cần quyết định của chủ dự án (khởi tạo/sở hữu scope `@routersync` trên npm và xử lý tên nếu có xung đột; quyết định giữ `better-sqlite3` hay lên kế hoạch `node:sqlite` theo `ADR-SQLITE-01`; quyết định có áp `PATCH_V3` hay không theo kết luận `W1`; quyết định tạo combo `rs-fast` nếu `W5` chưa đo; quyết định chốt số phiên bản, gắn tag và chạy `npm publish`).
   - Hoàn thiện đồng bộ `evidence/C44/REPORT.md` (`<= 120` dòng, bảng PR & CI gọn một dòng mỗi PR, dẫn liên kết tới biên bản đột biến QA trên PR) và `evidence/C44/NOTE.md` (nguyên văn tin báo cuối của CEO `<= 40` dòng, đã che tên riêng), bảo đảm tổng số tệp trên nhánh `origin/evidence/c44` không vượt `10` tệp.
2. **Tiêu chí chấp nhận (kiểm chứng tài liệu & verifier):**
   - **Kiểm chứng cấu trúc & nội dung:** `RELEASE-CANDIDATE.md` có đủ 6 phần theo C44 §4.4; mọi con số tài nguyên và kích thước tarball mang nhãn `đo được` khớp 100% với `evidence/m3` và `evidence/m4`; không còn mục bỏ trống hay số liệu tự suy đoán; danh sách `chờ chủ dự án` đánh số liên tục không trùng lặp; bộ lệnh viết sẵn cho chủ dự án không chứa chuỗi git bị cấm của `K6.2`.
   - **Kiểm chứng không vượt thẩm quyền:** `git tag -l` và lịch sử npm registry không có bất kỳ tag mới hay bản publish thật nào do đội tạo ra.
   - **Kiểm chứng verifier gói bằng chứng:** Nhánh `origin/evidence/c44` có `<= 10` tệp, commit kèm `[skip ci]`, không mở PR, `gh run list --branch evidence/c44` rỗng, `verify-records.mjs` SẠCH, `verify-package.mjs` OK, và `scan-private-names.mjs` đạt `0` khớp.
3. **Người làm:** **PM** chủ trì biên soạn `RELEASE-CANDIDATE.md` & gom hàng đợi `chờ chủ dự án`; **CTO** rà soát phần kỹ thuật, lệnh phát hành viết sẵn và đề xuất `ADR-SQLITE-01`/`W1`; **CEO** soạn `NOTE.md` (`<= 40` dòng) & đóng chương trình; **Ops** đóng gói và đẩy nhánh `origin/evidence/c44` (`[skip ci]`) sau khi QA ký.
4. **Người xác minh độc lập:** **QA** (khác người soạn; đối chiếu từng dòng danh sách GO/NO-GO với PR/SHA/nhánh evidence thật, xác minh `REPORT.md <= 120` dòng, `NOTE.md <= 40` dòng, số tệp `<= 10`, không có tag/publish ngoài phép, và chạy lại đủ 3 verifier).
5. **Tệp dự kiến:**
   - `evidence/C44/RELEASE-CANDIDATE.md` *(mới — chỉ trên nhánh `origin/evidence/c44`, không đưa lên `main`)*
   - `evidence/C44/REPORT.md` *(mới — `<= 120` dòng, chỉ trên `origin/evidence/c44`)*
   - `evidence/C44/NOTE.md` *(mới — `<= 40` dòng, chỉ trên `origin/evidence/c44`)*
   - `evidence/C44/records.jsonl` + các cặp `*.out.txt` / `*.err.txt` *(chỉ trên `origin/evidence/c44`, tổng `<= 10` tệp toàn nhánh)*
6. **Rủi ro:**
   - Vượt quá trần `10` tệp trên nhánh `origin/evidence/c44` khi gộp `BACKLOG.md`, `RELEASE-CANDIDATE.md`, `REPORT.md`, `NOTE.md`, `records.jsonl` và các bản ghi W1–W5 → gom các capture Track W thành bộ chạy hợp nhất (ví dụ 1–2 cặp `.out.txt`/`.err.txt` có cấu trúc rõ ràng) để tổng toàn nhánh luôn `<= 10` tệp.
   - Lọt chuỗi git cấm của `K6.2` vào mục "lệnh chủ dự án tự gõ" → chỉ viết lệnh đẩy tường minh từng tag đơn (`git push origin v0.1.0`) và chạy kiểm tra tự động chuỗi cấm trước khi đẩy nhánh.
7. **Lệnh kiểm chứng:**
   ```sh
   node tools/agent/verify-records.mjs evidence/C44/records.jsonl evidence/C44
   node tools/agent/verify-package.mjs evidence/C44
   node tools/agent/scan-private-names.mjs origin/evidence/c44
   gh run list --branch evidence/c44 --limit 5
   ```

---

## Phụ lục Track W — Kiểm chứng `9Router 0.5.123` (chạy song song)

- **Ngân sách tổng cứng (C44 §5):** Tối đa **`30` request chat** (`W1`: `3` + `W3`: tối đa `9` + `W5`: tối đa `18` = `30`) và tối đa **`3` lần `GET /v1/models`** (duy nhất trong `W1`; `W3` và `W5` dùng **`0` lần `GET /v1/models`**).
- **Quy tắc bảo vệ router:** Không ghi DB hay cấu hình router, không bật/tắt/khởi động lại router, không tự áp bản vá, không tạo hoặc sửa combo. Dừng ngay nếu vượt trần ngân sách hoặc gặp `3` lần HTTP `429` liên tiếp.
- **Kế hoạch gom PR:** `W-01` đi qua **PR #2** (không chung tệp với PR #1, có thể triển khai song song ngay); `W-02` gom vào **PR #4** cùng `M4-01` & `M4-02` sau khi có đủ kết quả đo `W1`, `W3`, `W5`.

---

### Vé `W-01` — [Track W: W2 + Runner W1/W3/W5] Sửa bộ đếm ngân sách & `SKIPPED-QUOTA` phía client (stream không ghi `usageHistory`) và công cụ chạy có cổng kiểm soát cho `W1`, `W3`, `W5`

1. **Mục tiêu:**
   - **Phần `W2` (sửa lỗi đếm thiếu stream từ phát hiện C43 §1.2):** Cập nhật `<REPO>/packages/cli/src/commands/combos-budget.ts`, `<REPO>/packages/cli/src/commands/combos-probe.ts`, và `<REPO>/packages/cli/src/commands/combos-reliability.ts` để:
     - `RequestBudget` và cơ chế `SKIPPED-QUOTA` đếm chính xác theo **request đã gửi & phản hồi nhận được ở phía client trong công cụ**, không phụ thuộc vào dòng bảng `usageHistory` (vì trên `9router@0.5.123` cả `9/9` request `stream=true` đều không ghi `usageHistory`).
     - Chuẩn hóa tên bước trong `recentQuotaSteps` (cắt hậu tố `#<attempt>` nếu có) và đánh dấu `quota=1` trực tiếp từ thân phản hồi HTTP `429` ở cả chế độ `combo` lẫn `step` ngay cả khi `stream=true` ghi `0` dòng `usageHistory`.
     - Khi có cả hai nguồn dữ liệu (`clientSentRequests` và `usageHistoryRows`), thực hiện đối chiếu và in rõ số chênh lệch (`diff = sent - usageRows`) để minh bạch độ thiếu của `usageHistory`.
   - **Phần runner có cổng kiểm soát cho `W1`, `W3`, `W5` (`<REPO>/tools/agent/c44-track-w.mjs`):**
     - Khóa cứng trần ngân sách toàn cục (`MAX_CHAT_REQUESTS = 30`, `MAX_MODELS_GET = 3`), đếm theo từng request gửi phía client và dừng tự động ngay khi gặp `3` lần HTTP `429` liên tiếp hoặc chạm trần.
     - **`W1` (`3` lần `GET /v1/models` + `3` chat request):** Đo `GET /v1/models` trên `0.5.123` nguyên bản `3` lần cách nhau `60 s`, ghi thời gian tới header, tổng thời gian, kích thước thân, và độ trễ của `1` `POST /v1/chat/completions` ngắn gửi song song ngay lúc `GET` đang chạy. Xuất kết luận đúng 1 trong 3 dạng: `còn nghẽn`, `hết nghẽn`, hoặc `không đủ dữ liệu`. Chỉ khi `còn nghẽn` mới tạo mục đề xuất `PATCH_V3` kèm lệnh trong hàng đợi `chờ chủ dự án` (tuyệt đối không áp).
     - **`W3` (`0` lần `GET /v1/models` + tối đa `9` chat request):** Theo dõi tuổi tiến trình — **tái sử dụng chỉ đọc `readRouterPid()` + `readRouterProcess()` (RAM, CPU, tuổi tiến trình, RAM trống) và TUYỆT ĐỐI KHÔNG gọi `runRouterWatch()` hay thêm bất kỳ lần `GET /v1/models` nào**. Nếu router không bị khởi động lại, đo `3` request ngắn (`stream=true`) trên `9Router-Agent-1` tại các mốc tiến trình đạt khoảng `6`, `24` và `48` giờ tuổi; luôn ghi rõ `tuổi tiến trình` và `đã khởi động lại` vào bản ghi; không đo nếu router vừa khởi động lại; nếu xảy ra treo thì lưu toàn bộ dấu vết (bước được phục vụ, dòng usage, thời điểm), dừng đo thêm ở mốc tuổi đó và báo ngay.
     - **`W5` (`0` lần `GET /v1/models` + `0` hoặc `18` chat request):** Kiểm tra chỉ đọc trong DB khi tới `W3`; nếu combo `rs-fast` đã có trong DB thì lặp ma trận C43 `R1` (`18` request, tính vào tổng trần `30`); nếu chưa có thì ghi `chưa đo` (`0` request, không tự tạo combo).
2. **Tiêu chí chấp nhận (đỏ trước – xanh sau):**
   - **Đỏ trước:**
     - Viết bộ test trong `<REPO>/packages/cli/test/combos-budget.test.ts`, `<REPO>/packages/cli/test/combos-probe-r1.test.ts` (hoặc `combos-probe-usage.test.ts`), và `<REPO>/packages/cli/test/combos-reliability.test.ts` mô phỏng kịch bản `stream=true` ghi `0` dòng `usageHistory` + phản hồi `429` có hậu tố `#<attempt>` và đối chiếu độ lệch `sent vs usageRows` — xác nhận test **đỏ** trên `bc61436`.
     - Viết `<REPO>/test/agent/c44-track-w.node.test.mjs` trên máy chủ HTTP giả cục bộ (`127.0.0.1`) kiểm chứng: (i) khóa trần `30` chat & `3` `GET /v1/models`; (ii) dừng ngay ở `3` lần `429` liên tiếp; (iii) `W3` phát ra chính xác `0` cuộc gọi `GET /v1/models` và từ chối đo nếu `đã khởi động lại=true`; (iv) `W5` trả `chưa đo` (`0` request) khi DB chưa có `rs-fast`; (v) phân loại đủ 3 kết luận `W1` (`còn nghẽn`, `hết nghẽn`, `không đủ dữ liệu`) — xác nhận **đỏ** trước khi viết runner.
   - **Xanh sau:**
     - Toàn bộ unit test `W2` và `c44-track-w.node.test.mjs` xanh trên đủ **5 hệ điều hành** (`0` cuộc gọi tới cổng router thật trong test).
     - Có đủ **đột biến của Engineer và đột biến riêng của QA** trên logic `W2` (`RequestBudget`, `SKIPPED-QUOTA`, cắt hậu tố `#<attempt>`, `diff = sent - usageRows`) và cổng ngân sách của `c44-track-w.mjs`.
     - PR #2 xanh đủ **5 hệ điều hành**, Ops squash-merge, CI `main` `attempt=1` xanh; các lần chạy thật `W1`, `W3`, `W5` (chạy qua `capture-evidence.mjs` sau khi PR #2 merge) tuân thủ đúng trần `<= 30` chat & `<= 3` `GET /v1/models` và lưu bản ghi sạch vào `origin/evidence/c44`.
3. **Người làm:** **Engineer** lập mã `W2`, `c44-track-w.mjs` và bộ test; **CTO** duyệt hợp đồng bộ đếm phía client và cổng an toàn Track W; **Ops** thực hiện `gh pr merge --squash` sau khi QA ký và hỗ trợ thu thập bản ghi `evidence/c44`.
4. **Người xác minh độc lập:** **QA** (khác Engineer; kiểm chứng đỏ-trước xanh-sau, chạy đột biến riêng cho `W2` và cổng trần ngân sách, xác nhận `W3` thực hiện `0` lần `GET /v1/models`, đối chiếu nhật ký chạy thật `W1`/`W3`/`W5` với tổng request không vượt `30` chat + `3` `GET /v1/models`).
5. **Tệp dự kiến:**
   - `<REPO>/packages/cli/src/commands/combos-budget.ts`
   - `<REPO>/packages/cli/src/commands/combos-probe.ts`
   - `<REPO>/packages/cli/src/commands/combos-reliability.ts`
   - `<REPO>/packages/cli/test/combos-budget.test.ts`
   - `<REPO>/packages/cli/test/combos-probe-r1.test.ts`
   - `<REPO>/packages/cli/test/combos-reliability.test.ts`
   - `<REPO>/tools/agent/c44-track-w.mjs` *(mới)*
   - `<REPO>/test/agent/c44-track-w.node.test.mjs` *(mới)*
6. **Rủi ro:**
   - Gọi nhầm `runRouterWatch()` trong `W3` sẽ tự động gửi `GET /v1/models` định kỳ và vi phạm trần cứng `3` lần của Track W → tuyệt đối không gọi `runRouterWatch()`, chỉ nhập và dùng `readRouterPid()` + `readRouterProcess()` (hoặc `tools/agent/router-process.mjs`), có unit test khẳng định số lần gọi `/v1/models` của `W3` luôn bằng `0`.
   - `9Router` có thể bị chủ máy khởi động lại giữa các mốc `6h / 24h / 48h` → `W3` bắt buộc so sánh `processStart` + `serverPid` trước khi gửi request; nếu phát hiện khởi động lại thì ghi `đã khởi động lại=true`, không gửi request sai mốc tuổi, và báo trung thực.
   - Đụng `429` do quota gói miễn phí ở nhà cung cấp ngược dòng → cổng dừng cứng ở `3` lần `429` liên tiếp và giãn cách giữa các request tránh đốt hạn mức.
7. **Lệnh kiểm chứng:**
   ```sh
   node tools/agent/preflight.mjs
   pnpm test:file packages/cli/test/combos-budget.test.ts packages/cli/test/combos-probe-r1.test.ts packages/cli/test/combos-reliability.test.ts
   node --test test/agent/c44-track-w.node.test.mjs
   pnpm prepush
   node tools/agent/ci-watch.mjs --sha <head-sha>
   RS_EVIDENCE_DIR=evidence/C44 node tools/agent/capture-evidence.mjs w1-models-contention -- node tools/agent/c44-track-w.mjs w1
   RS_EVIDENCE_DIR=evidence/C44 node tools/agent/capture-evidence.mjs w3-age-sample -- node tools/agent/c44-track-w.mjs w3
   RS_EVIDENCE_DIR=evidence/C44 node tools/agent/capture-evidence.mjs w5-rs-fast -- node tools/agent/c44-track-w.mjs w5
   ```

---

### Vé `W-02` — [Track W: W4] Cập nhật `docs/9router-combo-findings.md` mục `0.5.123`, sửa chiều `826 < 2 900`, bỏ ngoại suy `14 868` / `~15 000+` & gắn nhãn `chưa phân biệt`

1. **Mục tiêu:**
   - Cập nhật `<REPO>/docs/9router-combo-findings.md` (cùng test canh giữ `<REPO>/test/docs/9router-combo-findings.test.ts`) theo đúng kết luận đã kiểm chứng ở C44 §1 và kết quả Track W (`W1`, `W2`, `W3`, `W5`):
     - Bổ sung mục **`9router@0.5.123`** ghi nhận kết quả C43 R1 (`18/18` OK, không tái hiện trong 18 mẫu — không viết "đã sửa"), kết quả `W1` (`còn nghẽn` / `hết nghẽn` / `không đủ dữ liệu`), sửa lỗi đếm stream `W2`, kết quả theo dõi tuổi tiến trình `W3`, và kết quả `W5` (`rs-fast` hoặc `chưa đo`).
     - **Sửa đúng chiều so sánh `826 < 2 900`** (khắc phục lỗi diễn đạt ngược chiều ở báo cáo C43), đồng thời **xóa bỏ hoàn toàn các con số ngoại suy không có bản ghi** (`14 868` và `~15 000+` token). Trình bày tường minh hai con số `2 900` (`M0.3`, `9router@0.5.119`) và `826` (`C43`, `9router@0.5.123`, `stream=false`) như **hai phép đo độc lập ở hai phiên bản router khác nhau**, không tự giải thích nguyên nhân chênh lệch khi chưa có bản ghi đối chứng.
     - Gắn nhãn tường minh **`chưa phân biệt`** cho đủ **4 ứng viên nguyên nhân** khác biệt giữa M0.3 và C43 R1 (C44 §1.1): (1) đổi bản router `0.5.119` sang `0.5.123`, (2) tiến trình mới khởi động thay vì đã chạy lâu, (3) quota được hồi, (4) RAM máy chủ lúc đo.
     - Giữ nguyên kỷ luật nhãn nguồn chứng cứ (`**đo được**`, `**suy luận**`, `**chưa biết**`, `**chưa đo**`) trên mọi gạch đầu dòng nội dung và giữ nguyên toàn bộ mốc lịch sử `C32–C43`.
2. **Tiêu chí chấp nhận (đỏ trước – xanh sau):**
   - **Đỏ trước:** Cập nhật `<REPO>/test/docs/9router-combo-findings.test.ts` bổ sung assertion khóa: (i) tài liệu không còn chứa ngoại suy `14 868` hay `15 000+`; (ii) tài liệu nêu đúng chiều `826` nhỏ hơn `2 900` và mô tả hai phép đo ở hai bản router khác nhau (`0.5.119` và `0.5.123`); (iii) cả 4 ứng viên mục 1.1 đều đi kèm nhãn `chưa phân biệt`; (iv) có mục tổng kết `0.5.123` / `C44` — xác nhận test **đỏ** trên `docs/9router-combo-findings.md` nền `bc61436` (vốn đang chứa `~15 000+` ở dòng 171 và chưa có mục `C44` + nhãn `chưa phân biệt`).
   - **Xanh sau:**
     - `pnpm test:file test/docs/9router-combo-findings.test.ts` và `pnpm test:file test/docs/agent-docs.test.ts` xanh 100%.
     - Toàn bộ gạch đầu dòng giữ đúng quy chuẩn nhãn chứng cứ tiếng Việt, không lỗi UTF-8 (`0` ký tự `\uFFFD`), `0` đường dẫn cá nhân / tên riêng / chuỗi cấm `K6.2`.
     - PR #4 (gom `M4-01` + `M4-02` + `W-02`) xanh đủ **5 hệ điều hành**, Ops squash-merge, CI `main` `attempt=1` xanh.
3. **Người làm:** **PM** (soạn thảo nội dung chuẩn hóa nhãn chứng cứ & đối chiếu C44 §1) phối hợp **Engineer** (cập nhật `test/docs/9router-combo-findings.test.ts` & trích số liệu từ bản ghi `W1–W5`); **CTO** duyệt tính chính xác kỹ thuật; **Ops** thực hiện `gh pr merge --squash` sau khi QA ký.
4. **Người xác minh độc lập:** **QA** (khác người soạn; kiểm chứng đỏ-trước xanh-sau trên `9router-combo-findings.test.ts`, đối chiếu từng con số mới với bản ghi gốc `evidence/c43` và `evidence/c44`, chạy `scan-private-names.mjs`).
5. **Tệp dự kiến:**
   - `<REPO>/docs/9router-combo-findings.md`
   - `<REPO>/test/docs/9router-combo-findings.test.ts`
6. **Rủi ro:**
   - Sửa mục C43 vô tình làm gãy các mốc hồi quy lịch sử `C32–C41` hoặc quy tắc `PROVENANCE_BULLET_RE` trong `9router-combo-findings.test.ts` → chạy đầy đủ `test/docs/9router-combo-findings.test.ts` ngay sau khi sửa để giữ nguyên mọi mốc cũ và định dạng nhãn bắt buộc.
   - Suy diễn nguyên nhân vượt quá bản ghi khi tổng hợp kết quả `W1`/`W3`/`W5` → áp quy tắc ghi đúng trạng thái `đo được` / `chưa đo` / `chưa phân biệt`, không viết "đã sửa" khi chưa có bằng chứng nhân quả trực tiếp.
7. **Lệnh kiểm chứng:**
   ```sh
   node tools/agent/preflight.mjs
   pnpm test:file test/docs/9router-combo-findings.test.ts test/docs/agent-docs.test.ts
   pnpm lint
   pnpm prepush
   node tools/agent/ci-watch.mjs --sha <head-sha>
   node tools/agent/scan-private-names.mjs --file docs/9router-combo-findings.md
   ```

---

## Hạt giống Hàng đợi `chờ chủ dự án` (tổng hợp liên tục tới `M5-01`)

Các quyết định vượt thẩm quyền đội không làm dừng chương trình mà được tích lũy vào hàng đợi này và chốt đầy đủ trong `evidence/C44/RELEASE-CANDIDATE.md`:

1. **Scope `@routersync` trên npm registry (`M3-01`):** Cả 8 gói công bố `@routersync/*` trả `E404 Not Found` (kiểm `2026-11-23T22:19Z`); cần chủ dự án tạo/xác nhận quyền sở hữu org/scope `@routersync` trên npm (hoặc chọn scope thay thế nếu cần).
2. **Định hướng SQLite (`M3-02` / `ADR-SQLITE-01`):** Giữ `better-sqlite3` cho `v0.1` hay duyệt kế hoạch chuyển sang `node:sqlite` ở vòng sau (đội không đổi phụ thuộc trong C44).
3. **Bản vá `PATCH_V3` cho `9Router 0.5.123` (`W-01` / `W1`):** Chỉ kích hoạt câu hỏi nếu kết quả đo `W1` kết luận `còn nghẽn`; đội cung cấp lệnh sẵn, không tự áp bản vá.
4. **Combo `rs-fast` cho `W5` (`W-01`):** Nếu trong DB chưa có `rs-fast`, đội ghi `chưa đo` và không tự tạo combo; chủ dự án quyết định có tạo combo để đo bổ sung sau hay không.
5. **Cổng phát hành `v0.1` (`M5-01`):** Chủ dự án quyết định thời điểm GO/NO-GO, chọn phiên bản (`0.1.0` hoặc `0.1.0-rc.1`), tự gõ lệnh gắn tag tường minh (`git push origin v0.1.0`) và tự chạy `npm publish`.
