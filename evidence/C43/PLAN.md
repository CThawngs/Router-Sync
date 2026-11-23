# PLAN.md — Kế hoạch Chương trình RouterSync v0.1 RC (Cập nhật C43 mục 3.1 & mục 1 trước khi giao vé)

- **Chương trình:** C42 / C43 — Hiến chương & Quyết định mở thực thi M1, M2 và Track R cho RouterSync v0.1 Release Candidate
- **Đồng lập & phê duyệt nội bộ:** CEO (hiệu đính C43 mục 0.5, 0.8, 1, 2, 3.1 trước khi giao vé), Product Manager (PMO Lead), COO, CTO
- **Mốc nền tham chiếu:** nhánh `main`, commit `c28b7fb` (PR `#56`); bản ghi chuẩn `m0-ci-stats` trong `evidence/c42` (`1d921e5`).
- **Quy ước nguồn gốc con số (C43 mục 2):** Mỗi con số trong tài liệu này đều ghi nhãn `đo được (<tên-bản-ghi trong records.jsonl>)`, `suy luận`, `chưa biết`, hoặc `chưa kiểm` (khi con số chưa xuất phát từ đầu ra đã đi qua `capture-evidence.mjs` trong `records.jsonl`).

---

## 0. Ghi nhận Quyết định C43 (Mục 1) & Giải trình Mã nguồn Mục 0.8

- **Quyết định cổng C43 (trả lời `OQ-01` đến `OQ-08`):**
  - `OQ-01`: Duyệt có điều kiện — mở thực thi **Track M (`M1` rồi `M2`, tổng `6` vé — `suy luận`)** và **Track R (`R0`, `R1`, `R2` chạy song song, không chặn `M1`)**. Các cột mốc **`M3`, `M4`, `M5` chưa mở**; chờ người duyệt độc lập đọc `evidence/m1` và `evidence/m2`.
  - `OQ-02`: Giữ toàn đội bot trên kênh **Sub** hiện tại, tối đa **`2` bot gọi LLM đồng thời** (`suy luận`), xuyên suốt `M1–M2`. Chỉ chuyển sang 9Router khi Track R hoàn tất và `rs-fast` đã được chủ dự án tạo & đo.
  - `OQ-03`: Tạo `rs-fast` (Fallback) trên dashboard thuộc chủ dự án; nếu `rs-fast` đã có trong DB thì `R1.4` đo thêm `18` request (`suy luận`), nếu chưa có thì ghi `chưa đo` và không dừng chờ.
  - `OQ-04`, `OQ-06`, `OQ-08`: Việc của chủ dự án, không chặn `M1–M2`. `OQ-05`: `npm publish` do chủ dự án tự chạy ở `M5`. `OQ-07`: giữ nguyên **`17` mục ngoài phạm vi** (`suy luận`), không thêm mục mới vào `P1–P7`.
- **Mục 0.8 — Chỉ dẫn chính xác vị trí mã quy định `privateNamesLoaded=12` so với `4` tên riêng hiệu lực:**
  - Hàm `maskNames()` tại `tools/agent/capture-evidence.mjs` dòng `39–58` khởi tạo `Set` từ `effectivePrivateNames()` (`4` mục hiệu lực từ `tools/agent/private-names.mjs` dòng `55–57` — `đo được: evidence/c42 m0-ci-stats`) rồi cộng thêm mảng `extra` gồm `8` biến thể chuỗi đường dẫn có độ dài `> 8` tại `tools/agent/capture-evidence.mjs` dòng `45–54` thành tổng `12` mục (`4 + 8 = 12` — `đo được: evidence/c42 m0-ci-stats`), truyền qua `RS_PRIVATE_NAMES` ở dòng `67` và bắt buộc `loaded === names.length` tại dòng `93–99` (trong khi kiểm tra sàn tối thiểu `>= 4` nằm ở `tools/agent/private-names.mjs` dòng `106–120` và `test/agent/evidence-private-names.node.test.mjs` dòng `30–59`).

---

## 1. Phạm vi cuối cùng của RouterSync v0.1 RC (P1–P7, giữ nguyên `7` hạng mục — `suy luận`)

