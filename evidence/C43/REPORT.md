# C43 / C43A — Báo cáo Mốc nền Mục 3.1 & Cổng mở `M1-01` (`evidence/c43`)

- **Chương trình:** RouterSync v0.1 Release Candidate — Gói bằng chứng `evidence/c43` (commit mốc nền `[skip ci]`, không mở PR, không kích hoạt CI)
- **Kho mã:** `https://github.com/CThawngs/Router-Sync` (mốc nền `main`: `c28b7fb`, PR `#56` — `đo được (evidence/c42:m0-ci-stats)`)
- **Mục đích mốc nền (C43A mục 0 & mục 4):**
  1. Khóa và công bố trực tiếp trên GitHub (quy chuẩn **GitHub-First** cho Planner từ xa) trọn bộ `3` tệp mục `3.1` đã cập nhật C43 + C43A: [`PLAN.md`](./PLAN.md), [`CAPACITY.md`](./CAPACITY.md), [`RISKS.md`](./RISKS.md).
  2. Khóa bản ghi chỉ-đọc nền `c43-patch-status` qua `tools/agent/capture-evidence.mjs` (`0` request HTTP tới 9Router, `0` gọi `GET /v1/models`) để chứng thực trạng thái phiên bản & bản vá hiện hành trên đĩa (`version`, `patchV1`, `patchV2`, `loaded`) trước khi Track R (`R0 -> R2 -> R1`) thực thi.
  3. **Mở cổng cứng C43A mục 4 cho `M1-01`:** PR `M1-01` chỉ được QA ký biên bản và Ops squash-merge sau khi `origin/evidence/c43` đã đẩy lên GitHub chứa đủ `3` tệp mục `3.1` và vượt qua đủ `3` cổng kiểm định (`verify-records.mjs` đạt `SẠCH`, `verify-package.mjs` đạt `OK`, `scan-private-names.mjs` đạt `0` khớp).
- **Lộ trình cập nhật tiếp theo trên nhánh này:** Các kết quả thực thi tiếp theo của Track R (`R0` → `R2` → `R1.1` → `R1.2` hoặc `chưa đo`) sẽ được bổ sung bằng commit fast-forward có `[skip ci]` (tuyệt đối không force-push), giữ tổng số tệp trong `evidence/C43/` không vượt `10` tệp (`suy luận` trần gói; mốc nền này gồm **`8` tệp**, còn dư `2` tệp).
- **Quy ước nguồn gốc con số (C43 mục 2):** Mọi con số dưới đây đều gắn nhãn `đo được (evidence/c43:c43-patch-status)`, `đo được (evidence/c42:m0-ci-stats)`, `suy luận`, `chưa biết`, hoặc `chưa kiểm`.

---

## (a) Kết quả đã khóa ở mốc nền C43A

### 1. Bảng thành phần gói `evidence/C43/` (`8` tệp `<= 10` tệp — `suy luận` trần gói)

| STT | Tệp trong `evidence/C43/` | Vai trò & Trạng thái | Ghi chú kiểm chứng |
|---:|---|---|---|
| `1` | `PLAN.md` | **XONG (mục 3.1 + C43A mục 5)** — Kế hoạch `P1–P7`, `17` mục ngoài phạm vi (`suy luận`), lộ trình `M1–M5` & Track R, thứ tự `R0 -> R1`, cổng `M1-01`, GitHub-First | Quét tên riêng/mẫu cá nhân: `0` khớp; đã chuẩn hóa UTF-8 phần bổ sung C43A mục `5` |
| `2` | `CAPACITY.md` | **XONG (mục 3.1 + C43A mục 6)** — Kiến trúc Sub (`<= 2` bot đồng thời — `suy luận`), đính chính M0.3 là `chưa kiểm`/`chưa kết luận`, trần Track R `40` req (`suy luận`), biến nhiễu `ponytailEnabled` & hệ quả ~`2 900` token prompt | Quét tên riêng/mẫu cá nhân: `0` khớp; đã chuẩn hóa UTF-8 & đánh số mục `6` |
| `3` | `RISKS.md` | **XONG (mục 3.1 + C43A `R-13`)** — Ma trận `13` rủi ro (`R-01..R-13`), bổ sung `R-13` về `ReferenceError: createHash` trong `PATCH_V2` & cổng chặn `evidence/c43` | Quét tên riêng/mẫu cá nhân: `0` khớp; đã chuẩn hóa UTF-8 & nối liền bảng dòng `R-13` |
| `4` | `records.jsonl` | **XONG (mốc nền)** — `1` bản ghi chuẩn `c43-patch-status` sinh qua `tools/agent/capture-evidence.mjs` | `verify-records.mjs`: `SẠCH: 1 dòng`; `verify-package.mjs`: `OK` |
| `5` | `c43-patch-status.out.txt` | **XONG (mốc nền)** — Đầu ra chuẩn của `node tools/agent/nine-router-patch.mjs status` (`8` dòng, `240` byte — `đo được (evidence/c43:c43-patch-status)`) | `sha256=6c606b517135ca3ea2b5d60ac47d0fd058bda9d2ac8641ff6d62607d3093130f` (`đo được (evidence/c43:c43-patch-status)`) |
| `6` | `c43-patch-status.err.txt` | **XONG (mốc nền)** — `stderr` rỗng (`0` dòng, `0` byte — `đo được (evidence/c43:c43-patch-status)`) | `sha256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` (`đo được (evidence/c43:c43-patch-status)`) |
| `7` | `REPORT.md` | **XONG (mốc nền)** — Báo cáo tự đủ cho Planner đọc trực tiếp trên GitHub | Quét tên riêng/mẫu cá nhân: `0` khớp |
| `8` | `NOTE.md` | **XONG (mốc nền)** — Bản tóm tắt điều hành ngắn gọn cho mốc mở cổng `M1-01` | Quét tên riêng/mẫu cá nhân: `0` khớp |

