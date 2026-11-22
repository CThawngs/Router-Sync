# C34 — tóm tắt cuối (bản trên nhánh `evidence/c34`)

Nhánh bằng chứng: `evidence/c34` · gói: 9 tệp + `combo-B-test.txt`, `[skip ci]`, không PR.

## Trạng thái

- **Q0 — XONG.** Đã sửa 4 chỗ sai của C33: tiêu đề, sai số tương đối đúng là **max 80,8%** (không phải 59,6%), 4 số 120 026 ms là **cận dưới**, và `modelCaveat` trong kế hoạch (dự đoán là cận dưới). Giải thích 46 vs 54 (hợp 9 combo, mỗi combo 45–46) và vì sao 9 combo cùng `predictedHeaderMs`.
- **Q1 — MỘT PHẦN.** Đọc được: chọn strategy ở `chunks/9489.js` @14494, ghi `usageHistory` ở `chunks/9100.js` @29616, dashboard `comboStrategies` ở `combos/page.js`. **Không đọc được** (mã minify): vòng lặp theo từng tài khoản, hạn từng bước, backoff — ghi rõ là không đọc được.
- **Q2 — XONG (không tái hiện).** 2 combo × 4 biến thể (mt8/mt64 × stream/no-stream): tất cả **OK, 0,7–3,3 s**, mỗi request **1 dòng usage**, usage xuất hiện cùng lúc header. Header **không** đổi theo `max_tokens` hay `stream`. Độ trễ 80–130 s của C33 không tái hiện được.
- **Q3 — XONG.** Gọi thẳng 3 model, 3 lần mỗi biến thể: openrouter/ernie 946–1 804 ms, groq/qwen3.8 276–335 ms, gemini/gemini-4-hydrogen 2 779–12 070 ms. → **độ trễ nằm ở model, không ở đường combo**.
- **Q4 — XONG.** `<node-59>` 46 account (45 active, 23 errorCode, 8 backoff>0); gemini 8 (5 active, 6 backoff); openrouter 8 (7 backoff); opencode-zen 8 (8 backoff); groq 8 (0 lỗi); cohere 8 (1); nvidia 2; **không provider nào có `rateLimitedUntil`**.
- **Q5 — XONG.** `combo-B-test.txt` (24 bước, đã che) + bản tên thật ở `.agent/send-final/combo-B-test.real.txt`.

## CI

- PR #50: run **44969546332**, attempt 1, **success**.
- main sau merge: (xem REPORT).

## Bốn câu trả lời

1. **Mã 9Router cho thấy gì?** Strategy chọn ở `chunks/9489.js`, usage ghi ở `chunks/9100.js`; phần thử từng tài khoản và hạn từng bước **không đọc được** vì mã minify.
2. **Header có đổi theo `max_tokens`/stream?** **Không** — 8 biến thể đều 0,7–3,3 s; mỗi lần 1 dòng usage.
3. **Gọi thẳng model mất bao lâu?** 0,3–12 s tuỳ model; nhanh hơn đường combo (C33: 126–176 s) → độ trễ ở model/đường combo tuỳ thời điểm, lần này không có độ trễ combo.
4. **Bao nhiêu account đang cooldown/lỗi?** Không cái nào `rateLimitedUntil`; nhiều account có `errorCode`/`backoffLevel` lịch sử (nặng nhất: `<node-59>` 23/46 lỗi, 8 backoff).

## Giới hạn

- Không tái hiện được độ trễ 80–130 s → chưa có kết luận nguyên nhân gốc.
- Mã 9Router minify: vòng lặp theo tài khoản và hạn từng bước không đọc được.
- Không dòng nào bị gỡ; kế hoạch A/B vẫn là đề xuất.