| Hạng mục | Quyết định phạm vi | Cơ sở đối chiếu & Nguồn gốc số liệu | Ranh giới khóa chặt cho v0.1 RC |
|---|---|---|---|
| **P1 — Sức khỏe CI** | **Giữ nguyên** | Trong cửa sổ từ `2026-11-17`: `runs=100`, `uniqueSha=65`, `push` trên `main` xanh lần đầu **`23/27`**, commit của đội xanh lần đầu **`53/65 (82%)`**, `pending=0`, `dependabot=23`, run đỏ của đội `code=4, infra=0, unknown=5` (tất cả đều `đo được: evidence/c42 m0-ci-stats`). Con số chuỗi merge xanh lần `1` liên tiếp chưa được `m0-ci-stats` in ra nên ở thời điểm M0 ghi là **`chưa kiểm`** (C43 mục 0.5 & 3.2: `M1-01` bổ sung tính & in trực tiếp chuỗi `push` liên tiếp xanh ở lần `1` kèm `sha` đầu/cuối trong `ci-stats.mjs`, và `docs/CI.md` chỉ ghi con số do công cụ in ra). | Duy trì tối thiểu **`10` lần merge liên tiếp vào `main` xanh ở `attempt=1`** (`suy luận` tiêu chí P1, đo bằng `ci-stats.mjs` sau nâng cấp `M1-01`); thêm cảnh báo tự động `E2E-DAEMON-HEALTH-SIGNAL` có test, khử cảnh báo `[DEP0190]` trên Windows; merge chỉ khi xanh đủ **`5` hệ điều hành** (`suy luận` ma trận CI) trên head cuối. Nếu CI `main` đỏ ở lần `1` sau merge thì dừng toàn bộ và báo ngay (C43 mục 2). |
| **P2 — Known issues 1 & 2** | **Giữ nguyên** | Đối chiếu mã nguồn tại `c28b7fb`: (1) `packages/core/src/domain/model-state.ts` nhánh `isOmniRoute` chưa hợp nhất `comboModels` vào `availableModels` khi `!options.excludeComboModelsFromAvailability`, và `packages/cli/src/apps/drift.ts` mới xét `view.comboIds` cho OmniRoute; (2) `classifyModelDrift` trong `apps/drift.ts` chưa đối chiếu `view.comboNames`, làm tên combo bị rơi xuống `MISSING`. | Sửa đủ `2` lỗi (`M1-02`, `M1-03`) với test **đỏ trước – xanh sau** trên fixture DB giả lập; giữ nguyên bất biến `combos stale`; cập nhật `docs/known-issues.md`; `0` tác động lên DB router thật (`suy luận`). |
| **P3 — Phase 3 S2** | **Giữ nguyên** | Đối chiếu mã thực tế: (1) `maintain/grant.ts` & `commands/maintain.ts` đã có `4` lệnh vòng đời grant (`suy luận` đếm lệnh mã nguồn) nhưng `ADR-MAINTAIN-02` còn trỏ tới `tools/maintain/test-apply-grant.mjs` không tồn tại; (2) webhook ở `commands/tick.ts` mới có `12` dòng gửi thô (`chưa kiểm` — đếm dòng mã ngoài capture) và `0` bài test; (3) `commands/maintain.ts` in cứng `READBACK ok=yes` khi mới đọc SQLite DB. | Thực thi tuần tự `M2-01..03` sau khi `evidence/m1` đã `SẠCH` và CI `main` xanh lần `1` (C43 mục 3.3): dùng `100%` máy chủ giả & DB giả trong `os.tmpdir()`; chỉ được in `READBACK ok=yes` khi đọc lại đường phục vụ HTTP thành công, nếu chỉ đọc DB phải in `READBACK db-only`. |
| **P4 — Đóng gói tarball 5 OS** | **Giữ nguyên (Chờ mở M3)** | Đóng gói và cài đặt từ tarball chạy xanh trong CI trên đủ **`5` hệ điều hành** (`suy luận` tiêu chí P4). | Thuộc cột mốc `M3` (chưa mở ở C43); việc `npm publish` thuộc chủ dự án tại `M5` (`OQ-05`). |
| **P5 — Tài nguyên thấp & ADR SQLite** | **Giữ nguyên (Chờ mở M3)** | Đo lặp khởi động lạnh & bộ nhớ rảnh kèm phương sai qua `capture-evidence.mjs` (hiện phương sai ở nhánh RC là `chưa biết`) và lập ADR `better-sqlite3` vs `node:sqlite`. | Thuộc cột mốc `M3` (chưa mở ở C43); tuyệt đối không thay đổi hành vi sản phẩm. |
| **P6 — Tài liệu nhất quán** | **Giữ nguyên (Chờ mở M4)** | Đồng bộ `README.md`, `docs/SETUP.md`, `docs/WORKFLOW.md`, `docs/CI.md`, `docs/ROADMAP.md`, `docs/known-issues.md`. | Thuộc cột mốc `M4` (chưa mở ở C43; riêng `docs/CI.md`, `docs/known-issues.md`, `ADR-MAINTAIN-02`, `docs/ROADMAP.md` mục S2 và `docs/9router-combo-findings.md` cập nhật đúng phần thuộc `M1`, `M2`, `Track R`). |
| **P7 — Bảo mật sạch kho, bằng chứng & log CI** | **Giữ nguyên (Xuyên suốt & chốt ở M4)** | Quét khóa, tên riêng, đường dẫn cá nhân đạt `0` khớp (`suy luận` ngưỡng bắt buộc) trên mọi nhánh bằng chứng; tổng kiểm toán cuối tại `M4`. | Duy trì ở mọi PR và mọi gói `evidence/c43`, `evidence/m1`, `evidence/m2`; tổng kiểm toán toàn chương trình ở `M4` khi được mở. |

