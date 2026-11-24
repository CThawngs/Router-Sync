# M4 (`P6`, `P7`) & `W4` — Tóm tắt Bàn giao (`<= 40` dòng)

- **Trạng thái vé:**
  - `M4-01` (`P6` — Nhất quán tài liệu, hướng dẫn người dùng mới 4 bước chỉ đọc trên 9Router & OmniRoute, test CLI fixture tự động): **XONG**.
  - `M4-02` (`P7` — Kiểm toán bảo mật 5 bề mặt `main` / `evidence/*` / log CI / tarball / cổng ghi router + `SECURITY.md`): **XONG**.
  - `W-02` (`W4` — Cập nhật `docs/9router-combo-findings.md` mục `0.5.123`, sửa chiều `826 < 2 900`, bỏ ngoại suy, gắn nhãn `chưa phân biệt`): **XONG**.
- **Bốn bằng chứng RACI:**
  - PR gộp: `https://github.com/CThawngs/Router-Sync/pull/69` (`feat/m4-docs-security-and-w4`, HEAD `ddb6219`), PR CI Run `45315408557` (`18/18` xanh `attempt=1`).
  - Biên bản QA độc lập (`7/7` đột biến bị bắt: `M1..M4` + `Q1..Q3`): `https://github.com/CThawngs/Router-Sync/pull/69#issuecomment-7120782660`.
  - Merge SHA trên `main`: `2ea12c44abae747d466a3b81a5f67eaec68dc87d` (`2ea12c4`).
  - Push CI `main` lần 1: Run `45317752224` (`18/18` xanh, `attempt=1`, chuỗi `main` xanh liên tiếp = `5` từ `bc61436` tới `2ea12c4`).
- **Số liệu `đo được` trong `evidence/M4`:**
  - `m4-p6-docs-suites.out.txt`: `2/2` bộ test tài liệu & CLI fixture smoke (`26/26` bài kiểm thử PASS, `0` kết nối tới cổng router thật).
  - `m4-p7-security-audit.out.txt`: Quét `650` tệp `main`, `6` nhánh `evidence/*` (`759` blobs), `8` tarball công bố, `4` lượt log CI công khai gần nhất, và `12/12` bài kiểm tra từ chối của 3 cổng ghi router (`grant`, `approval-token`, `--yes-write-router`) → **`high=0`, `medium=0`, `low=0`** (`ok=true`).
  - `m4-ci-stats.out.txt`: `push on main green first attempt: 29/33`, `consecutive green first attempt: 5`, `our commits green first attempt: 67/77 (87%)`.
