# Khảo Sát Chỉ Đọc: Lưu Trữ Model Tiers Trong 9Router Và OmniRoute

## 1. Phương pháp khảo sát
- Thực hiện ở chế độ chỉ đọc trên bản sao cơ sở dữ liệu đặt tại thư mục tạm của hệ điều hành (`%TEMP%\rs-survey-*`).
- Không mở trực tiếp cơ sở dữ liệu gốc để ghi, không dừng tiến trình router.
- Toàn bộ giá trị nhạy cảm (API keys, JWT secrets, passwords, hash) được che bằng `[ẩn]` hoặc không trích xuất.

---

## 2. Kết quả khảo sát 9Router

### 2.1. Cấu trúc bảng và số dòng
Bản sao SQLite của 9Router chứa **11 bảng**:
- `_meta` (4 dòng): key-value cấu hình cơ bản (`version`, `migration`, v.v.).
- `apiKeys` (7 dòng): quản lý khóa truy cập của client router.
- `combos` (9 dòng): danh sách combo định tuyến (`id`, `name`, `kind`, `models` [JSON array], `createdAt`, `updatedAt`).
- `kv` (10.634 dòng): lưu trữ key-value phân vùng theo `scope` (TEXT, PK), `key` (TEXT, PK), `value` (TEXT).
- `providerConnections` (40 dòng): cấu hình kết nối provider (`id`, `provider`, `authType`, `name`, `email`, `priority`, `isActive`, `data`, `createdAt`, `updatedAt`).
- `providerNodes` (10 dòng): các nút provider tương thích OpenAI tuỳ chỉnh (`id`, `type`, `name`, `data`, `createdAt`, `updatedAt`).
- `proxyPools` (0 dòng).
- `requestDetails` (1.000 dòng): nhật ký yêu cầu chi tiết.
- `settings` (1 dòng): cài đặt hệ thống (`data` chứa `comboStrategies`, `providerStrategies`, v.v.).
- `usageDaily` (127 dòng): thống kê tiêu thụ theo ngày.
- `usageHistory` (108.785 dòng): lịch sử gọi API.

### 2.2. Vị trí lưu trữ Model Tiers trong 9Router
1. **Model đã tắt (Disabled models - Tầng B):**
   - Lưu trữ trong bảng `kv` với `scope = 'disabledModels'`.
   - Cột `key` là tên provider (ví dụ: `gemini`, `mistral`, `siliconflow`, `kc`, `ds`, `oc`, `nvidia`).
   - Cột `value` là mảng JSON chứa danh sách các model ID đã bị tắt.
   - Đối chiếu thực tế: `key = 'gemini'` có giá trị:
     `["gemini-3.1-flash-lite-preview","gemini-3-flash-preview","gemini-2.5-pro","gemini-2.5-flash","gemini-2.5-flash-lite","gemini-3.5-flash-lite","gemini-3.1-pro-preview","gemini-3.6-flash","gemini-3.7-flash"]` -> **Đúng 9 model** trong mảng JSON.
2. **Model tuỳ chỉnh do người dùng thêm (Custom models):**
   - Lưu trữ trong bảng `kv` với `scope = 'customModels'`.
   - Cột `key` có định dạng `<provider>|<model_id>|<type>`.
   - Cột `value` chứa JSON `{ "providerAlias": ..., "id": ..., "type": "llm", "name": ... }`.
   - Toàn bộ bảng `kv` có 435 dòng model tuỳ chỉnh trên tất cả các provider. Riêng với Google Gemini, chỉ có đúng **3 model tuỳ chỉnh** bắt đầu bằng `gemini|`:
     * `gemini|gemini-3.7-flash|llm`
     * `gemini|gemini-flash-latest|llm`
     * `gemini|gemini-4-argon|llm`
     *(Đính chính: Báo cáo C4v ghi nhầm model thứ ba là `models/gemini-2.5-flash`, kết quả truy vấn thực tế xác nhận đúng là `gemini-4-argon` khớp với báo cáo C4w).*
