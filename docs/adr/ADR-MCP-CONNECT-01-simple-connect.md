# ADR-MCP-CONNECT-01: Cơ chế kết nối MCP đơn giản và an toàn (Simple Connect)

- Trạng thái: PROPOSED
- Ngày đề xuất: 2026-10-28
- Phạm vi: Giao thức kết nối giữa RouterSync MCP Server và agent harness (Hermes Desktop, DeepSeek Harness, Claude Code).

## 1. Bối cảnh và vấn đề

RouterSync cung cấp công cụ MCP chỉ đọc (`routersync.read`) để AI agent tra cứu model, kiểm tra sức khỏe và lấy combo. Các client lưu cấu hình khác nhau:
- Hermes Desktop: đường dẫn cấu hình `config.yaml` hoặc trường `mcp_servers` được đánh dấu UNVERIFIED cho tới khi người dùng chạy kiểm tra trên máy thực tế.
- Claude Code dùng lệnh CLI `claude mcp add` hoặc cấu hình client.
- Cursor và các client VS Code dùng `mcp_config.json`.
- Giao thức hỗ trợ: tiến trình con `stdio` và mạng cục bộ `Streamable HTTP`.
- Các rủi ro an toàn cục bộ: chiếm cổng mạng, tấn công DNS rebinding, giả mạo yêu cầu CSRF, tấn công confused deputy và giả mạo redirect trong luồng OAuth.

## 2. Ma trận phân tích mối đe dọa theo phương án

Nguồn bất biến: .agent/ARCHITECTURE.md

| Phương án | Mã | Mối đe dọa | Rủi ro tác động | Biện pháp kỹ thuật |
|---|---|---|---|---|
| stdio | S-01 | Chiếm quyền tiến trình con | Khởi chạy nhị phân lạ | Chỉ trỏ đường dẫn file `packages/mcp-server/dist/index.js` chuẩn |
| stdio | S-02 | Rò rỉ biến môi trường | Đọc trộm secret | Redact khóa bí mật, không ghi nhận token ra stdout/stderr |
| stdio | S-03 | Lệnh ghi vượt thẩm quyền | Tác nhân confused deputy | Giới hạn quyền đọc, từ chối mutation qua stdio |
| stdio | S-04 | Treo luồng đọc ghi | Cạn kiệt CPU cục bộ | Timeout phiên giao tiếp 10 giây cho mọi frame JSON-RPC |
| HTTP | H-01 | Tấn công qua trình duyệt | Tấn công CSRF | Kiểm tra header Origin strictly bằng localhost |
| HTTP | H-02 | Tên miền độc hại trỏ về local | Tấn công DNS rebinding | Ràng buộc tiêu đề Host chỉ chấp nhận 127.0.0.1 hoặc localhost |
| HTTP | H-03 | Quét cổng cục bộ trái phép | Nguy cơ chiếm cổng | Dùng mã ghép nối ngẫu nhiên, so khớp giá trị băm SHA-256 |
| HTTP | H-04 | Chiếm đoạt phiên giao dịch | Nghe lén luồng HTTP | Token phiên ngẫu nhiên ngắn hạn, tự hủy sau 5 phút kèm giới hạn 5 lần thử |
| HTTP | H-05 | Lạm dụng tài nguyên | Tràn bộ đệm daemon | Giới hạn payload tối đa 1 MB, từ chối request dồn dập |
| OAuth | O-01 | Đánh cắp mã ủy quyền | Đánh chặn authorization code | Bắt buộc dùng PKCE (RFC 7636) cho public client |
| OAuth | O-02 | Lừa đảo chuyển hướng | Nguy cơ giả mạo redirect | Kiểm tra nghiêm ngặt URI chuyển hướng khớp danh sách trắng |
| OAuth | O-03 | Vượt cấp đặc quyền | Tác nhân confused deputy | Chỉ cấp scope hẹp `routersync.read` theo cơ chế RFC 8707 |
| OAuth | O-04 | Sai lệch đích tài nguyên | Gửi token nhầm dịch vụ | Xác thực metadata dịch vụ bảo vệ theo chuẩn RFC 9728 |
| OAuth | O-05 | Giả mạo máy chủ xác thực | Đăng nhập máy chủ giả | Kiểm tra chứng thực và endpoint cấp phát tin cậy |

## 3. Ánh xạ bất biến I1–I8 theo phương án kết nối

