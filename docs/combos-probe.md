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
| `--mode step` | một request cho mỗi bước duy nhất, `max_tokens: 8` (đổi được `1..64` qua `--max-tokens`) | 20 s |

`--combo <tên>` chọn một combo, `--all` chọn tất cả, `--max-minutes <n>` là ngân
sách thời gian cho cả lần chạy (mặc định 40), và `--concurrency <1|2>` giới hạn số
request đồng thời (mặc định `1`).

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
- **Hết `--budget <n>`** (C40 X0 & C44 W2, mặc định 40 request): dừng và liệt kê các bước
  chưa đo. Bộ đếm cuối lần chạy in `requests=<đã gửi>/<giới hạn>` và số request
  chia theo provider.

## C40 X0 & C44 W2 — Thăm dò tiết kiệm quota phía client (`RequestBudget` & đối chiếu `usageHistory`)

Mỗi lần thăm dò **đều tốn quota gói miễn phí** của provider, kể cả request trả
404/429/503. Đây là chi phí thật, không phải lỗi của router.

Trên `9router@0.5.123` (`ponytailEnabled=true`), các request `stream: true` trả
`HTTP 200 OK` có thể ghi `0` dòng mới vào bảng `usageHistory` trong cửa sổ đo.
Vì vậy từ vòng `W2` (`packages/cli/src/commands/combos-budget.ts` và
`packages/cli/src/commands/combos-probe.ts`), toàn bộ bộ đếm ngân sách và nhảy
bước quota đều hoạt động **độc lập ở phía client**:

| Cờ / cơ chế | Tác dụng |
|---|---|
| `--budget <n>` (`RequestBudget`) | Trần số request cho một lần chạy (`combos probe` và `combos reliability`, mặc định 40), đếm trực tiếp từng HTTP request phía client đã gửi đi (không phụ thuộc `usageHistory`). |
| `--skip-quota-from <file>` | Đọc tệp kết quả trước (`recentQuotaSteps`); cắt hậu tố `#<attempt>` và khớp cả dòng `http=429` có `quota=1` ở chế độ combo/step trong cửa sổ 30 phút để đánh dấu `SKIPPED-QUOTA` và **không gửi lại**. |
| `reconcileSentVsUsage` | Cuối lượt chạy, đối chiếu số request client đã gửi với số dòng `usageHistory` mới và in dòng `đối chiếu usage: sent=<N> usageHistory=<M> lệch=<N-M>`. |
| `quota=1` | Chú thích trên dòng `RATE-LIMITED` do quota, phân biệt với 429 thường. |
| xen kẽ provider | Tối đa 3 request liên tiếp tới cùng provider; giữa hai request cùng provider cách ít nhất 3 giây. |

Số request đã dùng ở các vòng trước là **ước lượng**: cộng số dòng kết quả trong
các tệp `*.out.txt` của `evidence/c32` … `evidence/c39`. Chạy
`node tools/agent/x40-evidence.mjs` để in số theo từng nhánh — đừng gõ tay. Ở lần
đo C40, con số đó là **381** (trong đó C32 = 354, C38 = 22, C39 = 5); các nhánh
đã xóa hoặc không còn tệp kết quả thì in 0. Con số này là ước lượng dưới, vì một
số vòng không lưu đầu ra dạng dòng kết quả.

## Đọc kết quả

- `usage=` trong log là provider/model đã phục vụ, đối chiếu bằng dòng mới trong
  `usageHistory` (chỉ đọc).
- `usage=không có dòng usage` (hoặc `usage=-` trên đường `stream: true` của
  `9router@0.5.123`) nghĩa là bảng `usageHistory` không xuất hiện dòng mới trong cửa
  sổ đọc lại; hãy xem thêm dòng `đối chiếu usage: sent=...` ở cuối lượt chạy.
- `HANG-AFTER-USAGE` là tín hiệu tách biệt: upstream đã trả lời, client thì không.

## C33: hạn dài, đo "chậm" vs "treo" (mode combo)

