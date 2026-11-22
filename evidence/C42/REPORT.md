# REPORT.md — Báo cáo Tổng hợp Giai đoạn M0 & Kế hoạch Chương trình C42 (RouterSync v0.1 RC)

- **Nhánh bằng chứng:** `evidence/c42` (`[skip ci]`, không mở PR, không merge; tối đa 10 tệp trong `evidence/C42/`)
- **Nền tham chiếu (chỉ đọc):** `origin/main` = `c28b7fb` (PR `#56`, run CI `45049049310`, `attempt=1`, `success`, `286 s`)
- **Đồng thực hiện:** CEO (điều phối & kiểm chứng chéo), Product Manager (`PLAN.md`, `RACI.md`, `BACKLOG.md`), COO (đo thực nghiệm M0.3, `CAPACITY.md`, `RISKS.md`), CTO (rà soát M0.1–M0.2 & thiết kế kỹ thuật)
- **Cam kết tuân thủ Mục 4–8:** `0` tệp mã nguồn bị sửa trên `main`, `0` PR được mở, `0` giao việc xuống Engineer/QA/Ops, `0` ghi vào DB/cấu hình router, `0` cuộc gọi `GET /v1/models`, khóa API khi đo M0.3 chỉ giữ trong RAM.

---

## (a) Việc đã làm, Trạng thái & Bằng chứng Kiểm chứng

### 1. Bảng trạng thái 6 sản phẩm của C42 (Mục 8)

> Lưu ý phân loại trung thực theo Mục 3.2 & Mục 8: Vòng C42 chỉ lập kế hoạch (không viết mã, không mở PR); toàn bộ hạng mục mã nguồn `P1–P7` (`M1–M5`) giữ trạng thái **`CHƯA LÀM`** chờ duyệt. Sáu sản phẩm kế hoạch M0 dưới đây đạt **`XONG` (cấp kế hoạch M0)** với bản ghi lệnh chuẩn và bộ kiểm định `verify-records.mjs` + `verify-package.mjs` + `scan-private-names.mjs` sạch trên `evidence/c42`.

| Mục | Tệp trong `evidence/C42/` | Trạng thái | Tóm tắt nội dung & bằng chứng |
|---|---|---|---|
| **8.1** | `PLAN.md` | **XONG (kế hoạch M0)** | Chốt giữ nguyên `P1–P7` có lý do đối chiếu mã nguồn; khóa 17 mục ngoài phạm vi gắn nhãn `"chờ chủ dự án"`; lập `M1–M5` kèm tiêu chí đo được, nhánh `evidence/m1..m5`, ước tính `390–785` request LLM & `15–28` phiên làm việc có biên độ không chắc (`±25%` đến `±45%`). |
| **8.2** | `RACI.md` | **XONG (kế hoạch M0)** | Bật `Exec` (CEO, PM, COO), `Tech` (CTO, Engineer, QA, Researcher, Data-AI khi cần số liệu; Designer chưa cần) và `Ops`; tắt 7 vai còn lại có điều kiện bật lại; ma trận R/A/C/I cho `M0–M5` và 3 quy tắc phân vai bất khả xâm phạm (nhãn `"CHƯA XÁC NHẬN"` khi thiếu bằng chứng). |
| **8.3** | `BACKLOG.md` | **XONG (kế hoạch M0)** | Lập 6 vé đủ 7 trường cho `M1` (`M1-01..03`) và `M2` (`M2-01..03`) kèm lệnh kiểm chứng chuẩn; để trống `M3–M5` có 4 lý do rõ ràng. |
| **8.4** | `RISKS.md` | **XONG (kế hoạch M0)** | Ma trận 12 rủi ro (`R-01..R-12`) phủ đủ bước treo, quota `429`, máy yếu `< 1.50 GiB` + `<cloud-sync>`, nghẽn router, tự chấm bài, lộ tên riêng/khóa, phình phạm vi, cấm `git worktree` + junction `node_modules` (C19) và sự cố `HEADER_TIMEOUT_60S` ở M0.3. |
| **8.5** | `CAPACITY.md` | **XONG (kế hoạch M0)** | Kết quả đo M0.3 in từ script; hạ trần đồng thời 9Router xuống `1` luồng tuần tự (giữ `<= 2` bot đồng thời trên Sub); chỉ gán combo sạch `HANG` (`rs-max` / `rs-fast`, chiến lược `fallback`); ngân sách 9Router `120` request/ngày do COO theo dõi theo provider mỗi ngày. |
| **8.6** | `REPORT.md`, `NOTE.md`, `records.jsonl`, `m0-ci-stats.out.txt`, `m0-ci-stats.err.txt` | **XONG (kế hoạch M0)** | Tổng cộng đúng **10 tệp** trong `evidence/C42/`; `capture.mjs` (`2f2768cf…`) & `verify-records.mjs` (`7b310d90…`) nguyên vẹn `sha256`; `verify-records` `SẠCH: 1 dòng`, `verify-package` `OK`, `scan-private-names` = `0` khớp. |

