# Evidence C31 — OmniRoute reader, private-name floor, CI handbook

- Build checked: `origin/main` = **4c5bc62** (PR #45). Previous: 85f4be3 (C30), 8c3f529.
- Branch `evidence/c31`, `[skip ci]`, no PR. 9 files.
- Records: 3 (stale table on 4c5bc62, host check, CI watch of 44934613387).

## L0 — 4 so với 7 — XONG

Nguồn danh sách tên riêng mà `capture.mjs` chuẩn đọc:
`.agent/private-names.local.json` (hoặc `RS_PRIVATE_NAMES`), do
`tools/agent/private-names.mjs` ghi ra từ guard
(`~/.routersync/providers.local.yaml`: 17 dòng, 9 cổng; 4 cổng riêng sau khi loại
mã công khai).

Vì sao 7 → 4:

| quan sát | số |
|---|---|
| dòng trong registry cục bộ | 17 |
| cổng trong registry | 9 |
| mã công khai đã biết | 158 |
| riêng theo guard | 4 |

Bản ghi C24–C27 `privateNamesLoaded: 7` là của `capture.mjs` do agent tự viết
(không còn trong cây làm việc). 7 không tái tạo được từ registry hiện hành. Ba mã
còn lại:

- xuất hiện nguyên văn trong `tools/guard/local-provider-names.mjs` và
  `test/no-secrets-guard.test.mjs`, tức là chuỗi công khai của repo — che chúng chỉ
  làm bằng chứng khó đọc;
- không che thêm gì trong thực tế: C27 che đúng 27 chỗ, C30 (danh sách 4) cũng che
  đúng 27 chỗ.

Chống tái diễn (không sửa `capture.mjs` chuẩn):

- `tools/agent/capture-evidence.mjs`: nạp danh sách hiện hành, truyền
  `RS_PRIVATE_NAMES`, chạy `capture.mjs` chuẩn, rồi bắt buộc
  `masked.privateNamesLoaded` = số tên; lệch → thoát 1.
- `verify-package.mjs` có floor: mặc định = số tên hiệu dụng
  (`tools/agent/private-names.mjs`), hoặc `--min-private-names <n>`.
- Test `test/agent/evidence-private-names.node.test.mjs`: danh sách giả 7 tên, bản
  ghi nạp 4 → đỏ; mutation bỏ floor → xanh (chứng minh floor là thứ chặn).

Quét lại bằng danh sách đầy đủ (`tools/agent/scan-private-names.mjs`, 4 tên):

| nơi | khớp |
|---|---|
| origin/main | 0 |
| evidence/c25, c26, c27, c28, c30 | 0 |
| PR #40–#45 (title + body + comments) | 0 |
| log CI PR #43 | 0 |

## L1 — OmniRoute reader — XONG

Bộ đọc nằm trong `packages/core/src/domain/model-state.ts` (cùng khuôn 9Router,
cùng `locateRouterDb`, mở `readOnly`, không ghi, không tạo file):

| nguồn | namespace / bảng | dùng cho |
|---|---|---|
| `syncedAvailableModels` | khoá `<provider>:<connectionId>` → mảng model | PRESENT |
| `customModels` | provider → mảng model (`isHidden` → DISABLED) | PRESENT / DISABLED |
| `modelAliases` | alias → `provider/model` | PRESENT |
| `radar_local_model_state` | `enabled=0` hoặc `tombstoned=1` | DISABLED |

`combos-stale.ts` không còn loại `omniroute`; `omittedRouters` rỗng.
Bước combo của OmniRoute là object `{ model, providerId }` nên parser combo đã mở
rộng (9Router vẫn nhận chuỗi `provider/model`).

Quy tắc trạng thái: provider không có bằng chứng → `UNVERIFIABLE`; có bằng chứng
mà thiếu id → `ABSENT`; id bị tắt → `DISABLED`; id đầy đủ `vendor/model` khớp
theo đoạn cuối → `PRESENT-NORMALIZED` (chỉ OmniRoute). Không xoá gì.

Kết quả trên DB OmniRoute thật (chỉ đọc, bản ghi `c31-stale-official`):

| router | trạng thái | số dòng |
|---|---|---|
| 9router | UNVERIFIABLE | 123 |
| 9router | PRESENT | 94 |
| 9router | ABSENT | 24 |
| omniroute | PRESENT-NORMALIZED | 118 |
| omniroute | ABSENT | 126 |
| omniroute | UNVERIFIABLE | 16 |
| omniroute | PRESENT | 2 |

`routers = ["9router","omniroute"]`, `omittedRouters = []`, `status = OK`.
Với `--source official`, các dòng ABSENT/UNVERIFIABLE của omniroute có kết luận:
`NOT-LISTED-UPSTREAM` 18, `NOT-IN-CATALOG` 12, `NO-OFFICIAL-SOURCE` 112.

Test `packages/cli/test/combos-stale-omniroute.test.ts` (DB tạm, không chạm DB
thật): PRESENT, PRESENT-NORMALIZED, DISABLED, ABSENT, UNVERIFIABLE; thiếu bảng
`key_value` → `missingTables` nêu tên và mọi dòng là UNVERIFIABLE; DB không đọc
được → không bao giờ ABSENT; mutation DISABLED → PRESENT làm test đỏ.

## L2 — docs/CI.md — XONG

Một trang: bộ công cụ, mã thoát `ci-watch` (0/10/11/12), luật phân loại hạ tầng /
mã, khi nào được rerun, nền xanh lần đầu in từ `ci-stats` (17/22 push main,
39/50 commit của mình), việc cần làm khi main đỏ, lỗi e2e còn treo, và §9 quy
trình trả bằng chứng. `test/agent/ci-doc.node.test.mjs` ghim sự tồn tại và tên các
công cụ.

## L3 — trả bằng chứng qua GitHub — XONG

- Nhánh này chứa `NOTE.md` = nguyên văn tóm tắt cuối trong chat, cộng `REPORT.md`,
  `records.jsonl`, 3 cặp `*.out.txt` / `*.err.txt` → 9 tệp.
- `[skip ci]`; `gh run list --branch evidence/c31` rỗng; 0 khớp tên riêng.
- `AGENTS.md` và `docs/CI.md` §9 ghi quy trình.

## CI

| lần | PR / commit | run | attempt | kết quả |
|---|---|---|---|---|
| PR #45 | `2ef1b20` | 44934613387 (head) | 1 | success |
| main | `4c5bc62` | 44934613387 | 1 | success |

`ci-watch` trả 0 (không rerun). Ghi chú: `ci-watch --sha 2ef1b20` trả `NO-RUN`
vì sha ngắn; dùng sha đủ 40 ký tự hoặc `--run <id>`.

## Giới hạn

- `ABSENT` của OmniRoute chỉ nói "không thấy ở trạng thái router", không phải
  phán quyết upstream; không xoá model theo ABSENT.
- `snapshot` cho OmniRoute giống `direct` (RouterSync không có registry riêng của
  OmniRoute).
- Lỗi e2e `44788053023` attempt 1 vẫn treo, chỉ theo dõi.