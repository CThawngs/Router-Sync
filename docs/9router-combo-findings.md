# Phát hiện về combo 9Router (tóm tắt để không đào lại)

Tài liệu này gom kết luận của C32–C40. Mỗi mệnh đề có nhãn **đo được**,
**suy luận** hoặc **chưa biết**. Chỉ nêu tên nhánh và commit bằng chứng, không có
tên riêng hay đường dẫn cá nhân.

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
  giờ; xem `docs/router-health.md`.

## 3. Giả thuyết chưa được ủng hộ

- **đo được** — Combo `fallback` đối chứng (`9Router-Agent-1`, `9Router-Coder-3`)
  cũng treo 0/2 trong W1; RAM trống tụt xuống 324 MB và 3 tên combo stale trả
  `NO-RESULT` (C38 `8c778a3`). Vì vậy **giả thuyết `round-robin` chưa được ủng hộ**;
  không gọi là bác bỏ vì phép đo nhiễu.
- **chưa biết** — Giả thuyết RAM (R2 chưa chạy). Chưa có số đo tách được ảnh hưởng
  của bộ nhớ và của thứ tự bước.

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
  `quota=1` (xem `docs/combos-probe.md`).

## 5. Việc chủ dự án có thể tự kiểm

| Việc | Dữ liệu gợi ý |
|---|---|
| Kết nối `huggingface` còn active không | thông điệp "No active credentials for provider: huggingface" |
| Quota gói miễn phí của `opencode` | `FreeUsageLimitError` ở bước `oc/...` |
| Endpoint / kiểu provider `cohere` | 405 với `Allow` rỗng; chưa đủ dữ liệu để kết luận |

## 6. Cách dùng kết quả

- Dùng combo ngắn, đã đo, chiến lược **Fallback** (`rs-fast` / `rs-max`) — vẫn là
  combo 9Router. Giữ xoay vòng tài khoản ở cấp provider; xem
  `docs/combo-rs-fast.md`.
- Với combo có sẵn, dùng `routersync combos plan --emit-reorder` để đưa bước
  `HANG` xuống cuối **mà không xoá**; xem mục "Sắp xếp lại combo có sẵn".
- Không restart router, không ghi DB/router trong các vòng đo này.
