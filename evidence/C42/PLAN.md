# PLAN.md — Kế hoạch Chương trình RouterSync v0.1 RC (C42)

- **Chương trình:** C42 — Hiến chương chương trình RouterSync v0.1 Release Candidate
- **Đồng lập & phê duyệt nội bộ:** CEO (điều phối & chịu trách nhiệm cuối), Product Manager (PMO Lead), COO (năng lực & rủi ro), CTO (thiết kế kỹ thuật & ADR)
- **Mốc nền tham chiếu (chỉ đọc):** nhánh `main`, commit `c28b7fb` (PR `#56`, run CI `45049049310` `attempt=1` `success`, `286 s`), `232` tệp test toàn kho
- **Nguồn tài liệu đã đối chiếu:** `AGENTS.md`, `docs/ROADMAP.md`, `docs/known-issues.md`, `docs/CI.md`, `docs/9router-combo-findings.md`, `docs/combo-rs-fast.md`, `docs/low-resource.md`, toàn bộ 9 ADR trong `docs/adr/`, `.github/workflows/ci.yml`, `package.json`
- **Quy tắc vệ sinh thông tin:** Tài liệu này không chứa tên người dùng hệ điều hành, đường dẫn cá nhân, tên dịch vụ đồng bộ đám mây, khóa API hay tên gateway riêng (dùng `<REPO>`, `<HOME>`, `<cloud-sync>`, `<private-gateway>`).

---

## 1. Đề xuất phạm vi cuối cùng của RouterSync v0.1 RC (Rà soát P1–P7)

Sau khi đọc hết `docs/ROADMAP.md`, `docs/known-issues.md`, `docs/CI.md`, `docs/9router-combo-findings.md` và đối chiếu trực tiếp với mã nguồn tại `c28b7fb`, nhóm Exec (CEO, PM, COO) cùng CTO đề xuất **giữ nguyên đủ 7 hạng mục P1–P7 ở Mục 2, không thêm hạng mục ngoài hiến chương, không bớt hạng mục nào, và làm rõ ranh giới kỹ thuật theo đúng hiện trạng mã nguồn đã kiểm chứng ở M0** như sau:

