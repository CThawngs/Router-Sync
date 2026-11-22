# C40 — tóm tắt cuối (đã che tên riêng; bản thật gửi trong chat)

Nhánh `evidence/c40`, `[skip ci]`, không PR. Gọi router: **20/30 request**, `max_tokens=8`, không `/v1/models`.

## Trạng thái

- **X0 — XONG.** `--budget` (mặc định 40) + bộ đếm theo provider cho `probe` và `reliability`; `SKIPPED-QUOTA` cho 429/quota trong 30 phút; xen kẽ provider, chú thích `quota=1`. Test máy chủ giả + mutation. Đo thật: `requests=3/3 theo provider=cf:3`, dừng đúng `budget=3`. Số request ước lượng C32–C39 = **381** (script đếm).
- **X1 — XONG.** `combos plan --emit-reorder`: 6 hạng, HANG xuống cuối nhưng không xoá; 2 069 bước trước = 2 069 sau; in vị trí cũ→mới cho Agent-1; bản che cả gateway UUID.
- **X2 — XONG.** 17 bước chưa đo đã chạy: 9 RATE-LIMITED quota, 8 DEAD do chỉ 1 request. `rs-fast` 11 bước, `rs-max` 14 bước sau khi xếp lại. 2 model chuyên dụng đưa vào danh sách cần xác nhận.
- **X3 — XONG.** `docs/9router-combo-findings.md`, mỗi mệnh đề gắn nhãn đo được / suy luận / chưa biết.

## CI

PR #55 → main **bcd030b**; main CI **45023692083**, attempt **1**, success.

## Câu trả lời ngắn

1. Request vòng này: 20 (3 cho X0 + 17 cho X2.3), theo provider: cf=3, oc=9, openrouter=8.
2. `rs-fast`/`rs-max` sau xếp lại: xem `combo-rs.txt` bản che; bản tên thật gửi trong chat.
3. `9Router-Agent-1`: 6 bước HANG dời từ vị trí 5, 17, 19, 61, 92, 157 xuống 180, 191, 197, 188, 205, 228. Không in predictedHeaderMs như số đáng tin.
4. Cần xác nhận: 2 model chuyên dụng (tên chứa `calibration`, `translate`) — suy luận từ tên.

Gói: `evidence/c40`; verify-records SẠCH 2 dòng, verify-package OK, quét tên riêng + mẫu cá nhân 0 khớp.
