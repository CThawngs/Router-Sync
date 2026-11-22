# CAPACITY — Năng lực đồng thời, gán combo theo vai và ngân sách ngày (C42)

- **Đồng lập & phê duyệt:** COO (đo thực nghiệm M0.3, ngân sách & theo dõi ngày), CEO (chốt gán combo theo vai & trần điều phối), Product Manager, CTO
- **Mốc dữ liệu:** Đo thực nghiệm M0.3 lúc `2026-11-22T18:40:36.179Z` → `18:41:36.228Z` (`main` = `c28b7fb`, 9Router `0.5.119`, `patchV1=true`, `patchV2=true`, `loaded=true`, `ageHours=3.15h`, `modelsCalled=false`).

## 1. Đối chiếu kiến trúc chạy thực tế vs giả định Mục 5 C42

- **Đo được (đọc `<HOME>/.openmausbot/bots.json`, chỉ đọc, đã che UUID):** Toàn bộ **17/17 bot OpenMausBot** hiện đang cấu hình chạy trực tiếp qua **Sub (`antigravity-<uuid>`)** với chuỗi fallback `antigravity-<uuid>` → `openrouter/free`:
  - Nhóm Code & Kiến trúc (5 bot): `CEO`, `CTO`, `Data-AI` (`gemini-4-carbon`); `Engineer`, `QA` (`claude-opus-5-5`).
  - Nhóm Phân tích sâu & Điều phối (6 bot): `Product Manager`, `COO`, `Researcher`, `Marketer`, `Ops`, `Finance` (`gemini-4-neon`).
  - Nhóm Thiết kế, Content & Pháp lý (3 bot): `Designer`, `Content`, `Legal` (`claude-sonnet-5-5`).
  - Nhóm Tác vụ thường nhật (3 bot): `Sales`, `Support`, `HR` (`gemini-4-hydrogen`).
- **Đo được (C41 Y2 & `router-strategies.mjs` chỉ đọc):** Riêng instance `openai-compat-<uuid>` trỏ tới combo `9Router-Agent-1` (`fallback`, 231 bước). Trong DB 9Router hiện có 9 combo: `9Router-Agent` (`round-robin`, 231 bước — **CẤM dùng do HANG W1**), `9Router-Agent-1`, `9Router-Agent-2`, `9Router-Coder-1` (230 bước), `9Router-Coder-2`..`5` (`fallback`, 231 bước), và `9Router-Dev` (`mặc định`, 231 bước). **Hai combo ngắn sạch `HANG` là `rs-fast` và `rs-max` chưa tồn tại trong DB 9Router** (chờ chủ dự án tạo trong dashboard — `OQ-03`).
- **Ý nghĩa vận hành:** Mục 5 C42 giả định đội bot gọi qua combo 9Router Fallback. Trong thực tế hiện tại, tải LLM chính của 17 bot đi qua Sub; chính sách gán combo và ngân sách dưới đây quản trị chặt cả hai kênh và khóa cứng điều kiện trước khi cho phép chuyển tải sản xuất sang 9Router.

## 2. Kết quả đo năng lực đồng thời M0.3 (số liệu in từ script bản ghi)

- **Tập lệnh đo (ngoài repo, chỉ đọc DB `{ readonly: true }`, khóa chỉ giữ trong RAM):** `m03-concurrency.mjs --combo 9Router-Agent-1` (2 luồng đồng thời `bot-A`, `bot-B`; mục tiêu 5 request nhỏ/luồng, `max_tokens=8`, `stream=true`, timeout header cứng `60 000 ms`, dừng ngay khi gặp `429` hoặc quá `60 s` không có header, không gọi `/v1/models`).
- **Trạng thái hệ thống trong lúc đo:** Tổng RAM `16 086 MB` (`15.71 GiB`), trống lúc bắt đầu `1 090 MB`, thấp nhất `1 086 MB`, kết thúc `1 914 MB` (máy ở chế độ `LIGHT-DEV` `< 1.50 GiB` lúc khởi đầu). Tiến trình 9Router `ageHours=3.15`, `rssMB=103`, `privateMB=151`, `patchV2 loaded=true`.

| Chỉ số | Tổng (`2` luồng) | `bot-A` | `bot-B` |
|---|---:|---:|---:|
| Mục tiêu request | 10 | 5 | 5 |
| Đã gửi thực tế (`attempted`) | **2** | 1 | 1 |
| Thành công (`2xx OK`) | **0** | 0 | 0 |
| Lỗi `429` (quota) | **0** | 0 | 0 |
| Quá hạn header `60 s` (`HEADER_TIMEOUT_60S`) | **2** | 1 | 1 |
| Lỗi khác | **0** | 0 | 0 |
| Thời gian tới header `p50` / `max` | `-` / `-` (không nhận được header trong `60 000 ms`; tổng thời gian ngắt: `60 009 ms` và `60 015 ms`) | `-` (`60 009 ms`) | `-` (`60 015 ms`) |
| Lý do dừng sớm (theo Mục 5) | Dừng cả 2 luồng sau sự cố đầu tiên | `TIMEOUT_60S_AT_REQ_1` | `TIMEOUT_60S_AT_REQ_1` |

