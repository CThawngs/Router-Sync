# Phát hiện về combo 9Router (tóm tắt để không đào lại)

Tài liệu này gom kết luận của C32–C43. Mỗi mệnh đề có nhãn **đo được**,
**suy luận**, **chưa biết** hoặc **chưa đo**. Chỉ nêu tên nhánh và commit bằng
chứng, không có tên riêng hay đường dẫn cá nhân.

## 1. Combo chạy tuần tự, không có hạn cho từng bước

- **đo được** — Combo thử các bước theo thứ tự; `combos probe --timeline` ghi nhiều
  dòng `usageHistory` liên tiếp trong cùng một request (C37, `evidence/c37-e2e`
  `7311326`; C39, `evidence/c39` `abec7d0`). Có bước trả lời (`status=ok`) nhưng
  router vẫn chuyển bước khác.
- **đo được** — Một bước treo làm cả combo đứng: `nvidia/z-ai/glm-5.3-flash` không
  trả header trong 20 s (C39); combo `9Router-Agent-1` không có header sau 60 s,
  không có dòng usage (C39). Cả 9 combo dùng chung 230 bước và 8 bước đầu giống
  nhau, nên đổi tên combo không tránh được bước treo (C39).
- **đo được** — Bước 429/503 nhanh thì **không** gây treo: bước 1 `oc/...` trả 429
  trong 390 ms, bước 3 trả 503 trong 8 ms; bước đầu tiên chạy được là thứ 8
  `cf/@cf/zai-org/glm-4.7-flash` (C39).
- **chưa biết** — Liệu router có ngưỡng thời gian nội bộ cho từng bước hay không;
  chỉ biết client không nhận header trong các hạn đã thử (20 s, 60 s, 120 s).

## 2. `/v1/models` đã hết nghẽn nhờ cache ngoài repo

- **đo được** — `/v1/models` từng đốt 4–5 giây CPU và chặn request khác (C35/C36,
  `e95507e`). Bản vá cache nằm ngoài repo, xem `tools/agent/nine-router-patch.mjs`.
  Bản **v1 đã chạy** (cache 60 s, đã restart trước C37 — `323cf88`). Bản **v2 đã được
  ghi vào tệp** (`evidence/c37-apply` `8fe166e`), nhưng C37 ghi rõ router **chưa**
  được khởi động lại sau lần ghi đó.
- **đo được (C41 Y0)** — `nine-router-patch.mjs status` so sánh thời điểm tiến trình
  bắt đầu với thời điểm tệp được sửa: `processStart=2026-11-22T15:29:07Z`,
  `fileModified=2026-11-22T13:46:56Z` ⇒ `loaded=true`. Router đã nạp v2. Số đo trong
  nhánh `evidence/c41`. Lệnh chỉ đọc; muốn tự kiểm chạy lại lệnh `status`.
- **đo được** — Sau vá, 215 mẫu / 45 phút cho 9/9 combo OK, p50 header 2 163 ms,
  `/v1/models` p50 2 ms (cache hit); tuổi tiến trình 33–78 phút (C37 `323cf88`).
- **suy luận** — Cache là lý do `/v1/models` hết nghẽn. Không đo được gì ở mốc 6/12/24
  giờ; xem `docs/router-health.md` (đối chiếu thêm sự cố `PATCH_V2` và bản vá
  `PATCH_V3` ở mục 7.1).

## 3. Giả thuyết chưa được ủng hộ

- **đo được** — Combo `fallback` đối chứng (`9Router-Agent-1`, `9Router-Coder-3`)
  cũng treo 0/2 trong W1; RAM trống tụt xuống 324 MB và 3 tên combo stale trả
  `NO-RESULT` (C38 `8c778a3`). Vì vậy **giả thuyết `round-robin` chưa được ủng hộ**;
  không gọi là bác bỏ vì phép đo nhiễu.
- **chưa biết** — Giả thuyết RAM: phép tính lại nhãn ngoại tuyến R2 đã hoàn tất
  (xem mục 7.2), nhưng vẫn chưa có số đo thực nghiệm tách riêng ảnh hưởng của bộ
  nhớ trống trên máy chủ và ảnh hưởng của thứ tự bước trong combo.

