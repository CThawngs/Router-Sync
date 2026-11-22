# E2E sau vá v2 + restart — chỉ gọi combo

- Router pid mới **31040**, `nine-router-patch status`: `patchV1=true patchV2=true`, sha `a741ca28…`.
- Mọi lệnh đo đều qua `capture-evidence.mjs`; **không gọi riêng model nào**, chỉ
  `combos probe --mode combo` với tên combo thật, `stream: true`, `max_tokens` 8.

## 1) Chạy lần đầu — 3 combo (`e2e-combo-v2`)

3/3 **OK**, header 2 393–2 510 ms. `9Router-Coder-3` phục vụ bởi
`opencode/deepseek-v4.1-flash-free` (dòng usage ở 2 605 ms).

## 2) Chạy đủ 9 combo (`e2e-combo-all`)

**9/9 OK**, header 883–2 803 ms. Routing thấy được (6/9 có dòng usage):
`opencode/deepseek-v4.1-flash-free` ở `9Router-Agent`, `-Agent-2`, `-Coder-1..3`.
Các combo còn lại trả 200 nhưng dòng usage ghi sau khi client đọc xong.

## 3) Lặp cùng combo `9Router-Agent` 5 lần (`e2e-combo-repeat`)

Lần 1: **HANG-AFTER-USAGE** 120 s, usage ở 952 ms, phục vụ
`opencode/tidepool-alpha-free`. Lần 2–4: **HANG-NO-USAGE** 120 s. Lần 5 bị cắt bởi hạn
của capture (600 s). → Lỗi không nằm ở `/v1/models`; cache v2 vẫn bật.

## 4) Chạy lại đủ 9 combo (`e2e-combo-all-2`)

**8/9 OK** (1 382–2 753 ms), **1 HANG** (`9Router-Agent`, 120 s). Combo này ghi **nhiều
dòng usage liên tiếp** — router đang thử nhiều provider (cloudflare-ai `@cf/zai-org/glm-4.7-flash`
14 s, opencode `hy4-flash-free` 22 s, `mimo-v2.6-flash-free` 23 s,
`openrouter/nvidia/nemotron-3.5-super-vl:free` 55 s, opencode
`nemotron-3.5-super-vl-free` 58 s, rồi cloudflare lại ở 116 s) — nhưng **không trả header**.

## Kết luận

- Cache v2 chạy ổn; `/v1/models` không còn là nút thắt.
- Combo phục vụ nhanh khi router dừng ở bước đầu khả dụng.
- **Lỗi còn lại nằm ở đường fallback của 9Router**: khi combo phải thử nhiều bước, router ghi
  usage từng bước nhưng không đẩy response về client → `HANG-AFTER-USAGE`. Đây là lỗi 9Router,
  không phải RouterSync, không phải cấu hình account.
- `9Router-Agent` là combo dễ dính nhất (đã treo 4/4 lần lặp + 1 lần trong lượt 9 combo).
- Giải pháp ngắn hạn: dùng `rs-fast` (12 bước đã đo, không có bước HANG) và strategy
  `fallback`; vẫn là combo 9Router, vẫn failover theo thứ tự.

## Gói

Nhánh `evidence/c37-e2e`: `records.jsonl` + 4 cặp out/err + REPORT + NOTE.
`verify-records`: SẠCH 4 dòng; `verify-package`: OK.
