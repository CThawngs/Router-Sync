# Evidence C38 — chiến lược combo, lỗi nhanh, độ ổn định từng bước

- Build: `origin/main` = **4a5179c** (PR #54). Gói `evidence/c38`, `[skip ci]`.
- Mọi lệnh đo đi qua `capture-evidence.mjs`; chỉ `POST /v1/chat/completions`, không gọi
  `/v1/models` trong lúc đo; không restart/ghi router.

## W0 — Chiến lược từ DB — XONG

`comboStrategies`: 12 mục (4 `round-robin`, 8 `fallback`), nhưng chỉ **9 combo** tồn tại:

| combo | bước | chiến lược |
|---|---|---|
| 9Router-Agent | 230 | round-robin |
| 9Router-Agent-1 / -2 | 230 | fallback |
| 9Router-Coder-1 | 229 | fallback |
| 9Router-Coder-2..5 | 230 | fallback |
| 9Router-Dev | 230 | mặc định (không rõ hành vi từ dữ liệu) |

`providerStrategies` **rỗng** → không khẳng định được xoay vòng tài khoản từ cấu hình;
chỉ ghi "không rõ". Đổi chiến lược cấp combo không làm mất cấu hình cấp provider.

## W1 — round-robin so với fallback — MỘT PHẦN (không kết luận được)

Đã thêm `--stop-after-sec` / `--strategy-report` và script `w1-strategy-test.mjs`.
Chạy 6 combo xen kẽ, hạn 90 s/request, dừng combo sau 2 lần treo liên tiếp:

| combo | chiến lược | OK/thử | ghi chú |
|---|---|---|---|
| 9Router-Agent | round-robin | 0/2 | 2 HANG (có usage: gemini-4-hydrogen, openrouter nemotron) |
| 9Router-Agent-1 | fallback | 0/2 | 2 HANG |
| 9Router-Coder-3 | fallback | 0/2 | 2 HANG (1 có usage gemini-3.8-flash) |
| 9Router-Combo-1, free-model, nvidia-models | stale | 0/4 | `NO-RESULT`: tên combo không tồn tại |

**Kết luận: chưa ủng hộ giả thuyết round-robin** — combo `fallback` đối chứng cũng treo.
Ngoài ra RAM trống tụt còn **324 MB** trong lúc đo → phép đo nhiễu. Không gọi là chứng minh.

## W2 — Cảnh báo trong RouterSync — XONG

`combos plan` có trường `strategy` và `RISK-ROUND-ROBIN` kèm số đo W1; docs
`combos-stale.md` và `combo-rs-fast.md` phân biệt xoay vòng tài khoản (provider) với
chiến lược combo. Test + mutation, 13 test pass.

## W3 — Lý do bước lỗi nhanh — XONG

| provider | mã | thông điệp rút gọn | nguyên nhân khả dĩ | chủ dự án kiểm gì |
|---|---|---|---|---|
| hf | 404 | `No active credentials for provider: huggingface` | **không phải model chết** — thiếu credential/connection HuggingFace | dashboard → provider huggingface: còn connection active? |
| cohere | 405 | `[405]: HTTP 405` (không có `Allow`) | đường dẫn/phương thức phía router hoặc upstream; thông điệp không đủ để kết luận | thử endpoint của cohere trong dashboard, xem provider type |
| oc | 429 | `FreeUsageLimitError` — free usage limit reached | quota free tier, **không phải model chết** | đổi/sửa account free, hoặc bật quota trả phí |

→ 138 bước "lỗi nhanh" của C32 **không nên bị xoá**: hf và oc là vấn đề tài khoản/cấu hình,
cohere cần thêm dữ liệu. Đây là phần chủ dự án có thể dùng được nếu sửa đúng chỗ.

## W4 — Độ ổn định thật — MỘT PHẦN

Chạy trên 39 bước đã lọc (loại 404/405/400/410/503 NO-PROVIDER) + 3 model hay treo,
2 vòng × 3 request, hạn 30 s, ngân sách 25 phút.

| nhóm | số bước | ví dụ |
|---|---|---|
| RELIABLE | **16** | cf 4, groq 4, kc 1, nvidia 7 (p50 ~0,7–2,2 s) |
| HANG | **6** | gemini-3.8-flash, gemini-4-hydrogen, nvidia gemma-4-31b-it, muse-glimmer-30b, stepfun-ai/step-5-preview, z-ai/glm-5.3-flash |
| RATE-LIMITED | 0 | — |
| DEAD | 0 | — |
| chưa đo | **17** | hết ngân sách 25 phút |

Danh sách mới lập từ 22 bước đã đo: `rs-fast` **12**, `rs-max` **16** (bản che trong
`combo-rs.txt`, bản tên thật gửi trong chat). Không bước HANG/DEAD nào vào hai danh sách.

## CI

| lần | sha | run | attempt | kết quả |
|---|---|---|---|---|
| PR #54 | 9bf7a71 | 45004836633 | 1 | success |
| main | 4a5179c | 45005432691 | 1 | success |

## Giới hạn

- W1 nhiễu (RAM 324 MB + 3 tên combo stale) → không kết luận round-robin.
- W4 chỉ 22/39 bước; 17 bước chưa đo.
- Không sửa router, không đổi chiến lược, không restart.