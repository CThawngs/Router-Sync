# RouterSync UI Tokens Contrast Audit (WCAG 2.1 AA)

> Sinh tự động bởi `tools/ui/contrast-check.mjs` theo Spec §34.5 (mục 4 & 5).
> Ngưỡng WCAG 2.1: ≥ 4.5:1 cho văn bản thông thường, ≥ 3.0:1 cho thành phần giao diện / vòng focus (SC 1.4.11).
> Các thành phần container (thẻ card, viền line trên nền) được ghi nhận ở mức **INFO** (tham khảo cấu trúc hình học và đổ bóng, không áp đặt fake threshold).

## Ghi chú về nguồn token và các biến thể Ink

- **100% token gốc:** Mọi token nguyên bản từ concept v5 (`--bg`, `--card`, `--text`, `--line`, `--dash`, `--blue`, `--grn`, `--yel`, `--amb`, `--cor`, v.v.) được giữ nguyên giá trị thiết kế ban đầu.
- **Biến thể mực chuyên dụng (`*-ink`):** Để văn bản trên nền thẻ và nền trang đạt chuẩn WCAG 2.1 AA (≥ 4.5:1), 3 token mực đậm được thêm vào:
  - Sáng: `--cor-ink: #A62812;` (7.2:1), `--amb-ink: #7A4B00;` (7.4:1), `--grn-ink: #146C36;` (6.5:1).
  - Tối: `--cor-ink: #FFB4A4;` (10.3:1), `--amb-ink: #FFE08A;` (13.6:1), `--grn-ink: #8EE5B5;` (11.7:1).
- **Yellow Ink & Blue Ink:** Sử dụng trực tiếp token mực sẵn có từ concept v5:
  - Yellow Ink = token `--yel-i` (`#6B4A00` sáng 8.1:1 / `#FFE08A` tối 13.6:1).
  - Blue Ink = token `--blue-i` (`#2A52D6` sáng 6.4:1 / `#B9CBFF` tối 10.9:1).

## Bảng kiểm tra tương phản (40 kiểm tra WCAG + 4 thông số tham khảo)