---

## 2. Danh sách `17` hạng mục NGOÀI PHẠM VI (`suy luận` theo quyết định `OQ-07` — Gắn nhãn `"chờ chủ dự án"`)

Giữ nguyên toàn bộ `17` hạng mục ngoài phạm vi đã khóa ở C42, không tự mở rộng:
1. Kiểm thử trên máy macOS và Linux vật lý — **chờ chủ dự án**.
2. Phát hành lên npm công khai (`npm publish` & tag release tại `M5`) — **chờ chủ dự án** (`OQ-05`).
3. `G5` — Giao diện web đọc trạng thái đầy đủ — **chờ chủ dự án**.
4. `G6` — BYOK Encrypted Key Bypass (`ROUTERSYNC_KEY_<PREFIX>`) — **chờ chủ dự án**.
5. Chế độ `auto-safe` & tự động failover có khóa ghi phần cứng — **chờ chủ dự án**.
6. Các cầu nối harness của Phase 5 — **chờ chủ dự án**.
7. Ghi vào router thật / sửa cấu hình app / dừng hoặc khởi động lại 9Router / áp hoặc gỡ bản vá router (`RS_OWNER_CONFIRMED=chạy`) / tạo `rs-fast` trên dashboard (`OQ-03`) / kiểm tra `huggingface`, `opencode`, `cohere` (`OQ-04`) / dời kho khỏi thư mục đồng bộ (`OQ-08`) — **chờ chủ dự án**.
8. Lịch BYOK cấu hình qua giao diện web — **chờ chủ dự án**.
9. Hợp nhất nguồn catalog giữa `scan` và `tick` — **chờ chủ dự án**.
10. Chuẩn hóa định dạng ngày trong nguồn L3 (`gemini-deprecations`, `openrouter-changelog`) — **chờ chủ dự án**.
11. Phủ test chính thức cho `routersync undo` — **chờ chủ dự án**.
12. Lọc đề xuất `NEW-CANDIDATE` trong `tick` theo nhãn `QUOTA` / `SẮP-NGỪNG` — **chờ chủ dự án**.
13. Đo tỷ lệ lỗi `7` ngày của 9Router — **chờ chủ dự án**.
14. Kiểm chứng đường dẫn DB 9Router trên macOS/Linux vật lý — **chờ chủ dự án**.
15. Gộp hai thư mục trạng thái riêng của `sync` và `tick` — **chờ chủ dự án**.
16. Mở rộng bảo vệ HTTP trong scanner nhà cung cấp ngoài cơ chế hiện có — **chờ chủ dự án**.
17. Nhóm `K8` ("Repo tự mô tả cho AI Agent") — **chờ chủ dự án**.

