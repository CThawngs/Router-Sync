# C41 — tóm tắt cuối (đã che tên riêng; bản thật gửi trong chat)

Nhánh `evidence/c41`, `[skip ci]`, không PR. Không request chat tới router, không tốn quota.

## Trạng thái

- **Y0 — XONG.** Sửa `docs/9router-combo-findings.md` (bỏ khẳng định v2 đã restart khi chưa có số đo). `status` thêm `processStart` / `fileModified` / `loaded`; 9 test pass. Đo thật: `loaded=true`, processStart `2026-11-22T15:29:07Z`, fileModified `2026-11-22T13:46:56Z`.
- **Y1 — XONG.** `combos plan --order-file` + `--order speed|file`; HANG/DEAD trong tệp bị chặn kèm lý do, dòng lạ được báo, tệp rỗng rơi về speed. 2 078 bước trước = 2 078 sau. `rs-fast` 11, `rs-max` 14 theo thứ tự đề xuất từ tên (không phải số đo).
- **Y2 — XONG.** Adapter `openmausbot` chỉ đọc + `apps drift-model`. Đo thật: instance `openai-compat-<uuid>` → `9Router-Agent-1`, 231 bước, fallback, bước tốt đầu tiên ở vị trí 0, 0 HANG trước ⇒ `OK`.

## CI

PR #56 → main **c28b7fb**; main CI **45049049310**, attempt **1**, success.

## Câu trả lời ngắn

1. Vá v2: `loaded=true` — router đã nạp (tiến trình bắt đầu sau khi sửa tệp).
2. `rs-fast` đề xuất từ tên: xem bản che trong `combo-rs.txt`; bản tên thật gửi trong chat. Chủ dự án nên chỉnh bằng `.agent/combo-order.txt`.
3. OpenMausBot: `9Router-Agent-1` → `OK` (231 bước, fallback, 0 HANG trước bước tốt đầu).

Gói: `evidence/c41`; verify-records SẠCH 2 dòng, verify-package OK, quét tên riêng + mẫu cá nhân 0 khớp.
