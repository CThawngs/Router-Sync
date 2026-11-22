# Evidence C34 — vì sao header về muộn 80–130 s sau khi usage đã ghi

- Build đầu vòng: `origin/main` = `959fda2` (PR #47, #49). Vòng này: PR #50.
- Router thật: 9Router `0.5.119` ở `127.0.0.1:20128`; DB đọc `query_only`, không ghi.
- Gói: `evidence/c34`, `[skip ci]`, 9 tệp (10 mục nếu tính cả `combo-B-test.txt`).

## Q0 — Sửa các chỗ sai của C33 — XONG

1. **Tiêu đề**: REPORT C33 ghi "Evidence C30". Bản trên nhánh `evidence/c33` giữ
   nguyên (không sửa lịch sử); bản đính chính nằm ở file này.
2. **Sai số tương đối tối đa**: C33 ghi 59,6%, nhưng bảng của chính nó có −80,8%.
   Tính lại: **min 4.6% / trung vị 33.7% / max 80.8%** (sai số tuyệt đối min 1 117 ms,
   trung vị 31 786 ms, max 34 049 ms).
3. **Số đo 120 026 ms là cận dưới** (bị cắt bởi hạn 120 s), không phải giá trị thật.
   Bảng N0 tính lại, dùng số đo thật của N1 (126–176 s) cho các combo đã có:

| combo | served_idx | dự đoán (ms) | đo thật (ms) | ghi chú |
|---|---|---|---|
| 9Router-Agent | 5 | 23 065 | 57 114 | số đo thật |
| 9Router-Agent-1 | 5 | 23 065 | 126 918 | số đo thật (N1) |
| 9Router-Agent-2 | 13 | 41 246 | 146 226 | số đo thật (N1) |
| 9Router-Coder-1 | 17 | 62 489 | 94 275 | số đo thật |
| 9Router-Coder-2 | 29 | 89 707 | 156 740 | số đo thật (N1) |
| 9Router-Coder-3 | 17 | 62 489 | 126 919 | số đo thật (N1) |
| 9Router-Coder-4 | 29 | 89 707 | 79 690 | số đo thật |
| 9Router-Coder-5 | 5 | 23 065 | 24 182 | số đo thật |

   Kết luận một câu: mô hình dự đoán **thấp hơn thực tế 1,4–5,5 lần** (trung vị
   ~2,4 lần), vì nó chỉ tính phần trước bước phục vụ và bỏ qua phần chờ sau usage.
4. **46 vs 54 và 34 573 giống nhau ở 9 combo**: tổng hợp 54 bước REMOVE là **hợp của
   9 combo** (mỗi combo chứa một phần: 45–46 bước). Mỗi combo có `removed = 46` vì
   danh sách bước gần như trùng nhau. `predictedHeaderMs` bằng nhau vì kế hoạch A
   giữ nguyên thứ tự gốc và các bước đứng trước bước phục vụ giống nhau ở cả 9 combo.
   Đã gắn `modelCaveat` vào file kế hoạch (`c34-combo-plan.json`): dự đoán chỉ tính
   các bước trước bước phục vụ, bỏ qua phần chờ sau usage → là **cận dưới**.

## Q1 — Mã 9Router đã cài (chỉ đọc) — MỘT PHẦN

Mã Next.js đã minify. Đọc được:

| câu hỏi | câu trả lời | bằng chứng |
|---|---|---|
| Chọn strategy | `comboStrategies[name]?.fallbackStrategy \|\| comboStrategy \|\| "fallback"`; có `comboStickyRoundRobinLimit` | `chunks/9489.js` @14494 (1 dòng) |
| Ghi `usageHistory` | INSERT cả bộ (timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta); có nhánh UPDATE `endpoint` cho dòng đã tồn tại | `chunks/9100.js` @29616 (1 dòng) |
| Dashboard đọc/ghi strategy | `PATCH /api/settings` với `comboStrategies` | `app/(dashboard)/dashboard/media-providers/combo/[id]/page.js` @3721 |

**Không đọc được / chưa tìm thấy**: vòng lặp thử từng tài khoản trong một provider,
hạn thời gian riêng cho từng bước, và delay/backoff giữa các lần thử — các chunk này
minify một dòng, không có tên hàm đọc được. Không đoán.

## Q2 — Dòng thời gian một request combo — XONG (không tái hiện được độ trễ)

`q2-matrix`: 2 combo × 4 biến thể, hạn 200 s, tuần tự (8 request).

| combo | biến thể | kết luận | header | số dòng usage | dòng usage đầu/cuối |
|---|---|---|---|---|---|
| 9Router-Coder-3 | mt8 stream | OK | 1 121 ms | 0 | – |
| 9Router-Coder-3 | mt64 stream | OK | 1 684 ms | 1 | 1 696 ms |
| 9Router-Coder-3 | mt8 no-stream | OK | 2 434 ms | 1 | 2 437 ms |
| 9Router-Coder-3 | mt64 no-stream | OK | 667 ms | 1 | 669 ms |
| 9Router-Agent-1 | mt8 stream | OK | 1 411 ms | 1 | 1 423 ms |
| 9Router-Agent-1 | mt64 stream | OK | 1 038 ms | 1 | 1 048 ms |
| 9Router-Agent-1 | mt8 no-stream | OK | 1 256 ms | 1 | 1 263 ms |
| 9Router-Agent-1 | mt64 no-stream | OK | 3 348 ms | 1 | 3 351 ms |

Trả lời:
- Header **không** phụ thuộc `max_tokens` hay `stream`: cả 8 biến thể 0,7–3,3 s.
- Mỗi request chỉ sinh **một** dòng usage (không phải nhiều dòng liên tiếp) → router
  không thử nhiều bước trong các lần này.
- Dòng usage xuất hiện **cùng lúc với header** (chênh 8–12 ms), không sớm hơn 80–130 s.
- Độ trễ 80–130 s của C33 **không tái hiện được**. Ghi nhận là trạng thái tạm thời của
  router lúc đó (có thể do tải/chính các lượt đo trước đó), không phải hành vi cố định.

## Q3 — Gọi thẳng model đã phục vụ — XONG

`q3-direct`: 3 model × 2 biến thể × 3 lần, cách nhau 10 s (18 request, mode step).

| model | header min / trung vị / max |
|---|---|
| openrouter/baidu/ernie-5.5-flash-preview:free | 946 / 1 276 / 1 804 ms |
| groq/qwen/qwen3.8-27b | 276 / 296 / 335 ms |
| gemini/gemini-4-hydrogen | 2 779 / 4 427 / 12 070 ms |

Kết luận một câu: **độ trễ nằm ở model, không nằm ở đường combo** — cùng model gọi
thẳng chỉ mất 0,3–12 s, trong khi qua combo (C33) mất 126–176 s; ở lần đo này combo
cũng chỉ 0,7–3,3 s.

## Q4 — Trạng thái tài khoản (chỉ đọc, chỉ số)

Cột `providerConnections`: `id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt`.
Cờ đọc trong `data`: `errorCode`, `lastError`, `backoffLevel`, `rateLimitedUntil`.

| provider | total | active | errorCode | lastError | backoff>0 |
|---|---|---|---|---|---|
| `<node-59>` (openai-compatible) | 46 | 45 | 23 | 22 | 8 |
| gemini | 8 | 5 | 7 | 7 | 6 |
| openrouter | 8 | 8 | 7 | 7 | 7 |
| groq | 8 | 8 | 0 | 0 | 0 |
| cohere | 8 | 8 | 1 | 1 | 1 |
| opencode-zen | 8 | 8 | 8 | 8 | 8 |
| kilocode | 4 | 4 | 4 | 4 | 0 |
| nvidia | 2 | 2 | 1 | 1 | 0 |
| cloudflare-ai | 1 | 1 | 0 | 0 | 0 |
| mistral | 1 | 1 | 1 | 1 | 1 |
| fireworks | 1 | 0 | 1 | 1 | 0 |
| siliconflow | 1 | 0 | 0 | 0 | 0 |
| deepseek | 1 | 1 | 1 | 1 | 1 |

Không provider nào có `rateLimitedUntil` != rỗng → router không thấy account nào đang
bị rate-limit; các cờ `errorCode`/`backoffLevel` là lịch sử lỗi, không phải cooldown.

## Q5 — Chuẩn bị combo nhỏ (chưa ghi router) — XONG

- `combo-B-test.txt`: 24 bước của kế hoạch B, thứ tự thời gian tăng dần, đã che tên
  riêng (`<private-provider-N>`).
- Bản tên thật cho chủ dự án: `.agent/send-final/combo-B-test.real.txt` (chỉ ở máy).
- Cách thử sau khi tạo combo `rs-test-fast` trong dashboard 9Router (3 bước): tạo
  combo mới → dán 24 dòng → lưu; rồi chạy
  `node packages/cli/dist/index.js combos probe --mode combo --combo rs-test-fast --yes-spend-tokens --combo-timeout-sec 200`
  và so header với `9Router-Coder-3`.

## CI

| lần | sha | run | attempt | kết quả |
|---|---|---|---|---|
| PR #50 | d4f25b9 | 44969546332 | 1 | success |
| main | 27bfeb4 | 44970039639 | 1 | success |

## Giới hạn

- Không tái hiện được độ trễ 80–130 s → chưa có kết luận nguyên nhân gốc.
- Mã 9Router minify; phần vòng lặp theo tài khoản và hạn từng bước **không đọc được**.
- Không dòng nào bị gỡ; kế hoạch A/B vẫn là **đề xuất**.
- `pnpm prepush` trên máy này bị cổng RAM chặn `test:related` (exit 3); lint + typecheck xanh, 41 test liên quan xanh; bộ đầy đủ do CI chạy.