---

## 3. Lộ trình Cột mốc M1–M5, Track R & Ước tính Nỗ lực

> **Lưu ý nguồn gốc ước tính:** Vận tốc thực tế của chuỗi `CTO → Engineer → QA (checkout sạch + mutation riêng) → Ops` trước khi mở PR đầu tiên đang là **`chưa biết`**; các khoảng request LLM và số phiên dưới đây đều là **`suy luận`** kế hoạch ban đầu để quản trị hạn mức.

| Cột mốc / Track | Trạng thái cổng tại C43 (`OQ-01`) | Phạm vi & Yêu cầu bổ sung C43 | Gói bằng chứng (`<= 10` tệp — `suy luận`) | Ước tính Request Sub / 9Router (`suy luận`) | Số phiên dự kiến (`suy luận`) | Độ không chắc (`suy luận`) |
|---|---|---|---|---|---|---|
| **M1** | **ĐANG MỞ** | Tuần tự `M1-01` (thêm in chuỗi `push` `main` xanh lần `1` liên tiếp + `sha` đầu/cuối trong `ci-stats.mjs`, cảnh báo `E2E-DAEMON-HEALTH-SIGNAL`, `docs/CI.md` chỉ ghi số do tool in), `M1-02` (`isOmniRoute` `comboModels`), `M1-03` (`comboNames` trong `apps drift` + `docs/known-issues.md`). QA kèm checkout sạch + `1` mutation riêng đỏ mỗi vé. | `evidence/m1` | Sub: `90 – 180` lượt; 9Router: `0` req | `4 – 7` phiên | `±40%` |
| **M2** | **ĐANG MỞ (sau khi `evidence/m1` SẠCH & `main` xanh lần 1)** | Tuần tự `M2-01` (grant lifecycle `ADR-MAINTAIN-02`), `M2-02` (outbound webhook đích giả), `M2-03` (read-back HTTP 2 router: chỉ in `READBACK ok=yes` khi HTTP máy chủ giả thành công, chỉ DB thì in `READBACK db-only`). QA kèm checkout sạch + `1` mutation riêng đỏ mỗi vé. | `evidence/m2` | Sub: `140 – 280` lượt; 9Router: `0` req | `5 – 9` phiên | `±45%` |
| **Track R** | **ĐANG MỞ (song song, không chặn M1)** | `R0` (kiểm `PATCH_V2` `createHash` ngoài router thật + `PATCH_V3` nếu cần, không áp), `R1` (`--concurrency <1\|2>` + ma trận `4` ô × `3` lần = `18` req trên `9Router-Agent-1`, lặp `18` req trên `rs-fast` nếu có, cập nhật `docs/9router-combo-findings.md`), `R2` (giải thích/sửa nhãn `DEAD` ở `ok=1/1` từ dữ liệu `c38`/`c40`, `0` req mới). | `evidence/c43` (kèm mục `3.1`) | Sub: `60 – 120` lượt; 9Router: `18 – 36` req (trần cứng `<= 40` req) | `3 – 5` phiên | `±35%` |
| **M3** | **CHƯA MỞ (chờ duyệt `evidence/m1`, `evidence/m2`)** | P4 (Tarball `5` OS) + P5 (Đo tài nguyên có phương sai & ADR SQLite, không đổi hành vi). | `evidence/m3` | Sub: `80 – 160` lượt (`0` req 9Router) | `3 – 6` phiên | `±35%` |
| **M4** | **CHƯA MỞ (chờ sau M3)** | P6 (Tài liệu nhất quán) + P7 (Bảo mật sạch kho, bằng chứng, log CI). | `evidence/m4` | Sub: `60 – 120` lượt (`0` req 9Router) | `2 – 4` phiên | `±30%` |
| **M5** | **CHƯA MỞ (chờ sau M4, Chủ dự án quyết)** | Cổng GO/NO-GO & `npm publish` do Chủ dự án tự thực hiện (`OQ-05`). | `evidence/m5` | Sub: `20 – 45` lượt (`0` req 9Router) | `1 – 2` phiên | `±25%` |

