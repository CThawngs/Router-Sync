# C39 — OpenMausBot báo "stopped answering"

Nhánh `evidence/c39`, `[skip ci]`, không PR.

Reproduce đúng combo OpenMausBot đang dùng (`9Router-Agent-1`): **HANG-NO-USAGE 60 s, không có header** — khớp lỗi client.

Nguyên nhân: **cả 9 combo dùng chung 230 bước, 8 bước đầu giống nhau**. Bước 1 → 429 (390 ms), bước 2 → 429 FreeUsageLimitError, bước 3 → 503, bước 6 → treo 20 s. Router phải lội qua các bước chết này trước khi tới bước sống ở vị trí 8 → client hết idle timeout. Đổi tên combo không giúp; không phải lỗi cache, không phải round-robin.

Cách sửa: tạo combo `rs-fast` (12 bước đã đo, Fallback) trong dashboard 9Router, rồi đổi field `model` của OpenMausBot từ `9Router-Agent-1` sang `rs-fast`. Agent không tự ghi router hay cấu hình client.

Gói: verify-records SẠCH 3 dòng, verify-package OK, quét tên riêng + mẫu cá nhân 0 khớp.
