# CAPACITY — Năng lực đồng thời, gán combo theo vai và ngân sách ngày (Cập nhật C43 mục 3.1 trước khi giao vé)

- **Đồng lập & phê duyệt:** CEO (hiệu đính C43 mục 0.1, 0.2, 0.3, 0.6, 0.7, 1, 2 trước khi giao vé), COO, Product Manager, CTO
- **Quy ước nguồn gốc con số (C43 mục 2):** Mỗi con số đều ghi nhãn `đo được (<tên-bản-ghi trong records.jsonl>)`, `suy luận`, `chưa biết`, hoặc `chưa kiểm` (khi không có bản ghi trong `records.jsonl`).

## 1. Đối chiếu kiến trúc chạy thực tế vs giả định Mục 5 C42

- **Cấu hình đội bot OpenMausBot:** `17/17` bot (`chưa kiểm` — đọc từ `<HOME>/.openmausbot/bots.json` ngoài `capture-evidence.mjs`) hiện chạy trực tiếp qua **Sub (`antigravity-<uuid>`)** kèm fallback `openrouter/free`:
  - Nhóm Code & Kiến trúc (`5` bot — `chưa kiểm`): `CEO`, `CTO`, `Data-AI` (`gemini-4-carbon`); `Engineer`, `QA` (`claude-opus-5-5`). Lưu ý theo C43 mục 0.7 & 3.4: vì `Engineer` và `QA` dùng chung model trên cùng kênh Sub, tính độc lập của QA bắt buộc được bảo đảm bằng `3` điều kiện thực chất (`suy luận` quy tắc quản trị): (a) checkout sạch của head PR, (b) QA tự viết `1` đột biến (mutation) riêng chưa có ở Engineer và chứng minh test đỏ, (c) ghi cả hai vào biên bản ký.
  - Nhóm Phân tích sâu & Điều phối (`6` bot — `chưa kiểm`): `Product Manager`, `COO`, `Researcher`, `Marketer`, `Ops`, `Finance` (`gemini-4-neon`).
  - Nhóm Thiết kế, Content & Pháp lý (`3` bot — `chưa kiểm`): `Designer`, `Content`, `Legal` (`claude-sonnet-5-5`).
  - Nhóm Tác vụ thường nhật (`3` bot — `chưa kiểm`): `Sales`, `Support`, `HR` (`gemini-4-hydrogen`).
- **Combo trong 9Router:** Trong DB 9Router có `9` combo (`đo được: evidence/c41 y2-drift`), gồm `9Router-Agent` (`round-robin`, `231` bước — `đo được: evidence/c41 y2-drift`, cấm dùng do `RISK-ROUND-ROBIN`), `9Router-Agent-1`, `9Router-Agent-2`, `9Router-Coder-1` (`230` bước — `đo được: evidence/c41 y2-drift`), `9Router-Coder-2`..`5` (`fallback`, `231` bước — `đo được: evidence/c41 y2-drift`), và `9Router-Dev` (`mặc định`, `231` bước — `đo được: evidence/c41 y2-drift`). Hai combo ngắn `rs-fast` (`11` bước dự kiến — `suy luận` từ `docs/combo-rs-fast.md`, đang chờ kiểm lại nhãn `DEAD` ở Track R mục `R2`) và `rs-max` (`14` bước dự kiến — `suy luận` từ `docs/combo-rs-fast.md`, chờ kiểm lại ở `R2`) chưa có trong DB tại thời điểm C42 (`chưa kiểm` ở đầu C43, sẽ kiểm lại ở Track R).
- **Quyết định OQ-02 (C43 mục 1):** Giữ nguyên đội bot trên kênh **Sub** hiện tại, tối đa `2` bot gọi LLM đồng thời (`suy luận` chính sách điều phối), xuyên suốt **M1 và M2**. Chỉ xét chuyển sang 9Router sau khi Track R có kết quả đã capture và `rs-fast` đã được chủ dự án tạo và đo.

