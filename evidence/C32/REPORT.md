# Evidence C32 — vì sao combo 9Router "toàn lỗi", và lệnh `combos probe`

- Build đã kiểm: `origin/main` = **9b10ee6** (PR #46). Trước đó: 4c5bc62 (PR #45).
- Router thật: 9Router `0.5.119` tại `127.0.0.1:20128` (chỉ đọc DB, chỉ gọi
  `POST /v1/chat/completions`).
- Gói: `evidence/c32`, `[skip ci]`, 9 tệp, không PR.

## M0 — "usageHistory 0 lỗi" vs "log toàn lỗi" — XONG

### 0.1 File log của 9Router

`%APPDATA%\9router\logs\` **rỗng** (chỉ có thư mục con `mitm` rỗng). Không có
file log nào khác trong `%APPDATA%\9router` hay `%LOCALAPPDATA%\9router`
(không tồn tại). Kết luận: **không có file log**; tab log của dashboard đọc bộ
đệm trong RAM của tiến trình, không phải file.

### 0.2 DB ghi gì (chỉ đọc, `query_only`)

| bảng | phạm vi | nội dung |
|---|---|---|
| `usageHistory` | 7 ngày: **6974 dòng, status = ok toàn bộ**; 24 giờ: 742 ok / 0 lỗi | chỉ ghi request **thành công** |
| `requestDetails` | 1000 dòng, **560 error / 440 success**, nhưng đóng băng ở **2026-07-28 → 2026-08-04** | có ghi lỗi, nhưng đã ngừng ghi từ 4/8 |

Một câu: **9Router hiện không lưu lỗi ở đâu cả.** `usageHistory` chỉ ghi request
thành công, `requestDetails` (bảng duy nhất từng ghi lỗi) đã ngừng ghi từ
2026-08-04, và không có file log. Thấy "log toàn lỗi" trên dashboard là bộ đệm
RAM của tiến trình; muốn tra lại sau thì phải bật `requestDetails` hoặc đọc log
trực tiếp khi đang chạy.

### 0.3 Cấu hình timeout / retry / fallback

Không có khoá nào tên `timeout`, `retry`, `attempt`, `max*` trong `settings`.
Chỉ có `comboStrategies` với `fallbackStrategy`:

| strategy | số combo |
|---|---|
| `round-robin` | 5 (`free-model`, `test-ollama`, `nvidia-models`, `9Router-Agent`, `9Router-Combo-1`) |
| `fallback` | 7 (`9Router-Coder-1..5`, `9Router-Agent-1`, `9Router-Agent-2`) |

**Một combo không có giới hạn số bước thử và không có giới hạn thời gian tổng.**
Mỗi bước là một lần gọi provider; combo 230 bước = tối đa 230 lần gọi nối tiếp.

### 0.4 Số bước thật

| combo | bước | duy nhất | provider |
|---|---|---|---|
| 9Router-Agent / -1 / -2 | 230 | 230 | 16 |
| 9Router-Coder-1 | 229 | 229 | 16 |
| 9Router-Coder-2..5 | 230 | 230 | 17 |
| 9Router-Dev | 230 | 230 | 16 |

Hợp của 9 combo = **231 bước duy nhất** (các combo gần như trùng nhau: 228–230
bước chung). Tổng số bước theo combo = 2069.

## M1 — `combos probe` (đã vào main qua PR #46)

Lệnh mới `routersync combos probe`, mặc định **dry-run** (không gọi mạng, chỉ in
số combo / bước / ước tính thời gian và nhắc `--yes-spend-tokens`).

Kết quả đo thật (`c32-probe-combo`, `c32-probe-step`, `c32-probe-step-pass2`):

### 1a. Mode combo (mỗi combo một request như client)

| combo | kết quả | header | tổng | usage |
|---|---|---|---|---|
| 9Router-Agent | OK | 57 112 ms | 57 114 ms | nvidia/z-ai/glm-5.3-flash |
| 9Router-Coder-5 | OK | 24 180 ms | 24 182 ms | nvidia/z-ai/glm-5.3-flash |
| 9Router-Coder-4 | OK | 79 686 ms | 79 690 ms | openrouter/baidu/ernie-5.5-flash-preview:free |
| 9Router-Coder-1 | OK | 94 274 ms | 94 275 ms | gemini/gemini-4-hydrogen |
| 9Router-Agent-1 | HANG-AFTER-USAGE | – | 120 026 ms | nvidia/z-ai/glm-5.3-flash |
| 9Router-Agent-2 | HANG-AFTER-USAGE | – | 120 017 ms | openrouter/nvidia/nemotron-3.5-super-vl:free |
| 9Router-Coder-2 | HANG-AFTER-USAGE | – | 120 027 ms | openrouter/baidu/ernie-5.5-flash-preview:free |
| 9Router-Coder-3 | HANG-AFTER-USAGE | – | 120 024 ms | gemini/gemini-4-hydrogen |

`HANG-AFTER-USAGE` = hết 120 s mà client chưa nhận được header, **nhưng**
`usageHistory` có dòng mới: router đã làm xong việc với provider mà không trả lời
cho client. 4/8 combo như vậy; 4 combo còn lại mất **24–94 giây** mới có header.

### 1b. Mode step (231 bước duy nhất, `max_tokens: 1`, hạn 20 s)

| lượt | OK | EOL-GONE | NO-PROVIDER | RATE-LIMITED | TIMEOUT | HANG | ERROR |
|---|---|---|---|---|---|---|---|
| pass1 | 26 | 26 | 28 | 9 | 3 | 1 | 138 |
| pass2 | 27 | 26 | 28 | 7 | 5 | 0 | 138 |

ERROR ở pass2: `http=404` ×110 (104 dòng `hf/*` + 6 dòng khác), `http=405` ×11
(`cohere/*`), `http=400` ×17 (`oc/*`).

Hai lượt cách nhau ~5 phút (hơn một phút), nên dùng để xét "lỗi cứng lặp lại".

## M2 — Đề xuất (chỉ báo cáo, không sửa router)

| nhóm | số bước | nghĩa |
|---|---|---|
| `okBoth` | 24 | chạy ok ở **cả hai** lượt |
| `hardTwice` | **54** | lỗi cứng giống nhau 2/2 lượt → **đề xuất gỡ** (cần chủ dự án xác nhận) |
| `softTwice` | **3** | `TIMEOUT-NO-HEADER` 2/2 lượt → **đề xuất đưa xuống cuối** |
| `inconclusive` | 145 | chưa kết luận (gồm 104 dòng `hf/*` 404, `oc/*` 400, `cohere/*` 405) |

`hardTwice` gồm 26 `EOL-GONE` (nvidia 18, cf 3, openrouter 4, oc 1) và 28
`NO-PROVIDER`. `softTwice`: `gemini/gemini-3.8-flash`,
`nvidia/google/gemma-4-31b-it`, `nvidia/meta/muse-glimmer-30b`.

Quy tắc cứng đã giữ: **không** đề xuất gỡ theo `ABSENT` / `UNVERIFIABLE` /
`NOT-LISTED-UPSTREAM` / `NOT-IN-CATALOG`. 104 dòng `hf/*` nằm ở `inconclusive`
đúng vì lý do đó: router không có bằng chứng khả dụng cho `hf`
(`UNVERIFIABLE`), còn upstream thì `LISTED-UPSTREAM` — gỡ ở đây là gỡ model đang
chạy được. Danh sách chi tiết 54 bước: xem `c32-probe-step.out.txt` và
`c32-probe-step-pass2.out.txt` (lọc `EOL-GONE` / `NO-PROVIDER`).

Không ghi gì vào DB hay cấu hình router.

## M3 — Đính chính nhãn "absent" — XONG

Bảng 9Router (provider × trạng thái router × kết luận official), từ
`combos stale --router 9router --source official --json`:

| provider | bước | ABSENT | PRESENT | UNVERIFIABLE |
|---|---|---|---|---|
| hf | 104 | 0 | 0 | **104** |
| nvidia | 30 | 19 | 11 | 0 |
| oc | 25 | 0 | 21 | 4 |
| openrouter | 16 | 1 | 15 | 0 |
| cohere | 11 | 0 | 11 | 0 |
| cf | 8 | 0 | 8 | 0 |
| gemini / google | 8 / 8 | 1 / 1 | 7 / 7 | 0 |
| groq | 6 | 2 | 4 | 0 |
| ocz | 5 | 0 | 4 | 1 |
| bzl / kc | 4 / 4 | 0 | 0 / 4 | 4 / 0 |
| <private-provider-2> | 7 | 0 | 0 | 7 |
| bai, ds, <private-provider-4>, <private-provider-3>, 1 node | 1 mỗi cái | 0 | 0/1 | 1/0 |

Official theo provider: `hf` → `LISTED-UPSTREAM` ×104; `nvidia` →
`NOT-IN-CATALOG` ×13 + `LISTED-IN-CATALOG` ×6; `openrouter` →
`NOT-LISTED-UPSTREAM` ×1; còn lại `NO-OFFICIAL-SOURCE`.

Đính chính: câu "hf 104/104 absent" của vòng trước là **sai**. Đúng ra 104 dòng
`hf` là `UNVERIFIABLE` phía router và `LISTED-UPSTREAM` phía upstream. "nvidia
19/30 absent" đúng về phía router nhưng phải đọc kèm 11 dòng PRESENT.

Chống đọc nhầm: `combos stale` giờ ghi thẳng vào `note` khi có dòng
`UNVERIFIABLE` — "không có bằng chứng khả dụng, **không** giống `ABSENT`, không
bao giờ là lý do xoá model". Có test.

## CI

| lần | sha | run | attempt | kết quả |
|---|---|---|---|---|
| PR #46 | 8d3b1d7 | 44948839596 | 1 | success |
| main | 9b10ee6 | 44949328202 | 1 | success |

`pnpm prepush` trên máy này bị cổng RAM chặn ở `test:related` (exit 3, RAM trống
1.20 GiB) — lint + typecheck xanh, bộ test đầy đủ do CI chạy.

## Trả lời ba câu hỏi

1. **Lỗi của chủ dự án nằm ở đâu?** Không nằm trong DB: `usageHistory` chỉ ghi
   thành công (7 ngày: 6974 ok, 0 lỗi), `requestDetails` ngừng ghi từ 2026-08-04,
   không có file log. "Log toàn lỗi" là bộ đệm RAM của dashboard. Lỗi thật đo
   được: **138/231 bước lỗi** (404 ×110, 405 ×11, 400 ×17), 26 EOL, 28
   no-provider.
2. **Combo thật mất bao lâu, bị chặn ở đâu?** Khi chạy được: **24–94 giây** tới
   header. 4/8 combo vượt 120 giây và rơi vào `HANG-AFTER-USAGE`: upstream đã
   trả lời (có dòng `usageHistory`) nhưng client không nhận được gì.
3. **Đề xuất gỡ / chưa kết luận?** **54** bước lỗi cứng 2/2 lượt (đề xuất gỡ,
   chờ xác nhận), **3** bước nên đưa xuống cuối, **145** bước chưa kết luận
   (trong đó 104 dòng `hf` — không được gỡ).

## Giới hạn

- Không khởi động lại / dừng 9Router; số đo là ảnh chụp tại thời điểm chạy.
- `HANG-AFTER-USAGE` là hiện tượng chưa được giải thích ở tầng 9Router; vòng này
  chỉ đo và ghi nhận.
- Không dòng nào bị gỡ; việc gỡ (nếu có) thuộc chủ dự án.