# ADR-MAINTAIN-01: Quy trình lập kế hoạch tự bảo trì model zero-token

- **Trạng thái:** PROPOSED
- **Ngày:** 2026-10-31
- **Tác giả:** RouterSync Team
- **Liên quan:** Điều kiện D26 / AT-114, Bất biến I1-I8, `maintain plan`, `maintain apply`
- **Mức độ kiểm chứng:** UNVERIFIED (chờ xác nhận qua diễn tập thực tế trên môi trường live)

## 1. Ngữ cảnh và vấn đề

Khi các nhà cung cấp mô hình AI thay đổi phiên bản, gỡ bỏ endpoint cũ hoặc áp dụng chính sách giới hạn mới, các combo định tuyến trong 9Router và OmniRoute có thể gặp lỗi nếu trỏ tới model đã ngừng hoạt động (Bất biến I1). Hiện tại, việc phát hiện và thay thế model đòi hỏi người vận hành can thiệp thủ công.
Mục tiêu của cờ `autoMaintain` là tự động phân tích dữ liệu quét sức sống zero-token từ `track-events`, đối chiếu với danh mục model hoạt động, và lập kế hoạch bảo trì định kỳ cho các combo được quản lý.

## 2. Dòng chảy kiến trúc (Architecture Flow)

Dòng chảy từ phát hiện đến áp dụng được mô tả qua sơ đồ sau:

```
[track once / watch] 
        │
        ▼ (ghi sự kiện)
   track-events (JSONL)
        │
        ▼ (đầu vào cho hàm thuần)
computePlan(input) ────► [maintain plan]
                              │
                              ▼ (tạo planHash 16 hex)
                      [Duyệt thủ công / TTY]
                              │
                              ▼ (nhập "chay" + --plan-hash)
                       maintain apply
                              │
                              ▼ (snapshot -> ghi -> read-back -> rollback nếu lệch)
                      Cơ sở dữ liệu Router
```

Dòng chảy này tuân thủ chuỗi: `track-events -> plan -> duyệt -> apply`.

## 3. Quyết định kiến trúc

### 3.1. Hàm thuần computePlan và tính xác định (Determinism)
Logic tạo kế hoạch bảo trì được đóng gói trong hàm thuần `computePlan(input)` tại `packages/cli/src/maintain/plan.ts`:
- Không thực hiện bất kỳ lệnh I/O trên đĩa nào (`fs` write blocked).
- Không thực hiện bất kỳ lệnh mạng nào (`fetch`, `net.connect` blocked).
- Mã băm kế hoạch `planHash` (16 ký tự hex) được tính toán tất định từ nội dung các thay đổi thêm và loại bỏ.
- Cấu trúc dữ liệu đầu vào:
  - `router`: định danh router (`9router` hoặc `omniroute`).
  - `policyMode`: chế độ chính sách router hiện hành (`manual`, `shadow`, `auto`).
  - `combos`: danh sách combo kèm luật áp dụng (`rule`) và cờ `autoMaintain`.
  - `providers`: trạng thái các nhà cung cấp (`status`, `removed`, `added`).
  - `agents`: danh sách các agent cần đồng bộ (`hermes`, `dsh`...).
- Cấu trúc dữ liệu đầu ra:
  - `adds`: danh sách model được thêm vào combo (`combo`, `model`, `position`).
  - `removes`: danh sách model bị loại khỏi combo (`combo`, `model`).
  - `blocked`: danh sách các hành động bị chặn kèm lý do chi tiết.
  - `agentTargets`: danh sách mục tiêu agent (các agent mang trạng thái `unverified`).
  - `summary`: thống kê tổng quan (`unmanagedTouched`, `autoEligible`...).
  - `planHash`: mã băm SHA-256 rút gọn 16 ký tự hex.

### 3.2. Ràng buộc an toàn và điều kiện D26 / AT-114
- **9Router Policy:** Theo điều kiện D26 / AT-114, 9Router chỉ được phép lập kế hoạch khi `policy.mode` là `manual` hoặc `shadow`. Nếu ở chế độ `auto` hoặc không xác định, các thay đổi sẽ bị chặn với lý do `d26-manual`.
- **Chế độ guard cho combo adopted:** Các combo ở chế độ `guard` chỉ được phép loại bỏ model đã ngừng hoạt động (`removed`), không tự ý thêm model mới (`blocked: adopt-guard`).
- **Bất biến minSteps (I3):** Khi loại bỏ model làm số bước trong combo nhỏ hơn 2, việc loại bỏ của combo đó sẽ bị chặn (`blocked: min-steps`).
- **Phạm vi quản lý (I5):** Combo `unmanaged` không bao giờ bị chạm vào (`blocked: unmanaged`).
- **Ràng buộc freeOnly (I6):** Combo `freeOnly` chỉ chấp nhận model có `free === true`.
- **Giới hạn số lượng model thêm:** Mặc định trần thêm tối đa 3 model cho mỗi combo trên mỗi kế hoạch (`add-cap`).

### 3.3. Hàm thuần reduceTrack và ánh xạ định danh model (Round 51)

