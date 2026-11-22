# Theo dõi sức khỏe router theo tuổi tiến trình

Dùng khi combo lại có dấu hiệu treo dù cache `/v1/models` vẫn bật.

## Chạy lại phép đo

```
# router đã chạy ~6 giờ / 12 giờ / 24 giờ
node packages/cli/dist/index.js router watch \
  --minutes 45 --interval-sec 10 \
  --combo 9Router-Coder-3 --combo-every-min 5 \
  --out evidence/<vong>/watch-6h.jsonl

node packages/cli/dist/index.js router watch --summarize evidence/<vong>/watch-6h.jsonl
```

Mỗi mẫu đã có `routerAgeSec` (tuổi tiến trình), `freeMemMB`, `modelsMs` và
`x-9r-models-cache` (nếu dùng `tools/agent/models-probe.mjs`).

## Đọc kết quả

| dấu hiệu | kết luận gần nhất |
|---|---|
| `routerAgeSec` tăng nhưng cache vẫn `hit`, combo OK | router ổn; không cần restart |
| cache `hit`, `/v1/models` ~5 ms, nhưng combo HANG | không còn do `/v1/models`; nghi bước model cụ thể (xem bảng reliability) |
| cache `miss` liên tục và `/v1/models` ~5–8 s | TTL quá ngắn hoặc client gọi quá nhiều; tăng `RS_MODELS_CACHE_TTL_MS` |
| combo OK lúc mới restart, HANG sau nhiều giờ dù cache hit | nghi tiến trình già / rò r不朽 tài nguyên — **bằng chứng**, chưa phải kết luận |

So sánh ba mốc 6h/12h/24h bằng cùng một lệnh, cùng combo, cùng `--minutes`: chỉ đổi tuổi tiến trình.

## Không làm

- Không tự đặt lịch restart. Chủ dự án tự quyết khi có số liệu.
- Không chỉnh DB/config router để chạy phép đo này.