---

### 2. Bản ghi đo nền chỉ-đọc `c43-patch-status` (`0` request HTTP tới 9Router, `0` gọi `GET /v1/models`)

Lệnh chạy qua `tools/agent/capture-evidence.mjs`: `node tools/agent/nine-router-patch.mjs status` (`exitCode=0`, `durationMs=870 ms`, `startedAt=2026-11-23T05:55:06.219Z`, `endedAt=2026-11-23T05:55:07.087Z` — tất cả `đo được (evidence/c43:c43-patch-status)`).

| Trường đo | Giá trị | Nhãn nguồn gốc | Ý nghĩa vận hành theo C43A |
|---|---|---|---|
| `version` | `0.5.123` | `đo được (evidence/c43:c43-patch-status)` | Gói `9router` trên máy đã được cập nhật lên `0.5.123` (cao hơn mốc `0.5.119` trước đây); lưu ý cho `R0` rằng `nine-router-patch.mjs` đang giữ `EXPECTED_VERSION = '0.5.119'` (`suy luận` đối chiếu mã) |
| `patchV1` / `patchV2` | `false` / `false` | `đo được (evidence/c43:c43-patch-status)` | Tệp `9router/app/custom-server.js` trên đĩa **không còn `PATCH_V2`** (bản gốc sạch của `0.5.123`); không cần hoàn tác `v2` trên đĩa nữa (`suy luận`), đội vẫn **tuyệt đối không gửi request HTTP nào tới 9Router** trước khi `R0` hoàn tất |
| `sha256` tệp mục tiêu | `c3b4f23acd30384d814ac16f729cc956db717a342abc68a74153f87bbe45ff3f` | `đo được (evidence/c43:c43-patch-status)` | Dấu vết hàm băm hiện tại của `9router/app/custom-server.js` bản `0.5.123` |
| `fileModified` | `2026-11-23T05:49:40.498Z` | `đo được (evidence/c43:c43-patch-status)` | Thời điểm cập nhật tệp trên đĩa |
| `processStart` / `loaded` | `2026-11-23T05:50:41.340Z` / `true` | `đo được (evidence/c43:c43-patch-status)` | Tiến trình 9Router mới khởi động sau thời điểm cập nhật tệp (`loaded=true`) và hiện hoạt động sạch không có `PATCH_V2`; tuy nhiên nguyên nhân cổng `20128` từng dừng ở phiên trước đó vẫn giữ nhãn **`chưa biết`** theo C43A mục 1 |
| Tài nguyên máy (`sys`) | `cpus=8`, `totalMemMB=16 086 MB`, `freeMemStartMB=986 MB`, `freeMemMinMB=986 MB` | `đo được (evidence/c43:c43-patch-status)` | Máy đang ở vùng RAM thấp (`< 1,50 GiB` ngưỡng `heavy.mjs` — `suy luận`), tiếp tục tuân thủ kỷ luật `LIGHT-DEV` và đẩy full suite lên CI `5` OS |
| Bảo mật ẩn danh (`masked`) | `privateNamesLoaded=12` (`guard=4`, `effective=12`), `homePath=0`, `userName=0`, `privateName=0`, `email=0` | `đo được (evidence/c43:c43-patch-status)` | Đạt sàn `>= 4` và khớp `12/12` mục theo `capture-evidence.mjs` dòng `39–58` |

