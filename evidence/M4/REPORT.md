# Báo cáo Gói Bằng chứng Milestone M4 (`P6` Nhất quán Tài liệu & `P7` Kiểm toán Bảo mật + `W4`)

- **Nhánh bằng chứng:** `evidence/m4` (`evidence/M4/`, `9` tệp `<= 10`)
- **Commit `main` neo:** [`2ea12c44abae747d466a3b81a5f67eaec68dc87d`](https://github.com/CThawngs/Router-Sync/commit/2ea12c44abae747d466a3b81a5f67eaec68dc87d) (`2ea12c4`)
- **PR gộp (`M4-01` + `M4-02` + `W-02`):** [PR #69](https://github.com/CThawngs/Router-Sync/pull/69) (`feat/m4-docs-security-and-w4`)

## 1. Bảng RACI 4 Bằng chứng cho Milestone M4 & `W-02`

| Vé | PR | PR HEAD SHA & PR CI (`attempt=1`) | Biên bản QA Độc lập (Đột biến) | Merge SHA trên `main` | Push CI `main` (`attempt=1`) | Chuỗi `main` xanh liên tiếp | Trạng thái |
|---|---|---|---|---|---|---|---|
| **M4-01 (`P6`) + M4-02 (`P7`) + W-02 (`W4`)** | [PR #69](https://github.com/CThawngs/Router-Sync/pull/69) | `ddb6219` ([Run 45315408557](https://github.com/CThawngs/Router-Sync/actions/runs/45315408557)) — `18/18` GREEN | [Comment #7120782660](https://github.com/CThawngs/Router-Sync/pull/69#issuecomment-7120782660) (`M1..M4` + `Q1..Q3`: `7/7` bị bắt) | [`2ea12c4`](https://github.com/CThawngs/Router-Sync/commit/2ea12c44abae747d466a3b81a5f67eaec68dc87d) | [Run 45317752224](https://github.com/CThawngs/Router-Sync/actions/runs/45317752224) — `18/18` GREEN (`attempt=1`) | **`5`** (`firstSha=bc61436 lastSha=2ea12c4`) | **XONG** |

## 2. Kết quả `M4-01` (`P6` — Nhất quán Tài liệu, Hướng dẫn Người mới & Smoke Fixture CLI)

- **đo được** (`evidence/M4/m4-p6-docs-suites.out.txt`): `test/docs/agent-docs.test.ts` (`19/19` passed) và `test/docs/9router-combo-findings.test.ts` (`7/7` passed) — tổng **`26/26` bài kiểm thử xanh**.
- **đo được**:
  - `docs/SETUP.md` & `README.md` (song ngữ Anh – Việt) đã đồng bộ yêu cầu `Node.js >= 22.12.0`, `pnpm >= 10.0.0`, cài hook qua `pnpm hooks:install`, và bổ sung quy trình Quickstart 4 bước chỉ đọc cho người dùng mới (`install` + build → `doctor` / `doctor --json` → `combos stale --router 9router` & `--router omniroute` → chạy thử chỉ đọc `scan` / `status` / `plan` / `verify` với `0` lệnh ghi router).
  - `docs/CI.md` (`144` dòng `< 400`), `docs/ROADMAP.md`, `docs/known-issues.md` (bổ sung Issue #3 về `stream=true` thiếu `usageHistory` trên `9router@0.5.123` đã khắc phục phía client ở `W2`), `docs/combos-probe.md` (`--mode step` `max_tokens=8`, `--concurrency <1|2>`, `reconcileSentVsUsage`) khớp mã nguồn và đầu ra công cụ.
  - Bài kiểm thử tích hợp trong `test/docs/agent-docs.test.ts` dựng fixture cô lập trong `os.tmpdir()` (`http://127.0.0.1:9`, `0` chạm cổng `20128`/`30128`/`3128`) và chạy thật CLI `--help`, `doctor --help`, `combos stale --help`, `doctor --json`, `combos stale --router 9router`, `combos stale --router omniroute`, `verify` đều thoát mã `0`.

## 3. Kết quả `M4-02` (`P7` — Kiểm toán Bảo mật 5 Bề mặt, Cổng Ghi Router & `SECURITY.md`)

Nguồn **đo được** (`evidence/M4/m4-p7-security-audit.out.txt`, chạy `node tools/agent/security-audit.mjs --with-ci-logs` trên `2ea12c4`):

| Bề mặt kiểm toán | Quy mô đã quét | Phát hiện (`HIGH` / `MEDIUM` / `LOW`) | Kết quả |
|---|---|---|---|
| `repo-files` (`main` tracked files) | `650` tệp | `0 / 0 / 0` | `ok=true` |
| `evidence-refs` (các nhánh `evidence/*`) | `6` nhánh / `759` git blobs | `0 / 0 / 0` | `ok=true` |
| `tarballs` (đóng gói mới 8 gói `@routersync/*`) | `8` tarball | `0 / 0 / 0` | `ok=true` |
| `ci-logs` (log CI công khai gần nhất) | `4` workflow runs | `0 / 0 / 0` | `ok=true` |
| `write-gates` (`grant`, `approval-token`, `--yes-write-router`) | `12/12` ca kiểm từ chối | `0 / 0 / 0` | `ok=true` |
| **Tổng kết (`SEC_AUDIT_SUMMARY`)** | **Đủ 5 bề mặt** | **`high=0 medium=0 low=0`** | **`ok=true` (`exit=0`)** |

- **đo được**: `SECURITY.md` quy định rõ phạm vi chỉ đọc mặc định của `v0.1`, biên tin cậy, 4 cơ chế ghi có người duyệt, danh sách 5 nhóm dữ liệu nhạy cảm mà RouterSync **không bao giờ ghi ra đĩa**, và kênh báo lỗi bảo mật riêng tư (SLA 48 giờ). Chi tiết 7 đột biến bị tiêu diệt (`M1..M4` + `Q1..Q3`, kiểm chứng Zero-Leak không in chuỗi bí mật giả ra stdout/stderr/JSON) lưu tại [Comment #7120782660](https://github.com/CThawngs/Router-Sync/pull/69#issuecomment-7120782660).

## 4. Tóm tắt `W-02` (`W4`) & `m4-ci-stats`

- **đo được**: `docs/9router-combo-findings.md` cập nhật dải `C32–C44`, giữ nguyên `"không tái hiện trong 18 mẫu"` (`0` chữ `"đã sửa"`), gắn nhãn `chưa phân biệt` cho cả 4 ứng viên C44 §1.1, sửa chiều so sánh `826` nhỏ hơn `2 900`, xóa ngoại suy `~15 000+` (`0` lần `14 868`), và bổ sung mục `## 8.` ghi nhận đầy đủ `W1`, `W2`, `W3`, `W5` trên `9router@0.5.123`.
- **đo được** (`m4-ci-stats.out.txt`): `push on main (CI workflow) green first attempt: 29/33`, `push on main consecutive green first attempt: 5 (firstSha=bc61436 lastSha=2ea12c4)`, `our commits green first attempt: 67/77 (87%)`.

## 5. Danh mục Bản ghi trong `evidence/M4/records.jsonl`

1. `m4-p6-docs-suites`: `pnpm test:file test/docs/agent-docs.test.ts test/docs/9router-combo-findings.test.ts` (`exit=0`)
2. `m4-p7-security-audit`: `node tools/agent/security-audit.mjs --with-ci-logs` (`exit=0`)
3. `m4-ci-stats`: `node tools/agent/ci-stats.mjs` (`exit=0`)
