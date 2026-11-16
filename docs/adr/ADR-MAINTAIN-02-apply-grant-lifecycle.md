# ADR-MAINTAIN-02: Vòng đời giấy phép ghi và giới hạn phạm vi áp dụng bảo trì

- **Trạng thái:** ACCEPTED
- **Ngày:** 2026-11-01
- **Tác giả:** RouterSync Team
- **Liên quan:** `maintain authorize`, `maintain apply`, `maintain grant-status`, `maintain revoke-grant`, Bất biến I1–I8, AT-114
- **Mức độ kiểm chứng:** L3 (hợp đồng kiểm thử `tools/maintain/test-apply-grant.mjs` đạt ALL PASS)

## 1. Ngữ cảnh và vấn đề

Lệnh `maintain apply` thực hiện thay đổi cấu hình trực tiếp trên các router (OmniRoute, 9Router) và các tệp cấu hình công cụ agent (Hermes, DSH).
Nhằm ngăn chặn hành động tự ý thay đổi dữ liệu từ các tiến trình tự động hoặc agent khi chưa có sự xác nhận của người vận hành:
1. Không cho phép cờ bypass dạng `--yes`.
2. Không cho phép thực thi không có giám sát nếu chưa được cấp giấy phép ghi có thời hạn.
3. Giới hạn phạm vi thao tác vào các combo thử nghiệm (`test-<n>`) và các agent được chỉ định rõ ràng.

## 2. Thiết kế vòng đời giấy phép (Grant Lifecycle)

Quy trình quản lý quyền ghi gồm 4 bước:

```
[Người vận hành TTY]
       │
       ▼ (gõ "chay" xác nhận)
maintain authorize --only test-1,test-2,test-3 --agents hermes,dsh --hours 1
       │
       ▼ (tạo <state>/apply-grant.json)
[Giấy phép có hạn: TTL 1-8 giờ, phạm vi test-<n>]
       │
       ▼ (kiểm tra hợp lệ, phạm vi và thời hạn)
maintain apply --router <r> --only <combos> --plan-hash <hash>
       │
       ▼ (hoàn tất phiên bảo trì)
maintain revoke-grant  -->  xóa giấy phép, in GRANT-REVOKED
```

### 2.1 Cấp quyền (Authorization)
Lệnh:
```bash
routersync maintain authorize --only test-1,test-2,test-3 --agents hermes,dsh --hours 1
```
- Bắt buộc chạy trên terminal có TTY. Nếu chạy qua ống dẫn không có TTY, lệnh từ chối với mã `no-tty`.
- Người vận hành gõ xác nhận từ "chay".
- Tham số `--only`: Bắt buộc tuân theo định dạng `^test-\d+(,test-\d+)*$`. Nếu sai định dạng báo `only-pattern`.
- Tham số `--hours`: Số nguyên từ 1 đến 8. Ngoài khoảng này báo `hours-range`.
- Tham số `--agents`: Chỉ chấp nhận danh sách trong tập hợp `hermes,dsh`. Nếu có giá trị khác báo `agents-invalid`.
- Ghi tệp `<state>/apply-grant.json` gồm phiên bản, mã định danh id hex, danh sách combos, agents, mốc thời gian createdAt và expiresAt.

### 2.2 Áp dụng (Apply)
Lệnh:
```bash
routersync maintain apply --router <r> --only <combos> --plan-hash <hash> [--agents <agents>]
```
- Nếu không có TTY và không có giấy phép: từ chối với mã `no-tty`.
- Nếu có cờ `--yes`: từ chối với mã `yes-flag`.
- Kiểm tra tính hợp lệ của tệp giấy phép:
  - Nếu tệp bị hỏng cú pháp, có thời hạn vượt quá 8 giờ, hoặc chứa combo ngoài mẫu `test-<n>`: từ chối với mã `grant-invalid`.
  - Nếu thời gian hiện tại vượt quá `expiresAt`: từ chối với mã `grant-expired`.
  - Nếu danh sách `--only` hoặc `--agents` yêu cầu vượt ngoài danh sách được cấp: từ chối với mã `grant-scope`.
- Sau khi xác thực giấy phép thành công, tiến trình tiếp tục các bước kiểm tra snapshot, kế hoạch và ghi dữ liệu.

