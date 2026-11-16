# Sổ Tay Vận Hành Kiểm Thử Thực Tế End-to-End (LIVE-E2E)

Tài liệu hướng dẫn quy trình kiểm thử trực tiếp trên các router thật (`9router` tại cổng `:20128` và `omniroute` tại cổng `:30128`), cùng các agent như Hermes và DeepSeek Harness.

---

## 1. Nguyên Tắc An Toàn Khi Chạy Thật

1. Không can thiệp vào các combo đang phục vụ người dùng. Chỉ thao tác trên các combo thử nghiệm có tên khớp định dạng `^test-\d+$` (cụ thể: `test-1`, `test-2`, `test-3`).
2. Mọi thao tác ghi (`maintain apply`, `maintain create`) bắt buộc phải có giấy phép cấp phát từ chủ dự án (`maintain authorize`).
3. Luôn thực hiện sao lưu trạng thái trước khi ghi và xác thực chu kỳ đọc lại (read-back) sau khi áp dụng.
4. Chuẩn bị sẵn phương án hoàn nguyên (`rollback`) ngay khi xuất hiện sai lệch dữ liệu.
5. Khi kết thúc chuỗi thao tác kiểm thử, thu hồi giấy phép (`revoke-grant`) để đóng quyền ghi.

---

## 2. Bước 1: Kiểm Tra Trạng Thái Sẵn Sàng (Preflight)

Kiểm tra kết nối và trạng thái của các router:

```bash
routersync scan
```

Yêu cầu preflight:
- OmniRoute phản hồi `up=yes`.
- 9Router phản hồi `up=yes` với `policyMode=manual` hoặc `policyMode=shadow`.
- Nếu 9Router bị chặn theo quyết định D26, ghi nhận trạng thái `D26-BLOCKED router=9router` kèm lý do.

---

## 3. Bước 2: Cấp Giấy Phép Ghi Có Hạn (maintain authorize)

Chủ dự án trực tiếp thao tác trên thiết bị đầu cuối TTY để cấp giấy phép ghi:

```bash
routersync maintain authorize --only test-1,test-2,test-3 --agents hermes,dsh --hours 4
```

Hệ thống sẽ yêu cầu người vận hành xác nhận bằng cách gõ từ khóa `chay` tại giao diện tương tác TTY.
Sau khi cấp thành công, kiểm tra trạng thái giấy phép:

```bash
routersync maintain grant-status
```

---

## 4. Bước 3: Tạo Combo Thử Nghiệm Miễn Phí (test-3)

Tạo combo mới chỉ chứa các mô hình miễn phí đã được gắn nhãn hợp lệ:

```bash
routersync maintain create --name test-3 --models openrouter/google/gemini-2.0-flash-exp:free,openrouter/meta-llama/llama-3.3-70b-instruct:free --free
```

Bộ điều khiển sẽ:
1. Xác thực tính miễn phí của từng mô hình qua hàm `classifyFree` và siêu dữ liệu `model-meta.json`.
2. Tạo snapshot sao lưu cơ sở dữ liệu router.
3. Ghi combo `test-3` và đọc lại kiểm chứng tính toàn vẹn.

---

## 5. Bước 4: Lập Kế Hoạch Và Áp Dụng Cho test-1, test-2

Thực hiện tính toán kế hoạch và áp dụng cập nhật:

```bash
routersync maintain plan --only test-1,test-2
routersync maintain apply --only test-1,test-2 --plan-hash <HASH>
```

Yêu cầu xác nhận:
- Chỉ các hàng thuộc `test-1` và `test-2` thay đổi, số lượng hàng khác đổi bằng 0 (`other_rows_changed=0`).
- Giữ vững quy tắc dự phòng tối thiểu 2 bước (minSteps >= 2).

---

## 6. Bước 5: Kiểm Thử Hoàn Nguyên (Rollback Proof)

Xác minh khả năng phục hồi dữ liệu khi cần:

```bash
routersync rollback <SNAPSHOT_ID>
```

Đọc lại trạng thái cơ sở dữ liệu và kiểm tra mã băm xác nhận khớp với trạng thái trước khi ghi (`digest_equals_before=yes`).

---

## 7. Bước 6: Kiểm Thử Khói (Smoke Call)

Thực hiện gọi thử nghiệm qua combo miễn phí để kiểm tra đường định tuyến:

```bash
curl -X POST http://127.0.0.1:30128/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <CLIENT_KEY>" \
  -d '{"model":"test-3","messages":[{"role":"user","content":"ping"}]}'
```

Yêu cầu: phản hồi mã trạng thái 200, hoàn thành câu trả lời mà không phát sinh chi phí token.

---

## 8. Bước 7: Thu Hồi Giấy Phép Ghi (revoke-grant)

Sau khi hoàn tất chuỗi kiểm thử, thu hồi giấy phép ngay:

```bash
routersync maintain revoke-grant
```

Kiểm tra lại để đảm bảo trạng thái trở về không có giấy phép:

```bash
routersync maintain grant-status
# Kết quả hiển thị: GRANT none
```