| Hạng mục | Quyết định phạm vi | Cơ sở đối chiếu (`ROADMAP.md`, `known-issues.md`, `CI.md`, mã nguồn M0) & Lý do | Ranh giới khóa chặt cho v0.1 RC |
|---|---|---|---|
| **P1 — Sức khỏe CI** | **Giữ nguyên** | Đo thật `ci-stats.mjs` tại M0 (bản ghi `m0-ci-stats`): cửa sổ từ `2026-11-17`, `runs=100`, `uniqueSha=65`; `push` trên `main` xanh lần đầu **`23/27`** (lệch với số cũ `17/22` trong `docs/CI.md` §5); commit của đội xanh lần đầu **`53/65 (82%)`**; đỏ `code=4, infra=0, unknown=5`; chuỗi merge (`push`) liên tiếp vào `main` xanh ngay ở `attempt=1` hiện đạt **`17` run liên tiếp** (`009d5b4` → `c28b7fb`, trung vị `304 s`). Ở `c28b7fb`, `test/e2e/e2e.test.ts` (dòng `453–504`, `diag()` dòng `503`) đã thu pipe stdout/stderr của daemon, nhưng `ci-watch.mjs`/`ci-stats-core.mjs` chưa có bộ nhận diện cảnh báo tự động cho tín hiệu lỗi health daemon ở run `44788053023` và `ci-stats.mjs` còn phát cảnh báo `[DEP0190]` trên Windows. | Duy trì tối thiểu **10 lần merge liên tiếp vào `main` xanh ở `attempt=1`** xuyên suốt chương trình (đo bằng `ci-stats.mjs`); chạy `flake-hunt.yml` kiểm chứng trên `ubuntu-24.04-arm` và bổ sung cảnh báo tự động `E2E-DAEMON-HEALTH-SIGNAL` trong `ci-watch.mjs`/`ci-stats-core.mjs` + dọn cảnh báo `[DEP0190]`; merge chỉ khi xanh đủ **5 hệ điều hành** trên head cuối (`ubuntu-latest`, `ubuntu-24.04-arm`, `macos-latest`, `windows-latest`, `windows-11-arm`; ARM báo cáo tách riêng). Cấm xóa test, cấm hạ guard, cấm thêm `continue-on-error`. |
| **P2 — Known issues 1 & 2** | **Giữ nguyên & làm rõ căn nguyên mã nguồn** | Đối chiếu `docs/known-issues.md` với mã sau C31–C41: (1) `packages/core/src/domain/model-state.ts` đã đọc `combos` OmniRoute vào `comboModels` (dòng `250–298`) nhưng nhánh `isOmniRoute` (dòng `715–720`) **chưa hợp nhất `comboModels` vào `availableModels`** khi `!options.excludeComboModelsFromAvailability` (khác nhánh `is9Router` dòng `538–542`), làm `availableModels=0` khi `syncedAvailableModels` rỗng; đồng thời `packages/cli/src/apps/drift.ts` (`340–392`) mới xét `view.comboIds` cho OmniRoute. (2) Trong `apps/drift.ts`, `buildRouterView` (`206–210`) đã tạo `view.comboNames`, nhưng `classifyModelDrift` (`285–407`) **chưa kiểm tra `view.comboNames.has(strippedId)`**, khiến `9Router-Coder-1` và `OmniRoute-Coder-1` rơi xuống `MISSING` (trong khi `apps drift-model` mới ở C41 chỉ phục vụ OpenMausBot). | Sửa dứt điểm cả 2 lỗi theo nguyên tắc test **đỏ trước – xanh sau** trên fixture DB giả lập; giữ bất biến `combos stale` (`excludeComboModelsFromAvailability` / `direct`); đồng bộ `docs/known-issues.md`. Tuyệt đối không ghi DB router thật. |
| **P3 — Phase 3 S2** | **Giữ nguyên & làm rõ phần đã có vs còn thiếu** | Đối chiếu `docs/ROADMAP.md` (vẫn để `[ ] S2`) với mã thực tế: (1) **Grant lifecycle `ADR-MAINTAIN-02`**: 4 lệnh `maintain authorize`, `grant-status`, `revoke-grant`, `secret-selftest` đã có trong `packages/cli/src/maintain/grant.ts` & `commands/maintain.ts`, nhưng `ADR-MAINTAIN-02` còn trỏ tới `tools/maintain/test-apply-grant.mjs` (không tồn tại) và cần phủ trọn bộ contract test cho mọi mã từ chối + vòng đời approval token tương tác; (2) **Outbound webhook**: mới có 12 dòng gửi thô ở `packages/cli/src/commands/tick.ts:1165–1177`, **0 bài test tự động**, chưa có schema cấu hình/kiểm URL an toàn và chưa nối cảnh báo actionable; (3) **Serving-path read-back**: hai adapter đã có hàm đọc lại HTTP, nhưng `maintain create`/`maintain apply` (`commands/maintain.ts:793, 1015–1034`) mới đọc lại SQLite DB rồi in cứng `READBACK ok=yes`, chưa xác minh đường phục vụ HTTP trên cả 9Router và OmniRoute. | Hoàn tất đủ 3 nhánh P3.1, P3.2, P3.3 với bộ test tự động cô lập trong `os.tmpdir()` (fake HTTP webhook, fake router, fixture DB); giữ nguyên tuyên bố trung thực về giới hạn PTY tại mục 4 `ADR-MAINTAIN-02`; 0 request tới router thật và không ghi DB thật. |
| **P4 — Đóng gói tarball 5 OS** | **Giữ nguyên & khóa ranh giới publish** | `pnpm e2e` đã đóng gói tarball (`@routersync/cli`, `@routersync/mcp-server`), cần xác minh đóng gói sạch & cài đặt độc lập từ tarball chạy xanh xuyên suốt trên **5 hệ điều hành** trong CI (`.github/workflows/ci.yml`) kèm các guard vệ sinh gói (`at-167`, `at-168`). | Kiểm chứng đóng gói và cài từ tarball trong CI trên đủ **5 hệ điều hành**; **việc phát hành lên npm do chủ dự án làm** (tách riêng sang cổng M5). |
| **P5 — Tài nguyên thấp & ADR SQLite** | **Giữ nguyên & khóa không đổi hành vi** | `docs/low-resource.md` hiện mới có mốc cold-start C17 (Node 24.18.0, Windows x64, 884 MiB RAM trống), chưa có số liệu lặp kèm phương sai cập nhật cho cold-start & idle memory tại nhánh RC, và chưa có ADR quyết định giữa `better-sqlite3` (đang dùng ở `core`, `daemon`, `cli`) với `node:sqlite`. | Đo lại khởi động lạnh và bộ nhớ khi rảnh (in từ script kèm cỡ mẫu `n`, trung bình, `p50`, `p95`, `max`, độ lệch chuẩn/phương sai); CTO hợp nhất ADR `better-sqlite3` vs `node:sqlite`; **tuyệt đối không thay đổi hành vi sản phẩm** trong v0.1 RC. |
| **P6 — Tài liệu nhất quán** | **Giữ nguyên** | `docs/CI.md` §5 đang lệch số liệu thực (`17/22` so với `23/27`), `docs/ROADMAP.md` và `docs/known-issues.md` sẽ thay đổi trạng thái sau M1–M3; `README.md`, `docs/SETUP.md`, `docs/WORKFLOW.md` cần khớp 100% hành vi thực tế của v0.1 RC. | Cập nhật đồng bộ `README.md`, `docs/SETUP.md`, `docs/WORKFLOW.md`, `docs/CI.md`, `docs/ROADMAP.md`, `docs/known-issues.md`; toàn bộ test tài liệu (`test/docs/`, `test/readme-clone-cd.test.mjs`) xanh. |
| **P7 — Bảo mật sạch kho, bằng chứng & log CI** | **Giữ nguyên** | Tại M0, `no-secrets.mjs`, `no-personal-paths.mjs`, `no-evidence-in-main.mjs` đều exit `0` trên `631` tệp của `main`; cần duy trì sạch tuyệt đối trên nhánh chính, mọi nhánh `evidence/*`, tarball và log CI đến khi đóng RC. | Quét khóa, tên riêng, đường dẫn cá nhân sạch (`0` khớp trên các nhánh `evidence/*`, toàn bộ guard và `pnpm audit --audit-level=moderate` xanh, kiểm mẫu log CI sạch). |

