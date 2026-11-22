# C36 — tóm tắt cuối (bản trên nhánh `evidence/c36`)

Nhánh: `evidence/c36` · gói 9 tệp, `[skip ci]`, không PR.

## Trạng thái

- **T0 — XONG.** Xóa `evidence/c35` khỏi remote. Script đo đưa vào `tools/agent/` (sửa lỗi ESM/RAM). Bộ che của `capture-evidence.mjs` che đường dẫn repo/OneDrive TRƯỚC khi tính sha256 → không sửa tay tệp capture. `verify-records` SẠCH 3 dòng, `verify-package` OK.
- **T1 — XONG.** `/v1/models`: **5,5 s chờ / 4,39 s CPU** mỗi lần (tỉ lệ 0,82), 904 model / 425 KB, 6/6 lần `usageAdded=0`.
- **T2 — XONG.** Có nghẽn: model gọi thẳng p50 **309 ms → 3 440 ms** (max 4 301 ms) khi có `/v1/models` cùng lúc. Combo không có header trong 120 s.
- **T3 — XONG.** `glm-5.3-flash` tự treo khi gọi thẳng; `gemini-4-hydrogen` hay timeout; các model khác trả lời (0,3–1,8 s, lẫn 429/5xx).
- **T4 — CHƯA LÀM.** RAM trống 699–3 878 MB, nhiều lúc <1500 MB → không chạy ép RAM. Top-5 RSS: 715/481/445/371 MB (che) + node 339 MB.
- **T5 — XONG.** `docs/upstream-9router-models-endpoint.md` (nháp issue, không gửi), 0 khớp tên riêng.

## Bốn câu trả lời

1. **`/v1/models` tốn bao nhiêu?** Trung vị **5,5 s chờ, 4,39 s CPU** (tỉ lệ 0,82), 904 model / 425 KB.
2. **Có làm chậm request khác?** Có: p50 **309 ms → 3 440 ms** (max 4 301 ms), ~11 lần.
3. **Model nào tự không trả header?** **`glm-5.3-flash`** (treo/timeout/5xx ngay khi gọi thẳng); `gemini-4-hydrogen` cũng timeout.
4. **R2 chạy chưa?** Chưa — RAM 699–3 878 MB, nhiều lúc <1500 MB; tiến trình chiếm RAM nhiều nhất ~715 MB (tên đã che).