## 2. Đính chính kết quả thử nghiệm M0.3 (Sửa theo C43 mục 0.1, 0.2 và 0.3 — CHƯA KIỂM & CHƯA KẾT LUẬN)

1. **Tình trạng kiểm chứng (`chưa kiểm` — C43 mục 0.2):**
   - Lượt chạy M0.3 ở C42 dùng script tạm `m03-concurrency.mjs` đặt ngoài `<REPO>` và **không chạy qua `tools/agent/capture-evidence.mjs`** (`records.jsonl` của `evidence/c42` chỉ có `1` bản ghi duy nhất là `m0-ci-stats` — `đo được: evidence/c42 m0-ci-stats`).
   - Do đó, **toàn bộ con số của M0.3 dưới đây đều mang nhãn `chưa kiểm`**, không được dùng làm bằng chứng đo đã xác nhận. Theo quy tắc từ C35 và C43 mục 2, mọi phép đo hợp lệ phải nằm trong `tools/agent/`, có unit test + mutation, và chạy qua `tools/agent/capture-evidence.mjs` (được thực hiện lại đầy đủ tại **Track R — mục R1**).
2. **Vì sao M0.3 KHÔNG ĐỦ để kết luận về đồng thời (C43 mục 0.1):**
   - Mỗi luồng chỉ gửi `1` request (`attempted=2` trên mục tiêu `10` — `chưa kiểm`), dừng ngay ở lần quá hạn `60 s` đầu tiên (`60 009 ms` và `60 015 ms` — `chưa kiểm`).
   - **Không có phép đối chứng `1` luồng** (`chưa biết` liệu `1` luồng tại thời điểm đó có treo tương tự hay không).
   - **Không có phép đối chứng `stream: false`** (`chưa biết` liệu lỗi nằm ở đường stream SSE hay ở tầng kết nối chung).
   - Vì vậy, câu kết luận cũ ở C42 rằng *"hạ 9Router xuống 1 luồng vì 2 luồng gây treo"* là **chưa có căn cứ** và bị hủy bỏ; kết quả thực chất về nhân quả đồng thời là **`chưa biết`** cho tới khi hoàn tất ma trận đối chứng `4` ô × `3` lần = `18` request (`suy luận` thiết kế R1) tại Track R.
3. **Ghi nhận dấu vết để đối chiếu tại Track R (C43 mục 0.3):**
   - Ghi chú không qua capture ở M0.3 cho thấy `usageHistory` tăng `+2` dòng (`chưa kiểm`) ở bước chỉ số `2` (`openrouter/nvidia/nemotron-3.5-super-vl:free`, `status=ok` sau `~1,66 s`, `promptTokens=2900`, `completionTokens=8` — toàn bộ là `chưa kiểm`) trong khi client không nhận HTTP header trong `60 s` (`chưa kiểm`).
   - Giải trình `promptTokens=2900` theo C43 mục 4: phía client chỉ gửi prompt ngắn (`max_tokens: 8`, `~6–7` token — `suy luận`), nhưng bảng `settings` của 9Router bật `cavemanEnabled = true` và `ponytailEnabled = true` (`chưa kiểm` — sẽ khóa qua bản ghi chuẩn ở `evidence/c43`; do `PONYTAIL` chỉ chèn khi `stream: true`, kích thước prompt giữa ô `stream: true` và `stream: false` ở `R1` sẽ khác nhau — `suy luận`, tuyệt đối không sửa cấu hình router).
   - Hệ quả logic (`suy luận`): (i) bước `nvidia/z-ai/glm-5.3-flash` ở vị trí thứ `6` (`chưa kiểm`) không giải thích được hiện tượng ở bước chỉ số `2`; (ii) hiện tượng *"upstream `ok` mà client không nhận phản hồi"* từng xuất hiện từ E2E của C37 trước khi nạp `PATCH_V2` (`suy luận` theo lịch sử dự án), và `PATCH_V2` chỉ chạy trên `GET /v1/models` nên bản vá v2 không phải nguyên nhân của hiện tượng treo chat này (`suy luận`, sẽ kiểm tra độc lập phạm vi `createHash` của v2 tại `R0`).