---

### 3. Tổng hợp các điều chỉnh bắt buộc của C43A & Tiến độ Track R / Track M

1. **C43A mục 1 — `createHash` trong `PATCH_V2` & hiện trạng sau cập nhật `0.5.123`:**
   - Trên gói công khai `9router@0.5.119`, tệp `app/custom-server.js` ở phạm vi tệp chỉ có `const crypto = require("crypto")` (dòng `4` — `đo được` bởi người duyệt độc lập trên bản npm công khai), không có định danh `createHash` trần.
   - `PATCH_V2` gọi `createHash(...)` trần trong `modelCacheKey -> serveModelsV2` ngay sau `if (viaProxy)...` không có `try/catch` nên mọi `GET /v1/models` đi vào nhánh này trên `0.5.119` ném `ReferenceError` (`suy luận` kiểm chứng mã nguồn, sẽ ghim bằng test đỏ-trước ở `R0`).
   - Hệ quả tại tiến trình (`router-server.js` dòng `722` có `process.on('uncaughtException', logError)`): treo vĩnh viễn request `/v1/models` hay thoát tiến trình hiện là **`chưa kiểm`** (sẽ kiểm chứng trong `node:vm` và đọc mã tại `R0`).
   - Hệ quả vận hành (nhiều ứng dụng agent gọi `GET /v1/models` lúc khởi động từ ~`15:29 UTC` ngày `2026-11-22` có thể là ứng viên giải thích hiện tượng ứng dụng ngừng trả lời ngoài lỗi combo): ghi nhãn **`suy luận`**, sẽ cập nhật vào `docs/9router-combo-findings.md` đúng nhãn.
   - Nguyên nhân cổng `20128` từng dừng ở phiên trước (khi tệp còn `0.5.119` kèm `patchV2=true`): ghi nhãn **`chưa biết`** theo C43A mục 1 (chờ ghi nhận xác nhận của chủ dự án về việc tắt thủ công hay tự tắt; nếu chủ dự án không biết thì ghi `"không rõ"`). Hiện tại `c43-patch-status` đo được `version=0.5.123`, `patchV1=false patchV2=false`, `processStart=2026-11-23T05:50:41.340Z`, `loaded=true` (`đo được (evidence/c43:c43-patch-status)`).
2. **C43A mục 3 — Thứ tự thực thi Track R (`R0` → `R2` → `R1`, `0` request HTTP tới 9Router ở mốc nền này):**
   - **`R0` (`đang thực thi` — bắt buộc xong trước `R1`):** Viết `PATCH_V3` + `4` bài test kèm `4` mutation riêng cho: (a) `PATCH_V2` ném `ReferenceError` trong `vm` sandbox đúng phạm vi `custom-server.js` gốc `0.5.119`; (b) `PATCH_V3` không ném lỗi; (c) `GET /v1/models` lần `1` (`miss`) và lần `2` (`hit`) đúng thân & tiêu đề `x-9r-models-cache`; (d) request khác `/v1/models` không vào nhánh vá; đồng thời trả lời hành vi `uncaughtException`. Tuyệt đối không tự áp lên router thật (`0` request 9Router — `suy luận`).
   - **`R2` (`tiếp theo` — `0` request mới):** Kiểm toán `7` bước `openrouter` đạt `ok=1/1` (`đo được (evidence/c40:x2-remaining)`) bị gắn `DEAD` và tính lại danh sách `rs-fast`/`rs-max` từ dữ liệu `evidence/c38` & `evidence/c40`.
   - **`R1` (`chờ sau khi R0 hoàn tất`):** Vì `c43-patch-status` đã đo được 9Router đang chạy bản sạch `0.5.123` (`patchV1=false patchV2=false`, `loaded=true` — `đo được (evidence/c43:c43-patch-status)`), điều kiện không chạy `R1.2` khi còn `PATCH_V2` đã an toàn (`suy luận`); tuy nhiên `R1.2` **chỉ được phép chạy sau khi `R0` hoàn tất** (ghi lại `status` ngay thời điểm đo vào `records.jsonl`). Khi chạy `R1`, bắt buộc ghi `promptTokens` từ `usageHistory` cho từng request; lưu ý biến nhiễu `ponytailEnabled` (chỉ chèn prompt khi `stream: true` — `suy luận`) giữa hai ô `stream bật` và `stream tắt`; ghi hệ quả ~`2 900` token prompt/request (`chưa kiểm` trước khi khóa qua capture; tác động làm cạn nhanh quota gói miễn phí ở mức **`suy luận`**).