## 4. Thăm dò tốn quota gói miễn phí

- **đo được** — Cùng bước `oc/deepseek-v4.1-flash-free` phục vụ trong 1–3 s ở C37
  (~80 phút trước), rồi trả 429 ở C39. Bước 2 `oc/tidepool-alpha-free` trả
  `FreeUsageLimitError`, `hf` trả 404 "No active credentials for provider:
  huggingface", `cohere` trả 405 (C38 `8c778a3`, C39 `abec7d0`).
- **suy luận** — Các lượt thăm dò C32–C39 (hàng trăm request nhỏ) có thể góp vào
  việc chạm quota. Ước lượng số request theo tệp bằng chứng: **381** (C32 = 354,
  C38 = 22, C39 = 5), do `tools/agent/x40-evidence.mjs` đếm. Đây là cận dưới,
  không phải số hoá đơn của provider.
- **đo được** — C40 X0 thêm `--budget` (mặc định 40), bộ đếm theo provider,
  `SKIPPED-QUOTA` cho bước 429 trong 30 phút qua, xen kẽ provider và chú thích
  `quota=1` (xem `docs/combos-probe.md` và chi phí `promptTokens` đo ở mục 7.3).

## 5. Việc chủ dự án có thể tự kiểm

| Việc | Dữ liệu gợi ý |
|---|---|
| Kết nối `huggingface` còn active không | thông điệp "No active credentials for provider: huggingface" |
| Quota gói miễn phí của `opencode` | `FreeUsageLimitError` ở bước `oc/...` |
| Endpoint / kiểu provider `cohere` | 405 với `Allow` rỗng; chưa đủ dữ liệu để kết luận |
| Tách riêng ảnh hưởng của `ponytailEnabled` trên đường `stream=true` | `ponytailEnabled=true` trong CSDL 9Router (`evidence/c43`); chỉ kiểm chứng khi chủ dự án chủ động bật/tắt cài đặt này |

## 6. Cách dùng kết quả

- Dùng combo ngắn, đã đo, chiến lược **Fallback** (`rs-fast` / `rs-max`) — vẫn là
  combo 9Router. Giữ xoay vòng tài khoản ở cấp provider; xem
  `docs/combo-rs-fast.md`.
- Với combo có sẵn, dùng `routersync combos plan --emit-reorder` để đưa bước
  `HANG` xuống cuối **mà không xoá**; xem mục "Sắp xếp lại combo có sẵn".
- Không restart router, không ghi DB/router trong các vòng đo này.

## 7. Kết quả Track R (C43 / C43A: R0, R2, R1)

### 7.1 R0 — Lỗi định danh trần `createHash` ở `PATCH_V2`, cơ chế treo `uncaughtException` và `PATCH_V3`

- **đo được** (`R0`, commit `7170958`, `test/agent/nine-router-patch.node.test.mjs`) —
  Ở cả `9router@0.5.119` và `9router@0.5.123`, tệp `app/custom-server.js` chỉ khai báo
  `const crypto = require("crypto")` ở phạm vi tệp (không có định danh trần
  `createHash`) và bọc `http.createServer` không có `try/catch` trước khi chuyển vào
  `handler` của Next.js. Trong phép tái hiện cô lập bằng `node:vm` trên cổng tạm
  `127.0.0.1:0` gắn cơ chế `router-server.js` của Next.js
  (`process.on('uncaughtException', logError)` ở dòng 722), `PATCH_V2` ném đồng bộ
  `ReferenceError: createHash is not defined` khi nhận `GET /v1/models` (và
  `GET /api/v1/models`): tiến trình máy chủ **không thoát**
  (`POST /v1/chat/completions` vẫn trả `200 OK`), còn request `GET /v1/models`
  **treo phía client** (`0` byte nhận về, `headersSent=false`).
