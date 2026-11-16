# Hướng dẫn chạy thử lần đầu lệnh maintain apply (FIRST-APPLY)

Tài liệu hướng dẫn từng bước dành cho người dùng vận hành, kiểm thử lệnh áp dụng thay đổi danh sách mô hình vào router trên hai combo thử nghiệm `test-1` và `test-2`.

---

## 1. Chuẩn bị tệp cấu hình YAML

Đặt tệp cấu hình tại đường dẫn người dùng quản lý, ví dụ `~/routersync-local.yaml` (không đưa khóa bí mật vào kho mã nguồn).

Nội dung cấu hình mẫu:

```yaml
version: 1
routers:
  9router:
    type: 9router
    managed: true
    combos:
      test-1:
        models:
          - nvidia/meta/llama-3.1-8b-instruct
          - openrouter/meta/llama-3.1-8b-instruct
        minSteps: 2
        autoMaintain:
          enabled: true
          providers:
            - nvidia
            - openrouter
          match: prefix
          maxAdds: 3
      test-2:
        models:
          - nvidia/meta/llama-3.1-70b-instruct
          - openrouter/meta/llama-3.1-70b-instruct
        minSteps: 2
        autoMaintain:
          enabled: true
          providers:
            - nvidia
            - openrouter
          match: prefix
          maxAdds: 3
```

---

## 2. Quét trạng thái provider (Zero-Token)

Chạy lệnh phát hiện mô hình từ các nhà cung cấp được cấu hình:

```bash
routersync track once --discover --plan -c ~/routersync-local.yaml
```

Quan sát bảng kết quả `TRACK-DISCOVER`:
- Cột `provider`: tên định danh nhà cung cấp (ví dụ `nvidia`, `openrouter`).
- Cột `status`: hiển thị `ok` (hoạt động), `auth_error` (lỗi khóa), hoặc `unreachable` (không kết nối được).
- Dòng `SKIPPED`: liệt kê nhà cung cấp bị bỏ qua cùng lý do tương ứng.
- Dòng `HTTP-METHODS`: xác nhận phương thức HTTP chỉ sử dụng `GET`, số lượng request khác `GET` bằng 0.

---

## 3. Tạo kế hoạch thay đổi (Simulation/Dry-Run)

Chạy lệnh tính toán kế hoạch cập nhật mà chưa ghi dữ liệu:

```bash
routersync maintain plan --json -c ~/routersync-local.yaml
```

Cách đọc các trường trong kế hoạch:
- `planHash`: chuỗi băm 16 ký tự hexa đại diện cho nội dung kế hoạch tính toán.
- `removes`: danh sách mô hình đã biến mất cần đưa ra khỏi combo.
- `adds`: danh sách mô hình mới phát hiện phù hợp tiêu chí cần thêm vào combo.
- `blocked`: danh sách thay đổi bị chặn (ví dụ nhà cung cấp chưa `ok` hoặc vi phạm số bước tối thiểu `minSteps`).

---

## 4. Vị trí lưu trữ bản sao lưu và snapshot

Trước khi áp dụng bất kỳ thay đổi nào, hệ thống tự động chụp snapshot cấu hình hiện tại của router.
- Thư mục lưu snapshot: nằm trong thư mục dữ liệu trạng thái RouterSync (`state/snapshots/` hoặc `~/.routersync/snapshots/`).
- Mỗi snapshot lưu tệp JSON ghi nhận trạng thái bảng combo trước khi sửa đổi kèm mã định danh snapshot ID dạng timestamp.

---

## 5. Áp dụng kế hoạch vào hai combo thử nghiệm

Khi đã kiểm tra kỹ kế hoạch, tiến hành áp dụng trên terminal tương tác (TTY thật):

```bash
routersync maintain apply --only test-1,test-2 --plan-hash <hash> -c ~/routersync-local.yaml
```

Quy trình xác nhận trên màn hình:
1. Hệ thống kiểm tra điều kiện an toàn: cờ `--only` đúng định dạng `test-<n>`, môi trường TTY hợp lệ, mã hash khớp.
2. Hệ thống hiển thị tóm tắt số lượng mục thêm và loại bỏ trên từng combo.
3. Hệ thống hiển thị câu hỏi xác nhận: `Nhập chữ "chay" để xác nhận thực thi: `.
4. Người dùng gõ đúng từ `chay` và nhấn Enter để tiến hành ghi vào cơ sở dữ liệu router.

---

## 6. Khôi phục trạng thái (Rollback)

Nếu kết quả sau khi áp dụng không đúng mong muốn, thực hiện khôi phục ngay lập tức:

1. Chạy thử kiểm tra rollback (chế độ dry-run):
```bash
routersync rollback <snapshotId> -c ~/routersync-local.yaml
```
2. Thực hiện khôi phục thật (yêu cầu terminal tương tác và xác nhận):
```bash
routersync rollback <snapshotId> --write -c ~/routersync-local.yaml
```

---

## 7. Dấu hiệu bất thường và xử lý

- Lỗi `MAINTAIN-REFUSED reason=no-tty`: lệnh áp dụng bị từ chối vì tiến trình chạy không có TTY người dùng trực tiếp. Giải pháp: chạy lệnh trên cửa sổ dòng lệnh thật.
- Lỗi `MAINTAIN-REFUSED reason=only-pattern`: tên combo ngoài danh sách `^test-\d+$`. Giải pháp: chỉ thử nghiệm trên combo `test-1,test-2`.
- Lỗi mã băm không khớp: kế hoạch đã bị thay đổi do có đợt quét mới. Giải pháp: chạy lại `maintain plan` lấy mã hash mới.
