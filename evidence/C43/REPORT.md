# C43 / C43A — Báo cáo Hoàn tất Track R & Gói Bằng chứng `evidence/c43`

- **Chương trình:** RouterSync v0.1 Release Candidate — Gói bằng chứng `evidence/c43` (commit tuyến tính fast-forward trên `c500c2615196bc354f896480b616d78cb5979d19`, nhãn `[skip ci]`, không mở PR, không kích hoạt CI).
- **Kho mã (GitHub-First cho Planner từ xa):** `https://github.com/CThawngs/Router-Sync`
- **Mốc `main` sau khi khép Track R:** `5b39320a133a260515fa240465dfab8bf637d6fb` (PR `#63` — `R1-5`), `main` push CI `45191355709` đạt **`18/18` GREEN `attempt=1`**, chuỗi xanh liên tiếp trên `main` (`ci-stats`): **`24`** (`firstSha=009d5b4`, `lastSha=5b39320`, `28/31` xanh lần đầu trên `main`, toàn đội `62/71 = 87%`, `pending=0`).
- **Tài liệu kỹ thuật chính thức trên `main`:** [`docs/9router-combo-findings.md`](https://github.com/CThawngs/Router-Sync/blob/5b39320a133a260515fa240465dfab8bf637d6fb/docs/9router-combo-findings.md) (mục `7` tổng hợp đầy đủ `R0`, `R2`, `R1`).
- **Trần gói bằng chứng:** Đúng **`10/10` tệp** (`<= 10` tệp), giữ nguyên 100% chữ ký SHA-256 của cả `2` dòng trong `records.jsonl` (`c43-patch-status` và `c43-track-r`).
- **Ràng buộc an toàn khi đóng gói:** `0` lời gọi HTTP/TCP tới cổng `20128`, `30128`, `3128` trong bước đóng gói; `0` đụng chạm tệp/DB thật của router hay kho chính `<REPO>`; chỉ dùng placeholder `<REPO>`, `<USER_DIR>`, `<APPDATA>`, `<cloud-sync>`.
- **Quy ước nguồn gốc con số (C43 mục 2):** Mọi con số dưới đây đều gắn nhãn `đo được (...)`, `xác nhận trực tiếp bởi chủ dự án`, `suy luận`, hoặc `chưa đo`.

---

## 1. Bảng thành phần gói `evidence/C43/` (`10/10` tệp `<= 10`)

| STT | Tệp trong `evidence/C43/` | Vai trò & Trạng thái | Ghi chú kiểm chứng |
|---:|---|---|---|
| `1` | `PLAN.md` | **XONG (mốc nền 3.1 + C43A mục 5)** — Kế hoạch `P1–P7`, `17` mục ngoài phạm vi, lộ trình `M1–M5` & Track R (`R0 -> R2 -> R1`), cổng `M1-01`, GitHub-First | Quét tên riêng/mẫu cá nhân: `0` khớp |
| `2` | `CAPACITY.md` | **XONG (mốc nền 3.1 + C43A mục 6)** — Kiến trúc Sub (`<= 2` bot đồng thời), đính chính M0.3, trần Track R `40` req, biến nhiễu `ponytailEnabled` | Quét tên riêng/mẫu cá nhân: `0` khớp |
| `3` | `RISKS.md` | **XONG (mốc nền 3.1 + C43A `R-13`)** — Ma trận `13` rủi ro (`R-01..R-13`), gồm `R-13` về `ReferenceError: createHash` trong `PATCH_V2` | Quét tên riêng/mẫu cá nhân: `0` khớp |
| `4` | `records.jsonl` | **XONG (`2` bản ghi chuẩn)** — Dòng `1`: `c43-patch-status`; dòng `2`: `c43-track-r` | `verify-records.mjs`: `SẠCH: 2 dòng`; `verify-package.mjs`: `OK` |
| `5` | `c43-patch-status.out.txt` | **XONG (mốc nền)** — `node tools/agent/nine-router-patch.mjs status` (`8` dòng, `240` byte) | `sha256=6c606b517135ca3ea2b5d60ac47d0fd058bda9d2ac8641ff6d62607d3093130f` |
| `6` | `c43-patch-status.err.txt` | **XONG (mốc nền)** — `stderr` rỗng (`0` dòng, `0` byte) | `sha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `7` | `c43-track-r.out.txt` | **XONG (Track R live + offline)** — `node tools/agent/c43-track-r.mjs --live-r1 --yes-spend-tokens` (`32` dòng, `4 634` byte) | `sha256=0af760e22c86278c884d78717a74afdeb47354528f4780f57a6708b044ad2197` |
| `8` | `c43-track-r.err.txt` | **XONG (Track R live + offline)** — `stderr` rỗng (`0` dòng, `0` byte) | `sha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `9` | `REPORT.md` | **XONG (GitHub-First hoàn chỉnh)** — Báo cáo tự thân đầy đủ C43 Baseline Gate + toàn bộ Track R (`R0`, `R2`, `R1.1–R1.5`) | Quét tên riêng/mẫu cá nhân: `0` khớp |
| `10` | `NOTE.md` | **XONG (GitHub-First hoàn chỉnh)** — Tóm tắt điều hành ngắn gọn cho Planner đọc trực tiếp trên GitHub | Quét tên riêng/mẫu cá nhân: `0` khớp |

---

## 2. Mốc nền C43 Baseline Gate (`c43-patch-status`, commit `c500c26`)

Đã khóa ở commit nền `c500c2615196bc354f896480b616d78cb5979d19` (`[skip ci]`, `0` request HTTP tới 9Router, `0` gọi `GET /v1/models`) để mở cổng cứng C43A mục `4` cho `M1-01` và khóa hiện trạng trên đĩa trước Track R:

- **Lệnh chụp (`records.jsonl` dòng 1):** `node tools/agent/nine-router-patch.mjs status` (`exitCode=0`, `durationMs=870 ms`, `startedAt=2026-11-23T05:55:06.219Z`, `endedAt=2026-11-23T05:55:07.087Z`, `privateNamesLoaded=12`, `masked=0` — `đo được (evidence/c43:c43-patch-status)`).
- **Trạng thái 9Router trên đĩa & tiến trình:** `version=0.5.123`, `patchV1=false`, `patchV2=false`, `sha256=c3b4f23acd30384d814ac16f729cc956db717a342abc68a74153f87bbe45ff3f`, `fileModified=2026-11-23T05:49:40.498Z`, `processStart=2026-11-23T05:50:41.340Z`, `loaded=true` (`đo được (evidence/c43:c43-patch-status)`). Tệp `custom-server.js` trên máy là bản sạch `0.5.123`, không còn `PATCH_V2`.
- **Xác nhận C43A mục 1 của Chủ dự án:** Lần dừng 9Router trên cổng `20128` ở phiên trước là do **chủ dự án tắt thủ công** (`xác nhận trực tiếp bởi chủ dự án` ngày `2026-11-23`), không phải tự tắt hay do `PATCH_V2` làm sập tiến trình.
- **Tài nguyên tại mốc nền:** `cpus=8`, `totalMemMB=16 086 MB`, `freeMemStartMB=986 MB`, `freeMemMinMB=986 MB` (`đo được (evidence/c43:c43-patch-status)`).

---

## 3. Bảng tổng hợp các PR của Track R trên `main`

| Hạng mục | PR & Liên kết GitHub | Merge SHA trên `main` | PR CI (`attempt=1`) | Biên bản ký QA | `main` push CI (`attempt=1`) | Nội dung chính đã hợp nhất |
|---|---|---|---|---|---|---|
| **`R0`** | [PR `#60`](https://github.com/CThawngs/Router-Sync/pull/60) | `71709585c45b6034dccc8317e1ad15d8dc5fbba5` | `45149972407` (`18/18` GREEN) | [QA Sign-Off `#60`](https://github.com/CThawngs/Router-Sync/pull/60#issuecomment-7097556820) | `45154273427` (`18/18` GREEN, streak `21`) | Xác nhận `PATCH_V2` ném `ReferenceError: createHash is not defined` gây treo client (`0` byte, `headersSent=false`) khi `router-server.js` bắt `uncaughtException` mà không thoát server; xây `PATCH_V3` (`0.5.119` & `0.5.123`) kèm `4` test + `4` mutation riêng (`0` ghi router thật) |
| **`R2 + R1.1`** | [PR `#61`](https://github.com/CThawngs/Router-Sync/pull/61) | `f0e8534fa74dd160d37b55177f7541bc9837edfd` | `45167416764` (`18/18` GREEN) | [QA Sign-Off `#61`](https://github.com/CThawngs/Router-Sync/pull/61#issuecomment-7100514280) | `45172224721` (`18/18` GREEN, streak `22`) | Thêm nhãn `LOW-SAMPLE` cho `labelStep`/`relabelReliabilityText`, bổ sung `concurrency` + ghi `promptTokens` cho `combos-probe`, và công cụ đo `tools/agent/c43-track-r.mjs` |
| **`R1-5`** | [PR `#63`](https://github.com/CThawngs/Router-Sync/pull/63) — [`docs/9router-combo-findings.md`](https://github.com/CThawngs/Router-Sync/blob/5b39320a133a260515fa240465dfab8bf637d6fb/docs/9router-combo-findings.md) | `5b39320a133a260515fa240465dfab8bf637d6fb` | `45187390402` (`18/18` GREEN) | [QA Sign-Off `#63`](https://github.com/CThawngs/Router-Sync/pull/63#issuecomment-7103477856) | `45191355709` (`18/18` GREEN, streak `24`) | Ghi nhận chính thức mục `7` (Track R: `R0`, `R2`, `R1`) gồm bảng ma trận `2×2`, trạng thái `rs-fast`, biến nhiễu `ponytailEnabled` và chi phí `promptTokens` thực tế |

---

## 4. Kết quả thực chứng `c43-track-r` (`records.jsonl` dòng 2)

### 4.1 Ngân sách phiên đo & thông số thực thi
- **Lệnh chụp:** `node tools/agent/c43-track-r.mjs --live-r1 --yes-spend-tokens` (chạy duy nhất `1` lần trong clone cô lập, `0` đụng chạm `<REPO>`).
- **Thời gian & trạng thái:** `startedAt=2026-11-23T12:26:50.178Z`, `endedAt=2026-11-23T12:32:32.306Z`, `durationMs=342131` (`342,1 s`), `exitCode=0`, `timedOut=false`, `truncated=false` (`đo được (evidence/c43:c43-track-r)`).
- **Ngân sách & an toàn:** `18/40` request (`<= 40` trần cứng), `0` lỗi `429`, `0` treo (`hangs=0`), `gapMs=30000`, `maxTokens=8`, `timeoutMs=60000`, `seed=1806245027`, `0` lệnh `GET /v1/models`, `0` ghi DB/router (`đo được (evidence/c43:c43-track-r)`).
- **Tài nguyên & ẩn danh:** `cpus=8`, `totalMemMB=16 086 MB`, `freeMemStartMB=1 960 MB`, `freeMemMinMB=1 109 MB`, `privateNamesLoaded=12`, `masked={homePath:0, userName:0, privateName:0, email:0}` (`đo được (evidence/c43:c43-track-r)`).

### 4.2 Kết quả `R2_OFFLINE` (`0` request mạng)
Tính lại hoàn toàn ngoại tuyến trên dữ liệu `origin/evidence/c38:evidence/C38/w4-reliability.out.txt` và `origin/evidence/c40:evidence/C40/{x2-remaining.out.txt,combo-rs.txt}` (`đo được (evidence/c43:c43-track-r)`):
- **Tổng hợp:** `changes=7`, `keptDead=1`, `keptRateLimited=9`, `rsFastUnchanged=true`, `lowSampleCandidates=7`.
- **`7` ứng viên đổi nhãn sang `LOW-SAMPLE` (tất cả `ok=1/1`):**
  1. `openrouter/openrouter/free` — `ok=1/1`, `p90=845 ms`
  2. `openrouter/nvidia/nemotron-3.5-lightning:free` — `ok=1/1`, `p90=872 ms`
  3. `openrouter/nvidia/nemotron-3.5-super-vl:free` — `ok=1/1`, `p90=901 ms`
  4. `openrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` — `ok=1/1`, `p90=994 ms`
  5. `openrouter/recursive/flint-v1.0:free` — `ok=1/1`, `p90=1 219 ms`
  6. `openrouter/nvidia/nemotron-3-ultra-550b-a55b:free` — `ok=1/1`, `p90=1 274 ms`
  7. `openrouter/baidu/ernie-5.5-flash-preview:free` — `ok=1/1`, `p90=3 312 ms`
- **`1` bước giữ nguyên `DEAD`:**
  - `openrouter/inclusionai/ling-3.2-flash:free` — `ok=0/1`, `p90=5 584 ms`.

### 4.3 Cổng `R1_GATE` & trạng thái `rs-fast`
- **`R1_GATE` (`đo được (evidence/c43:c43-track-r)`):** `version=0.5.123`, `patchV1=false`, `patchV2=false`, `patchV3=false`, `loaded=true`, `portListening=true`, `ponytailEnabled=true`, `hasAgent1=true`, `hasRsFast=false`.
- **Trạng thái `rs-fast` (`chưa đo`):** `R1_RS_FAST=chưa đo`, `reason=combo_not_in_db` (`hasRsFast=false` trong SQLite DB hiện hành của 9Router; tuân thủ nghiêm kỷ luật `0` write xuống DB).

### 4.4 Ma trận đo trực tiếp `9Router-Agent-1` (`2 × 2 × 3` = `18` request)
Toàn bộ `18/18` request trong `12` ô xáo trộn (`seed=1806245027`) trả về **`HTTP 200 OK`**, `0` hang/timeout, `0` lỗi `429` (`đo được (evidence/c43:c43-track-r)`):

| Ô ma trận | Cấu hình (`stream`, `concurrency`) | Số mẫu & mã HTTP | Độ trễ header (tổng) | Hang / `429` | Ghi nhận `usageHistory` |
|---|---|---|---|---|---|
| `stream_on_c1` | `stream=true`, `c=1` | `3/3` `HTTP 200 OK` | `631–1 365 ms` (`632–1 367 ms`) | `0` / `0` | `tokens_in=-`, `tokens_out=-`, `usage=-` |
| `stream_off_c1` | `stream=false`, `c=1` | `3/3` `HTTP 200 OK` | `702–834 ms` (`703–835 ms`) | `0` / `0` | `tokens_in=826`, `tokens_out=4`, `cloudflare-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast` |
| `stream_on_c2` | `stream=true`, `c=2` | `6/6` `HTTP 200 OK` (`3` cặp) | `667–1 067 ms` (`668–1 068 ms`) | `0` / `0` | `tokens_in=-`, `tokens_out=-`, `usage=-` |
| `stream_off_c2` | `stream=false`, `c=2` | `6/6` `HTTP 200 OK` (`3` cặp) | `699–1 632 ms` (`700–1 632 ms`) | `0` / `0` | `tokens_in=826`, `tokens_out=2`, `cloudflare-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast` |

- **Kết luận phân loại chính thức (C43A §2):** `R1_CLASSIFY combo=9Router-Agent-1 count=18 conclusion="không tái hiện trong 18 mẫu"` (`đo được (evidence/c43:c43-track-r)`).

### 4.5 Hai minh bạch quan sát (Transparency Disclosures)
1. **Biến nhiễu `ponytailEnabled=true` trên tiến trình live dù `patchV1..V3=false`:**
   - Cổng `R1_GATE` đo trực tiếp `ponytailEnabled=true` trong SQLite cấu hình của `9router@0.5.123` nguyên bản (`patchV1=false`, `patchV2=false`, `patchV3=false`, `loaded=true` — `đo được (evidence/c43:c43-track-r)`).
   - Vì quy tắc C43A cấm sửa cấu hình router thật, mọi phép đối chiếu giữa ô `stream=true` và `stream=false` bị nhiễu đồng thời bởi cơ chế tiêm ngữ cảnh của `ponytailEnabled` trên luồng stream (`suy luận`). Ngoài ra, `9/9` mẫu `stream=true` không ghi dòng `usageHistory` mới trong cửa sổ đo (`tokens_in=-`, `usage=-`), trong khi `9/9` mẫu `stream=false` ghi đầy đủ (`đo được (evidence/c43:c43-track-r)`).
2. **Chi phí `tokens_in=826` mỗi request non-stream vượt dự toán lý thuyết `< 2 900` của C43A §2:**
   - Dù payload thăm dò tối giản (`max_tokens=8`), mỗi request `stream=false` đo trực tiếp tiêu thụ **`826` input tokens** (`7 434` input tokens trên `9` request non-stream — `đo được (evidence/c43:c43-track-r)`), ước tính **`~14 868` input tokens** khi gộp cả `9` request stream (`suy luận`) do phần đệm system prompt nội bộ của 9Router/combo.
   - Con số này vượt mức ước tính lý thuyết `< 2 900` của C43A §2 (`suy luận`), nhưng vẫn giữ **`0` chi phí trả phí** (chạy hoàn toàn trên `cloudflare-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast` free tier) và giữ nghiêm trần số lượng **`18 <= 40` request** (`đo được (evidence/c43:c43-track-r)`).

---

## 5. Hạng mục chưa đo & quyết định tùy chọn của Chủ dự án (không chặn Track R)

1. **`rs-fast` (`chưa đo`, `reason=combo_not_in_db`):** Chưa tồn tại trong SQLite DB hiện hành của 9Router; việc tạo `rs-fast` (`fallback`) thuộc quyền chủ dự án trên dashboard 9Router.
2. **Áp `PATCH_V3` (`0` lần ghi router thật):** Máy chủ đang chạy bản sạch `9router@0.5.123` (`patchV1=false`, `patchV2=false`, `patchV3=false`). Việc có áp `PATCH_V3` hay tiếp tục giữ bản nguyên gốc thuộc quyền chủ dự án.
3. **Cô lập biến nhiễu `ponytailEnabled`:** Nếu sau này cần tách riêng ảnh hưởng của SSE streaming khỏi `ponytailEnabled`, chủ dự án có thể chủ động tắt tạm tùy chọn này trước khi chạy lại vòng đo mới.
