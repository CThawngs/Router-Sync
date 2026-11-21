# C33 — tóm tắt cuối (bản trên nhánh `evidence/c33`)

Nhánh bằng chứng: `evidence/c33` · gói: 8 tệp, `[skip ci]`, không PR.

## Trạng thái từng mục

- **N0 — XONG (mô hình đúng một phần).** Mô hình "tổng thời gian các bước trước
  bước phục vụ" đúng về cấu trúc nhưng sai độ lớn: sai số tuyệt đối min 1 117 ms,
  trung vị 31 786 ms, max 34 049 ms; tương đối 4.6% / 33.7% / 59.6%. Nhóm
  404/405/400 (138 bước) chỉ chiếm **5.8%** tổng thời gian 231 bước.
- **N1 — XONG.** 5 combo với hạn 300 s: 4 combo **SLOW-OK** (header ở 126.9 /
  146.2 / 156.7 / 175.7 s) và 1 combo **HANG-AFTER-USAGE** (300 s không header,
  `usageHistory` có dòng ở giây 45). → Nhãn `HANG-AFTER-USAGE` ở hạn 120 s
  **phần lớn là chậm**, không phải treo; còn tồn tại một trường hợp treo thật.
- **N2 — XONG.** 503 trơn → `ERROR-5XX` (không vào nhóm gỡ); 503 có thông điệp
  "no provider…" → `NO-PROVIDER`. Có `startedAt`, `usageAt=`; test từng nhánh +
  mutation.
- **N3 — XONG (chỉ kế hoạch).** `combos plan` trên dữ liệu C32: REMOVE=54,
  MOVE-END=3, KEEP=24, FAST-ERROR=147, UNTESTED=3. Phương án A (bản gọn) 184 bước
  dự đoán **34.6 s**; phương án B (chỉ bước OK) 24 bước dự đoán **319 ms**. Kế
  hoạch có sha256 DB đầu vào (`fa8924cc…`) và thứ tự cũ để hoàn tác.
- **N3.4 — XONG (đọc mã, không chạy).** `applyPlan` có kiểm fingerprint +
  transaction + đọc lại `/v1/models`, nhưng `createSnapshot` **không copy DB**,
  `DELETE FROM combos` là xoá cứng, read-back cần API key của chủ dự án → không
  viết đường ghi mới; kế hoạch dừng ở file.

## CI

- PR #47: run **44958147027**, attempt 1, **success**.
- main: run **44958629998** (`53f4249e`), attempt 1, **success**.

## Ba câu trả lời

1. **Mô hình đúng hay sai?** Đúng một phần: đúng cấu trúc (bước chết trước bước
   sống chiếm thời gian; 404/405/400 chỉ 5.8%), sai độ lớn (trung vị 33.7%, tối đa 80.8%).
2. **Chậm hay treo?** Phần lớn **chậm** — 4/5 combo có header ở 126–176 s khi cho
   hạn 300 s. `9Router-Agent-1` vẫn không header sau 300 s dù usage có ở giây 45 →
   **treo thật**.
3. **Kế hoạch còn bao nhiêu bước?** Phương án A còn **184** bước, dự đoán **34.6 s**
   (B còn 24 bước, **319 ms**). **54** bước đề xuất gỡ — chờ chủ dự án xác nhận.

## Giới hạn

- `9Router-Agent-1` treo ở 300 s là một trường hợp, chưa rõ nguyên nhân.
- Mô hình N0 dùng để so sánh phương án, không phải để hứa thời gian chính xác.
- 28 `NO-PROVIDER` của C32 theo luật cũ; đo lại theo N2 trước khi gỡ.