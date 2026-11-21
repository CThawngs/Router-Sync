# C31 — tóm tắt cuối (bản trên nhánh)

- Nhánh bằng chứng: `evidence/c31`
- Commit mang bằng chứng: `f25a36480815521289a779a04fc610c5a8b7b20d`
- Build đã kiểm: `origin/main` = `4c5bc62` (PR #45)
- CI: run `44934613387` (head `4c5bc62`), attempt 1, success (5 OS); `ci-watch` trả 0

## Trạng thái từng mục

- **L0 — XONG.** Danh sách tên riêng hiệu dụng = 4 (registry 9 cổng, 4 riêng). 7
  không tái tạo được: đó là số của `capture.mjs` tự viết ở C24–C27; 3 mã còn lại là
  chuỗi công khai trong repo (guard + test) và C27/C30 đều che đúng 27 chỗ. Chống
  tái diễn: `capture-evidence.mjs` (bắt buộc `privateNamesLoaded` = số tên),
  floor trong `verify-package.mjs`, test danh sách giả 7 / nạp 4 → đỏ. Quét 6 ref:
  0 khớp.
- **L1 — XONG.** OmniRoute có reader (`key_value`: `syncedAvailableModels`,
  `customModels`, `modelAliases` + `radar_local_model_state` cho DISABLED);
  `combos stale` không còn `omittedRouters`. DB thật (chỉ đọc): 252 bước → 120
  PRESENT (2 PRESENT + 118 PRESENT-NORMALIZED), 126 ABSENT, 16 UNVERIFIABLE.
- **L2 — XONG.** `docs/CI.md` một trang + `test/agent/ci-doc.node.test.mjs`.
- **L3 — XONG.** Nhánh này có `NOTE.md`, `REPORT.md`, `records.jsonl`, 9 tệp,
  `[skip ci]`, 0 khớp tên riêng.

## Giới hạn

- `ABSENT` của OmniRoute chỉ là "không thấy ở trạng thái router".
- Lỗi e2e `44788053023` attempt 1 vẫn treo, chỉ theo dõi.