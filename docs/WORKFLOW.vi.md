# Hướng Dẫn Vận Hành & An Toàn RouterSync

Tài liệu này hướng dẫn chi tiết quy trình vận hành hằng ngày với RouterSync: quan sát, đề xuất, phê duyệt bởi con người, áp dụng giao dịch an toàn và khôi phục khi có sự cố.

---

## 1. Triết Lý Vận Hành Cốt Lõi

RouterSync đồng bộ danh mục model và chuỗi combo dự phòng qua các router AI cục bộ (OmniRoute, 9Router) và các agent harness (Hermes Agent, DeepSeek Harness) mà không phát sinh chi phí inference.

Các nguyên tắc chính:
- **Quan Sát Không Tốn Token:** RouterSync không bao giờ gọi endpoint tính phí để kiểm tra model. Quá trình thăm dò dựa vào cấu hình cục bộ, database và các endpoint phát hiện zero-token.
- **Bắt Buộc Con Người Phê Duyệt:** Mọi thay đổi cấu hình không bao giờ được áp dụng tự động bởi tiến trình nền hay MCP agent.
- **Bảo Toàn Bất Biến:** Kế hoạch áp dụng phải thỏa mãn I1 (không trỏ model vắng mặt) và I8 (thứ tự ghi chuẩn).
- **An Toàn Cờ Lệnh:** Cờ `--yes` bị từ chối bởi chính sách an toàn của CLI; lệnh ghi bắt buộc có xác nhận TTY tương tác.

---

## 2. Thiết Lập & Cài Đặt

Khởi tạo cấu hình và quét các router cục bộ:
```bash
routersync init
routersync scan
```

Chẩn đoán cấu hình harness và phát hiện phụ thuộc vòng:
```bash
routersync doctor
```

Khởi chạy daemon cục bộ ở lát cắt chỉ đọc (S1):
```bash
routersync daemon --port 3128
```

Khởi chạy giao diện web UI cục bộ (kết nối daemon tại cổng 3128, nguồn: packages/ui/package.json):
```bash
pnpm --filter @routersync/ui dev
```

Cấu hình tích hợp MCP server vào agent harness ở chế độ chạy thử (dry-run):
```bash
routersync mcp install --client hermes
```
Đích ghi cấu hình agent (`~/.hermes/mcp_config.json`) hiện có trạng thái kiểm chứng là `UNVERIFIED` cho đến khi kiểm thử trên phiên bản harness trực tiếp.

---

## 3. Quan Sát & Phát Hiện Trôi Trạng Thái

Theo dõi router đang hoạt động và phát hiện độ lệch giữa cấu hình dự kiến và thực tế:
```bash
routersync status
```

---

## 4. Bảng Mức Độ Hoàn Thiện Tính Năng & UI Chỉ Đọc

Trạng thái sẵn sàng của các bề mặt vận hành:
- [WORKS TODAY — r44-cli-help] Bộ lệnh CLI: đầy đủ các lệnh status, scan, plan, apply, rollback, mcp, daemon, doctor.
- [WORKS TODAY — r44-mcp-tools] Công cụ MCP server: 17 tool chỉ đọc phục vụ kiểm tra và lập kế hoạch qua stdio.
- [WORKS TODAY — r44-mcp-install-dry] Tích hợp harness: xem trước khác biệt không phá hủy cho cấu hình agent.
- [NOT YET] Ghi trực tiếp trên trình duyệt: thực hiện lệnh ghi cấu hình từ web UI mà không qua xác nhận TTY.
- [NOT RUN] Tiến trình daemon nền tự động ghi cấu hình mà không có token phê duyệt từ con người.
- [UNVERIFIED] Đồng bộ cụm phân tán nhiều nút router.

Hôm nay UI chỉ-đọc: các nút ghi chỉ hiện lệnh CLI để chạy. Các nút thao tác ghi (Áp dụng, Duyệt, Hoàn tác, Tạm dừng) mở hộp thoại hiển thị lệnh CLI chuẩn để người dùng tự xác nhận trong terminal. RouterSync chỉ ghi khi bạn tự xác nhận ở terminal.

---

## 5. Đề Xuất Thay Đổi & Lập Kế Hoạch

Tạo kế hoạch thay đổi tất định mà không làm biến đổi trạng thái router:
```bash
routersync plan
```

---

## 6. Phê Duyệt Của Con Người & Áp Dụng Giao Dịch

Xem xét kỹ lưỡng khác biệt trong kế hoạch và áp dụng an toàn vào router:
```bash
routersync apply --write
```
- Lệnh apply yêu cầu xác nhận TTY tương tác; cờ `--yes` bị từ chối.
- Mỗi lần áp dụng thực hiện: snapshot trước ghi -> ghi nguyên tử -> kiểm tra phản ánh reload (mã: packages/adapter-9router/src/index.ts:506 hoặc UNVERIFIED) -> đọc lại kiểm chứng.

---

## 7. Khôi Phục Trạng Thái & Rollback

Khi phát hiện bất thường, lệnh rollback khôi phục trạng thái logic của router từ snapshot đã lưu:
```bash
routersync rollback
```
- Khôi phục logic theo cấp hàng bảo vệ tính toàn vẹn của hệ thống tệp router.
- Đọc lại kiểm chứng xác nhận tính nhất quán của router sau khi khôi phục (phản ánh router reload: UNVERIFIED).

---

## 8. Agent Harness & 17 Công Cụ MCP Chỉ Đọc

RouterSync cung cấp 17 công cụ MCP chỉ đọc cho agent harness:
1. Phát hiện & Cấu hình: `detect_routers`, `get_config`, `validate_config`, `get_schema`.
2. Model & Combo: `list_models`, `list_combos`, `list_traits`, `list_strategies`.
3. Sức khỏe & Trôi lệch: `status`, `drift`, `plan_status`, `audit_tail`.
4. Kế hoạch & Hướng dẫn: `plan`, `explain`, `search_docs`, `inbox_list`, `get_item`.

---

## 9. Ranh Giới An Toàn & Hợp Đồng Nghiệm Thu

Các hợp đồng bảo vệ tính an toàn và toàn vẹn của hệ thống:
- **T3-DAEMON-SEC:** Daemon chạy ở chế độ chỉ đọc (S1) gắn với localhost. Endpoint `POST /api/v1/changes/approve` tồn tại để kiểm tra token, nhưng chưa có nơi cấp token ngoài bộ test.
- **T3-DAEMON-PAYLOAD-TEXT:** Tính toàn vẹn dữ liệu được đảm bảo bằng type guard nghiêm ngặt ngăn chèn văn bản tùy tiện.
- **AT-84:** Xác minh bảo toàn các bất biến trong quá trình đánh giá kế hoạch.
- **AT-114:** Phép thử ghi 9Router thật (live router write test, hiện ở trạng thái NOT RUN; kiểm tra an toàn kind=NULL và tiền tố marker).