---

## 4. Điều kiện Dừng Khẩn cấp & Kỷ luật Thực thi (C43 mục 2, 3.4, 3.5)

1. **Mỗi lúc chỉ `1` PR mở**; nhánh → PR → CI xanh đủ `5` hệ điều hành trên head cuối → QA ký đủ `3` mục (checkout sạch + mutation riêng đỏ + verifier chuẩn) → **Ops** duy nhất chạy `gh pr merge --squash` → `ci-watch` báo kết quả `main` lần chạy đầu (`attempt=1`).
2. **Tự động chuyển sang M2 sau M1 (mục 3.5):** Không cần dừng chờ chủ dự án giữa M1 và M2 nếu mọi cổng ở mục 2 đều đạt; đóng xong `evidence/m1` và `evidence/m2` + `evidence/c43` thì dừng chờ người duyệt mở M3.
3. **Sáu điều kiện dừng toàn bộ ngay lập tức (mục 2):** (i) CI `main` đỏ ở lần `1` sau merge; (ii) `verify-records.mjs` / `verify-package.mjs` không `SẠCH`/`OK`; (iii) quét tên riêng hoặc mẫu cá nhân có khớp (`> 0`); (iv) vượt ngân sách request; (v) gặp `3` lần `429` liên tiếp; (vi) bất kỳ bot nào báo `XONG` mà thiếu `1` trong `4` bằng chứng của RACI mục 3 (hoặc thiếu `3` mục biên bản QA ở mục 3.4).

---

## 5. Điều chỉnh Thứ tự Làm việc theo C43A & Quy chuẩn Báo cáo GitHub-First

1. **Thứ tự Track R:** `R0` bắt buộc hoàn thành trước `R1`. Bộ kiểm thử `R0` phải chứng minh kèm đột biến (mutation) cho đủ `4` mục: **(a)** trong `vm` sandbox chỉ chứa đúng các tên phạm vi tệp `custom-server.js` gốc (`0.5.119`), `PATCH_V2` ném `ReferenceError` (đỏ trước); **(b)** `PATCH_V3` không ném lỗi; **(c)** `GET /v1/models` lần đầu và lần hai trả đúng thân và tiêu đề `x-9r-models-cache` lần lượt `miss` rồi `hit`; **(d)** request khác `/v1/models` không đi vào nhánh vá; đồng thời trả lời bằng thực nghiệm `vm` và đọc mã (`router-server.js` dòng `722` `uncaughtException`) về việc request bị treo hay tiến trình thoát khi `PATCH_V2` ném lỗi.
2. **Quy tắc cổng cứng cho `M1-01` đang chạy (C43A mục 4):** Chấp nhận việc Engineer khởi động `M1-01` trước khi đẩy `evidence/c43` vì bộ mục `3.1` đã cập nhật; tuy nhiên **PR của `M1-01` chỉ được phép merge sau khi nhánh `origin/evidence/c43` đã chứa đầy đủ các tệp mục `3.1` và vượt qua `verify-records.mjs` đạt `SẠCH`** (cùng `verify-package.mjs` đạt `OK`, quét tên riêng `0` khớp). **QA chỉ ký biên bản `M1-01` sau khi kiểm điều kiện này.**
3. **Quy chuẩn Báo cáo GitHub-First cho Planner từ xa:** Mỗi nhánh tính năng đã merge (kèm CI `5` hệ điều hành xanh và `main` xanh ở `attempt=1`) cùng mỗi gói bằng chứng (`evidence/c43`, `evidence/m1`, `evidence/m2` — commit `[skip ci]`, `<= 10` tệp, `0` tên riêng/đường dẫn cá nhân) đều được đẩy trực tiếp lên GitHub kèm `REPORT.md` và `NOTE.md` tự đủ để công cụ lập kế hoạch đọc trực tiếp từ xa mà chủ dự án không phải đính kèm tệp thủ công.