**Lý do không thêm hoặc bớt hạng mục so với Mục 2:**
- Không bớt mục nào vì cả 7 mục P1–P7 đều là điều kiện cần và đo được để đạt chuẩn **RouterSync v0.1 release candidate**.
- Không tự thêm bất kỳ mục nào ngoài P1–P7 để chống phình phạm vi, bảo vệ máy RAM yếu (`LIGHT-DEV` `< 1.50 GiB`) và giữ hạn mức request LLM của toàn đội trong trần `CAPACITY.md`.

---

## 2. Danh sách hạng mục NGOÀI PHẠM VI (Gắn nhãn `"chờ chủ dự án"`)

Mọi hạng mục dưới đây nằm ngoài phạm vi thực thi của đội bot trong chương trình này và đều được gắn nhãn **`"chờ chủ dự án"`** theo đúng Mục 2 & Mục 7:

### 2.1 Nhóm bắt buộc ngoài phạm vi theo Hiến chương C42 & vận hành 9Router
1. **Kiểm thử trên máy macOS và Linux vật lý** — **chờ chủ dự án** (đội chỉ xác minh trên ma trận 5 hệ điều hành của GitHub Actions CI).
2. **Phát hành lên npm công khai (`npm publish` và gắn tag release chính thức)** — **chờ chủ dự án** (tách riêng tại cổng M5 để chủ dự án quyết và tự làm).
3. **G5 — Giao diện web (`packages/ui` đọc trạng thái đầy đủ)** — **chờ chủ dự án** (hoãn sau v1 theo `docs/ROADMAP.md`).
4. **G6 — BYOK Encrypted Key Bypass (`ROUTERSYNC_KEY_<PREFIX>`)** — **chờ chủ dự án** (chưa chốt thiết kế bảo mật, hoãn sau v1).
5. **Chế độ `auto-safe` & tự động failover có khóa ghi phần cứng (Phase 4)** — **chờ chủ dự án**.
6. **Các cầu nối harness của Phase 5** (Hermes Agent, OpenClaw, DeepSeek Harness, Claude Code, Antigravity, đồng bộ edge router phân tán) — **chờ chủ dự án**.
7. **Ghi vào router thật / sửa cấu hình app của chủ dự án / dừng hoặc khởi động lại router / xóa model hay bước combo** (gồm việc tạo `rs-fast`, `rs-max`, cập nhật thứ tự `9Router-Agent-1` trên dashboard 9Router, và tự kiểm `huggingface` 404, `opencode` 429, `cohere` 405 nêu trong `docs/9router-combo-findings.md` §5) — **chờ chủ dự án**.

