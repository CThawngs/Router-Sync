# Evidence C39 — OpenMausBot "stopped answering": nguyên nhân là 8 bước đầu chung của mọi combo

- Router: `patchV1=true patchV2=true`, sha `a741ca28…` (đã restart ở C37). `/v1/models` không còn là nút thắt.
- OpenMausBot: instance `openai-compat-…` trỏ `model=9Router-Agent-1`, `url` tới `localhost:20128/v1`.
- Mọi lệnh đo qua `capture-evidence.mjs`; chỉ `POST /v1/chat/completions`, `max_tokens=8`, stream bật.

## 1. Reproduce đúng lỗi

`combos probe --mode combo --combo 9Router-Agent-1 --stop-after-sec 60`:

```
9Router-Agent-1  HANG-NO-USAGE  http=-  header=-ms  total=60010ms  usage=không có usage
```

Khớp thông báo "The model server at localhost:20128 stopped answering" — client không nhận được token/header trong lúc chờ.

## 2. Nguyên nhân gốc

Đọc DB 9Router (chỉ đọc): **cả 9 combo dùng chung một danh sách 230 bước**, 8 bước đầu giống hệt nhau:

| vị trí | bước | kết quả đo |
|---|---|---|
| 1 | `oc/deepseek-v4.1-flash-free` | **429** RATE-LIMITED, 390 ms (C39 `front-step1`) |
| 2 | `oc/tidepool-alpha-free` | **429** `FreeUsageLimitError` (C38 W3) |
| 3 | `ocz/deepseek-v4.1-flash-free` | **503** ERROR-5XX, 8 ms |
| 6 | `nvidia/z-ai/glm-5.3-flash` | **TIMEOUT-NO-HEADER** 20 s (C39 `front-step6`) |
| 8 | `cf/@cf/zai-org/glm-4.7-flash` | bước đầu tiên có thể trả lời |

Router phải lội qua các bước 429/503/20 s này trước khi tới bước sống → vượt quá idle timeout của OpenMausBot. Đổi tên combo (`Agent`, `Agent-1`, `Agent-2`, `Coder-*`, `Dev`) **không giúp gì** vì phần đầu giống nhau. Đây không phải lỗi cache và không phải lỗi chiến lược `round-robin` — cùng xảy ra ở combo `fallback`.

## 3. Cách sửa (cần chủ dự án tự làm)

1. Trong dashboard 9Router tạo combo **`rs-fast`** với 12 bước đã đo ở C38 (tất cả RELIABLE), chiến lược **Fallback**. Không restart router.
2. Trong OpenMausBot đổi field `model` của instance từ `9Router-Agent-1` thành `rs-fast`.

Agent không tự ghi vào router hay cấu hình client. Sau khi có combo, có thể nhờ agent đổi field `model` trong cấu hình OpenMausBot.

## 4. Giới hạn

- Chỉ reproduce 1 lần combo (`9Router-Agent-1`) + 2 bước đại diện; không đo lại 9 combo (C37/C38 đã đo và thấy cùng hiện tượng).
- Không sửa router, không đổi chiến lược, không restart trong vòng này.

## Gói

`evidence/c39`: 3 bản ghi (`omb-repro`, `front-step1`, `front-step6`), 3 cặp out/err. `verify-records`: SẠCH 3 dòng; `verify-package`: OK; quét tên riêng + mẫu cá nhân 0 khớp.