- **Đối chiếu `usageHistory` (đọc chỉ đọc ngay sau phiên đo, đã che tên riêng):**
  - `usageHistoryDelta`: **+2 dòng mới** tại `18:40:37.836Z` và `18:40:37.843Z` (~`1.66 s` sau khi phát request), `provider=openrouter`, `model=nvidia/nemotron-3.5-super-vl:free` (bước index 2 của `9Router-Agent-1`), `status=ok`, `promptTokens=2900`, `completionTokens=8`.
  - **Nhận xét trung thực (tách đo được / chưa biết):** Dù 9Router đã ghi nhận `status=ok` phía upstream OpenRouter ở `t+1.66 s`, phía client HTTP không nhận được bất kỳ header phản hồi nào trong suốt `60 s` (`HEADER_TIMEOUT_60S`). Nguyên nhân kỹ thuật nội bộ 9Router (trả stream SSE / giữ kết nối khi 2 luồng đồng thời vào combo 231 bước) **chưa biết**; COO dừng đo ngay đúng quy tắc Mục 5, không thử lại gây hao quota.

## 3. Quyết định giới hạn đồng thời (Concurrency Limit)

1. **Đối với luồng gọi qua 9Router (khi dùng `openai-compat` hoặc chạy probe có duyệt):**
   - **Trần hiện hành: HẠ tạm xuống tối đa `1` luồng tuần tự (thay vì `2`)** do phép đo M0.3 ở mức `2` luồng chạm `2/2` `HEADER_TIMEOUT_60S`.
   - **Điều kiện nâng lại lên `2` luồng (theo Mục 5):** Chỉ sau khi chủ dự án tạo combo ngắn `rs-fast`/`rs-max` (`0` bước `HANG`/`DEAD`) trên dashboard 9Router và COO đo lại M0.3 đạt `>= 9/10` request có header `< 10 s`, `0` timeout `60 s`, `0` lỗi `429`.
2. **Đối với đội bot chạy trên Sub (`antigravity-<uuid>`):**
   - Giữ cứng trần điều phối **tối đa `2` bot gọi LLM đồng thời** trong suốt giai đoạn đầu (M1–M2) để tuân thủ Mục 5 và bảo vệ RAM máy cục bộ (`freeMem` thực đo `0.99–1.43 GiB` `< 1.50 GiB` `LIGHT-DEV`).

## 4. Gán combo 9Router theo vai (CEO đề xuất theo Mục 5 — cấm gán combo có bước `HANG` đã biết)

Nguyên tắc bất khả xâm phạm từ Mục 5 C42: **không gán bất kỳ combo nào có bước `HANG` đã biết hoặc dùng chiến lược `round-robin` / `mặc định`**.
- Cả 9 combo dài 230–231 bước đang có trong DB 9Router (`9Router-Agent` `round-robin`, `9Router-Dev` `mặc định`, `9Router-Agent-1..2` và `9Router-Coder-1..5`) đều chứa các bước `HANG` đã biết từ C32–C39 chưa được chủ dự án dời/tách trên dashboard (và `9Router-Agent-1` vừa chạm `HEADER_TIMEOUT_60S` ở M0.3).
- Do đó, **CEO đề xuất chỉ gán 2 combo ngắn chiến lược `fallback` hoàn toàn sạch bước `HANG`/`DEAD` (`rs-max` 14 bước và `rs-fast` 11 bước theo `docs/combo-rs-fast.md`)** cho các vai đang bật; trong thời gian chờ chủ dự án tạo `rs-fast`/`rs-max` trên dashboard (`OQ-02`, `OQ-03`), các vai giữ nguyên kênh chạy Sub hiện tại và **không gán combo 230–231 bước chưa lọc `HANG` làm kênh chạy sản xuất**:

| Vai trò | Trạng thái phòng | Kênh chạy hiện tại (giữ nguyên khi chờ `OQ-02`/`OQ-03`) | Combo 9Router gán chính thức (0 bước `HANG` đã biết, chiến lược `fallback`) | Ghi chú kiểm soát |
|---|---|---|---|---|
| **CEO** | Exec (Bật) | Sub / `gemini-4-carbon` | **`rs-max`** (`fallback`, 14 bước đã đo sạch, 0 `HANG`/`DEAD`) | Cấm dùng `9Router-Agent` / `9Router-Dev` / combo 231 bước chưa lọc `HANG` cho sản xuất |
| **Product Manager** | Exec (Bật) | Sub / `gemini-4-neon` | **`rs-fast`** (`fallback`, 11 bước đã đo sạch, 0 `HANG`/`DEAD`) | Ưu tiên tốc độ phản hồi điều phối backlog |
| **COO** | Exec (Bật) | Sub / `gemini-4-neon` | **`rs-fast`** (`fallback`, 11 bước đã đo sạch, 0 `HANG`/`DEAD`) | Riêng phép đo sức khỏe chỉ-đọc chỉ chạy tuần tự `1` luồng khi có duyệt |
| **CTO** | Tech (Bật) | Sub / `gemini-4-carbon` | **`rs-max`** (`fallback`, 14 bước đã đo sạch, 0 `HANG`/`DEAD`) | Thiết kế kiến trúc, ADR & review kỹ thuật |
| **Engineer** | Tech (Bật từ M1) | Sub / `claude-opus-5-5` | **`rs-max`** (`fallback`, 14 bước đã đo sạch, 0 `HANG`/`DEAD`) | Mọi test code dùng fake server/DB, 0 request router thật |
| **QA** | Tech (Bật từ M1) | Sub / `claude-opus-5-5` | **`rs-fast`** (`fallback`, 11 bước đã đo sạch, 0 `HANG`/`DEAD`) | Độc lập 100% với Engineer; kiểm chứng offline/CI |
| **Ops** | Ops (Bật từ M1) | Sub / `gemini-4-neon` | **`rs-fast`** (`fallback`, 11 bước đã đo sạch, 0 `HANG`/`DEAD`) | Theo dõi CI, đóng gói bằng chứng & merge PR |
| **Researcher** | Tech (Bật theo vé) | Sub / `gemini-4-neon` | **`rs-fast`** (`fallback`, 11 bước đã đo sạch, 0 `HANG`/`DEAD`) | Chỉ kích hoạt khi vé cần tra cứu nguồn chính thức |
| **Data-AI** | Tech (Bật khi cần số liệu) | Sub / `gemini-4-carbon` | **`rs-max`** (`fallback`, 14 bước đã đo sạch, 0 `HANG`/`DEAD`) | Chỉ bật ở M3 (phương sai P5) hoặc khi cần phân tích thống kê |
| **Designer & 7 vai chưa bật** (`Legal`, `HR`, `Finance`, `Sales`, `Content`, `Marketer`, `Support`) | Chưa kích hoạt | Tắt (`0` request) | **Không gán (`0`)** | Chỉ gán khi có quyết định mở lại trong kế hoạch |

## 5. Ngân sách request theo ngày (COO đặt & theo dõi hằng ngày theo provider)

Mục tiêu: Khóa trần chi tiêu request qua **9Router ở mức tối đa `120` request/ngày** toàn đội (thấp hơn nhiều mức `381` request tích lũy ở C32–C39 từng gây `429` tại `opencode`), kèm trần `combos probe --budget <= 40` mỗi phiên khi được duyệt; đồng thời áp trần tham chiếu ngày cho kênh Sub để chống đốt vòng lặp:

| Vai trò | Ngân sách 9Router / ngày (khi bật kênh 9Router) | Cảnh báo mềm 80% | Trần phiên/lượt trên Sub (tham chiếu điều phối) | Quy tắc ngắt mạch bắt buộc (Mục 5) |
|---|---:|---:|---:|---|
| **CEO** | 15 | 12 | <= 25 lượt/ngày | Gặp `429` hoặc `>60 s` không có header → dừng ngay tác vụ đó, ghi sự cố, chuyển việc khác; cấm retry liên tục |
| **Product Manager** | 10 | 8 | <= 15 lượt/ngày | Như trên; cấm gọi `GET /v1/models` định kỳ |
| **COO** | 15 | 12 | <= 15 lượt/ngày | Như trên; cấm gọi `GET /v1/models` định kỳ |
| **CTO** | 20 | 16 | <= 25 lượt/ngày | Như trên |
| **Engineer** | 25 | 20 | <= 40 lượt/ngày | Không chạy `combos probe` lặp lại; chỉ dùng mock/fake server trong test |
| **QA** | 20 | 16 | <= 30 lượt/ngày | Ưu tiên kiểm chứng offline/CI; không lặp probe thật |
| **Ops** | 10 | 8 | <= 20 lượt/ngày | Không gọi `GET /v1/models` định kỳ |
| **Dự phòng (`Researcher` / `Data-AI` khi bật)** | 5 | 4 | <= 10 lượt/ngày | Chỉ cấp khi có vé cụ thể được CEO duyệt |
| **Tổng trần toàn đội** | **120 / ngày** | **96 / ngày** | **<= 180 lượt/ngày** | Chạm 100% trần ngày → COO đóng băng mọi request không thiết yếu sang ngày kế tiếp |

- **Kỷ luật theo dõi hằng ngày của COO:** Cuối mỗi ngày làm việc, COO đọc bảng `usageHistory` ở chế độ chỉ-đọc (đã che tên riêng) và báo cáo số request phân theo từng provider trong phòng điều hành; bất kỳ provider nào chạm `429`, bước `HANG` mới xuất hiện hoặc 3 lần thất bại liên tiếp đều được chuyển ngay vào hàng đợi **chờ chủ dự án**.