### 2.2 Nhóm "Hoãn sau v1" trong `docs/ROADMAP.md`
8. **Lịch BYOK cấu hình qua giao diện web** — **chờ chủ dự án**.
9. **Hợp nhất nguồn catalog giữa `scan` và `tick` thành một pipeline duy nhất** — **chờ chủ dự án**.
10. **Chuẩn hóa định dạng ngày trong nguồn L3 (`gemini-deprecations`, `openrouter-changelog`)** — **chờ chủ dự án**.
11. **Phủ test tự động chính thức cho `routersync undo` để nâng lên đường hoàn tác chính thức** — **chờ chủ dự án**.

### 2.3 Nhóm "Biết trước (chưa xử lý trong v0.1)" & K8 trong `docs/ROADMAP.md`
12. **Lọc đề xuất `NEW-CANDIDATE` trong `tick` theo nhãn `QUOTA` / `SẮP-NGỪNG`** — **chờ chủ dự án**.
13. **Đo tỷ lệ lỗi 7 ngày của 9Router** (`usageHistory` hiện chỉ lưu request thành công) — **chờ chủ dự án**.
14. **Kiểm chứng thực tế đường dẫn DB 9Router trên macOS/Linux vật lý (`~/.9router/db/data.sqlite`)** — **chờ chủ dự án**.
15. **Gộp hai thư mục trạng thái riêng biệt của `sync` và `tick`** — **chờ chủ dự án**.
16. **Mở rộng bảo vệ HTTP trong scanner nhà cung cấp** (chặn cross-host redirect nội bộ, lọc SSRF dải IP riêng tư, allowlist host cứng ngoài 7 cơ chế hiện có) — **chờ chủ dự án**.
17. **Nhóm K8 ("Repo tự mô tả cho AI Agent")**: adapter AI Agent qua `packages/adapter-sdk`, kênh tự cập nhật theo tag, fuzz/property test đường ghi và bảng độ phủ L1/L2/L3 theo provider — **chờ chủ dự án**.

---

## 3. Lộ trình 5 Cột mốc (M1–M5), Tiêu chí Hoàn tất, Gói Bằng chứng & Ước tính Nỗ lực