| Bất biến | Mô tả bất biến RouterSync | Phương án stdio | Phương án Streamable HTTP | Phương án OAuth / PKCE |
|---|---|---|---|---|
| I1 | Combo managed không trỏ model hỏng | Chỉ đọc catalog thật từ SQLite | Tra cứu trạng thái model qua daemon | Xác thực model hợp lệ qua scope |
| I2 | Model quarantined/dead không vào top | Lọc trạng thái trong engine core | Báo lỗi khi model cách ly | Trả mã cảnh báo trong metadata |
| I3 | Combo giữ tối thiểu 2 bước dự phòng | Không cho phép hạ chuẩn bước | Từ chối yêu cầu thiếu model | Chặn cấu hình vi phạm số bước |
| I4 | Áp dụng hai lần không phát sinh đổi | Không hỗ trợ ghi qua stdio | Không mở endpoint ghi trên daemon | Không cấp quyền ghi từ xa |
| I5 | Không can thiệp combo unmanaged | Chỉ trả về combo managed | Phân loại rõ managed và custom | Phân quyền truy cập theo định danh |
| I6 | Combo freeOnly không chứa metered | Kiểm tra cờ free trên catalog | Báo lỗi nếu combo vi phạm | Xác minh đặc tính model theo chuẩn |
| I7 | Tối thiểu 2 nhà cung cấp độc lập | Kiểm tra độc lập provider | Cảnh báo khi trùng lặp nguồn | Kiểm soát đa dạng nhà cung cấp |
| I8 | Thứ tự ghi: providers, models, combos | Ghi tuần tự ở adapter local | Áp dụng kế hoạch theo thứ tự | Giữ nguyên thứ tự ghi bất biến |

## 4. Các phương án kỹ thuật chi tiết

### Phương án 1: Giao thức stdio (Ưu tiên mặc định)
- Cơ chế: Agent khởi chạy tiến trình con MCP độc lập qua Node.js.
- Đường dẫn thực thi: `node packages/mcp-server/dist/index.js`.
- Ưu điểm: Cách ly hoàn toàn, không mở cổng mạng, an toàn trước CSRF và DNS rebinding.

### Phương án 2: Streamable HTTP kèm mã ghép nối
- Cơ chế: Agent kết nối qua endpoint Streamable HTTP trên daemon cục bộ (`127.0.0.1:3128`).
- An toàn: Người dùng bật tính năng kết nối trên UI, hệ thống sinh một mã ghép nối ngắn hạn (ví dụ `739-104`) có thời hạn 5 phút và tối đa 5 lần thử.
- Xác thực: Daemon chỉ lưu giá trị băm SHA-256 của mã ghép nối. Client gửi mã ghép nối qua tiêu đề Authorization để nhận token phiên.
- Bảo vệ: Kiểm tra tiêu đề Host và Origin để ngăn chặn DNS rebinding và CSRF.

### Phương án 3: OAuth 2.0 kèm PKCE (Dự kiến mở rộng)
- Hỗ trợ ủy quyền nâng cao qua RFC 8707 (Resource Indicators) và RFC 9728 (Protected Resource Metadata).
- Ứng dụng PKCE ngăn ngừa đánh cắp mã và chống giả mạo redirect.
- Lộ trình: Xếp lịch đánh giá chi tiết và thử nghiệm ở vòng R49.

## 5. Màn hình giao diện Kết nối agent

Màn hình "Kết nối agent" trên RouterSync UI hỗ trợ người dùng tích hợp:
1. Hiển thị danh sách agent được hỗ trợ: Hermes Desktop, DeepSeek Harness, Claude Code, Cursor.
2. Hộp cấu hình tạo sẵn: Cho phép sao chép đoạn JSON/YAML để dán vào `mcp_config.json` hoặc cấu hình tương ứng.
3. Khối lệnh mẫu sử dụng đường dẫn stdio chuẩn trỏ tới `packages/mcp-server/dist/index.js`.
4. Nếu kết nối qua HTTP, hiển thị mã ghép nối kèm đồng hồ đếm ngược hiệu lực 5 phút.

## 6. Lộ trình triển khai

- Vòng R47: Hoàn thiện tài liệu kiến trúc ADR-MCP-CONNECT-01, chốt ma trận rủi ro và kiểm chứng tính khả thi.
- Vòng R48: Hiện thực hóa mã nguồn giao thức stdio (`mcp install --print`, ghi nhận client trong daemon và mcp-server), xây dựng giao diện "Kết nối agent" và kiểm thử liên vận hành.
- Vòng R49: Đánh giá mô hình Streamable HTTP và chuẩn bị kịch bản mã ghép nối.
- Vòng R50 (đã làm): Hiện thực hóa máy chủ loopback HTTP qua lệnh `routersync mcp serve-http` gắn cổng `127.0.0.1`. Hệ thống quản lý mã ghép nối một lần 5 phút qua `mcp pair`, lưu băm SHA-256 an toàn trong tệp trạng thái `mcp-tokens.json` và `mcp-pairing.json`, kiểm tra nghiêm ngặt tiêu đề Host và Origin để chống DNS rebinding / CSRF, đồng thời hỗ trợ thu hồi token tức thì qua `mcp revoke` và liệt kê qua `mcp list`. Lộ trình tiếp theo sẽ nghiên cứu tích hợp tiêu chuẩn OAuth 2.0 PKCE đầy đủ cho các client đám mây.