---

### 2. Kết quả kiểm chứng M0.1–M0.2 & Đối chiếu từng điểm với Mục 1 Hiến chương C42

1. **Môi trường máy & cổng RAM (`node tools/agent/preflight.mjs`):**
   - `available RAM: 1.34 GiB` (trong lúc đo M0.3 dao động `1 086–1 914 MB` trên tổng `16 086 MB`), `cores: 8`, `cloud-sync folder: CÓ`, `mode: LIGHT-DEV` (`< 1.50 GiB`). Không chạy suite nặng cục bộ, không đặt `RS_FORCE_HEAVY`.
2. **Số liệu CI thực tế (`m0-ci-stats` — `node tools/agent/ci-stats.mjs`) và trạng thái `main`:**
   - Cửa sổ từ `2026-11-17`: `runs=100`, `uniqueSha=65`, `pending=0`, `dependabot=23`.
   - `push on main (CI workflow) green first attempt`: **`23/27`** (`85.2%`); `our commits green first attempt`: **`53/65 (82%)`**; phân loại đỏ của đội: **`code=4, infra=0, unknown=5`**.
   - Chuỗi merge (`push`) vào `main` xanh ngay ở `attempt=1` hiện hành: **`17` lần liên tiếp** (từ `009d5b4` / run `44866932530` đến `c28b7fb` / run `45049049310`), thời gian wall-clock `282–336 s` (trung vị **`304 s`**; đường găng tại `windows-11-arm` `282–283 s`, `windows-latest` `216–235 s`, `macos-latest` `133–151 s`, `ubuntu-latest` `94–100 s`, `ubuntu-24.04-arm` `90–94 s`).
   - Tổng số tệp test hiện có (chỉ đọc): **`232` tệp test** (`146` trong `packages/*/test` + `86` trong `test/`).
   - Guard bảo mật trên `main` (`631` tệp): `no-secrets.mjs` exit `0`, `no-personal-paths.mjs` exit `0`, `no-evidence-in-main.mjs` exit `0`.