> **Ghi chú minh bạch về độ không chắc của ước tính:** Tại M0, đội chưa mở bất kỳ PR mã nguồn nào của chương trình C42 nên vận tốc thực thi tổ hợp `CTO → Engineer → QA → Ops` đang là `CHƯA ĐO`. Toàn bộ ước tính **số request LLM** và **số phiên làm việc** dưới đây được trình bày theo **khoảng `Min – Max` kèm biên độ không chắc**, phù hợp với trần năng lực tại `CAPACITY.md` (tối đa `2` bot đồng thời trên Sub; nếu chạy qua 9Router thì tối đa `1` luồng tuần tự trong trần `120` request/ngày sau khi có `rs-fast`/`rs-max`), và sẽ được COO + PM hiệu chỉnh lại sau khi đóng M1 và M2.
> - **Định nghĩa `1 phiên làm việc`:** Một vòng khép kín trên 1 vé hoặc 1 cổng kiểm chứng (thiết kế/viết mã & test đỏ-trước xanh-sau → `pnpm prepush` → PR CI xanh đủ 5 hệ điều hành → QA xác minh độc lập → Ops `gh pr merge --squash` → `ci-watch` trên `main` lần 1 → đóng gói bằng chứng).

### Cột mốc M1 — Sức khỏe CI (P1) và Known Issues 1 & 2 (P2)
- **Mục tiêu:** Giải thích/khoanh vùng bằng thực nghiệm `flake-hunt.yml` và gắn cảnh báo tự động cho lỗi health daemon ở `test/e2e/e2e.test.ts`, làm sạch cảnh báo `ci-stats.mjs`, duy trì chuỗi merge `main` xanh lần đầu, và đóng dứt điểm Known Issue 1 (`OmniRoute availableModels=0`) cùng Known Issue 2 (`comboNames` bị báo `MISSING` trong `apps drift`).
- **Tiêu chí hoàn tất đo được:**
  1. Cả 3 vé `M1-01`, `M1-02`, `M1-03` trong `BACKLOG.md` có test tái hiện **đỏ trước, xanh sau** và được QA xác minh độc lập (khác Engineer).
  2. Mọi PR thuộc M1 xanh đủ **5 hệ điều hành** trên head cuối trước khi Ops chạy `gh pr merge --squash`; mọi run CI `push` trên `main` xanh ngay ở **lần chạy đầu (`attempt=1`)**, giữ vững chuỗi `>= 10` lần merge liên tiếp xanh lần đầu trên `main` đo bằng `ci-stats.mjs`.
  3. Lỗi `e2e.test.ts` ở run `44788053023` được kiểm tra qua `flake-hunt.yml` trên `ubuntu-24.04-arm` và có cơ chế nhận diện/cảnh báo tự động `E2E-DAEMON-HEALTH-SIGNAL` có unit test trong `ci-watch.mjs` / `ci-stats-core.mjs`; `ci-stats.mjs` chạy `0` cảnh báo `[DEP0190]`.
  4. `docs/known-issues.md` được cập nhật đóng cả 2 lỗi; `verify-records.mjs` exit `0`, `verify-package.mjs` exit `0`, `scan-private-names.mjs` = `0` khớp.
- **Gói bằng chứng:** Nhánh `evidence/m1` (`evidence/M1/`, `[skip ci]`, không PR, không merge, tối đa 10 tệp).
- **Ước tính nỗ lực & độ không chắc:**
  - **Số request LLM:** `90 – 180` request (trung vị dự kiến ~`130`).
  - **Số phiên làm việc:** `4 – 7` phiên (3 vé kỹ thuật + 1 phiên đóng gói & kiểm chứng cổng M1).
  - **Độ không chắc:** **Trung bình–Cao (`±40%`)** — phụ thuộc khả năng tái hiện lỗi không tất định trên runner `ubuntu-24.04-arm` trong `flake-hunt.yml`.

