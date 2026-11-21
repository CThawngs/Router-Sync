# CI — sổ tay cho người và cho agent

Bộ công cụ, mã thoát, luật phân loại và ngưỡng nền hiện tại. Không lặp lại
`AGENTS.md`; đọc nó trước, trang này chỉ nói về CI.

## 1. Bộ công cụ

| Công cụ | Việc |
|---|---|
| `pnpm prepush` | Cổng trước khi đẩy: `lint` → `typecheck:changed` → `test:related` (qua cổng RAM) → `validate-workflows`. |
| `tools/agent/ci-watch.mjs` | Chờ một run và phân loại lỗi. Không tự rerun, không tự merge. |
| `tools/agent/ci-stats.mjs` | Tỷ lệ xanh lần đầu, danh sách đỏ, phân loại hạ tầng/mã. |
| `.github/workflows/flake-hunt.yml` | Lặp lại một test N lần trên một OS để săn flake (`workflow_dispatch`). |
| `tools/hooks/pre-commit` | Chặn commit trực tiếp trên `main` cục bộ. |
| `tools/hooks/pre-push` | Chạy `prepush` + `tools/guard/no-force-push.mjs` (chặn đẩy non-fast-forward). |
| `tools/guard/no-secrets.mjs`, `no-personal-paths.mjs`, `no-evidence-in-main.mjs`, `no-force-push.mjs` | Các guard trong `pnpm lint` và pre-push. |
| `tools/agent/capture-evidence.mjs` | Lớp bọc `capture.mjs` chuẩn: nạp danh sách tên riêng rồi ghi bản ghi có `sha256`. |
| `tools/agent/verify-records.mjs`, `verify-package.mjs` | Kiểm gói bằng chứng. Xem §6. |
| `tools/agent/scan-private-names.mjs` | Đếm (không in) số lần tên riêng xuất hiện ở một ref. |

## 2. `ci-watch.mjs`: mã thoát

| Mã | Nghĩa | Việc phải làm |
|---|---|---|
| `0` | Xanh | Chờ run trên `main` sau merge, rồi báo. |
| `10` | Chỉ lỗi hạ tầng | `gh run rerun <id> --failed` **một lần** cho mỗi head, ghi bằng chứng vào PR. |
| `11` | Có lỗi mã | Sửa nguyên nhân. **Không** rerun. |
| `12` | Hết giờ chờ, không thấy run, hoặc lỗi không phân loại được | Kiểm `gh run list`, xem lại sha, đừng đoán. |

`--sha` chọn commit; `--run <id>` ghim đúng run; `--workflow <name>` (mặc định
`CI`) chọn đúng workflow khi một sha có nhiều run (dependabot, flake-hunt).

## 3. Phân loại hạ tầng / mã

`ci-watch` đọc log job đỏ và khớp mẫu hạ tầng đã biết (`cache-service`,
`services-down`, `runner-shutdown`, `artifact-create`, `capacity`,
`network-reset`, `operation-canceled`). Job `continue-on-error` (ví dụ
`windows-11-arm`) được báo là `masked`, không tính là mã.

- Chỉ hạ tầng → rerun một lần, tối đa.
- Có mã → sửa, không rerun.
- Không đọc được log → `unknown` → mã `12`, xử lý bằng tay.

## 4. Khi nào được rerun

Chỉ khi `ci-watch` trả `10` và bằng chứng là hạ tầng. Một lần cho mỗi head. Đỏ
lại cùng chỗ, hoặc `11` → sửa nguyên nhân; rerun để lấy màu xanh là chặn.

## 5. Tỷ lệ xanh lần đầu (`ci-stats`)

Số in trực tiếp từ script, không gõ tay:

```
node tools/agent/ci-stats.mjs
```

Nền hiện tại (khi viết trang này):

| Chỉ số | Giá trị |
|---|---|
| Cửa sổ | 100 run gần nhất, từ 2026-11-17 |
| `push` trên `main` xanh lần đầu | 17/22 |
| Commit của mình xanh lần đầu | 39/50 (78%) |
| Chạy dependabot (tách riêng) | 38 |
| Đỏ của mình | code=2, infra=0, unknown=6 |

Dùng con số của lần chạy gần nhất, đừng dùng bảng này làm hằng số.

## 6. Gói bằng chứng

- `capture.mjs` chuẩn (`2f2768cf…`) ghi `records.jsonl` + `*.out.txt` + `*.err.txt`;
  sha256 của cả hai luồng nằm trong bản ghi.
- `verify-records.mjs` chuẩn (`7b310d90…`) kiểm sha256, số byte, thời gian và
  `masked.privateNamesLoaded`.
- `verify-package.mjs` là lớp thêm: bản ghi giả, lệnh không chạy được, và
  `privateNamesLoaded` nhỏ hơn số tên hiệu dụng (`tools/agent/private-names.mjs`).
- Cả hai phải xanh trước khi đẩy gói.

## 7. Khi `main` đỏ

1. `node tools/agent/ci-watch.mjs --sha <sha>` để biết mã hay hạ tầng.
2. Mã `11` → đọc log, sửa, mở PR. Không rerun.
3. Mã `10` → rerun một lần, ghi bằng chứng vào PR; đỏ lại thì sửa.
4. Sau merge: chờ run trên `main`, báo kết luận ở **lần chạy 1**.

## 8. Lỗi e2e còn treo

Run `44788053023` attempt 1: `verify (ubuntu-24.04-arm, node 22)` đỏ tại
`e2e.test.ts:470` (daemon không trả lời health sau 20 s). Run có `pnpm build`,
khác với các lần đỏ của flake-hunt (thiếu `dist`). Chưa giải thích, chưa tái
hiện.

Theo dõi: khi `e2e.test.ts` đỏ ở lần 1 của một run `main` mà `flake-hunt` vẫn
`red=0`, đó là tín hiệu của lỗi này, không phải nhiễu.

## 9. Quy trình trả bằng chứng qua GitHub

Chủ dự án thường ở xa máy. Gói bằng chứng đi theo nhánh, không theo tệp đính
kèm:

1. Nhánh `evidence/c<N>` chứa `REPORT.md`, `NOTE.md`, `records.jsonl`,
   `*.out.txt`, `*.err.txt` — tối đa 10 tệp.
2. `NOTE.md` là nguyên văn tóm tắt cuối mà agent báo trong chat: trạng thái từng
   mục, PR và sha merge, kết luận run `main` ở lần 1, tên nhánh và sha.
3. Tin nhắn cuối trong chat chỉ cần trỏ tới tên nhánh và sha.
4. Quy tắc: `[skip ci]`, không PR, không merge, quét tên riêng = 0 khớp,
   `gh run list --branch evidence/c<N>` rỗng.

Người duyệt đọc bằng `git fetch` + `git show evidence/c<N>:evidence/C<N>/NOTE.md`;
không cần `.agent/send-final/` trên máy agent.