3. **Các điểm LỆCH giữa Mục 1 / Tài liệu hiện hữu và Mã nguồn thực tế tại `c28b7fb`:**
   - **Lệch 1 (`docs/CI.md` §5 vs `m0-ci-stats`):** `docs/CI.md` còn lưu số cũ (`17/22`, `39/50 = 78%`, `code=2, infra=0, unknown=6`); thực tế là `23/27`, `53/65 (82%)`, `code=4, infra=0, unknown=5`. Ngoài ra `ci-stats.mjs` phát sinh cảnh báo Node `[DEP0190]` ở `stderr` trên Windows (xem `m0-ci-stats.err.txt`).
   - **Lệch 2 (`e2e.test.ts:470` ở run `44788053023`):** Tại `c28b7fb`, `test/e2e/e2e.test.ts` (dòng `453–504`) đã được nâng cấp thu pipe `daemonOut`/`daemonErr` và in `diag()` ở dòng `503` (không còn ở dòng `:470` cũ), nhưng `ci-watch.mjs`/`ci-stats-core.mjs` chưa có luật phát cảnh báo tự động riêng khi lỗi này tái xuất ở `attempt=1`.
   - **Lệch 3 (`docs/ROADMAP.md` Phase 3 S2 vs `ADR-MAINTAIN-02` trong code):** `ROADMAP.md` vẫn để `[ ] S2`, nhưng 4 lệnh `maintain authorize`, `grant-status`, `revoke-grant`, `secret-selftest` đã có trong `packages/cli/src/maintain/grant.ts` và `commands/maintain.ts`; ngược lại, tệp test `tools/maintain/test-apply-grant.mjs` nêu trong `ADR-MAINTAIN-02` không tồn tại trên đĩa.
   - **Lệch 4 (Known Issue 1 & 2 sau C31–C41):** `model-state.ts` đã đọc `combos` OmniRoute vào `comboModels`, nhưng nhánh `isOmniRoute` (`715–720`) quên hợp nhất `comboModels` vào `availableModels` khi `!options.excludeComboModelsFromAvailability`; trong `apps/drift.ts`, `buildRouterView` đã tạo `view.comboNames` nhưng `classifyModelDrift` (`285–407`) không kiểm tra `view.comboNames.has(strippedId)`, làm `9Router-Coder-1` và `OmniRoute-Coder-1` bị báo `MISSING` (lệnh `apps drift-model` ở C41 chỉ kiểm riêng OpenMausBot).
   - **Lệch 5 (Webhook & Serving-path read-back ở P3):** Webhook mới có 12 dòng gửi thô ở `tick.ts:1165–1177` với `0` bài test; còn `maintain create`/`maintain apply` (`commands/maintain.ts:793, 1015–1034`) mới đọc lại SQLite DB rồi in cứng `READBACK ok=yes`, chưa gọi xác minh đường phục vụ HTTP trên 9Router và OmniRoute.
   - **Lệch 6 (Giả định Mục 5 C42 vs cấu hình thực của đội bot):** `17/17` bot OpenMausBot hiện cấu hình chạy qua Sub (`antigravity-<uuid>`) + fallback `openrouter/free`, chỉ riêng instance `openai-compat-<uuid>` trỏ `9Router-Agent-1`; hai combo sạch `HANG` (`rs-fast`, `rs-max`) chưa có trong DB 9Router.

---

### 3. Mục CI (theo `AGENTS.md` §7.8)

| Lần chạy | PR / Nhánh | Commit `sha` | Run ID | Attempt | Kết quả | Tỷ lệ xanh lần 1 (`m0-ci-stats`) |
|---|---|---|---|---:|---|---|
| Nền `main` hiện hành | PR `#56` → `main` | `c28b7fb` | `45049049310` | `1` | `success` (`18/18` jobs, `286 s`) | `main`: `23/27` (`17` merge gần nhất xanh liên tiếp); đội: `53/65 (82%)` |
| Gói kế hoạch C42 | `evidence/c42` (`[skip ci]`, không PR) | *(xem commit đầu nhánh)* | *(không kích hoạt CI)* | — | Đạt `verify-records` + `verify-package` + `0` khớp tên riêng | Sự cố hạ tầng mới trong C42: `0` |

---

## (b) Điều chưa biết hoặc chưa đo

1. **Nguyên nhân nội bộ 9Router ở phép đo M0.3 (`CHƯA BIẾT`):** Khi 2 luồng gọi đồng thời `9Router-Agent-1`, `usageHistory` ghi nhận `+2` dòng `openrouter` (`nvidia/nemotron-3.5-super-vl:free`, `status=ok`) lúc `t+1.66 s` nhưng HTTP client không nhận được response header trong `60 s` (`HEADER_TIMEOUT_60S` ở `60 009 ms` và `60 015 ms`). COO đã dừng ngay đúng quy tắc Mục 5, không thử lại.
2. **Độ trễ đồng thời trên `rs-fast` và `rs-max` (`CHƯA ĐO`):** Hai combo ngắn sạch `HANG` chưa tồn tại trong DB 9Router nên chưa đo được `p50`/`max` header ở mức 2 luồng.
3. **Nguyên nhân gốc lỗi `e2e.test.ts:470` tại run `44788053023` (`CHƯA BIẾT`):** Chưa chạy `flake-hunt.yml` trong M0; sẽ kiểm chứng và khóa cảnh báo tự động ở `M1-01`.
4. **Sức khỏe 9Router ở mốc `6h / 12h / 24h` và số liệu phương sai tài nguyên M3 (`CHƯA ĐO`):** M0 mới quan sát tiến trình 9Router ở `ageHours=3.15h`; phép đo lặp có phương sai cho cold-start/idle memory và vận tốc thực tế theo vé sẽ được đo tại `M1–M3`.

