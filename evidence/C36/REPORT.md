# Evidence C36 — `/v1/models` đốt CPU và nghẽn hàng đợi router

- Build: `origin/main` = **95a8ddc** → PR #52 (`1459350`).
- Gói: `evidence/c36`, `[skip ci]`, 9 tệp, `verify-records` SẠCH 3 dòng, `verify-package` OK.

## T0 — Sửa gói C35 — XONG

- Đã xóa nhánh `evidence/c35` khỏi remote (`git push origin --delete evidence/c35`,
  `git ls-remote` rỗng). Không dựng lại; C35 được đo lại ở T1/T2.
- Hai script đưa vào repo (tên có nghĩa, sửa lỗi): `tools/agent/router-process.mjs`
  (đọc RAM bằng `os.totalmem()`/`freemem()`, không tách chuỗi `|`) và
  `tools/agent/combo-short.mjs` (dùng `import`, không `require` trong ESM).
- Bộ che trong `capture-evidence.mjs` mở rộng: thêm đường dẫn repo (dạng `\` và `/`),
  `OneDrive/Documents` và phần còn lại sau khi capture thay HOME bằng `<HOME>`.
  capture che **trước khi tính sha256** → bản ghi vẫn khớp tệp, không sửa tay.
  Kiểm tra: stderr chứa đường dẫn đầy đủ giờ chỉ còn `<private-provider-N>`.
- `r0-router-process` chạy lại: pid 26368, start 2026-11-21T22:33:48+07:00, tuổi
  11,39 giờ, RSS 108 MB, CPU 746 s, 0 con. RAM trống **3 878 MB** lúc đó; top-5 RSS:
  715 / 481 / 445 / 371 MB (đều là `<proc-N>`) và node 339 MB.
- `r1-combo-short`: 2/2 combo **NO-HEADER** ở 60 s, RAM trống 2 322 MB → độ trễ
  không phải do RAM thấp.

## T1 — `/v1/models` tốn bao nhiêu CPU — XONG

`tools/agent/models-probe.mjs`, 6 lần, cách 20 s, không request nào khác
(`usageAdded=0` ở cả 6).

| lần | wall (ms) | CPU (s) | CPU/wall | bytes | models |
|---|---|---|---|---|---|
| 1 | 6 797 | 5,19 | 0,76 | 424 955 | 904 |
| 2 | 5 512 | 4,39 | 0,80 | 424 955 | 904 |
| 3 | 5 236 | 4,30 | 0,82 | 424 955 | 904 |
| 4 | 5 848 | 4,88 | 0,83 | 424 955 | 904 |
| 5 | 5 151 | 4,11 | 0,80 | 424 955 | 904 |
| 6 | 5 037 | 4,28 | 0,85 | 424 955 | 904 |

**Trung vị: 5,5 s chờ / 4,39 s CPU / tỉ lệ 0,82** — một luồng bị chiếm gần hết
trong suốt thời gian trả danh sách 904 model / 425 KB.

## T2 — Nghẽn hàng đợi — XONG

`tools/agent/blocking-probe.mjs` (10 request model + 1 combo):

| điều kiện | n | p50 header | max header |
|---|---|---|---|
| router rảnh | 5 | **309 ms** | 326 ms |
| có `/v1/models` trước 1 s | 5 | **3 440 ms** | 4 301 ms |

Mỗi lần `/v1/models` trong pha thứ hai mất 5,4–6,3 s. Biến thể combo: gọi
`/v1/models` 5 s sau khi combo bắt đầu → combo **không có header trong 120 s**.

Kết luận: **có nghẽn** — `/v1/models` chặn luồng sự kiện của router, làm request
khác chậm ~11 lần.

## T3 — Gọi thẳng model đã treo — XONG

`tools/agent/direct-models.mjs`, 5 model × 2 mức `max_tokens` × 3 lần:

| model | mt=8 | mt=64 |
|---|---|---|
| tidepool-alpha-free | 3/3 429, ~607 ms | 3/3 429, ~326 ms |
| glm-5.3-flash | 3 lần treo/không header + 3× 5xx | 2 treo + 1 timeout + 3× 5xx |
| nemotron-3.5-super-vl | OK ~437 ms (lẫn 429/5xx) | OK ~417 ms (lẫn 429/5xx) |
| gemini-4-hydrogen | ERROR/timeout, vài lần OK 10–15 s | ERROR/timeout, 1 OK 6,5 s |
| ernie-5.5-flash-preview | 3/3 OK, p50 1 589 ms | 3/3 OK, p50 1 268 ms |

→ **`glm-5.3-flash` tự nó không trả header** ngay khi gọi thẳng; `gemini-4-hydrogen`
cũng hay timeout. Các model còn lại trả lời được (kèm 429/5xx).

## T4 — R2 chỉ khi đủ điều kiện — CHƯA LÀM

RAM trống lúc các lệnh đo chạy: **699 MB – 3 878 MB**, trong đó nhiều lần <1500 MB
(`t2-blocking` freeMemMin 699 MB, `t3-direct-models` 972 MB). Theo luật, không chạy
thí nghiệm ép RAM. Top-5 tiến trình tốn RAM ở T0.4: 715 / 481 / 445 / 371 MB (tên
đã che) và node 339 MB — chủ dự án có thể tự quyết đóng ứng dụng nào.

## T5 — Bản nháp issue cho tác giả 9Router — XONG

`docs/upstream-9router-models-endpoint.md` (tiếng Anh, không gửi đi). Kiểm
`scan-private-names.mjs`: 0 khớp.

## CI

| lần | sha | run | attempt | kết quả |
|---|---|---|---|---|
| PR #52 | 1459350 | 44979970255 | 1 | success |
| main | 92d07bf | 44980417069 | 1 | success |

## Giới hạn

- Không chạy R2 (RAM thấp); nguyên nhân RAM chưa bị loại hoàn toàn, nhưng T1/T2
  cho thấy cơ chế nghẽn luồng rõ ràng.
- T2 có 10 request model + 1 combo; không vượt ngân sách 45 phút.
- Không dòng nào bị gỡ; bản nháp issue chỉ để chủ dự án quyết.