3. **Model đang bật / khả dụng (Available models - Tầng A):**
   - Đối với custom OpenAI nodes (`openai-compatible-chat-*`): Danh sách model được bật lưu trực tiếp trong `providerConnections.data -> providerSpecificData.enabledModels` (mảng JSON các model ID).
   - Đối với built-in providers (Google Gemini, Antigravity, Mistral, v.v.): Giao diện 9Router tính toán danh sách "Available Models" độc lập với cấu hình connection, theo công thức:
     $$\text{Available Models} = (\text{Built-in provider registry} \cup \text{customModels} \cup \text{modelAliases}) \setminus \text{disabledModels} \quad (\text{loại llm})$$
   - **Mã nguồn giao diện 9Router tính toán Available Models:** Được xác minh trực tiếp từ các bundle:
     * `app/.next-cli-build/static/chunks/1321-2fde166305caeddb.js` (module `72940`): Lưu trữ từ điển provider registry tích hợp sẵn, chứa danh sách model chuẩn hóa và alias prefix của từng provider.
     * `app/.next-cli-build/static/chunks/5497-2d39b4ce6857f490.js` (module `29281` hàm `u()`, module `81231` hàm `r()`): Lấy danh sách built-in từ module `72940`, hợp với `customModels` và `modelAliases`, sau đó trừ đi các model ID trong `disabledModels`.
     * `app/.next-cli-build/static/chunks/761-4ab39a76a6565658.js` (hàm `es()`): Render danh sách model khả dụng lên trang nhà cung cấp.
     * **Thu hồi kết luận W4:** Báo cáo C4w W4 cho rằng giao diện coi cả 63 model live trừ 9 disabled là đang bật (xếp 36 model vào Tầng A) là **sai lệch**. Thực tế `enabledModels` trong connection không quyết định danh sách Available Models của giao diện.
4. **Model Lock (Khóa model):**
   - Lưu trong trường JSON `providerConnections.data` dưới các khóa `modelLock_<model_id>`.
   - Giá trị là timestamp ISO (nếu bị khóa tạm thời do lỗi/rate limit) hoặc `null` (nếu bình thường).
5. **Model gợi ý (Suggested models):**
   - Không lưu trong bảng SQLite riêng biệt.
   - Được lọc động tại phía giao diện client từ tệp tĩnh `model-catalog.json` (6.379 model) dựa trên thẻ free/pricing.

---

## 3. Kết quả khảo sát OmniRoute

### 3.1. Cấu trúc bảng liên quan và Đính chính Bảng Không Tồn Tại
Cơ sở dữ liệu SQLite của OmniRoute chứa tổng cộng **132 bảng** (131 bảng ứng dụng + bảng hệ thống `sqlite_sequence`).

> **ĐÍNH CHÍNH QUAN TRỌNG (Thu hồi báo cáo C4t §2.2):**  
> Qua khảo sát thực nghiệm trực tiếp trên bản sao database `storage.sqlite` qua câu lệnh `SELECT name FROM sqlite_master WHERE type='table'`, **KHÔNG CÓ BẤT KỲ BẢNG NÀO** trong số 9 bảng sau đây tồn tại trong cơ sở dữ liệu OmniRoute:
> 1. `model_usage_metrics` (KHÔNG TỒN TẠI)
> 2. `model_error_logs` (KHÔNG TỒN TẠI)
> 3. `model_latency_stats` (KHÔNG TỒN TẠI)
> 4. `model_fallbacks` (KHÔNG TỒN TẠI)
> 5. `model_routing_rules` (KHÔNG TỒN TẠI)
> 6. `model_rate_limits` (KHÔNG TỒN TẠI)
> 7. `provider_node_models` (KHÔNG TỒN TẠI)
> 8. `provider_model_mappings` (KHÔNG TỒN TẠI)
> 9. `model_price_overrides` (KHÔNG TỒN TẠI)
> Toàn bộ các phân tích dựa trên 9 bảng trên trong các báo cáo sơ thảo trước đây chính thức được thu hồi.