| Cờ | Nghĩa |
|---|---|
| `--combo-timeout-sec <n>` | Hạn cho mỗi combo, 1..600 giây (mặc định 120). |
| `--combo <tên>` | Chọn một combo, truyền nhiều lần để chọn nhiều. |
| `--only <regex>` | (mode step) chỉ thử bước khớp regex. |

Trong lúc chờ, lệnh hỏi `usageHistory` mỗi 5 giây và ghi thời điểm dòng usage
xuất hiện so với header. Kết luận của mode combo:

| Kết luận | Nghĩa |
|---|---|
| `OK` | Header trong ngưỡng |
| `SLOW-OK` | Có header nhưng sau 120 giây (chậm, không treo) |
| `HANG-AFTER-USAGE` | Hết hạn, chưa có header, **có** dòng usage (upstream đã làm việc) |
| `HANG-NO-USAGE` | Hết hạn, chưa header, **không** dòng usage |

Ngưỡng 120 giây là hằng số `SLOW_THRESHOLD_MS`. Một dòng log có `usageAt=` cho
biết dòng usage xuất hiện ở mili-giây thứ mấy.

## C34 & R1: đo phần chờ sau usage và độ đồng thời

| Cờ | Nghĩa |
|---|---|
| `--timeline` | Ghi MỌI dòng `usageHistory` mới trong lúc chờ (hỏi mỗi 1 giây), kèm `usageRows` trong JSON và dòng `usage@<ms> provider/model` trong log. |
| `--max-tokens <n>` | `max_tokens` mỗi request, 1..64 (mặc định 8 ở cả `combo` và `step`). |
| `--no-stream` | Gửi `stream: false`. |
| `--concurrency <1\|2>` | Số request gửi đồng thời (`1` hoặc `2`, mặc định `1`). |
| `--repeat <n>` | (mode step) lặp lại mỗi bước n lần, hậu tố `#1`, `#2`. |

Dùng khi cần biết header về sau khi router đã ghi usage bao lâu, và router có thử
nhiều bước liên tiếp hay không (mỗi bước thử là một dòng usage).

## `combos plan` — kế hoạch gọn combo (chỉ lập kế hoạch)

```
routersync combos plan --router 9router \
  --from evidence/C33/c33-probe-step.out.txt \
  --from evidence/C33/c33-probe-step-pass2.out.txt \
  --out combo-plan.json
```

Đọc DB router **chỉ đọc**, đọc các file probe, rồi ghi một file kế hoạch. Không
ghi gì vào router.

| Nhóm | Vào nhóm khi |
|---|---|
| `REMOVE` | lỗi cứng (EOL-GONE, hoặc NO-PROVIDER có thông điệp khớp) ở ≥2 lượt cách nhau > 1 phút — **đề xuất gỡ**, chờ chủ dự án xác nhận |
| `MOVE-END` | `TIMEOUT-NO-HEADER` ở ≥2 lượt — gợi ý đưa xuống cuối |
| `KEEP` | `OK` ở 2 lượt — xếp theo thời gian tăng dần |
| `FAST-ERROR` | 404/405/400 — chỉ liệt kê, **không** phải lý do gỡ |
| `UNTESTED` | còn lại (ABSENT, UNVERIFIABLE, NOT-LISTED, NOT-IN-CATALOG) |

Kế hoạch có hai phương án cho từng combo: **A** bản gọn của chính combo đó (bỏ
nhóm gỡ, đưa nhóm timeout xuống cuối), **B** combo mới chỉ gồm bước OK hai lượt.
Kèm dự đoán thời gian tới header theo mô hình ở `docs/combos-probe.md` mục
"Vì sao combo chậm", sha256 của DB đầu vào, và bản sao thứ tự cũ để hoàn tác.

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

# thử từng bước duy nhất với trần ngân sách 20 request
node packages/cli/dist/index.js combos probe --mode step --all --budget 20 --yes-spend-tokens --max-minutes 25
```
