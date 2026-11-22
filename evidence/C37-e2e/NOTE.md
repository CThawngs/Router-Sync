# E2E combo 9Router sau vá v2 (chỉ gọi combo)

- Router pid 31040, patch v1+v2, sha a741ca28…, không gọi riêng model nào.
- Lần đầu 3 combo: 3/3 OK, 2,4–2,5 s.
- Đủ 9 combo: 9/9 OK, 0,9–2,8 s, routing chủ yếu `opencode/deepseek-v4.1-flash-free`.
- Lặp 5 lần `9Router-Agent`: 4 lần HANG (1 có usage, 3 không), capture hết hạn ở lần 5.
- Chạy lại 9 combo: 8 OK, riêng `9Router-Agent` HANG 120 s sau 6 dòng usage (router thử nhiều provider: cloudflare, opencode, openrouter rồi cloudflare lại).

Kết luận: cache `/v1/models` đã ổn; lỗi còn lại là đường fallback của 9Router — combo thử nhiều bước thì ghi usage nhưng không trả header. Dùng `rs-fast` (12 bước đã đo) với strategy `fallback` là cách tránh ngắn hạn, vẫn dùng combo 9Router.

Gói: nhánh `evidence/c37-e2e`; verify-records SẠCH 4 dòng, verify-package OK.