### 3.2. Khảo sát Thực Nghiệm Các Bảng Thực Tế trong OmniRoute
1. **Bảng `key_value` (2.812 dòng):**
   - Cấu trúc: `namespace` (TEXT), `key` (TEXT), `value` (TEXT).
   - Thống kê các namespace chính:
     * `modelAliases`: 1.581 dòng (ánh xạ alias model sang ID gốc).
     * `lkgp`: 468 dòng (Last Known Good Parameters / probes).
     * `gemini_thought_signatures`: 418 dòng.
     * `models_dev_pricing`: 239 dòng (dữ liệu giá model).
     * `syncedAvailableModels`: 33 dòng (cache model danh mục theo connection).
     * `databaseSettings`: 29 dòng.
     * `settings`: 14 dòng.
     * `compression`: 9 dòng.
     * `customModels`: 7 dòng.
     * `gamification:streaks`: 7 dòng.
     * `modelCompatOverrides`: 3 dòng.
     * `secrets`: 2 dòng.
     * `apiKeySelfService`: 1 dòng.
     * `scheduler`: 1 dòng.
2. **Bảng `provider_connections` (34 dòng):**
   - Thông tin kết nối provider (`id`, `provider`, `auth_type`, `name`, `is_active`, `api_key` [encrypted], `provider_specific_data`, v.v.).
   - Cột `provider_specific_data`: Chứa JSON thiết lập bổ trợ, đáng chú ý nhất là cờ `importFreeModelsOnly: true` (có mặt trên 22/34 kết nối như Groq, Gemini, Mistral, OpenRouter, v.v.). Không có trường `disabledModels` cấp người dùng.
3. **Bảng `model_capabilities` (10.429 dòng):**
   - Từ điển năng lực toàn diện của mọi model đã biết trên các provider (`provider`, `model_id`, `tool_call`, `reasoning`, `status`, `limit_context`, v.v.).
   - Cột `status`: `null` (9.212), `deprecated` (1.136), `beta` (79), `alpha` (2).
4. **Bảng `combos` (10 dòng):**
   - Danh sách combo định tuyến (`id`, `name`, `data`, `sort_order`, v.v.). Các model được định nghĩa trong cột `data`.
5. **Các bảng model khác được kiểm tra:**
   - `model_probes` (10.169 dòng): nhật ký thăm dò telemetry (`probed_at`, `model`, `provider`, `verdict`, `status`, `duration_ms`...). Không chứa trạng thái bật/tắt model.
   - `model_combo_mappings` (14 dòng): bảng ánh xạ pattern chuỗi sang combo ID (`pattern`, `combo_id`, `priority`, `enabled`). Không chứa cờ bật/tắt model của router.
   - `provider_nodes` (3 dòng): danh sách nút provider tùy chỉnh (`node-b`, `AI Hub Mix`, `ModelBridge`). Không quản lý trạng thái bật/tắt model.
   - `group_model_permissions` (0 dòng): phân quyền model theo nhóm người dùng (chưa có dữ liệu).
   - `radar_local_model_state` (0 dòng): schema dự phòng chứa cột `enabled`, `tombstoned` nhưng chưa có dữ liệu.
   - `discovery_results` (0 dòng), `tier_assignments` (0 dòng).
   - **Kết luận:** Cơ chế bật/tắt model cấp router ngoài combo: **chưa tìm thấy** cơ chế đã xác minh trong SQLite của OmniRoute. Model ngoài combo được gán `UNKNOWN` để bảo đảm an toàn.

---

## 4. Đối chiếu số liệu với giao diện

