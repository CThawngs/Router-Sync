# Bản vá v2 đã áp dụng (sau lệnh "chạy" của chủ dự án)

- Thời điểm: 2026-11-22T07:47:54Z.
- Lệnh: `RS_OWNER_CONFIRMED=chạy node tools/agent/nine-router-patch.mjs apply --yes-write-router`
- Kết quả: ghi thành công, verify sha256 `a741ca28…` khớp bản đã tính ở dry-run.
- `status`: `version=0.5.119 patchV1=true patchV2=true`; apply lại → "đã có bản vá v2, không đổi gì (idempotent)".
- Backup trước khi ghi: `<APPDATA>/npm/node_modules/9router/app/custom-server.js.bak-2026-11-22T07-47-54-638Z`
  (đường dẫn thật chỉ tồn tại trên máy chủ dự án; không đăng lên GitHub).
- **Chưa khởi động lại router.** Bản v2 chỉ có hiệu lực sau khi chủ dự án tự restart 9Router.
- Quy tắc: agent không tự restart; write command cần chủ dự án gõ "chạy" — đã thực hiện theo đúng lệnh đó.