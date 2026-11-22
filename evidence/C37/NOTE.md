# C37 — bản tóm tắt cuối (đã che tên riêng; bản thật gửi trong chat)

Nhánh bằng chứng: `evidence/c37` · `[skip ci]`, không PR.

## Trạng thái

- **V0 — XONG.** Xóa `evidence/router-patch` khỏi remote. Thêm quét mẫu cá nhân (tên user OS, `C:\Users/<user>`, `/Users/<user>`, `/home/<user>`, đoạn đường dẫn đám mây) vào `scan-private-names.mjs` và `verify-package.mjs`, có test + mutation.
- **V1 — XONG (không áp v2 lên router thật).** `tools/agent/nine-router-patch.mjs`: `status`, `apply --dry-run`, apply/revert có cờ `--yes-write-router` **và** `RS_OWNER_CONFIRMED=chạy`. Kiểm phiên bản 0.5.119, backup, sha256, idempotent. Bản v2 khóa cache theo sha256(Authorization+query), TTL env, 20 khóa; test trên bản sao tệp. Router đang chạy **v1**; v2 chờ lệnh của chủ dự án.
- **V2 — XONG.** 215 mẫu / 45 phút, 9/9 combo OK, p50 **2 163 ms**, max **3 518 ms**; tuổi router 1 998–4 690 s; `/v1/models` p50 2 ms (cache hit), max 11 s (miss). Không thấy combo treo khi tuổi tiến trình tăng.
- **V3 — MỘT PHẦN.** Đã có `routersync combos reliability` + 6 test + mutation; **chưa chạy** phép đo 40 phút (ngân sách 60 phút đã dùng cho V2).
- **V4 — XONG.** Từ dữ liệu C32: RELIABLE=24, RATE-LIMITED=7, HANG=6, DEAD=192. `rs-fast` 12 bước, `rs-max` 31 bước. `docs/combo-rs-fast.md`, `docs/router-health.md`.

## CI

- PR #53 → main **46d8cc9**; main CI **44998004029**, attempt 1, success.

## Bốn câu trả lời

1. **V2:** combo vẫn OK sau 45 phút — 9/9, p50 2,16 s, tuổi router 33–78 phút.
2. **V3:** chưa đo; lệnh đã sẵn sàng, số liệu dùng tạm từ C32.
3. **Danh sách:** bản che nằm trong `combo-rs.txt`; bản tên thật gửi trong chat (không lên GitHub).
4. **Chờ:** áp bản vá v2 cần chủ dự án gõ `RS_OWNER_CONFIRMED=chạy node tools/agent/nine-router-patch.mjs apply --yes-write-router` rồi tựrestart.

## Giới hạn

Bản v1 trên router chưa khóa cache theo Authorization; V3 chưa đo; không restart router trong vòng này.