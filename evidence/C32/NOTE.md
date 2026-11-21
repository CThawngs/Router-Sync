# C32 — tóm tắt cuối (bản trên nhánh)

- Nhánh bằng chứng: `evidence/c32`
- Build đã kiểm: `origin/main` = `9b10ee6` (PR #46)
- Router thật: 9Router `0.5.119` ở `127.0.0.1:20128` (chỉ đọc DB, chỉ gọi
  `POST /v1/chat/completions`)

## Trạng thái từng mục

- **M0 — XONG.** 9Router **không có file log** (`%APPDATA%\9router\logs` rỗng).
  `usageHistory` 7 ngày = 6974 dòng, **toàn bộ `ok`** (không ghi lỗi);
  `requestDetails` là bảng duy nhất từng ghi lỗi (560 error / 440 success) nhưng
  **đóng băng ở 2026-07-28 → 2026-08-04**. Cấu hình không có khoá
  `timeout`/`retry`/`attempt`/`max`; chỉ có `comboStrategies.fallbackStrategy`
  (5 `round-robin`, 7 `fallback`) → **combo không có giới hạn số bước lẫn thời
  gian**. 9 combo × 229–230 bước, hợp = **231 bước duy nhất**, 16–17 provider.
- **M1 — XONG.** `routersync combos probe` (dry-run mặc định; thật phải có
  `--yes-spend-tokens`). Mode combo: 4/8 combo OK nhưng mất **24–94 giây** tới
  header; 4/8 combo `HANG-AFTER-USAGE` (120 s, **có** dòng `usageHistory` nhưng
  client không nhận được header). Mode step (231 bước, 2 lượt):
  pass1: 26 OK, 26 EOL-GONE, 28 NO-PROVIDER, 9 RATE-LIMITED, 3 TIMEOUT, 1 HANG,
  138 ERROR. pass2: 27 OK, 26 EOL, 28 NO-PROVIDER, 7 RATE-LIMITED, 5 TIMEOUT,
  138 ERROR (404×110, 405×11, 400×17).
- **M2 — XONG (chỉ báo cáo).** 24 bước OK cả hai lượt; **54 bước lỗi cứng 2/2
  lượt → đề xuất gỡ** (chờ chủ dự án xác nhận); **3 bước** `TIMEOUT-NO-HEADER` 2/2
  → nên đưa xuống cuối; **145 bước chưa kết luận** (gồm 104 dòng `hf`). Không
  đề xuất gỡ theo ABSENT / UNVERIFIABLE / NOT-LISTED / NOT-IN-CATALOG. Không ghi
  gì vào router.
- **M3 — XONG.** `hf` = 104 dòng **UNVERIFIABLE** phía router và
  `LISTED-UPSTREAM` phía upstream (câu "hf 104/104 absent" của vòng trước là
  sai). `nvidia` = 19 ABSENT + 11 PRESENT. `combos stale` giờ ghi chú trong
  `note` rằng UNVERIFIABLE khác ABSENT và không bao giờ là lý do xoá model; có test.

## Ba câu trả lời

1. **Lỗi nằm ở đâu?** Không nằm trong DB — `usageHistory` chỉ ghi request thành
   công, `requestDetails` ngừng ghi từ 2026-08-04, không có file log. "Log toàn
   lỗi" là bộ đệm RAM của dashboard. Lỗi thật: **138/231 bước** không gọi được
   (404 ×110, 405 ×11, 400 ×17), 26 EOL, 28 no-provider.
2. **Combo mất bao lâu, chặn ở đâu?** 24–94 giây khi chạy được; 4/8 combo vượt
   120 giây và rơi vào `HANG-AFTER-USAGE`: upstream đã trả lời, client không nhận.
3. **Đề xuất gỡ / chưa kết luận?** 54 bước đề xuất gỡ (lỗi cứng 2/2 lượt), 3 bước
   nên đưa xuống cuối, 145 bước chưa kết luận (104 dòng `hf` — không được gỡ).

## CI

| lần | sha | run | attempt | kết quả |
|---|---|---|---|---|
| PR #46 | 8d3b1d7 | 44948839596 | 1 | success |
| main | 9b10ee6 | 44949328202 | 1 | success |

`pnpm prepush` bị cổng RAM chặn ở `test:related` (exit 3); lint + typecheck xanh,
bộ test đầy đủ do CI chạy.

## Giới hạn

- `HANG-AFTER-USAGE` chưa được giải thích ở tầng 9Router.
- Không khởi động lại / dừng 9Router; số đo là ảnh chụp tại thời điểm chạy.
- Không dòng nào bị gỡ; việc gỡ thuộc chủ dự án.