- **đo được** (`R0`, commit `7170958`, `tools/agent/nine-router-patch.mjs`) — Bản vá
  `PATCH_V3` (`MARK_V3 = 'C43 PATCH v3'`, `SUPPORTED_VERSIONS = ['0.5.119', '0.5.123']`)
  tính băm SHA-256 qua `crypto.createHash` / `node:crypto` mà không dùng `createHash`
  trần, trả `x-9r-models-cache: miss` rồi `hit` trong thời hạn TTL cho
  `GET /v1/models`, đồng thời bỏ qua các đường dẫn không phải danh sách `/v1/models`
  (`POST /v1/chat/completions`, `POST /v1/models`, `GET /api/health`,
  `GET /v1/models/<id>`).
- **đo được** (`evidence/c43`: `c43-patch-status` & `c43-track-r`) — Trên máy chủ thực
  tế, 9Router đã được nâng lên phiên bản `0.5.123` với trạng thái `patchV1=false`,
  `patchV2=false`, `patchV3=false`, `loaded=true` (`custom-server.js` nguyên bản chưa
  vá); chủ dự án xác nhận lần dừng cổng `20128` trước đó là `tắt thủ công`. Bản
  `PATCH_V3` **chưa** được ghi vào router máy chủ (`0` lần chạy `--yes-write-router`).

### 7.2 R2 — Tính lại nhãn `LOW-SAMPLE` ngoại tuyến trên C38 + C40 (`0` request mạng)

- **đo được** (`R2`, commit `f0e8534`, `tools/agent/c43-track-r.mjs`, `evidence/c43`) —
  Khi cập nhật `labelStep` (`packages/cli/src/commands/combos-reliability.ts`) và
  `relabelReliabilityText` (`packages/cli/src/commands/combos-reorder.ts`) để bước có
  `0 < ok === attempts < 5`, `timedOut === 0`, `rateLimited === 0` nhận nhãn
  `LOW-SAMPLE` thay vì `DEAD`, phép tính lại hoàn toàn ngoại tuyến trên `evidence/c38`
  và `evidence/c40` đã đổi nhãn **`7` bước `openrouter/*` (`ok=1/1`)** sang `LOW-SAMPLE`
  (`openrouter/openrouter/free` `p90=845 ms`,
  `openrouter/nvidia/nemotron-3.5-lightning:free` `872 ms`,
  `openrouter/nvidia/nemotron-3.5-super-vl:free` `901 ms`,
  `openrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` `994 ms`,
  `openrouter/recursive/flint-v1.0:free` `1 219 ms`,
  `openrouter/nvidia/nemotron-3-ultra-550b-a55b:free` `1 274 ms`,
  `openrouter/baidu/ernie-5.5-flash-preview:free` `3 312 ms`), giữ nguyên `1` bước lỗi
  cứng là `DEAD` (`openrouter/inclusionai/ling-3.2-flash:free`, `ok=0/1`,
  `p90=5 584 ms`), giữ nguyên `9` bước `oc/*` là `RATE-LIMITED`, và không làm thay đổi
  danh sách `rs-fast` (`rsFastUnchanged=true`).

### 7.3 R1 — Ma trận `2×2` có kiểm soát (`stream × concurrency`), biến nhiễu `ponytailEnabled` và chi phí `promptTokens`

- **đo được** (`evidence/c43`: `c43-track-r`) — Cổng an toàn trước khi đo
  (`checkR1Gate` trong `tools/agent/c43-track-r.mjs`, dùng `nine-router-patch.mjs status`
  kết hợp kiểm tra socket TCP thuần, `0` request `GET /v1/models`) ghi nhận
  `version=0.5.123`, `patchV1=false`, `patchV2=false`, `patchV3=false`, `loaded=true`,
  `portListening=true`, `ponytailEnabled=true`, `hasAgent1=true`, `hasRsFast=false`.
- **chưa đo** (`evidence/c43`: `c43-track-r`) — Combo `rs-fast` mang trạng thái
  `R1_RS_FAST=chưa đo` với lý do `combo_not_in_db` (combo chưa được khởi tạo trong cơ
  sở dữ liệu SQLite của 9Router đang chạy).