| Chỉ số ghi nhận sơ bộ ở C42 (ngoài `capture-evidence.mjs`) | Giá trị ghi chép | Nhãn nguồn gốc (C43 mục 2) | Hiệu lực kết luận |
|---|---:|---|---|
| Tổng RAM máy trong bản ghi chuẩn M0 (`totalMemMB`) | `16 086 MB` | `đo được (evidence/c42: m0-ci-stats)` | Hợp lệ (máy `8` nhân — `đo được: m0-ci-stats`) |
| RAM trống trong `m0-ci-stats` (`freeMemStartMB` / `freeMemMinMB`) | `2 368 MB` / `1 980 MB` | `đo được (evidence/c42: m0-ci-stats)` | Hợp lệ cho thời điểm chạy `ci-stats` |
| Số request thử / mục tiêu của `m03-concurrency.mjs` | `2` / `10` | `chưa kiểm` (ngoài `records.jsonl`) | **Chưa kết luận** (thiếu đối chứng `1` luồng & `stream:false`) |
| Số lần quá hạn header `60 s` / số lỗi `429` ở M0.3 | `2` / `0` | `chưa kiểm` (ngoài `records.jsonl`) | **Chưa kết luận** — đo lại bằng ma trận `18` request ở `R1` |
| Thời gian tới header `1` luồng & `stream:false` trên `9Router-Agent-1` | — | `chưa biết` | Sẽ đo qua `capture-evidence.mjs` tại `R1` |
| Thời gian tới header trên `rs-fast` | — | `chưa biết` | Chỉ đo ở `R1.4` nếu chủ dự án đã tạo `rs-fast` trong DB |

## 3. Quyết định giới hạn đồng thời (Concurrency Limit — Cập nhật theo C43 mục 0.1 & mục 1)

1. **Đối với đội bot chạy trên kênh Sub hiện hành (áp dụng suốt M1–M2 theo quyết định `OQ-02`):**
   - Giữ cứng trần điều phối **tối đa `2` bot gọi LLM đồng thời** (`suy luận` quy định Mục 5 C42 & mục 1 C43) để bảo vệ RAM máy cục bộ (ngưỡng cổng `tools/agent/heavy.mjs` là `1,50 GiB` — `suy luận` theo cấu hình công cụ).
2. **Đối với luồng gọi qua 9Router:**
   - **Không chuyển đội bot sang 9Router trong M1–M2** (`suy luận` theo quyết định `OQ-02`).
   - Giữ trần **`1` luồng tuần tự** cho mọi tác vụ thông thường chạm 9Router như **biện pháp thận trọng tạm thời** (`suy luận` phòng ngừa rủi ro khi chưa có đối chứng), **không phải** kết luận từ số đo M0.3.
   - Ngoại lệ duy nhất được phép chạy `2` luồng là phép đo đối chứng có kiểm soát **Track R (`R1`)** với `--concurrency 2` trong trần ngân sách riêng `40` request (`suy luận` theo C43 mục 4).

## 4. Đề xuất gán combo 9Router theo vai (Chờ kết quả Track R `R1`/`R2` và chờ chủ dự án tạo `rs-fast`)

