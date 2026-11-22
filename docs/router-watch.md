# `router watch` — lấy mẫu sức khỏe router theo thời gian

`routersync router watch` ghi một dòng JSONL mỗi chu kỳ, dùng để trả lời câu hỏi
"lúc chậm thì máy đang thế nào" thay vì đoán.

## Dùng

```
# 10 phút, mỗi 10 giây một mẫu
routersync router watch --router 9router --minutes 10 --interval-sec 10 --out watch.jsonl

# kèm thử combo mỗi 5 phút (tối đa 20 request combo mỗi lần chạy)
routersync router watch --router 9router --minutes 45 --combo 9Router-Coder-3 --combo-every-min 5 --out watch.jsonl

# đọc lại
routersync router watch --summarize watch.jsonl
```

## Mỗi dòng JSONL

| trường | nghĩa |
|---|---|
| `t` | thời điểm mẫu (ISO) |
| `freeMemMB` | RAM trống của máy (MB) |
| `load1` | tải CPU trung bình 1 phút (null nếu OS không hỗ trợ) |
| `routerRssMB`, `routerCpuSec`, `routerAgeSec` | RSS, CPU tích luỹ, tuổi tiến trình router |
| `modelsMs`, `modelsStatus` | độ trễ và mã của `GET /v1/models` (đo cả khi lỗi/quá hạn 15 s) |
| `combo` | nếu có `--combo`: `{ model, headerMs, usageMs, servedBy, verdict }` |

## Giới hạn an toàn

- Chỉ đọc: không ghi vào router, không dừng/khởi động lại.
- Combo tối đa **20 request** mỗi lần chạy, `max_tokens` 8, hạn 180 s; dừng sớm
  nếu gặp 5 lần 429 liên tiếp.
- Nhẹ: mỗi chu kỳ chỉ một request `/v1/models` và một lần đọc tiến trình.

## `--summarize`

In phân vị p50/p90/max của `/v1/models` và của combo theo ba khoảng RAM trống
(`<600 MB`, `600–1500 MB`, `>1500 MB`), kèm hệ số tương quan Pearson giữa RAM
trống và độ trễ `/v1/models`.

Ô dưới **5 mẫu** ghi `không đủ mẫu` và không in phân vị — thà thiếu còn hơn kết
luận sai từ 2–3 điểm.

## Khi nào dùng

Khi có nghi ngờ "máy chậm thì router chậm": chạy 30–60 phút trong lúc làm việc
thật, rồi xem độ trễ `/v1/models` có tăng ở khoảng RAM thấp hay không. Nếu tương
quan gần 0 và phân vị các khoảng giống nhau, RAM không phải nút thắt.

## Thí nghiệm có kiểm soát

`tools/agent/load-sim.mjs` (không nằm trong CLI) chạy bốn pha: đối chứng A →
tải RAM → tải CPU → đối chứng B, cùng một combo. Nó tự dừng nếu RAM trống xuống
dưới 500 MB và luôn nhả bộ nhớ trong `finally`. Chỉ chạy khi RAM trống lúc bắt
đầu ≥ 1500 MB; dưới ngưỡng đó thì ghi `CHUA LAM`.