### 2.3 Tra cứu trạng thái (Status)
Lệnh:
```bash
routersync maintain grant-status
```
- Nếu có giấy phép hợp lệ: in dòng `GRANT id=<hex> combos=<list> agents=<list> expiresAt=<ISO> remaining_min=<phút>`.
- Nếu không có giấy phép hoặc đã hết hạn: in dòng `GRANT none`.
- Không in khóa bí mật.

### 2.4 Thu hồi (Revocation)
Lệnh:
```bash
routersync maintain revoke-grant
```
- Xóa tệp `<state>/apply-grant.json`.
- In thông báo `GRANT-REVOKED`.
- Lệnh này cho phép chạy không cần TTY để các kịch bản dọn dẹp có thể thu hồi quyền khi kết thúc.

## 3. Rủi ro và biện pháp giảm thiểu

| Rủi ro | Mức độ | Biện pháp giảm thiểu |
|---|---|---|
| Agent tự cấp quyền qua script tự động không có TTY | Cao | Chặn khi stdin không phải TTY (`reason=no-tty`) |
| Giấy phép bị lạm dụng sửa combo sản xuất | Nghiêm trọng | Ép cứng định dạng combo trong giấy phép phải thuộc `test-<n>`, từ chối ngay từ khâu cấp phép |
| Giấy phép tồn tại vô hạn | Cao | Giới hạn thời gian hiệu lực tối đa 8 giờ, kiểm tra `expiresAt` trước mỗi thao tác ghi |
| Ghi nhầm sang agent không được phép | Trung bình | So khớp danh sách `--agents` với phạm vi trong giấy phép |

## 4. Bảng 7 cổng xác nhận ghi và giới hạn thực tế

Giới hạn bảo mật cần ghi rõ: **tiến trình có PTY gõ chữ vẫn qua khi không có tệp grant; rào còn lại là agent không có PTY và chủ chạy lệnh ghi ở cửa sổ riêng**. Không coi `apply-grant.json` (hay biến bí mật của grant) là cơ chế bảo vệ cổng ghi trước một tiến trình có PTY, vì trên nhánh TTY tương tác cả 7 cổng đều cho phép đi tiếp khi gõ đúng cụm từ xác nhận (`chạy` hoặc `chay`).

| Cổng ghi | Tệp và hàm bao quanh | TTY bắt buộc | Cụm từ xác nhận TTY | Nhánh grant khi không gõ lại | Tiến trình có PTY gõ chữ không có grant có qua được không? |
|---|---|---|---|---|---|
| `sync --apply` | `packages/cli/src/commands/sync/sync-cli.ts:190` (`runSyncCommand`) | Có (`isTTY`) | `chạy` (+ `planHash`) | Không | Có (PTY gõ `chạy` qua trực tiếp) |
| `undo --apply` | `packages/cli/src/commands/sync/sync-cli.ts:323` (`runUndoCommand`) | Có (`isTTY`) | `chạy` | Không | Có (PTY gõ `chạy` qua trực tiếp) |
| `apply --write` | `packages/cli/src/commands/apply.ts:96` (`runApplyCommand`) | Có (`isTTY`) | `chay` | Không | Có (PTY gõ `chay` qua trực tiếp) |
| `maintain apply` | `packages/cli/src/commands/maintain.ts:575` (`runMaintainApplyCommand`) | Có (`isTTY`) | `chay` (+ `planHash`) | Có (chỉ cho `test-<n>`) | Có (PTY gõ `chay` vẫn qua khi không có tệp grant) |
| `rollback --write` | `packages/cli/src/commands/rollback.ts:150` (`runRollbackCommand`) | Có (`isTTY`) | `chay` | Không | Có (PTY gõ `chay` qua trực tiếp) |
| `maintain create` | `packages/cli/src/commands/maintain.ts:340` (`runMaintainCreateCommand`) | Có (`isTTY`) | `chay` | Có (chỉ cho `test-<n>`) | Có (PTY gõ `chay` vẫn qua khi không có tệp grant) |
| `agents update` | `packages/cli/src/commands/agents.ts:453` (`applyAgentModelUpdate`) | Có (`isTTY`) | `chay` | Có (theo danh sách `--agents`) | Có (PTY gõ `chay` vẫn qua khi không có tệp grant) |