| Đối tượng | Giao diện | Cơ sở dữ liệu | Khớp / Lệch & Giải thích |
|---|---|---|---|
| **Gemini (9Router) - Tắt** | 9 model (ảnh chụp 2026-11-16 08:05) | `kv` (`scope='disabledModels'`, `key='gemini'`): đúng 9 model | **Khớp chính xác 9 model**: `gemini-3.7-flash`, `gemini-3.6-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-pro-preview`, `gemini-3.1-flash-lite-preview`, `gemini-3-flash-preview`, `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`. |
| **Gemini (9Router) - Khả dụng (Available / Tầng A)** | **Đúng 4 model** (ảnh chụp màn hình 2026-11-16 08:05: `gemini-flash-latest`, `gemini-4-argon`, `gemini-3.8-flash`, `gemma-4-31b-it`) | Công thức: (Built-in [2] $\cup$ Custom [3] $\cup$ Aliases [0]) $\setminus$ Disabled [9].<br>- Built-in: `gemini-3.8-flash`, `gemma-4-31b-it`.<br>- Custom: `gemini-3.7-flash`, `gemini-flash-latest`, `gemini-4-argon`.<br>- Giao thoa bị tắt: `gemini-3.7-flash`.<br>$\rightarrow$ Kết quả: đúng 4 model. | **Các tập này bằng nhau trong lần đối chiếu ngày 2026-11-16 với ảnh chụp màn hình giao diện thật**. Báo cáo W4 cũ (xếp 36 model vào Tầng A) bị loại bỏ do không khớp giao diện thực tế. 31 model có trong combo nhưng không thuộc Available Models (`gemini-3.5-flash`, `gemini-3.1-flash-lite`, `gemma-4-26b-a4b-it`, v.v.) được phân loại là Tầng `UNKNOWN` với cờ `inconsistent=true`, `inCombo=true` và không phát sinh đề xuất. |
| **Antigravity (9Router) - Khả dụng (Tầng A)** | **Đúng 33 model** có tiền tố `ag/` (ảnh chụp 2026-11-16 08:05) | Built-in provider registry (module 72940 alias `ag`): đúng 33 model, không có model tắt trong `kv`. | **Khớp chính xác 33 model** với giao diện thật. |
| **OpenCode Zen - Gợi ý** | Chưa kiểm tra trên UI live | `model_capabilities` có 155 model `opencode-zen`, 444 model nhóm opencode | **Chưa kiểm tra**: Hiện tại chưa có ảnh chụp màn hình hoặc dữ liệu kiểm chứng trực tiếp trên giao diện live của OpenCode Zen. Mọi suy đoán trước đây về bộ lọc ~80 model chưa được coi là bằng chứng xác thực. |

---

## 5. Kết quả kiểm tra điểm cuối HTTP của Router (Chỉ GET)

- **9Router (Cổng 20128):**
  - `GET /api/providers/gemini/models`: Trả về HTTP `401 Unauthorized`. Điểm cuối này có tồn tại trong mã nguồn Next.js nhưng yêu cầu phiên đăng nhập quản trị (session cookie / internal JWT), không chấp nhận Bearer API Key thông thường của client.
  - `GET /api/provider-connections`: Trả về HTTP `401 Unauthorized`.
  - `GET /v1/models`: Điểm cuối công khai OpenAI-compatible; trả về danh sách model tổng hợp phục vụ client, không có tham số lọc theo provider nội bộ.
- **OmniRoute (Cổng 30128):**
  - Tiến trình OmniRoute hiện đang đứng yên (port đóng).
  - Schema mã nguồn hỗ trợ `GET /v1/models` tổng hợp công khai; các API quản trị provider yêu cầu header xác thực quản trị.

---

## 6. Khảo sát LiteLLM: Khái niệm "Tắt" model trong cấu hình

- **Tài liệu chính thức:**
  - Cấu hình chung: `https://docs.litellm.ai/docs/proxy/configs`
  - Cấu trúc định tuyến: `https://docs.litellm.ai/docs/routing`
  - Quản lý model qua API: `https://docs.litellm.ai/docs/proxy/model_management`
- **Kết luận:**
  - Trong tệp cấu hình tĩnh `config.yaml` của LiteLLM, danh sách `model_list` **KHÔNG** có thuộc tính hoặc khái niệm "tắt" (`disabled: true` hay `is_active: false`). Mọi model được khai báo trong `model_list` đều được coi là sẵn sàng định tuyến. Để tắt một model trong cấu hình tĩnh, người quản trị bắt buộc phải xoá hoặc comment dòng cấu hình đó.
  - Trong LiteLLM Proxy chạy kèm cơ sở dữ liệu (`LiteLLM_ProxyModelTable`), model được thêm/xoá động qua các endpoint `/model/new` và `/model/delete`. Schema database có hỗ trợ cờ xóa mềm (tombstone) hoặc xóa hẳn dòng, nhưng trong file YAML tĩnh không có khái niệm Tầng B (disabled).
