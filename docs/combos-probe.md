# `combos probe` — thử combo như một client thật

`routersync combos probe` gửi request thật tới router đang chạy và ghi lại điều
xảy ra ở phía client (header, byte đầu, tổng thời gian) đối chiếu với
`usageHistory` của router.

## Vì sao có lệnh này

`combos stale` chỉ đọc trạng thái router và kết luận "thấy / không thấy". Nó
không trả lời được câu "gọi combo thì có chạy không, chậm ở đâu, và ai phục vụ".
`combos probe` trả lời đúng câu đó.

## An toàn

- **Mặc định là chạy thử (dry-run)**: chỉ in số combo, số bước duy nhất, ước
  tính thời gian và nhắc cờ `--yes-spend-tokens`. Không có request nào được gửi.
- Muốn gửi thật phải thêm `--yes-spend-tokens` — mỗi request tốn token của chủ dự
  án.
- Chỉ đọc router: DB 9Router mở `readOnly`, API key đọc từ đó và **không bao giờ
  in ra**.
- Thân phản hồi chỉ giữ 200 ký tự và bị che chuỗi dài (khoá, đường dẫn).

## Chế độ

| Chế độ | Gửi gì | Hạn mỗi lần |
|---|---|---|
| `--mode combo` (mặc định) | một request cho mỗi combo, `model` = tên combo, `stream: true`, `max_tokens: 8` | 120 s |
| `--mode step` | một request cho mỗi bước duy nhất, `max_tokens: 1` | 20 s |

`--combo <tên>` chọn một combo, `--all` chọn tất cả, `--max-minutes <n>` là ngân
sách thời gian cho cả lần chạy (mặc định 40).

## Kết luận của một lần thử

| Kết luận | Nghĩa |
|---|---|
| `OK` | HTTP 200, có nội dung |
| `EOL-GONE` | 410, hoặc thân nói rõ model đã ngừng phục vụ |
| `NO-PROVIDER` | 503 kiểu "không còn provider nào phục vụ model này" |
| `RATE-LIMITED` | 429 |
| `AUTH` | 401 / 403 |
| `TIMEOUT-NO-HEADER` | hết hạn mà chưa có header |
| `HANG-AFTER-USAGE` | hết hạn, chưa có header, **nhưng** `usageHistory` có dòng mới → router đã làm xong việc với provider mà không trả lời cho client |
| `ERROR` | còn lại |

Hàm phân loại là `perStepConclusion()` (thuần, có test cho từng nhánh).

## Dừng sớm

- Hết `--max-minutes`.
- **5 lần 429 liên tiếp**: dừng, không cố tiếp. Đây là giới hạn cứng, không phải
  gợi ý.

## Đọc kết quả

- `usage=` trong log là provider/model đã phục vụ, đối chiếu bằng dòng mới trong
  `usageHistory` (chỉ đọc).
- `usage=không có dòng usage` nghĩa là router không ghi nhận request nào — thường
  là combo chưa bao giờ gọi tới provider.
- `HANG-AFTER-USAGE` là tín hiệu tách biệt: upstream đã trả lời, client thì không.

## Không làm

- Không sửa combo, không sửa cấu hình, không ghi vào DB router.
- Không khởi động lại / dừng tiến trình router.
- Không gọi thẳng provider ngoài, không đọc key để dùng ngoài router.
- Không kết luận "model này nên xoá" chỉ vì một lần thử; xem `docs/combos-stale.md`.

## Ví dụ

```
# xem trước sẽ gọi gì
node packages/cli/dist/index.js combos probe --mode combo --all

# thử thật 9 combo, tối đa 12 phút
node packages/cli/dist/index.js combos probe --mode combo --all --yes-spend-tokens --max-minutes 12

# thử từng bước duy nhất
node packages/cli/dist/index.js combos probe --mode step --all --yes-spend-tokens --max-minutes 25
```