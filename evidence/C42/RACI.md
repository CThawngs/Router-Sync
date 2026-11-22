# RACI.md — Ma trận Phân vai & Quy tắc Quản trị RouterSync v0.1 RC (C42)

- **Chương trình:** C42 — Hiến chương chương trình RouterSync v0.1 Release Candidate
- **Đồng lập & phê duyệt nội bộ:** CEO, Product Manager (PMO Lead), COO, CTO
- **Phạm vi áp dụng:** Giai đoạn M0 (lập kế hoạch chỉ-đọc) và toàn bộ 5 cột mốc M1–M5 của RouterSync v0.1 RC.
- **Quy tắc vệ sinh thông tin:** Không chứa tên người dùng hệ điều hành, đường dẫn cá nhân, tên dịch vụ đồng bộ đám mây, khóa API hay tên gateway riêng.

---

## 1. Trạng thái Kích hoạt Phòng ban & Vai trò (Mục 3)

Chương trình chỉ kích hoạt phòng và vai trò có đầu việc trực tiếp trong P1–P7 để giữ kỷ luật ngữ cảnh và bảo vệ hạn mức LLM.

### 1.1 Các phòng ban & vai trò ĐANG BẬT (hoặc bật theo điều kiện rõ ràng)

| Phòng | Vai trò | Trạng thái | Trách nhiệm cốt lõi trong RouterSync v0.1 RC |
|---|---|---|---|
| **Steering** | **Chủ dự án (Owner) & Người duyệt độc lập** | **Bật (Cổng tối cao)** | Duyệt kế hoạch C42 trước khi mở M1; quyết định mọi mục thuộc Mục 7; quyết định GO/NO-GO và tự thực thi `npm publish` tại M5; duy nhất được ghi vào router thật hoặc gõ từ xác nhận `"chạy"`. |
| **Exec** | **CEO** | **Bật** | Điều phối liên phòng, chịu trách nhiệm cuối trước Chủ dự án, kiểm định đủ 4 bằng chứng trước khi chấp nhận nhãn `"XONG"`, chốt gán combo theo vai. |
| **Exec** | **Product Manager (PMO Lead)** | **Bật** | Quản lý phạm vi P1–P7, `PLAN.md`, `RACI.md`, `BACKLOG.md`, tiêu chí chấp nhận từng vé và chống phình phạm vi. |
| **Exec** | **COO** | **Bật** | Quản lý nhịp làm việc, giới hạn đồng thời, ngân sách request theo ngày (`CAPACITY.md`), sổ rủi ro (`RISKS.md`), theo dõi & báo cáo số request theo provider mỗi ngày. |
| **Tech** | **CTO** | **Bật** | **Vai trò duy nhất hợp nhất thay đổi thiết kế và ADR** (`ADR-MAINTAIN-02`, webhook, read-back, ADR `better-sqlite3` vs `node:sqlite`), chia việc kỹ thuật. |
| **Tech** | **Engineer** | **Bật từ M1 (M0 chưa giao việc)** | Viết mã, viết bài test tái hiện đỏ-trước xanh-sau, tự chạy kiểm chứng lần 1 (`pnpm prepush`) và mở PR trên nhánh riêng. |
| **Tech** | **QA** | **Bật từ M1 (M0 chưa giao việc)** | **Độc lập 100% với người viết mã**; chạy xác minh độc lập lần 2 bằng công cụ chuẩn (`verify-records.mjs`, `verify-package.mjs`, `scan-private-names.mjs`) và ký duyệt trước khi merge. |
| **Tech** | **Researcher** | **Bật khi vé cần tra cứu** | Tra cứu tài liệu nguồn chính thức (Node `node:sqlite`, GitHub Actions ARM, quy cách gói npm) khi CTO/PM yêu cầu. |
| **Tech** | **Data-AI** | **Chỉ bật khi cần phân tích số liệu** | Xử lý thống kê phương sai khởi động lạnh & bộ nhớ rảnh tại M3 (P5) hoặc phân tích dữ liệu đo khi cần. |
| **Tech** | **Designer** | **Chưa cần bật** | Giao diện web G5 nằm ngoài phạm vi v0.1 RC (`"chờ chủ dự án"`). |
| **Ops** | **Ops** | **Bật từ M1 (M0 chưa giao việc)** | Theo dõi CI (`ci-watch.mjs`), **vai trò duy nhất chạy lệnh `gh pr merge --squash` sau khi QA ký**, theo dõi run CI `main` lần chạy đầu và đóng gói nhánh bằng chứng. |

### 1.2 Các phòng ban & vai trò CHƯA KÍCH HOẠT

> **Quy tắc bật lại bắt buộc:** Tất cả 7 vai trò dưới đây (cùng `Designer`) giữ trạng thái **CHƯA KÍCH HOẠT (`0` quota)**. Chỉ được bật lại khi đồng thời có: (1) đầu việc cụ thể phát sinh, và (2) lý do rõ ràng được bổ sung vào kế hoạch và được **Chủ dự án + CEO** chấp thuận.