### Cột mốc M2 — Phase 3 S2: Grant Lifecycle, Outbound Webhook & Đọc lại Đường Phục vụ (P3)
- **Mục tiêu:** Hoàn tất trọn vẹn Phase 3 slice S2: phủ kín contract test & đồng bộ tài liệu cho vòng đời grant theo `ADR-MAINTAIN-02`, hoàn thiện outbound webhook có kiểm thử bằng đích HTTP giả cục bộ, và nối xác minh đọc lại đường phục vụ HTTP trên cả 9Router và OmniRoute (kể cả trong `maintain create`/`maintain apply` và `status`/`targets`).
- **Tiêu chí hoàn tất đo được:**
  1. Cả 3 vé `M2-01`, `M2-02`, `M2-03` trong `BACKLOG.md` có bộ test cô lập (`os.tmpdir()`) **đỏ trước, xanh sau**, `0` kết nối tới router hay mạng ngoài (pass `at-127`, `at-170`).
  2. `ADR-MAINTAIN-02` trỏ đúng tới tệp test thực tế trong kho (xóa tham chiếu lỗi thời `tools/maintain/test-apply-grant.mjs`) và giữ nguyên tuyên bố trung thực về giới hạn PTY.
  3. Outbound webhook gửi đúng thông báo tới đích HTTP giả trong test, lọc sạch bí mật/tên riêng, xử lý timeout/5xx kiểu non-fatal.
  4. Cả `adapter-9router`, `adapter-omniroute`, `applier`, `maintain` và `status`/`targets` đều xác minh và báo cáo trung thực `ReadBackLevel` (`api-verified`, `existence-only`, `db-only` + `degradedReason`) trên cả hai router.
  5. Mọi PR merge xanh đủ 5 hệ điều hành, CI `main` xanh ở `attempt=1`, `verify-records.mjs` & `verify-package.mjs` xanh, `0` khớp tên riêng.
- **Gói bằng chứng:** Nhánh `evidence/m2` (`evidence/M2/`, `[skip ci]`, không PR, không merge, tối đa 10 tệp).
- **Ước tính nỗ lực & độ không chắc:**
  - **Số request LLM:** `140 – 280` request (trung vị dự kiến ~`200`).
  - **Số phiên làm việc:** `5 – 9` phiên (3 vé liên gói + phiên thẩm định thiết kế CTO & audit bảo mật QA).
  - **Độ không chắc:** **Cao (`±45%`)** — chạm nhiều gói cốt lõi (`core`, `cli`, `daemon`, `adapter-9router`, `adapter-omniroute`) và các cổng bảo mật ghi/đọc lại.

### Cột mốc M3 — Đóng gói Tarball 5 OS (P4) và Tài nguyên thấp + ADR SQLite (P5)
- **Mục tiêu:** Xác minh đóng gói & cài đặt từ tarball chạy xanh trong CI trên đủ 5 hệ điều hành; đo lại khởi động lạnh và bộ nhớ rảnh kèm phương sai khi máy rảnh; chốt quyết định `better-sqlite3` so với `node:sqlite` bằng ADR mà không thay đổi hành vi sản phẩm.
- **Tiêu chí hoàn tất đo được:**
  1. Khâu `pnpm pack` và cài đặt/chạy thử từ tarball của `@routersync/cli` và `@routersync/mcp-server` xanh trên đủ **5 hệ điều hành** trong CI, pass `at-167`, `at-168` và `e2e.test.ts` (**không** chạy `npm publish`).
  2. Tập lệnh đo xuất trực tiếp số liệu khởi động lạnh và bộ nhớ rảnh kèm cỡ mẫu `n`, trung bình, `p50`, `p95`, `max`, phương sai / độ lệch chuẩn.
  3. ADR so sánh `better-sqlite3` vs `node:sqlite` được CTO hợp nhất vào `docs/adr/`, kèm xác minh hồi quy khẳng định **không thay đổi hành vi và không đổi driver mặc định** trong v0.1 RC.
  4. Mọi PR merge xanh đủ 5 hệ điều hành, CI `main` xanh ở `attempt=1`, `verify-records.mjs` & `verify-package.mjs` xanh, `0` khớp tên riêng.