---

## (c) Hàng đợi việc cần Chủ dự án quyết hoặc làm (Mục 7 — `OQ-01..OQ-08`)

| Mã | Việc chờ Chủ dự án | Lý do thuộc thẩm quyền Mục 7 | Hậu quả nếu chờ / Cách đội xử lý trong lúc chờ |
|---|---|---|---|
| **OQ-01** | **Duyệt kế hoạch C42 (`evidence/c42`: phạm vi `P1–P7`, `RACI`, `BACKLOG` M1–M2, `CAPACITY`, `RISKS`)** | Mục 8 yêu cầu người duyệt độc lập & Chủ dự án chấp nhận trước khi giao việc xuống phòng ban. | **Chặn mở M1:** Đội dừng chờ duyệt, chưa viết mã, chưa mở PR, chưa kích hoạt Engineer/QA/Ops. |
| **OQ-02** | **Chốt kênh LLM thực thi cho đội bot ở M1–M4** (giữ nguyên chạy qua Sub `antigravity-<uuid>` hiện hành với trần `<= 2` bot đồng thời, hay chuyển sang combo 9Router) | Thay đổi cấu hình app của chủ dự án thuộc Mục 7. | Không chặn M1 nếu giữ nguyên Sub; nếu chuyển sang 9Router thì phụ thuộc hoàn tất `OQ-03` trước. |
| **OQ-03** | **Tự tạo combo `rs-fast` (11 bước) và `rs-max` (14 bước) chiến lược `fallback` trên dashboard 9Router** (hoặc cập nhật thứ tự `9Router-Agent-1`) | Ghi vào DB/cấu hình router thật thuộc độc quyền Chủ dự án (Mục 4 & Mục 7). | Trần gọi đồng thời qua 9Router giữ ở mức `1` luồng tuần tự và chưa gán combo 9Router cho sản xuất cho tới khi có `rs-fast`/`rs-max` và đo lại M0.3 sạch. |
| **OQ-04** | **Tự kiểm tra kết nối/quota 3 provider báo lỗi từ C38–C40** (`huggingface` 404 thiếu credential, `opencode` 429 hết quota free, `cohere` 405) | Quản lý tài khoản/khóa provider và gói dịch vụ thuộc Mục 7. | Không chặn phát triển mã nguồn RouterSync (vì mọi test M1–M4 dùng fake server/fixture DB, `0` token). |
| **OQ-05** | **Quyết định GO/NO-GO tại cổng M5 và tự chạy gắn tag + `npm publish`** | Phát hành lên npm thuộc độc quyền Chủ dự án (Mục 2 & Mục 7). | Chỉ cần ở cuối chương trình (sau khi `evidence/m1..m4` đã `XONG`). |
| **OQ-06** | **Kiểm thử thực tế trên máy macOS và Linux vật lý (nếu Chủ dự án muốn kiểm trước hoặc sau M5)** | Cần phần cứng vật lý của Chủ dự án (ngoài phạm vi C42). | Đội vẫn hoàn tất kiểm chứng tự động trên đủ 5 hệ điều hành của GitHub Actions CI. |
| **OQ-07** | **Xác nhận giữ nguyên 17 hạng mục ngoài phạm vi / hoãn sau v1 ở nhãn `"chờ chủ dự án"`** (`G5`, `G6`, `auto-safe`, Phase 5 bridges, `undo` chính thức, K8...) | Chọn phạm vi ngoài Mục 2 thuộc thẩm quyền Chủ dự án (Mục 7). | Đội mặc định khóa ngoài v0.1 RC để bảo vệ tiến độ và hạn mức LLM. |
| **OQ-08** | *(Tùy chọn)* **Dời thư mục kho cục bộ ra ngoài thư mục đồng bộ đám mây (`<cloud-sync>`)** | Thay đổi vị trí thư mục làm việc trên máy cá nhân của Chủ dự án. | Không chặn công việc; hiện đội giảm thiểu nhiễu I/O bằng chế độ `LIGHT-DEV` và đẩy full suite lên CI. |
