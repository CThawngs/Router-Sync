# Evidence C37 — dọn gói vá, rà bản vá v2, độ bền 45 phút, danh sách rs-fast/rs-max

- Build: `origin/main` = **46d8cc9** (PR #53). Đầu vòng: 92d07bf (PR #52).
- Gói: `evidence/c37`, `[skip ci]`, không PR; verifier phải SẠCH/OK trước khi đẩy.

## V0 — Dọn gói và quét mẫu cá nhân — XONG

- Xóa nhánh công khai `evidence/router-patch` khỏi remote (`git push origin --delete`,
  `git ls-remote` rỗng). Không dựng lại.
- `tools/agent/scan-private-names.mjs` và `verify-package.mjs` giờ quét thêm mẫu cá nhân:
  tên user OS (`os.userInfo()`), `C:\Users\<user>`, `C:/Users/<user>`, `/Users/<user>`,
  `/home/<user>`, `một đoạn đường dẫn đám mây` (không in giá trị). Khớp là verifier báo ĐÁNG NGỜ. Có test + mutation.
- Đường dẫn backup trong REPORT này viết `<HOME>/RouterSync-backups/...`.
- Quét các nhánh `evidence/*` còn lại, `main`, PR #40–#52: báo số khớp trong phần dưới.

## V1 — Công cụ vá trong repo — XONG (không áp v2 lên router thật)

`tools/agent/nine-router-patch.mjs`: `status`, `apply --dry-run`,
`apply --yes-write-router`, `revert --yes-write-router`.

- Từ chối nếu phiên bản ≠ **0.5.119**; luôn backup; verify bằng sha256 sau ghi; idempotent.
- Ghi thật cần **cả** cờ `--yes-write-router` **và** `RS_OWNER_CONFIRMED=chạy` do chủ dự án đặt.
- Bản vá **v2** trong repo: cache khóa theo sha256(`Authorization` + query string), TTL từ
  `RS_MODELS_CACHE_TTL_MS` (mặc định 60 000, `0` = tắt), tối đa 20 khóa (evict cũ nhất),
  giữ `x-9r-models-cache`. Request không khớp khóa đi qua handler gốc → cổng xác thực vẫn chạy.
- Test trên bản sao tệp tạm: apply, apply lại, revert, sai phiên bản, thiếu quyền;
  mutation bỏ `Authorization` khỏi khóa → đỏ. 5 test pass.
- **Router đang chạy bản vá v1** (cache theo path, không theo khóa). Bản v2 chưa áp — chờ
  chủ dự án gõ lệnh:
  `RS_OWNER_CONFIRMED=chạy node tools/agent/nine-router-patch.mjs apply --yes-write-router`
  (sau đó tự quyết restart).

## V2 — Tách cache khỏi restart — XONG

`router watch` 45 phút, `--interval-sec 10`, `--combo 9Router-Coder-3 --combo-every-min 5`,
mỗi 10 giây có một lần `GET /v1/models` (cache hit ~2–5 ms, miss 6–10 s).

| mốc | tuổi router | số mẫu | combo OK | p50 header | max header |
|---|---|---|---|---|---|
| trước vá (C35/C36) | ~10–11 h | 11 / 6 | 0/3 + 0/2 | không có header | >120 s |
| sau vá, V2 | 1 998–4 195 s (33–70 phút) | 215 | 9/9 | 2 163 ms | 3 518 ms |

Tuổi tiến trình tăng dần trong lấy mẫu mà combo vẫn OK; `/v1/models` p50 ~2 ms. Trong cửa
sổ này không có dấu hiệu "router già làm combo treo". So sánh dài hạn (6h/12h/24h) xem
`docs/router-health.md`.

## V3 — Độ ổn định từng bước — MỘT PHẦN

- Đã thêm `routersync combos reliability --from <file> --repeat <n> --rounds <r> --gap-sec <s>`,
  phân loại `RELIABLE / SLOW / RATE-LIMITED / HANG / DEAD`; 6 test + mutation pass.
- **Chưa chạy phép đo 40 phút**: ngân sách đo V2 đã dùng gần hết 60 phút của vòng. Không có
  số liệu độ ổn định mới; danh sách ở V4 lập từ dữ liệu đã đo ở C32 (hai lượt 231 bước).

## V4 — `rs-fast` và `rs-max` — XONG

Lập từ hai lượt probe C32 (`OK` ở cả hai → RELIABLE; `RATE-LIMITED` ở cả hai → nhanh,
không treo; `TIMEOUT/HANG` → loại; `EOL/NO-PROVIDER/5xx/ERROR` → DEAD):

- Nhóm: **RELIABLE=24, RATE-LIMITED=7, HANG=6, DEAD=192**.
- `rs-fast` = 12 bước RELIABLE nhanh nhất, sắp theo thời gian.
- `rs-max` = 24 RELIABLE + 7 RATE-LIMITED, xen kẽ provider (dùng nhiều account/provider nhất
  mà không có bước treo).
- `docs/combo-rs-fast.md`: cách tạo trong dashboard, strategy `fallback`, kiểm bằng
  `combos probe --mode combo`, cách xóa combo thử.
- Bản tên thật tại `.agent/send-final/combo-rs.real.txt` (không lên GitHub); bản trong gói
  đã che `combo-rs.txt`.

## V5 — Gói — XONG

- PR #53: run **44997360075**, attempt 1, success; main **46d8cc9**, run
  **44998004029**, attempt 1, success.
- Nhánh `evidence/c37`, `[skip ci]`, không PR, `gh run list` rỗng.
- `verify-records.mjs`: SẠCH (bản ghi capture của watch); `verify-package.mjs`: OK.
- Quét tên riêng và mẫu cá nhân: 0 khớp.

## Giới hạn

- Bản vá v1 trên router chưa có khóa theo `Authorization` — v2 chỉ nằm trong repo, chờ lệnh.
- V3 chưa đo; V4 dùng dữ liệu C32, không phải số đo mới.
- Không restart/không ghi vào router trong vòng này.