- **Gói bằng chứng:** Nhánh `evidence/m3` (`evidence/M3/`, `[skip ci]`, không PR, không merge, tối đa 10 tệp).
- **Ước tính nỗ lực & độ không chắc:**
  - **Số request LLM:** `80 – 160` request (trung vị dự kiến ~`115`).
  - **Số phiên làm việc:** `3 – 6` phiên (sẽ tách vé sau khi đóng M2; bật `Data-AI` nếu cần phân tích phương sai).
  - **Độ không chắc:** **Trung bình (`±35%`)** — phụ thuộc nhiễu nền RAM/I/O khi đo lặp trên máy yếu cục bộ so với runner CI.

### Cột mốc M4 — Tài liệu Nhất quán (P6) và Bảo mật Sạch kho / Bằng chứng / Log CI (P7)
- **Mục tiêu:** Đồng bộ nhất quán `README.md`, `SETUP.md`, `WORKFLOW.md`, `docs/CI.md`, `docs/ROADMAP.md`, `docs/known-issues.md` theo đúng hiện trạng sau M1–M3; thực hiện tổng kiểm toán bảo mật (quét khóa, tên riêng, đường dẫn cá nhân) trên nhánh `main`, toàn bộ nhánh bằng chứng và log CI.
- **Tiêu chí hoàn tất đo được:**
  1. Bộ tài liệu `README.md`, `docs/SETUP.md`, `docs/WORKFLOW.md`, `docs/CI.md` đúng hiện trạng thực tế và nhất quán với nhau; toàn bộ test tài liệu (`test/docs/`, `test/readme-clone-cd.test.mjs`) xanh 100%.
  2. Quét trên `main`, các nhánh `evidence/c42`, `evidence/m1..m4` và mẫu log CI gần nhất: `no-secrets.mjs`, `no-personal-paths.mjs`, `no-evidence-in-main.mjs` đều exit `0`; `scan-private-names.mjs` đạt `0` khớp trên mọi nhánh bằng chứng; `pnpm audit --audit-level=moderate` xanh; chuỗi `>= 10` lần merge liên tiếp vào `main` xanh ở `attempt=1` trong `ci-stats.mjs` được giữ vững.
  3. Mọi PR merge xanh đủ 5 hệ điều hành, CI `main` xanh ở `attempt=1`, `verify-records.mjs` & `verify-package.mjs` xanh.
- **Gói bằng chứng:** Nhánh `evidence/m4` (`evidence/M4/`, `[skip ci]`, không PR, không merge, tối đa 10 tệp).
- **Ước tính nỗ lực & độ không chắc:**
  - **Số request LLM:** `60 – 120` request (trung vị dự kiến ~`85`).
  - **Số phiên làm việc:** `2 – 4` phiên (sẽ tách vé sau khi đóng M3).
  - **Độ không chắc:** **Thấp–Trung bình (`±30%`)** — phụ thuộc khối lượng cập nhật tài liệu phát sinh từ M1–M3 và kết quả `pnpm audit`.

### Cột mốc M5 — Cổng Phát hành v0.1 RC (Do Chủ dự án Quyết định & Thực thi)
- **Mục tiêu:** Trình bộ hồ sơ nghiệm thu hoàn tất P1–P7 (`evidence/m1..m4`) để Chủ dự án ra quyết định cổng phát hành v0.1 RC và trực tiếp thực thi việc phát hành lên npm nếu chấp thuận.
- **Tiêu chí hoàn tất đo được:**
  1. Toàn bộ 4 cột mốc `M1`–`M4` đã đạt trạng thái `XONG` theo đúng 4 điều kiện cứng ở Mục 3.2 (PR merge, `sha`, CI `main` attempt 1 xanh, `verify-records.mjs` & `verify-package.mjs` sạch).
  2. Chủ dự án xem xét hồ sơ RC Readiness và chốt quyết định **GO / NO-GO** bằng văn bản.
  3. Nếu **GO**: Chủ dự án tự gắn tag và chạy `npm publish` (đội bot tuyệt đối không xin token npm và không chạy `npm publish`); đội chỉ kiểm tra xác nhận chỉ-đọc sau phát hành và lưu biên bản cổng vào `evidence/m5`.
