# ADR-MCP-CONNECT-01: Kiến trúc kết nối Agent qua MCP Streamable HTTP SDK và lộ trình OAuth

- **Trạng thái:** PROPOSED
- **Ngày:** 2026-11-01
- **Phạm vi:** packages/mcp-server, packages/cli
- **Mức độ kiểm chứng:** UNVERIFIED (chờ xác nhận thực tế với các client MCP)

## 1. Ngữ cảnh và vấn đề

RouterSync cung cấp công cụ MCP chỉ-đọc để AI agent (Claude Code, Cursor, Codex, Hermes...) tra cứu danh mục mô hình, combo và sức khỏe router.
Ở Round 50, máy chủ HTTP MCP được triển khai bằng bộ định tuyến JSON-RPC tự viết trên `node:http`. Tuy nhiên, các client MCP chính thức yêu cầu giao thức chuẩn hoá dựa trên `@modelcontextprotocol/sdk`.
Mục tiêu là chuyển dịch sang sử dụng `StreamableHTTPServerTransport` từ MCP SDK chính thức, bảo đảm tính tương thích cao với hệ sinh thái client, đồng thời duy trì mô hình an toàn loopback và vạch ra lộ trình tích hợp OAuth trong tương lai.

## 2. Quyết định kiến trúc

### 2.1. Sử dụng transport chính thức từ MCP SDK

- Thay thế bộ xử lý JSON-RPC tự viết bằng `StreamableHTTPServerTransport` từ gói `@modelcontextprotocol/sdk/server/streamableHttp.js`.
- Đăng ký công cụ thông qua API công khai của SDK (`server.setRequestHandler(ListToolsRequestSchema, ...)` và `server.setRequestHandler(CallToolRequestSchema, ...)`).
- Không truy cập vào thuộc tính nội bộ `_registeredTools`.
- Mọi công cụ khai báo `inputSchema` dạng `object` theo chuẩn JSON Schema do Zod sinh ra.

### 2.2. Mô hình đe dọa và rào chắn an toàn loopback

Máy chủ HTTP MCP vận hành trên máy cục bộ với các rào chắn:
1. **Ràng buộc địa chỉ:** Chỉ lắng nghe trên giao diện loopback `127.0.0.1`.
2. **Kiểm tra tiêu đề:** Chặn tấn công DNS rebinding bằng cách kiểm tra tiêu đề `Host` (chỉ chấp nhận `127.0.0.1` hoặc `localhost` kèm cổng tương ứng). Chặn tấn công CSRF qua trình duyệt bằng cách kiểm tra tiêu đề `Origin` nếu có.
3. **Cơ chế ghép nối (Pairing):** Mã ghép nối ngắn hạn dạng `XXXX-XXXX`, có hiệu lực trong 5 phút và tự hủy sau khi dùng hoặc sau 5 lần thử thất bại.
4. **Xác thực token:** Token Bearer ngẫu nhiên được băm SHA-256 trước khi lưu vào `mcp-tokens.json`. So khớp giá trị băm trong bộ nhớ bằng `crypto.timingSafeEqual` để chống tấn công thời gian.
5. **Thu hồi tức thì:** Tệp `mcp-tokens.json` được đọc lại ở mỗi yêu cầu hoặc kiểm tra danh sách thu hồi trực tiếp.
6. **Giới hạn kích thước payload:** Từ chối mọi yêu cầu có `Content-Length` vượt quá 1 MB.

### 2.3. Lộ trình tích hợp OAuth trong tương lai

Khi RouterSync hỗ trợ các tác nhân từ xa hoặc mô hình ủy quyền người dùng phân tán:
- **Chuẩn OAuth 2.1 với PKCE (RFC 7636):** Bắt buộc cho public client, loại bỏ grant type implicit và mật khẩu.
- **Phạm vi quyền hẹp (Scope):** Chỉ cấp scope đọc `routersync.read` theo cơ chế phân tách tài nguyên (RFC 8707).
- **Xác thực chuyển hướng:** Kiểm tra danh sách trắng redirect URI để ngăn ngừa lừa đảo chuyển hướng.
- **Xác thực metadata máy chủ:** Tuân thủ RFC 9728 về phát hiện metadata dịch vụ bảo vệ.

## 3. Hệ quả

- Tính tương thích chuẩn xác với mọi client tuân thủ MCP SDK.
- Giảm thiểu mã nguồn tự duy trì cho tầng giao thức JSON-RPC.
- Tách biệt rõ ràng giữa xác thực loopback bằng token SHA-256 hiện tại và lộ trình OAuth cho giai đoạn tiếp theo.