3. **C43A mục 4 — Cổng cứng cho `M1-01` & Quy chuẩn CI:**
   - Gói nền `evidence/c43` này (không PR, commit `[skip ci]`, `0` CI workflow chạy) thỏa mãn điều kiện tiên quyết mục `4` để sau khi Engineer hoàn tất PR `M1-01` và CI xanh đủ `5` hệ điều hành, QA tự kiểm lại điều kiện này rồi mới ký biên bản (`3` mục: checkout sạch + `1` mutation riêng đỏ + verifier chuẩn) và Ops mới chạy `gh pr merge --squash`.
   - Đối chiếu nền CI từ `evidence/c42`: `main` tại `c28b7fb` (PR `#56`), `push` trên `main` xanh lần đầu `23/27`, đội `53/65 (82%)`, `pending=0` (`đo được (evidence/c42:m0-ci-stats)`).

---

## (b) Điều chưa biết, chưa kiểm hoặc chưa đo tại mốc nền này

1. **Nguyên nhân cổng `20128` từng dừng ở phiên trước (`chưa biết`):** Dù hiện tại `9router@0.5.123` đã chạy lại (`processStart=2026-11-23T05:50:41.340Z`, `loaded=true`, `patchV1=false patchV2=false` — `đo được (evidence/c43:c43-patch-status)`), nguyên nhân phiên trước ngừng lắng nghe khi còn `0.5.119` (`patchV2=true`) vẫn chưa có bằng chứng xác định là tắt thủ công hay tự dừng.
2. **Hành vi `uncaughtException` khi `PATCH_V2` ném `ReferenceError` (`chưa kiểm`):** Chờ `R0` chạy thực nghiệm `node:vm` và đọc mã `router-server.js` dòng `722`.
3. **Kết quả thực thi `R0`, `R2`, `R1.1`, `R1.2` (`chưa đo` ở mốc nền này):** Sẽ cập nhật bằng commit fast-forward trên `evidence/c43` sau khi `R0` → `R2` → `R1` hoàn tất (`0` request HTTP tới 9Router đã được gửi ở mốc nền này).
4. **Con số `~2 900` token prompt/request từ `usageHistory` (`chưa kiểm` ở mốc nền này):** Sẽ chuyển sang `đo được` khi `R1` chụp từ `usageHistory` qua `capture-evidence.mjs`; tác động lên tốc độ cạn quota gói miễn phí giữ nhãn **`suy luận`**.
5. **Khả năng tương thích bản vá trên `9router@0.5.123` (`chưa kiểm`):** Hiện `nine-router-patch.mjs` khóa `EXPECTED_VERSION = '0.5.119'` (`suy luận` đọc mã); `R0` cần kiểm tra và báo rõ phạm vi `0.5.119` vs `0.5.123` mà không tự ghi lên router thật.

---

## (c) Việc cần Chủ dự án xác nhận hoặc tự thực hiện (Mục 1, 2 C43A & Mục 7 — đội không tự bật/tắt/ghi)

1. **Ghi nhận nguyên nhân 9Router dừng ở phiên trước (C43A mục 1):** Xác nhận giúp đội xem chủ dự án có tắt thủ công 9Router trước khi nâng lên `0.5.123` hay không (nếu không rõ thì đội ghi `"không rõ"`).
2. **Quyết định áp bản vá sau `R0` (tùy chọn, không chặn Track R):** Hiện `9router@0.5.123` đang chạy sạch (`patchV1=false patchV2=false`, `loaded=true` — `đo được (evidence/c43:c43-patch-status)`), không còn `PATCH_V2`. Việc có áp `PATCH_V3` sau khi `R0` xong hay giữ nguyên `0.5.123` sạch là quyết định của chủ dự án.
3. **Các mục tùy chọn khác của Chủ dự án (không chặn `M1`, `M2`):** Tạo `rs-fast` (`fallback`) trên dashboard sau khi `R2` xác nhận danh sách bước; tách thử `ponytailEnabled` nếu sau `R1` muốn cô lập hoàn toàn biến nhiễu kích thước prompt khỏi đường stream.