- **Gói bằng chứng:** Nhánh `evidence/m5` (`evidence/M5/`, `[skip ci]`, không PR, không merge, tối đa 10 tệp).
- **Ước tính nỗ lực & độ không chắc:**
  - **Số request LLM:** `20 – 45` request (trung vị dự kiến ~`30`).
  - **Số phiên làm việc:** `1 – 2` phiên (1 phiên trình hồ sơ cổng M5 + 1 phiên ghi nhận biên bản sau quyết định của Chủ dự án).
  - **Độ không chắc:** **Thấp về kỹ thuật (`±25%`), thời gian lịch phụ thuộc Chủ dự án** (đặc biệt nếu Chủ dự án chọn tự kiểm thêm trên macOS/Linux vật lý trước khi publish).

---

## 4. Bảng Tổng hợp Lộ trình & Ngân sách Ước tính (M1–M5)

| Cột mốc | Hạng mục thuộc phạm vi | Gói bằng chứng | Request LLM ước tính (Min – Max) | Số phiên làm việc (Min – Max) | Biên độ không chắc |
|---|---|---|---:|---:|---|
| **M1** | P1 (Sức khỏe CI & `e2e.test.ts`) + P2 (Known issues 1 & 2) | `evidence/m1` | 90 – 180 | 4 – 7 | Trung bình–Cao (`±40%`) |
| **M2** | P3 (Phase 3 S2: Grant `ADR-MAINTAIN-02`, Webhook, Read-back 2 router) | `evidence/m2` | 140 – 280 | 5 – 9 | Cao (`±45%`) |
| **M3** | P4 (Tarball 5 OS) + P5 (Đo tài nguyên có phương sai & ADR SQLite) | `evidence/m3` | 80 – 160 | 3 – 6 | Trung bình (`±35%`) |
| **M4** | P6 (Tài liệu nhất quán) + P7 (Bảo mật sạch kho/bằng chứng/log CI) | `evidence/m4` | 60 – 120 | 2 – 4 | Thấp–Trung bình (`±30%`) |
| **M5** | Cổng phát hành v0.1 RC & `npm publish` (do Chủ dự án quyết & làm) | `evidence/m5` | 20 – 45 | 1 – 2 | Thấp (`±25%`, chờ lịch Chủ dự án) |
| **Tổng M1–M5** | **RouterSync v0.1 RC (P1–P7)** | `evidence/m1..m5` | **390 – 785** | **15 – 28** | **Hiệu chỉnh sau M1 & M2** |

---

## 5. Cơ chế Quản trị Chuyển Cổng & Hàng đợi Chờ Chủ dự án

1. **Chưa giao việc trước khi kế hoạch C42 được duyệt:** Đội giữ nguyên trạng thái đóng băng thực thi mã nguồn cho đến khi người duyệt độc lập và Chủ dự án chấp thuận gói `evidence/c42`.
2. **Đóng cổng tuần tự:** Chỉ tách vé chi tiết cho M3 sau khi `evidence/m2` đạt `XONG`; chỉ tách vé M4 sau khi `evidence/m3` đạt `XONG`; chỉ mở cổng M5 sau khi `evidence/m4` đạt `XONG`.
3. **Quy tắc leo thang 3-Strike & Mâu thuẫn Bằng chứng (Mục 7):** Bất kỳ việc nào thất bại 3 lần liên tiếp, có 2 nguồn bằng chứng mâu thuẫn, hoặc chạm thẩm quyền Mục 7 đều được chuyển ngay vào hàng đợi `"chờ chủ dự án"` kèm lý do và hậu quả nếu chờ, không tự thử vòng thứ 4.
