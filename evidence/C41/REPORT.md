# Evidence C41 — trạng thái nạp vá, thứ tự theo chủ dự án, kiểm app trỏ tới

- Đầu vòng: `origin/main` = **bcd030b** (PR #55), CI main xanh lần 1; `evidence/c40`
  = `5e34a98`.
- **Không gọi router bằng request chat nào**, không tốn quota, không ghi DB/router,
  không sửa OpenMausBot hay app khác, không restart 9Router.

## Y0 — Sửa tài liệu và `status` nói đúng bản đang chạy — XONG

- `docs/9router-combo-findings.md` mục 2: bỏ khẳng định "v2 đã restart" không có căn
  cứ; ghi rõ v1 đã chạy, v2 đã ghi tệp, và chỉ khẳng định nạp khi có số đo.
- `nine-router-patch.mjs status` thêm `processStart`, `fileModified`, `loaded`
  (`true` khi tiến trình bắt đầu sau lần sửa tệp, `false` khi trước, `unknown` khi
  thiếu một thời điểm). Đọc thời điểm theo cách của `router watch`; test tệp tạm +
  tiến trình giả, mutation đảo so sánh thì đỏ. 9/9 test pass.
- Đo thật (bản ghi `y0-status`): `version=0.5.119`, `patchV1=true patchV2=true`,
  `processStart=2026-11-22T15:29:07.519Z`, `fileModified=2026-11-22T13:46:56.046Z`,
  **`loaded=true`**. Router đã nạp v2.

## Y1 — Thứ tự combo theo danh sách của chủ dự án — XONG

- `combos plan --order-file <tệp>` và `--order speed|file` (mặc định `speed`).
  Bước trong tệp còn đủ điều kiện đứng đầu đúng thứ tự tệp; bước `HANG`/`DEAD` bị
  chặn kèm lý do + số liệu; dòng không khớp được báo riêng; tệp rỗng rơi về `speed`.
  Test 5 ca + mutation cho phép HANG đứng đầu thì đỏ.
- Ví dụ che tên: `docs/examples/combo-order.example.txt`; hướng dẫn trong
  `docs/combo-rs-fast.md`. Tệp thật đặt tại `.agent/combo-order.txt` (không lên GitHub).
- Tệp thứ tự do agent lập **từ tên model** (lớn trước nhỏ trong cùng provider, xen
  kẽ provider): `tools/agent/order-by-name.mjs` + 3 test. Đây là đề xuất từ tên,
  **không phải số đo chất lượng** — chủ dự án chỉnh bằng tệp riêng.
- Chạy thật trên dữ liệu C40: 2 078 bước trước = 2 078 sau, không mất/nhân đôi.
  `rs-fast` 11 bước, `rs-max` 14 bước theo thứ tự đề xuất (bản thật trong chat).

## Y2 — Kiểm model app đang trỏ tới — XONG

- Bộ đọc OpenMausBot chỉ đọc: `<HOME>/.openmausbot/config.json`; UUID instance bị
  che, cổng khác 20128 bị che, key/token chỉ báo `keyPresent`. Đăng ký adapter
  `openmausbot` vào `apps inspect` và `apps drift`; lệnh chi tiết
  `apps drift-model --from <reliability>` trả `OK` / `MISSING` /
  `RISK-HANG-BEFORE-FIRST-GOOD` / `UNVERIFIABLE`. Không tìm thấy tệp thì in các
  đường dẫn đã thử dạng `<HOME>/...`. Test fixture + mutation; 31 test pass.
- `docs/adapters/agent-apps.md` cập nhật.
- Đo thật (`y2-drift`): instance `openai-compat-<uuid>` trỏ `model=9Router-Agent-1`
  → combo **231 bước**, chiến lược `fallback`, bước chạy được đầu tiên ở vị trí 0,
  0 bước HANG trước nó ⇒ **`OK`**. Lưu ý: thứ tự bước của combo đã khác C39 (khi đó
  8 bước đầu chung chứa bước treo); không khẳng định nguyên nhân cũ đã biến mất.

## CI

| lần | sha | run | attempt | kết quả |
|---|---|---|---|---|
| PR #56 | 907bdc5 | 45048472330 | 1 | success |
| main | c28b7fb | 45049049310 | 1 | success |

## Giới hạn

- `loaded=true` chỉ nói tiến trình bắt đầu sau lần sửa tệp; không đo trực tiếp header
  cache của bản v2 trong vòng này.
- Thứ tự `rs-fast`/`rs-max` là suy luận từ tên model, cần chủ dự án xác nhận.
- Không đổi combo, không restart router, không sửa cấu hình app.