- Nguyên tắc giữ nguyên (`suy luận` theo C42 Mục 5 & C43 mục 1): cấm gán combo `round-robin` (`9Router-Agent`) hoặc combo có bước `HANG` đã biết.
- **Lưu ý quan trọng từ C43 mục 0.6 (`R2`):** Trong `evidence/c40/x2-remaining.out.txt`, có `7` bước `openrouter` đạt `ok=1/1` (ví dụ `p90=901 ms` — `đo được: evidence/c40 x2-remaining`) nhưng bị gắn nhãn `DEAD`. Vì vậy danh sách `rs-fast` (`11` bước — `suy luận`) và `rs-max` (`14` bước — `suy luận`) trong bảng dưới đây là **danh sách dự kiến tạm thời**, phải đi qua bước kiểm toán & tính lại của **Track R (`R2`)** trước khi chủ dự án dùng để cấu hình trên dashboard:

| Vai trò | Trạng thái phòng | Kênh chạy thực tế suốt M1–M2 (`OQ-02`) | Combo 9Router dự kiến sau khi đóng `R1`/`R2` & chủ dự án tạo | Ghi chú kiểm soát |
|---|---|---|---|---|
| **CEO** | Exec (Bật) | Sub / `gemini-4-carbon` | `rs-max` (dự kiến `14` bước — `suy luận`, chờ `R2` xác nhận) | Không dùng combo `230–231` bước cho sản xuất |
| **Product Manager** | Exec (Bật) | Sub / `gemini-4-neon` | `rs-fast` (dự kiến `11` bước — `suy luận`, chờ `R2` xác nhận) | Giữ trên Sub suốt M1–M2 |
| **COO** | Exec (Bật) | Sub / `gemini-4-neon` | `rs-fast` (dự kiến `11` bước — `suy luận`, chờ `R2` xác nhận) | Điều phối phép đo đối chứng `R1` qua `capture-evidence.mjs` |
| **CTO** | Tech (Bật) | Sub / `gemini-4-carbon` | `rs-max` (dự kiến `14` bước — `suy luận`, chờ `R2` xác nhận) | Duy nhất hợp nhất thiết kế M1, M2, Track R |
| **Engineer** | Tech (Bật từ M1) | Sub / `claude-opus-5-5` | `rs-max` (dự kiến `14` bước — `suy luận`, chờ `R2` xác nhận) | Mọi unit/integration test dùng fake server/DB (`0` req thật) |
| **QA** | Tech (Bật từ M1) | Sub / `claude-opus-5-5` | `rs-fast` (dự kiến `11` bước — `suy luận`, chờ `R2` xác nhận) | Bắt buộc thêm checkout sạch + `1` mutation riêng đỏ (C43 mục 3.4) |
| **Ops** | Ops (Bật từ M1) | Sub / `gemini-4-neon` | `rs-fast` (dự kiến `11` bước — `suy luận`, chờ `R2` xác nhận) | Duy nhất chạy `gh pr merge --squash` khi xanh `5` OS & QA ký |
| **Researcher / Data-AI** | Tech (Bật theo vé) | Sub (`neon` / `carbon`) | `rs-fast` / `rs-max` (chờ `R2` xác nhận) | Chỉ kích hoạt khi vé cần tra cứu hoặc thống kê |
| **Designer & `7` vai chưa bật** | Chưa kích hoạt | Tắt (`0` request — `suy luận`) | Không gán (`0` — `suy luận`) | Giữ đóng suốt M1–M2 |

## 5. Ngân sách request (Ngân sách Track R và trần ngày do COO giám sát)

