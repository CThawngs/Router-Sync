# C38 — tóm tắt cuối (đã che tên riêng; bản thật gửi trong chat)

Nhánh `evidence/c38`, `[skip ci]`, không PR.

## Trạng thái

- **W0 — XONG.** 9 combo: 4 round-robin, 4 fallback, 9Router-Dev "mặc định"; `providerStrategies` rỗng → không rõ xoay vòng tài khoản.
- **W1 — MỘT PHẦN.** Combo fallback đối chứng cũng treo 0/2; RAM xuống 324 MB; 3 tên combo stale. **Chưa ủng hộ giả thuyết round-robin.**
- **W2 — XONG.** `combos plan` có `strategy` + `RISK-ROUND-ROBIN`; docs phân biệt xoay vòng tài khoản và chiến lược combo; 13 test pass.
- **W3 — XONG.** hf 404 = "No active credentials for provider: huggingface"; cohere 405 = HTTP 405 (chưa rõ); oc 429 = FreeUsageLimitError. Cả ba **không phải model chết** → không xoá.
- **W4 — MỘT PHẦN.** 22/39 bước đo được: RELIABLE=16, HANG=6, 17 chưa đo. rs-fast 12, rs-max 16.

## CI

PR #54 → main **4a5179c**; main CI **45005432691**, attempt 1, success.

## Câu trả lời ngắn

1. round-robin: **không ủng hộ** (fallback cũng treo; phép đo nhiễu).
2. lỗi nhanh: hf thiếu credential, oc hết quota free, cohere 405 cần thêm dữ liệu — đều **không nên xoá bước**.
3. rs-fast 12 / rs-max 16 từ 22 bước đã đo; 17 bước chưa đo.

Gói: `evidence/c38`; verify-records SẠCH 3 dòng, verify-package OK, quét tên riêng + mẫu cá nhân 0 khớp.