| Cặp màu / Thành phần | Nguồn token | Chủ đề | Tỷ lệ đo được | Ngưỡng yêu cầu | Kết quả | Ghi chú |
|---|---|---|---|---|---|---|
| Text on Background | `--text on --bg` | light | 16.8:1 | ≥ 4.5:1 | **PASS** | - |
| Text on Card | `--text on --card` | light | 18.4:1 | ≥ 4.5:1 | **PASS** | - |
| Muted text on Card | `--muted on --card` | light | 6.7:1 | ≥ 4.5:1 | **PASS** | - |
| Muted text on Background | `--muted on --bg` | light | 6.1:1 | ≥ 4.5:1 | **PASS** | - |
| Link text on Card | `--link on --card` | light | 6.4:1 | ≥ 4.5:1 | **PASS** | - |
| Link text on Background | `--link on --bg` | light | 5.9:1 | ≥ 4.5:1 | **PASS** | - |
| Amber Ink (text) on Card | `--amb-ink on --card` | light | 7.4:1 | ≥ 4.5:1 | **PASS** | - |
| Coral Ink (text) on Card | `--cor-ink on --card` | light | 7.2:1 | ≥ 4.5:1 | **PASS** | - |
| Green Ink (text) on Card | `--grn-ink on --card` | light | 6.5:1 | ≥ 4.5:1 | **PASS** | - |
| Yellow Ink (text) on Card | `--yel-i on --card` | light | 8.1:1 | ≥ 4.5:1 | **PASS** | - |
| Blue Ink (text) on Card | `--blue-i on --card` | light | 6.4:1 | ≥ 4.5:1 | **PASS** | - |
| Focus Ring on Card | `--blue on --card` | light | 4.4:1 | ≥ 3:1 | **PASS** | WCAG 2.1 SC 1.4.11 non-text focus indicator (>=3.0:1) |
| Focus Ring on Background | `--blue on --bg` | light | 4.0:1 | ≥ 3:1 | **PASS** | WCAG 2.1 SC 1.4.11 non-text focus indicator (>=3.0:1) |
| Gate #a41f yellow box: text on alpha bg | `--yel-i on --yel-t (blend --card)` | light | 7.5:1 | ≥ 4.5:1 | **PASS** | - |
| Chip Risk High (coral): text on chip bg | `--del-tx on --del-bg (blend --card)` | light | 8.4:1 | ≥ 4.5:1 | **PASS** | - |
| Chip Source Good (green): text on chip bg | `--add-tx on --add-bg (blend --card)` | light | 8.5:1 | ≥ 4.5:1 | **PASS** | - |
| Chip Amber: text on chip bg | `--yel-i on --yel-t2 (blend --card)` | light | 6.7:1 | ≥ 4.5:1 | **PASS** | - |
| Chip Blue: text on chip bg | `--blue-i on --blue-t (blend --card)` | light | 5.4:1 | ≥ 4.5:1 | **PASS** | - |
| Chip Yellow: text on chip bg | `--yel-i on --yel-t (blend --card)` | light | 7.5:1 | ≥ 4.5:1 | **PASS** | - |
| Chip Stale Gray: text on chip bg | `--muted on --fill (blend --card)` | light | 6.0:1 | ≥ 4.5:1 | **PASS** | Viền nét đứt --dash |
| Card on Background | `--card on --bg` | light | 1.1:1 | Tham khảo | `INFO` | Thông số tham khảo (INFO). Tách biệt bằng viền/đổ bóng, không áp chuẩn WCAG text/control. |
| Card Border on Background | `--line on --bg` | light | 1.1:1 | Tham khảo | `INFO` | Viền thẻ phân tách với nền (kèm đổ bóng --sh) |
| Text on Background | `--text on --bg` | dark | 17.7:1 | ≥ 4.5:1 | **PASS** | - |
| Text on Card | `--text on --card` | dark | 15.8:1 | ≥ 4.5:1 | **PASS** | - |
| Muted text on Card | `--muted on --card` | dark | 7.6:1 | ≥ 4.5:1 | **PASS** | - |
| Muted text on Background | `--muted on --bg` | dark | 8.5:1 | ≥ 4.5:1 | **PASS** | - |
| Link text on Card | `--link on --card` | dark | 8.8:1 | ≥ 4.5:1 | **PASS** | - |
| Link text on Background | `--link on --bg` | dark | 9.8:1 | ≥ 4.5:1 | **PASS** | - |
| Amber Ink (text) on Card | `--amb-ink on --card` | dark | 13.6:1 | ≥ 4.5:1 | **PASS** | - |
| Coral Ink (text) on Card | `--cor-ink on --card` | dark | 10.3:1 | ≥ 4.5:1 | **PASS** | - |
| Green Ink (text) on Card | `--grn-ink on --card` | dark | 11.7:1 | ≥ 4.5:1 | **PASS** | - |
| Yellow Ink (text) on Card | `--yel-i on --card` | dark | 13.6:1 | ≥ 4.5:1 | **PASS** | - |
| Blue Ink (text) on Card | `--blue-i on --card` | dark | 10.9:1 | ≥ 4.5:1 | **PASS** | - |
| Focus Ring on Card | `--blue on --card` | dark | 6.7:1 | ≥ 3:1 | **PASS** | WCAG 2.1 SC 1.4.11 non-text focus indicator (>=3.0:1) |
| Focus Ring on Background | `--blue on --bg` | dark | 7.5:1 | ≥ 3:1 | **PASS** | WCAG 2.1 SC 1.4.11 non-text focus indicator (>=3.0:1) |
| Gate #a41f yellow box: text on alpha bg | `--yel-i on --yel-t (blend --card)` | dark | 11.1:1 | ≥ 4.5:1 | **PASS** | - |
| Chip Risk High (coral): text on chip bg | `--del-tx on --del-bg (blend --card)` | dark | 9.1:1 | ≥ 4.5:1 | **PASS** | - |
| Chip Source Good (green): text on chip bg | `--add-tx on --add-bg (blend --card)` | dark | 10.3:1 | ≥ 4.5:1 | **PASS** | - |
| Chip Amber: text on chip bg | `--yel-i on --yel-t2 (blend --card)` | dark | 8.5:1 | ≥ 4.5:1 | **PASS** | - |
| Chip Blue: text on chip bg | `--blue-i on --blue-t (blend --card)` | dark | 8.1:1 | ≥ 4.5:1 | **PASS** | - |
| Chip Yellow: text on chip bg | `--yel-i on --yel-t (blend --card)` | dark | 11.1:1 | ≥ 4.5:1 | **PASS** | - |
| Chip Stale Gray: text on chip bg | `--muted on --fill (blend --card)` | dark | 6.7:1 | ≥ 4.5:1 | **PASS** | Viền nét đứt --dash |
| Card on Background | `--card on --bg` | dark | 1.1:1 | Tham khảo | `INFO` | Thông số tham khảo (INFO). Tách biệt bằng viền/đổ bóng, không áp chuẩn WCAG text/control. |
| Card Border on Background | `--line on --bg` | dark | 1.5:1 | Tham khảo | `INFO` | Viền thẻ 1px solid #2C2B4B phân tách rõ ràng với nền |

**Tổng kết:** 40/40 kiểm tra chuẩn WCAG 2.1 AA đạt; 4 chỉ số tham khảo INFO.
