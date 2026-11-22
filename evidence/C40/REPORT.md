# Evidence C40 — tiết kiệm quota, sắp xếp lại combo, kết luận 9Router

- Đầu vòng: `origin/main` = **4a5179c** (PR #54), CI main xanh lần 1.
- Mọi lệnh đo qua `capture-evidence.mjs`; **20/30 request** `POST /v1/chat/completions`,
  `max_tokens=8`, không gọi `/v1/models`, không ghi router/OpenMausBot, không restart.

## X0 — Thăm dò tiết kiệm quota — XONG

- Thêm `--budget <n>` (mặc định 40) và `--skip-quota-from <file>` cho `combos probe`
  và `combos reliability`; in `requests=<n>/<limit> theo provider=...` ở cuối.
- `FreeUsageLimitError` / quota → `RATE-LIMITED` có chú thích `quota=1`; bước 429
  trong 30 phút qua bị bỏ qua, in `SKIPPED-QUOTA`. Tối đa 3 request liên tiếp
  cùng provider, cách nhau ≥3 giây.
- Test máy chủ giả: 429 quota, 429 thường, bước bỏ qua, vượt ngân sách; mutation
  bỏ kiểm tra `budget` thì đỏ. Cùng 47 test CLI vẫn pass.
- `docs/combos-probe.md`: mỗi lần thăm dò tốn quota. Script
  `tools/agent/x40-evidence.mjs` đếm **381** request ước lượng từ `evidence/c32`…
  `c39` (C32=354, C38=22, C39=5); các nhánh không còn tệp kết quả in 0.
- Đo thật `x0-budget`: 3 request, `requests=3/3 theo provider=cf:3`, dừng sớm
  đúng `budget=3`.

## X1 — Sắp xếp lại combo hiện có — XONG

- `combos plan --emit-reorder <file>`: 6 hạng (1 RELIABLE sort p90, 2 SLOW,
  3 RATE-LIMITED, 4 chưa đo, 5 lỗi nhanh cứng, 6 HANG/503 chậm). HANG **xuống
  cuối, không xoá**; trong hạng giữ thứ tự gốc và xen kẽ provider.
- Bất biến: 2 069 bước trước = 2 069 bước sau, không mất/nhân đôi.
- `9Router-Agent-1`: 6 bước HANG dời từ vị trí 5, 17, 19, 61, 92, 157 sang
  180, 191, 197, 188, 205, 228. **Không in `predictedHeaderMs` như số đáng tin**
  (sai số mô hình C33 tới 80,8%); chỉ liệt kê bước đứng trước bước chạy được đầu
  tiên và số đo thật gần nhất.
- Tệp bản thật ở `.agent/send-final/`; bản che trong `reorder.masked.txt`
  (che cả gateway dạng UUID không nằm trong danh sách guard).
- Test: HANG vào hạng 1 thì đỏ; tổng bước trước/sau bằng nhau.

## X2 — Rà `rs-fast` / `rs-max` — XONG

- Xếp lại theo p90 tăng dần, xen kẽ provider: `rs-fast` **11 bước**, `rs-max`
  **14 bước**.
- Model chuyên dụng từ tên (suy luận, không phải số đo) → danh sách cần xác nhận:
  `nvidia/nvidia/ising-calibration-1.5-31b` ("calibration"),
  `nvidia/nvidia/riva-translate-4b-instruct-v2` ("translate").
- Chạy 17 bước chưa đo của W4, 1 vòng, budget 30: **9 RATE-LIMITED quota**
  (toàn bộ `oc/...`) + **8 DEAD**. Chú ý: `DEAD` ở đây nghĩa là `ok<3` với chỉ 1
  request — "chưa đủ mẫu", **không phải bằng chứng model chết**. Tất cả 17 bước
  đã đo, không còn bước liệt kê chưa đo.

## X3 — Tài liệu kết luận — XONG

`docs/9router-combo-findings.md`: mỗi mệnh đề gắn nhãn **đo được / suy luận /
chưa biết**, có tên nhánh + commit tham chiếu (`evidence/c32` `b4cba5f` …
`evidence/c39` `abec7d0`), không tên riêng hay đường dẫn cá nhân; kiểm bằng hai
lớp quét (`scan-private-names`, `verify-package`).

## CI

| lần | sha | run | attempt | kết quả |
|---|---|---|---|---|
| PR #55 | 08a39ed | 45023041922 | 1 | success |
| main | bcd030b | 45023692083 | 1 | success |

## Giới hạn

- Số 381 là cận dưới ước lượng từ tệp kết quả, không phải hoá đơn provider.
- `DEAD` của 8 bước openrouter chỉ có 1 request; cần đo lại nhiều vòng trước khi gỡ.
- Không đổi combo, không restart router, không sửa OpenMausBot trong vòng này.