| Phòng | Vai trò | Trạng thái | Lý do chưa kích hoạt trong v0.1 RC | Điều kiện cụ thể để bật lại |
|---|---|---|---|---|
| **Ops** | **Legal** | Chưa kích hoạt | Kho giữ nguyên giấy phép MIT hiện hành; thay đổi giấy phép thuộc thẩm quyền Chủ dự án (Mục 7). | Khi Chủ dự án yêu cầu rà soát giấy phép phụ thuộc mới trước cổng M5. |
| **Ops** | **HR** | Chưa kích hoạt | Tổ chức đội bot cho C42 đã cố định; không thêm/xóa bot trong v0.1 RC. | Khi cần tái cấu trúc bộ máy bot theo quyết định của Chủ dự án + CEO. |
| **Ops** | **Finance** | Chưa kích hoạt | Chương trình dùng tài nguyên sẵn có (`0` chi tiêu mua dịch vụ mới; mua/nâng gói thuộc Mục 7). | Khi Chủ dự án yêu cầu thẩm định chi phí mua runner/gói dịch vụ mới. |
| **Growth** | **Sales** | Chưa kích hoạt | Sản phẩm mã nguồn mở MIT, chưa có hoạt động bán hàng hay cam kết khách hàng bên ngoài. | Sau M5 nếu Chủ dự án mở hướng thương mại hóa. |
| **Growth** | **Content** | Chưa kích hoạt | P6 chỉ cập nhật tài liệu kỹ thuật trong kho; công bố bài viết ra ngoài thuộc Mục 7. | Sau M5 khi Chủ dự án quyết định công bố bài viết ra ngoài. |
| **Growth** | **Marketer** | Chưa kích hoạt | Không chạy chiến dịch truyền thông hay mạng xã hội trong giai đoạn làm RC (thuộc Mục 7). | Sau M5 khi Chủ dự án yêu cầu truyền thông phát hành. |
| **Growth** | **Support** | Chưa kích hoạt | Chưa phát hành lên npm công khai nên chưa mở bàn hỗ trợ người dùng ngoài. | Sau M5 khi gói npm đã được Chủ dự án phát hành công khai. |

---

## 2. Ma trận R / A / C / I cho M0, M1–M5 và Vận hành Xuyên suốt

**Ký hiệu:** `R` = Trực tiếp thực hiện (Làm) · `A` = Chịu trách nhiệm cuối / Duyệt chốt · `C` = Được tham vấn · `I` = Được báo cáo · `—` = Chưa tham gia.