- **đo được** (`evidence/c43`: `c43-track-r`) — Trên ma trận ngẫu nhiên `2×2` với combo
  `9Router-Agent-1` (`seed=1806245027`, `12` lượt phát = `18` request `<= 40` trần ngân
  sách, `max_tokens=8`, `timeout=60 000 ms`, `gap=30 000 ms`, xem
  `packages/cli/src/commands/combos-probe.ts`), cả **`18/18` request đều trả
  `HTTP 200 OK`** (`0` lần quá hạn/treo, `0` phản hồi `429`; kết luận phân loại:
  `"không tái hiện trong 18 mẫu"`):

| Ô ma trận | Cấu hình (`stream`, `concurrency`) | Số mẫu & mã HTTP | Độ trễ header (tổng) | Ghi nhận `usageHistory` trong cửa sổ đo |
|---|---|---|---|---|
| `stream_on_c1` | `stream=true`, `concurrency=1` | `3/3` `200 OK` | `631–1 365 ms` (`632–1 367 ms`) | `-` (`0` dòng mới xuất hiện) |
| `stream_off_c1` | `stream=false`, `concurrency=1` | `3/3` `200 OK` | `702–834 ms` (`703–835 ms`) | `promptTokens=826`, `completionTokens=4`, `cloudflare-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast` |
| `stream_on_c2` | `stream=true`, `concurrency=2` | `6/6` `200 OK` (`3` cặp) | `667–1 067 ms` (`668–1 068 ms`) | `-` (`0` dòng mới xuất hiện) |
| `stream_off_c2` | `stream=false`, `concurrency=2` | `6/6` `200 OK` (`3` cặp) | `699–1 632 ms` (`700–1 632 ms`) | `promptTokens=826`, `completionTokens=2`, `cloudflare-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast` |

- **đo được** (`evidence/c43`: `c43-track-r` — chênh lệch ghi nhận `usageHistory` theo
  `stream`) — Trên `9router@0.5.123` khi `ponytailEnabled=true`, cả `9/9` request
  `stream=false` đều ghi ngay dòng `usageHistory` (`promptTokens=826`), trong khi cả
  `9/9` request `stream=true` đều trả `200 OK` nhưng không xuất hiện dòng
  `usageHistory` mới trong cửa sổ thăm dò của công cụ đo (`tokens_in=-`, `usage=-`).
- **suy luận** (C43A §3.3 — biến nhiễu `ponytailEnabled`) — Vì `ponytailEnabled=true`
  tiêm thêm ngữ cảnh vào đường `stream: true` trong 9Router và cài đặt router được giữ
  nguyên không sửa, mọi phép đối chiếu giữa các ô `stream=true` và `stream=false` đều
  **bị nhiễu đồng thời** giữa giao thức truyền SSE streaming và việc tiêm ngữ cảnh
  `ponytailEnabled`.
- **đo được** (C36/C37 & `evidence/c43`: `c43-track-r` — chi phí `promptTokens` thực
  tế) — Phép tính `40 × 8 = 320` chỉ giới hạn **token đầu ra (`max_tokens=8`)**, không
  phải tổng token tiêu thụ phía nhà cung cấp: ngay cả với câu nhắc tối giản 7 từ
  (`"Trả lời đúng một từ: ok"`), các dòng `usageHistory` lịch sử ở C36/C37 từng ghi
  nhận `~2 900` `promptTokens`/request từ phần đệm hệ thống/wrapper, và phép đo `R1`
  trên `9router@0.5.123` (`stream=false`) đo trực tiếp **`826` `promptTokens`/request**
  (`9 × 826 = 7 434` token đầu vào chỉ tính riêng `9` request `stream=false`).
- **suy luận** (C43A §3.4 — dự toán hạn mức gói miễn phí) — Ước tính trên toàn bộ `18`
  request của ma trận `R1`, tổng tiêu thụ đầu vào ở mức `~15 000+` token; do đó việc
  dự toán ngân sách thăm dò trên gói miễn phí bắt buộc phải tính chi phí nền
  `promptTokens` mỗi request thay vì chỉ nhìn vào `max_tokens`.