1. **Ngân sách riêng cho Track R trên 9Router (C43 mục 4):**
   - Tổng trần toàn bộ Track R: **`40` request** (`suy luận` quy định cứng C43 mục 4), tối đa **`3` request liên tiếp** tới cùng một provider (`suy luận` quy tắc bảo vệ quota):
     - `R0` (kiểm `PATCH_V2` ngoài router thật): **`0` request** (`suy luận`).
     - `R1` trên `9Router-Agent-1` (`4` ô × `3` lần: `2` ô `1`-luồng × `3` + `2` ô `2`-luồng × `3`): **`18` request** (`suy luận`), `max_tokens <= 8`, cách nhau `>= 30 s`, cắt ở `60 s`, không dừng ở lần treo đầu.
     - `R1.4` trên `rs-fast` (chỉ chạy nếu `rs-fast` đã có trong DB): **`18` request** (`suy luận`; nếu chưa có thì tốn **`0` request** và ghi `chưa đo`).
     - Biên dự phòng trong trần `40`: **`4` request** (`suy luận` — **tuyệt đối không dùng để retry** sau `429`/timeout hay vượt quy tắc tối đa `3` request liên tiếp/provider; nếu `rs-fast` chưa có trong DB thì mục tiêu chỉ dùng đúng `18` request; chạm `3` lần `429` liên tiếp thì dừng toàn bộ và báo ngay theo C43 mục 2).
     - `R2` (kiểm toán nhãn `DEAD` trên dữ liệu `evidence/c38` & `evidence/c40`): **`0` request mới** (`suy luận`).
2. **Trần ngân sách ngày khi vận hành 9Router sau này (`120` request/ngày — `suy luận` chính sách từ C42):**
   - Giữ bảng phân bổ trần tham chiếu `120` request/ngày (`CEO: 15`, `PM: 10`, `COO: 15`, `CTO: 20`, `Engineer: 25`, `QA: 20`, `Ops: 10`, `Dự phòng: 5` — toàn bộ là `suy luận` hạn mức quản trị; cảnh báo mềm `80%` = `96` request/ngày — `suy luận`). Trong M1–M2, các vé kỹ thuật dùng fake server/DB nên tiêu thụ **`0` request** trên 9Router (`suy luận`), chỉ Track R dùng trong trần `40` request nêu trên.
   - Cấm tuyệt đối gọi `GET /v1/models`; cuối ngày và cuối C43, COO trích xuất bằng script qua `capture-evidence.mjs` số request thực tế đã dùng theo từng provider từ `usageHistory` để ghi nhãn `đo được` trong báo cáo cuối.

---

## 6. Bổ sung theo C43A (Cập nhật thứ tự mở lại 9Router, biến nhiễu prompt & hệ quả quota)

1. **Hệ quả ~`2 900` token prompt mỗi request qua 9Router:** Trong `usageHistory`, mỗi request ngắn qua 9Router ghi nhận khoảng `2 900` token prompt (`chưa kiểm` trước khi khóa bản ghi chuẩn trong `evidence/c43`, do `cavemanEnabled = true` và `ponytailEnabled = true` — `suy luận` từ cấu hình bảng `settings`). Với các gói miễn phí giới hạn theo token, ghi nhận ở mức **`suy luận`** rằng phần đệm này có thể làm quota cạn nhanh hơn dự kiến (không kết luận khi chưa có số đo đối chứng).
2. **Biến nhiễu `ponytailEnabled` giữa hai ô `stream bật` và `stream tắt` ở `R1`:** Do `ponytailEnabled` chỉ chèn thêm prompt khi `stream: true` (`suy luận` đọc cấu hình), `R1` bắt buộc ghi `promptTokens` từ `usageHistory` cho từng request; mọi kết luận rơi vào nhánh `"nghi đường stream"` bắt buộc kèm số token prompt của hai ô và nêu rõ hai yếu tố (đường stream và kích thước prompt) bị lẫn vào nhau. Đội tuyệt đối không tự đổi cấu hình router; nếu cần tách yếu tố thì liệt kê vào danh sách việc tùy chọn của chủ dự án.
3. **Điều kiện mở lại 9Router cho `R1.2`:** Không bật lại 9Router khi tệp còn bản vá `v2`. `R1.2` chỉ chạy sau khi chủ dự án tự hoàn tác `v2` về `patchV1=true patchV2=false` và tự bật lại 9Router (trạng thái `status` được ghi vào bản ghi chuẩn); nếu chưa mở lại thì ghi **`chưa đo`** và tiếp tục thực thi `M1`, `M2` không dừng chờ.