| Cột mốc | Hạng mục công việc | Chủ dự án / Duyệt độc lập | CEO | PM | COO | CTO | Engineer | QA | Ops | Researcher | Data-AI | Designer & 7 vai chưa bật |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **M0** | Kiểm kê chỉ-đọc, đo M0.2 & M0.3, lập `PLAN`, `RACI`, `BACKLOG`, `RISKS`, `CAPACITY`, đẩy `evidence/c42` | **A** (duyệt kế hoạch C42) | **R/A** (điều phối & chốt gói) | **R** (`PLAN`, `RACI`, `BACKLOG`) | **R** (đo M0.3, `CAPACITY`, `RISKS`) | **R** (M0.1–M0.2 & thiết kế nền) | I (chưa giao) | I (chưa giao) | I (chưa giao) | — | — | — |
| **M0–M5** | Quản trị trần đồng thời, ngân sách request/ngày, báo cáo provider mỗi ngày & hàng đợi `"chờ chủ dự án"` | **A** (quyết mục Mục 7) | **A** (duyệt nội bộ) | C (phạm vi) | **R** (theo dõi & báo hằng ngày) | C (sự cố kỹ thuật) | I | I | C (theo dõi CI/router) | — | — | — |
| **M1** | **P1 & P2 — Hợp nhất thiết kế sửa lỗi** (`e2e.test.ts`, Known issues 1 & 2) | I | I | C (tiêu chí vé) | C (rủi ro CI) | **A/R** (duy nhất hợp nhất thiết kế) | C | C (tiêu chí kiểm chứng) | C (workflow CI) | C (khi cần) | — | — |
| **M1** | **P1 & P2 — Viết mã, test đỏ-trước xanh-sau & chạy `pnpm prepush`** | I | I | I | I | C | **R** (xác minh bản 1) | — (độc lập) | I | — | — | — |
| **M1** | **P1 & P2 — Xác minh độc lập & ký duyệt QA** | I | I | I | I | C | — (cấm tự chấm) | **A/R** (xác minh bản 2 & ký) | C | — | — | — |
| **M1** | **P1 & P2 — Merge PR (`--squash` khi xanh 5 OS), `ci-watch` trên `main` lần 1 & gói `evidence/m1`** | I | **A** (nghiệm thu M1) | C (cập nhật backlog) | C (hiệu chỉnh nỗ lực) | I | I | C (kiểm `verify-*`) | **R** (duy nhất merge) | — | — | — |
| **M2** | **P3 — Hợp nhất thiết kế Phase 3 S2** (`ADR-MAINTAIN-02`, Webhook, Read-back 2 router) | C (nếu chạm cổng Mục 7) | I | C (phạm vi S2) | C (rủi ro an ninh) | **A/R** (duy nhất hợp nhất thiết kế) | C | C (ma trận test) | I | C (khi cần) | — | — |
| **M2** | **P3 — Viết mã & test cô lập (fake webhook/router/DB)** | I | I | I | I | C | **R** (xác minh bản 1) | — (độc lập) | I | — | — | — |
| **M2** | **P3 — Xác minh độc lập, audit bảo mật & ký duyệt QA** | I | I | I | C | C | — (cấm tự chấm) | **A/R** (xác minh bản 2 & ký) | C | — | — | — |
| **M2** | **P3 — Merge PR (xanh 5 OS), `ci-watch` trên `main` lần 1 & gói `evidence/m2`** | I | **A** (nghiệm thu M2) | C (tách vé M3) | C (hiệu chỉnh nỗ lực) | I | I | C (kiểm `verify-*`) | **R** (duy nhất merge) | — | — | — |
| **M3** | **P4 & P5 — Kiểm đóng gói tarball 5 OS, đo tài nguyên có phương sai & ADR SQLite** | I | I | C (tách vé M3) | C (cổng RAM máy yếu) | **A/R** (hợp nhất ADR SQLite) | **R** (script & test gói) | **A/R** (xác minh độc lập & không đổi hành vi) | C (CI 5 OS) | C (`node:sqlite`) | **R** (phân tích phương sai nếu bật) | — |
| **M3** | **P4 & P5 — Merge PR, kiểm CI `main` lần 1 & gói `evidence/m3`** | I | **A** (nghiệm thu M3) | C (tách vé M4) | C | I | I | C (kiểm `verify-*`) | **R** (duy nhất merge) | — | I | — |
| **M4** | **P6 & P7 — Cập nhật tài liệu nhất quán & tổng kiểm toán bảo mật kho/bằng chứng/log CI** | I | I | **R** (rà soát nội dung P6) | C (chốt sổ `RISKS`) | C (rà kỹ thuật) | **R** (cập nhật docs & sửa nếu có) | **A/R** (audit độc lập P6 & P7) | **R** (quét nhánh/log CI) | — | — | — |
| **M4** | **P6 & P7 — Merge PR, kiểm CI `main` lần 1, gói `evidence/m4` & hồ sơ trình RC** | I | **A** (duyệt trình M5) | C | C | C | I | C | **R** (duy nhất merge & đóng gói) | — | — | — |
| **M5** | **Cổng phát hành v0.1 RC — Quyết định GO/NO-GO & phát hành npm** | **A/R** (quyết định & tự chạy `npm publish`) | **R** (trình hồ sơ RC) | C (tổng hợp P1–P7) | C (báo cáo ngân sách/rủi ro cuối) | C (xác nhận kỹ thuật) | I | C (kiểm tra hậu phát hành) | **R** (đóng gói `evidence/m5`) | — | — | — |

---

## 3. Ba Quy tắc Phân vai Bất khả Xâm phạm (Mục 3)

1. **Độc lập tuyệt đối giữa QA và người viết mã:**
   - QA không được là người đã viết hoặc đã báo `"xong"` mã đang xác minh.
   - Mỗi hạng mục bắt buộc có **hai bản xác minh riêng biệt**: (i) một của **Engineer** (tự chạy test và `pnpm prepush`), và (ii) một của **QA** (chạy lại độc lập bằng công cụ chuẩn).
2. **Điều kiện bắt buộc để CEO chấp nhận nhãn `"XONG"` (nếu thiếu phải ghi `"CHƯA XÁC NHẬN"`):**
   - Kết luận `"XONG"` của bất kỳ bot nào chỉ được CEO chấp nhận khi có đủ cả 4 bằng chứng kiểm chứng được:
     1. Đường dẫn PR đã merge vào `main`;
     2. Mã commit `sha` trên `main`;
     3. Run CI của `main` xanh ngay ở **lần chạy đầu (`attempt=1`)** sau khi PR đã xanh đủ **5 hệ điều hành** trên head cuối (ARM báo cáo tách riêng);
     4. Đầu ra sạch (`exit 0`) của cả `verify-records.mjs` (sha256 `7b310d90…`) và `verify-package.mjs` chuẩn trong nhánh bằng chứng (`evidence/m<n>`, kèm `scan-private-names.mjs` = `0` khớp).
   - Báo cáo chỉ có lời kể hoặc thiếu bất kỳ mục nào ở trên thì bắt buộc ghi **`"CHƯA XÁC NHẬN"`** (hoặc `MỘT PHẦN` / `CHƯA LÀM`), tuyệt đối không dùng nhãn `"XONG"`.
3. **Độc quyền hợp nhất thiết kế của CTO và độc quyền merge của Ops:**
   - **CTO** là người duy nhất hợp nhất thay đổi thiết kế kỹ thuật và ADR.
   - **Ops** là người duy nhất chạy lệnh `gh pr merge --squash` sau khi QA đã ký duyệt độc lập và head cuối xanh đủ 5 hệ điều hành. Không ai được commit thẳng lên `main`, không force-push, không merge nhánh bằng chứng.
