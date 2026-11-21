# Evidence C30 — mô hình thời gian combo, hạn 300 s, kế hoạch gọn combo

- Build đã kiểm: `origin/main` = `9b10ee6` (PR #46). Vòng này: PR #47.
- Router thật: 9Router `0.5.119` ở `127.0.0.1:20128`; DB đọc `query_only`, không
  ghi, không dừng/khởi động lại tiến trình.
- Gói: `evidence/c33`, `[skip ci]`, 8 tệp.

## N0 — Mô hình thời gian duyệt bước — XONG (mô hình đúng một phần)

Thứ tự bước đọc từ DB (chỉ đọc); thời lượng mỗi bước lấy trung vị hai lượt
`c32-probe-step-pass2` (20:38Z) và `c32-probe-step` (21:03Z). Mô hình:
`thời gian tới header = tổng thời gian các bước trước bước phục vụ + chính bước đó`.

| combo | bước | served_idx | tổng trước (ms) | dự đoán (ms) | đo (ms) | sai lệch |
|---|---|---|---|---|---|---|
| 9Router-Agent | 230 | 5 | 3785 | 23065 | 57114 | −59.6% |
| 9Router-Agent-1 | 230 | 5 | 3785 | 23065 | 120026 | −80.8% |
| 9Router-Agent-2 | 230 | 13 | 40685 | 41246 | 120017 | −65.6% |
| 9Router-Coder-1 | 229 | 17 | 48788 | 62489 | 94275 | −33.7% |
| 9Router-Coder-2 | 230 | 29 | 88398 | 89707 | 120027 | −25.3% |
| 9Router-Coder-3 | 230 | 17 | 48788 | 62489 | 120024 | −47.9% |
| 9Router-Coder-4 | 230 | 29 | 88398 | 89707 | 79690 | +12.6% |
| 9Router-Coder-5 | 230 | 5 | 3785 | 23065 | 24182 | −4.6% |

- Sai số tuyệt đối: min **1117 ms**, trung vị **31786 ms**, max **34049 ms**.
- Sai số tương đối: min **4.6%**, trung vị **33.7%**, max **59.6%**.
- Kết luận: **đúng một phần**. Đúng về cấu trúc (bước chết đứng trước bước sống
  mới là thứ chiếm thời gian), sai về độ lớn: đo từng bước với hạn 20 s không
  dự đoán được độ trễ của bước đó khi chạy trong combo. N1 cho thấy chính xác vì
  sao: bước phục vụ trả header sau 126–176 s, dù dòng `usageHistory` xuất hiện
  ở giây 30–45.

### Phân rã 231 bước (lượt 21:03Z)

| nhóm | bước | ms | % |
|---|---|---|---|
| NO-PROVIDER | 28 | 62762 | 31.9 |
| TIMEOUT-NO-HEADER | 3 | 60059 | 30.5 |
| OK | 26 | 26607 | 13.5 |
| HANG-AFTER-USAGE | 1 | 20029 | 10.2 |
| EOL-GONE | 26 | 12595 | 6.4 |
| ERROR | 138 | 11428 | 5.8 |
| RATE-LIMITED | 9 | 3120 | 1.6 |
| **TỔNG** | **231** | **196600** | **100** |

OK: n=26, min 283 ms, trung vị 574 ms, max 7237 ms. Nhóm 404/405/400 chỉ chiếm
**5.8%** thời gian — đúng như giả thuyết.

## N1 — Hạn 300 s: "chậm" hay "treo thật" — XONG

`c33-probe-combo-300` (5 combo, `--combo-timeout-sec 300`, tuần tự):

| combo | kết luận | header | tổng | usageAt | ai phục vụ |
|---|---|---|---|---|---|
| 9Router-Agent-2 | **SLOW-OK** | 146 223 ms | 146 226 ms | 40 465 ms | groq/qwen/qwen3.8-27b |
| 9Router-Coder-2 | **SLOW-OK** | 156 740 ms | 156 740 ms | 40 836 ms | openrouter/baidu/ernie-5.5-flash-preview:free |
| 9Router-Coder-3 | **SLOW-OK** | 126 918 ms | 126 919 ms | 45 209 ms | openrouter/baidu/ernie-5.5-flash-preview:free |
| 9Router-Dev | **SLOW-OK** | 175 697 ms | 175 699 ms | 30 133 ms | openrouter/baidu/ernie-5.5-flash-preview:free |
| 9Router-Agent-1 | **HANG-AFTER-USAGE** | – | 300 016 ms | 45 475 ms | gemini/gemini-4-hydrogen |

Bốn combo trước đó bị dán nhãn `HANG-AFTER-USAGE` ở hạn 120 s nay **có header ở
126–176 s**: chúng **chậm**, không treo. Một combo (`9Router-Agent-1`) vẫn không
có header sau **300 s** dù upstream đã trả lời và `usageHistory` ghi ở giây 45 →
đây là treo thật (đường trả lời cho client).

Điểm chung của cả 5: dòng usage xuất hiện ở **30–46 giây**, còn header (nếu có)
ở **126–176 giây**. Router làm xong việc với provider rất sớm, phần còn lại là
đường chờ của combo.

## N2 — Nhãn bước — XONG

- 503 **có** thông điệp "no provider…" → `NO-PROVIDER`; 503 trơn → `ERROR-5XX`
  (không vào nhóm đề xuất gỡ). 500/502 → `ERROR-5XX`.
- `combos probe` in `bắt đầu=<ISO>`; JSON có `startedAt` từng dòng; mode combo
  in `usageAt=`.
- Bản ghi mới: `c33-probe-combo-300` (một lượt) và `c33-combo-plan`; các lượt
  step của C32 được gọi theo đúng thứ tự thời gian trong `probeRuns`
  (`c32-probe-step-pass2.out.txt` 20:38Z trước, `c32-probe-step.out.txt` 21:03Z sau).
- Test: từng nhánh + mutation (`500 → ACCESS-RESTRICTED` đỏ; 503 trơn →
  `NO-PROVIDER` đỏ).

## N3 — Kế hoạch gọn combo — XONG (chỉ kế hoạch)

`c33-combo-plan.json` (sinh trên dữ liệu C32, sha256 DB đầu vào
`fa8924cc…`):

| nhóm | số bước | nghĩa |
|---|---|---|
| REMOVE | **54** | lỗi cứng ≥2 lượt cách nhau >1 phút — **đề xuất gỡ**, chờ chủ dự án xác nhận |
| MOVE-END | **3** | `TIMEOUT-NO-HEADER` 2 lượt — đưa xuống cuối |
| KEEP | **24** | `OK` 2 lượt — xếp theo thời gian |
| FAST-ERROR | 147 | 404/405/400 (+ rate-limit) — chỉ liệt kê, **không** phải lý do gỡ |
| UNTESTED | 3 | còn lại |

Hai phương án cho mỗi combo (9 combo):

| phương án | số bước | dự đoán tới header |
|---|---|---|
| A — bản gọn của chính combo (bỏ REMOVE, timeout xuống cuối) | 184 | **34 573 ms** |
| B — chỉ bước OK hai lượt, xếp theo thời gian | 24 | **319 ms** |

So với thực đo 24–176 s (và 1 combo treo), A dự đoán ~35 s; sai số mô hình ở N0
là 33.7% trung vị, nên khoảng dao động thực tế có thể rộng hơn con số này.

### N3.4 — đường ghi của adapter 9Router (đọc mã, không chạy)

- `packages/adapter-9router` có `applyPlan`: kiểm fingerprint schema (AT-97) →
  transaction → ghi `combos` + `settings.comboStrategies` → đọc lại qua
  `/v1/models` (poll 2 s, ceiling theo `servingWaitMs`).
- **Nguy hiểm đã xác định:**
  - `createSnapshot` **không copy file DB**; nó deep-clone combos trong RAM và
    `backupFilePath` chỉ là đường dẫn DB đang chạy. `rollback` ghi lại combos từ
    snapshot chứ không phục hồi tệp.
  - Ghi thẳng DB khi router đang chạy (`allowLiveDbWrite: true`);
    `DELETE FROM combos WHERE id = ?` là xoá cứng.
  - Read-back cần `Authorization` của chủ dự án (`/v1/models` trả 401 khi thiếu);
    không có key thì mức đọc lại rơi về `db-only`.
- Kết luận: **không viết đường ghi mới trong vòng này**; kế hoạch dừng ở file.

## CI

| lần | sha | run | attempt | kết quả |
|---|---|---|---|---|
| PR #47 | c0e16f9 | 44958147027 | 1 | success |
| PR #49 | 0d2492b | 44959022833 | 1 | success |
| main | 53f4249 (PR #47) | 44958629998 | 1 | success |
| main | 959fda2 (PR #49) | 44959477269 | 1 | success |
## Giới hạn

- `9Router-Agent-1` treo ở 300 s là **một** trường hợp; chưa rõ vì sao combo đó
  khác (cùng danh sách bước với các combo khác).
- Mô hình N0 đúng cấu trúc, sai độ lớn: dùng nó để so sánh phương án, không dùng
  để hứa thời gian chính xác.
- 28 `NO-PROVIDER` của C32 được phân loại theo luật cũ; theo N2, một phần có thể
  là 503 trơn (`ERROR-5XX`). Phải đo lại nhóm này trước khi gỡ bất kỳ bước nào.
- Không dòng nào bị gỡ; việc gỡ thuộc chủ dự án.