Để tách biệt tầng I/O và tầng tính toán, Round 51 bổ sung hàm thuần thứ hai `reduceTrack` (`packages/cli/src/maintain/reduce-track.ts`):
- **Đầu vào:** `{ state: { providers: { [id]: { status, lastScanAt, ... } } }, events: [...], nowMs, sinceMs?, staleMs? }`.
- **Đầu ra:** `{ providers: { [id]: { status, removed: [idĐầyĐủ], added: [{ id }] } }, ignoredEvents }`.
- **Quy tắc giảm trừ:**
  - Sự kiện mới hơn cùng model ghi đè sự kiện cũ hơn.
  - Quét cũ hơn ngưỡng `staleMs` (mặc định 3 ngày) được coi là quá hạn, provider không đạt trạng thái `ok`.
  - Định danh model thô từ tracker được gắn tiền tố `<provider>/`:

| Nguồn dữ liệu | Định danh gốc | Tiền tố | Định danh chuẩn hoá |
|---|---|---|---|
| Tracker (NVIDIA) | `meta/llama-3.1-70b-instruct` | `nvidia/` | `nvidia/meta/llama-3.1-70b-instruct` |
| Tracker (OpenRouter) | `openai/gpt-4o-mini` | `openrouter/` | `openrouter/openai/gpt-4o-mini` |
| Tracker (Groq) | `llama-3.3-70b-versatile` | `groq/` | `groq/llama-3.3-70b-versatile` |

- **Giả định tiền tố provider trong combo:** Combo trong router định danh model theo cú pháp `<provider>/<model_id>`. Nếu ID của nhà cung cấp trong trạng thái theo dõi không khớp với tiền tố nào trong cấu hình combo, hệ thống ghi nhận thông báo `PROVIDER-UNMATCHED <id>` mà không gây dừng tiến trình.

### 3.4. Rào chắn bảo vệ của lệnh maintain apply (Round 51)

Lệnh `maintain apply` được bảo vệ bằng hợp đồng rào chắn hộp đen theo thứ tự kiểm tra:
1. `no-only`: Bắt buộc truyền tham số `--only`.
2. `only-pattern`: Mọi tên combo trong danh sách `--only` bắt buộc khớp mẫu `^test-\d+$` (cho phép danh sách phân tách bằng dấu phẩy như `--only test-1,test-2`).
3. `yes-flag`: Cấm sử dụng cờ `--yes` để tự động hóa mà không qua người duyệt.
4. `no-tty`: Bắt buộc môi trường TTY tương tác để người dùng gõ xác nhận `chay`.
5. `test-db-outside-tmp`: Khi sử dụng cặp biến kiểm thử `ROUTERSYNC_TEST_FAST=1` và `ROUTERSYNC_TEST_CONFIRM=chay`, đường dẫn cơ sở dữ liệu router bắt buộc phải nằm trong thư mục tạm của hệ điều hành (`os.tmpdir()`). Nếu trỏ tới cơ sở dữ liệu thật, lệnh bị từ chối với mã lỗi `test-db-outside-tmp`.
6. `plan-hash`: Kiểm tra tính lại mã băm kế hoạch, khớp chính xác giá trị `--plan-hash` trước khi áp dụng.

Các biến môi trường cũ có nguy cơ lách kiểm tra (`ROUTERSYNC_FORCE_TTY` và `ROUTERSYNC_CONFIRM_WORD`) bị xóa khỏi mã nguồn.

## 4. Bảng phân tích rủi ro và biện pháp giảm thiểu

| Rủi ro tiềm ẩn | Mức độ | Biện pháp giảm thiểu kiến trúc |
|---|---|---|
| Model ngừng hoạt động làm sập combo | Cao | Theo dõi qua `track-events`, loại bỏ sau 2 chu kỳ ân hạn |
| Loại bỏ làm combo không còn bước dự phòng | Nghiêm trọng | Bất biến I3 (`minSteps >= 2`), chặn kế hoạch nếu vi phạm |
| Tự ý sửa combo cá nhân ngoài kiểm soát | Cao | Bất biến I5, chặn mọi thay đổi với combo unmanaged |
| Model trả phí lọt vào combo miễn phí | Trung bình | Bất biến I6, chặn model không có `free === true` |
| Thay đổi ngoài ý muốn khi áp dụng | Nghiêm trọng | Bắt buộc khớp `planHash`, TTY xác nhận, snapshot & rollback |
| Router 9Router xung đột chính sách | Cao | Áp dụng quy tắc D26 / AT-114: chỉ cho phép mode manual/shadow |

## 5. Trạng thái và lộ trình kiểm chứng

Tính năng tự bảo trì hiện ở trạng thái PROPOSED và được gắn nhãn UNVERIFIED.
Kế hoạch bảo trì được kiểm thử tự động qua bộ kiểm thử hợp đồng `tools/track/test-maintain-plan.mjs` (M1–M12) và `tools/track/test-maintain-apply.mjs` (A1–A8).
Mọi thao tác ghi thực tế lên router sản xuất phải chờ phê duyệt cuối cùng từ chủ dự án.
