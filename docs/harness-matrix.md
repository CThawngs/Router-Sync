# Ma Trận Năng Lực Harness — RouterSync C45 WP1

- **Phục vụ:** `S2`, `S3`, `S6`
- **Ngày xác minh:** `2026-11-24`
- **Phạm vi:** 9 harness (toàn bộ 8 harness trong mục S2 + `dsh` để giữ tương thích hiện có)
- **Tệp dữ liệu máy đọc:** `harness-matrix.json` (schema v1)
- **Nguyên tắc bằng chứng:**
  - **Bậc `A`:** Quan sát trực tiếp chỉ đọc trên máy chủ Windows 11 (chỉ kiểm tra tồn tại tệp & cấu trúc khóa, **0 bí mật / 0 tên người dùng / 0 đường dẫn cá nhân**) + đối chiếu tài liệu chính thức của hãng.
  - **Bậc `B`:** Xác minh từ tài liệu chính thức của hãng (kèm URL chuẩn & ngày `2026-11-24`).
  - **Bậc `C` (`CHƯA-XÁC-MINH`):** Không đoán khi thiếu bằng chứng.

---

## 1. Bảng Tóm Tắt Ma Trận (C45 §5)

| Harness | MCP (định dạng & tệp chính) | Lịch chạy gốc (chạy script 0 token?) | Sửa được danh sách model (Hướng A) | Agent chạy shell? | Cần nạp lại? | Bậc bằng chứng |
| :--- | :--- | :--- | :--- | :---: | :---: | :---: |
| **`hermes`** (Hermes Agent) | YAML — `%LOCALAPPDATA%/hermes/config.yaml` (Win32) / `~/.hermes/config.yaml` (`mcp_servers`) | **Có — 0 token (`true`)** (`cron/jobs.json`, `no_agent: true` + `script`) | **Có (`write-adapter`)** — `providers.<id>.models` & `custom_providers` | Có (`true`) | Có (MCP `/reload-mcp`; gateway/session restart) | **A** |
| **`claude-code`** (Claude Code) | JSON — `~/.claude.json` (`mcpServers`) & `.mcp.json`; CLI `claude mcp add` | Có nhưng **chỉ chạy LLM (`false`)** (`/loop`, Desktop/Cloud Tasks) | **Chỉ báo cáo (`report-only`)** — Anthropic-centric, không có danh sách model đa provider trên đĩa | Có (`true`) | Có (khởi động lại phiên) | **A** |
| **`codex`** (OpenAI Codex) | TOML — `~/.codex/config.toml` (`[mcp_servers.<name>]`); CLI `codex mcp add` | Có trên Desktop/Web nhưng **chỉ chạy LLM (`false`)** (`automation.toml`) | **Chỉ báo cáo (`report-only`)** — `[model_providers.<id>]` không chứa mảng `models[]` (chỉ có 1 slot `model` mặc định hoặc `model_catalog_json` tùy chọn) | Có (`true`) | Có (khởi động lại CLI/Desktop) | **A** |
| **`antigravity`** (Google Antigravity) | JSON — `~/.gemini/config/mcp_config.json` (`mcpServers`; không ghi `type` cho stdio) | **Có — 0 token (`true`)** (`sidecars/<id>/sidecar.json` với `builtin: "schedule"`) | **Chỉ báo cáo (`report-only`)** — danh mục model do Google quản lý qua UI (**Settings > Models**) | Có (`true`) | Có (Restart MCP hoặc app) | **A** |
| **`opencode`** (OpenCode) | JSONC — `~/.config/opencode/opencode.json` (`mcp.<name>`, `type: "local"`, `command: [...]`) | **Không có (`false`)** (chỉ có GitHub Actions / plugin cộng đồng) | **Có (`write-adapter`)** — `provider.<id>.models.<model_id>` | Có (`true`) | Có (khởi động lại phiên/TUI) | **A** |
| **`cursor`** (Cursor IDE & CLI) | JSON — `~/.cursor/mcp.json` (`mcpServers`); CLI `agent mcp add` | Có trên Cloud/SDK nhưng **chỉ chạy LLM / không chạy script cục bộ (`false`)** | **Chỉ báo cáo (`report-only`)** — UI/Cloud & SQLite nội bộ `state.vscdb` (không an toàn sửa trên đĩa) | Có (`true`) | Có (Reload MCP / cửa sổ) | **A** |
| **`grok-bot`** (xAI Grok Bot) | **Chỉ Remote HTTPS MCP** (từ chối `localhost`/stdio cục bộ; xem ghi chú CLI `grok`) | Có Cloud Routines nhưng **chỉ chạy LLM (`false`)** | **Chỉ báo cáo (`report-only`)** — không có bộ chọn model thủ công / không có tệp model cục bộ | Có (`true`, máy đám mây) | Không (đồng bộ đám mây) | **B** |
| **`openmausbot`** (OpenMausBot) | JSON — `~/.openmausbot/config.json` (`mcpServers`) | Có Croner Routines nhưng **chỉ chạy LLM (`false`)**; cấm sửa tay `routines.json` | **Có (`write-adapter`)** — `config.json` `instances.<id>.config.managedModels` (cho `openai-compat`); **cấm sửa `bots.json`** | Có (`true`) | Có (khởi động lại app để nạp `instances`) | **A** |
| **`dsh`** (DeepSeek Harness) | YAML — `~/.dsh/profiles/desktop/cordis.patch.yml` (`- insert:` `@deepseek-ai/dsh-mcp-client`) | Có `@deepseek-ai/dsh-schedule` nhưng **chỉ gửi prompt LLM (`false`)** | **Có (`write-adapter`)** — `llm-pi-ai` `config.providers.<id>.models[]` (giữ nguyên toàn bộ khối `config` Cordis) | Có (`true`) | Model: Không (nạp theo request); MCP: Có/HMR | **A** |

---

## 2. Quyết Định Kiến Trúc Cho WP2 (Hướng A) & WP7 (Thang Lịch Chạy)

### 2.1. Phạm Vi Adapter Ghi Hướng A (WP2 — S3)
1. **Nhóm `write-adapter` (4 harness, đều xác minh bậc A):**
   - `hermes` (`%LOCALAPPDATA%/hermes/config.yaml` trên Win32 / `~/.hermes/config.yaml` trên macOS/Linux)
   - `opencode` (`~/.config/opencode/opencode.json` / `.jsonc`)
   - `openmausbot` (`~/.openmausbot/config.json` — **chỉ** `instances.<id>.config.managedModels` của driver `openai-compat`, tuyệt đối không đụng `bots.json`, `routines.json`, `defaultModelSelection`, `config.model`)
   - `dsh` (`~/.dsh/profiles/desktop/cordis.patch.yml` — **chỉ** `models[]` của provider đã có key trong hàng `@deepseek-ai/dsh-llm-pi-ai`, bắt buộc bảo toàn nguyên hàng `config` theo luật Cordis và kiểm tra tiến trình đang chạy)
2. **Nhóm `report-only` (5 harness — Hướng A chỉ báo cáo & hướng dẫn, không ghi tệp model):**
   - `claude-code`, `codex`, `antigravity`, `cursor`, `grok-bot`.

### 2.2. Thang Lịch Chạy 0 Token (WP7 — S6, S7)
- **Bậc 1 (Lịch gốc của harness chạy script 0 token):** Chỉ có **2 harness** đạt chuẩn xác minh:
  - `hermes`: `cron/jobs.json` với `no_agent: true` + `script` nằm trong `<HERMES_HOME>/scripts/`.
  - `antigravity`: `~/.gemini/config/sidecars/<id>/sidecar.json` với `builtin: "schedule"` + kích hoạt trong `~/.gemini/config/config.json` (`sidecars.<id>.enabled = true`).
  - *Lưu ý:* Cả hai vẫn yêu cầu gateway/app tương ứng đang chạy; cần kết hợp Bậc 2 (OS scheduler) khi máy dùng ở chế độ không bật sẵn app.
- **Bậc 2 (Bộ lập lịch hệ điều hành qua `routersync schedule install`) & Bậc 3 (`tick_if_due`):** Áp dụng cho **tất cả 7 harness còn lại** (`claude-code`, `codex`, `opencode`, `cursor`, `grok-bot`, `openmausbot`, `dsh`) và làm lớp dự phòng tin cậy cho `hermes` / `antigravity`.

---

## 3. Chi Tiết Từng Harness `(a)` – `(e)`

### 3.1. `hermes` — Hermes Agent (Nous Research)
- **(a) Cấu hình MCP & Lệnh cài:**
  - **Đường dẫn:**
    - `win32`: `%LOCALAPPDATA%/hermes/config.yaml` (bản cài Windows native; `~/.hermes/config.yaml` dùng cho WSL2/di sản; ưu tiên biến môi trường `HERMES_HOME`).
    - `darwin` / `linux`: `~/.hermes/config.yaml`.
  - **Định dạng & Schema:** YAML, khóa gốc `mcp_servers.<name>`. Stdio dùng `{ command, args, env?, enabled? }` (hỗ trợ nội suy `${VAR}` và `${env:VAR}`); HTTP dùng `{ url, headers?, auth?, timeout?, trust? }` (OAuth token tách riêng tại `<HERMES_HOME>/mcp-tokens/`).
  - **Lệnh cài gốc:** `hermes mcp add <name> -- <command> <args...>` (kèm `hermes mcp test`, `/reload-mcp` trong chat).
  - **Chiến lược `routersync mcp install --client hermes`:** Gộp YAML bảo toàn chú thích vào `mcp_servers.<name>`, ưu tiên `$HERMES_HOME/config.yaml` → `%LOCALAPPDATA%/hermes/config.yaml` (Win32 nếu tồn tại) → `~/.hermes/config.yaml`.
- **(b) Lịch chạy gốc & 0 token:**
  - **Có lịch gốc:** Có — bộ lập lịch tích hợp của Hermes gateway (`%LOCALAPPDATA%/hermes/cron/jobs.json` trên Win32; `~/.hermes/cron/jobs.json` trên macOS/Linux/WSL2).
  - **Chạy script 0 token (`zeroTokenScriptCapable`):** **`true`** — chế độ chính thức *Script-Only Cron Jobs (No LLM)* dùng `"no_agent": true` và `"script"` nằm trong `<HERMES_HOME>/scripts/`. Không gọi LLM, 0 token.
- **(c) Danh sách Provider & Model (Hướng A):**
  - **Vị trí & định dạng:** `config.yaml` (YAML); API key tách riêng ở `<HERMES_HOME>/.env`.
  - **Cấu trúc:** `providers.<id>.models` (quan sát trực tiếp trên bản Windows native kèm `base_url`, `api`, `key_env`, `discover_models`) và `custom_providers[].models`.
  - **Sửa an toàn trên đĩa:** **Có** — tệp cấu hình dành cho người dùng. Không được đụng các slot mặc định (`model.default`, `model.provider`, `model.base_url`, `cron.model`).
  - **Cần nạp lại:** Có (khởi động lại gateway hoặc phiên mới; riêng MCP có `/reload-mcp`).
  - **Chế độ Hướng A (`directionAMode`):** **`write-adapter`**.
- **(d) Agent chạy lệnh shell:** **`true`** (bộ công cụ terminal trên local / Docker / SSH / WSL).
- **(e) Bậc bằng chứng:** **`A`**
  - Quan sát chỉ đọc trên máy Windows 11: `%LOCALAPPDATA%/hermes/config.yaml`, `%LOCALAPPDATA%/hermes/cron/jobs.json`, `~/.hermes/config.yaml`, lệnh `hermes` có trong `PATH` (`2026-11-24`).
  - Tài liệu chính thức (`2026-11-24`):
    - https://hermes-agent.nousresearch.com/docs/user-guide/configuration
    - https://hermes-agent.nousresearch.com/docs/user-guide/configuring-models
    - https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp
    - https://hermes-agent.nousresearch.com/docs/user-guide/features/cron
    - https://hermes-agent.nousresearch.com/docs/guides/cron-script-only
    - https://hermes-agent.nousresearch.com/docs/user-guide/windows-native

---

### 3.2. `claude-code` — Anthropic Claude Code
- **(a) Cấu hình MCP & Lệnh cài:**
  - **Đường dẫn (`win32` / `darwin` / `linux`):** `~/.claude.json` (phạm vi user tại khóa gốc `mcpServers`, phạm vi local nằm theo dự án trong `~/.claude.json`) và `<project>/.mcp.json` (phạm vi dự án). Tài liệu chính thức khẳng định Claude Code **không đọc** `~/.claude/.mcp.json`, `~/.claude/mcp.json` hay `%APPDATA%/Claude/mcp.json`.
  - **Định dạng & Schema:** JSON, khóa `mcpServers.<name>`: stdio `{ command, args, env? }`; remote bắt buộc có `"type"` (`"http"` | `"streamable-http"` | `"sse"` | `"ws"`) kèm `url`, `headers?`.
  - **Lệnh cài gốc:** `claude mcp add --scope user <name> -- <command> <args...>` (hoặc `claude mcp add-json`).
  - **Chiến lược `routersync mcp install --client claude-code`:** Ưu tiên gọi `claude mcp add --scope user` (tôn trọng khóa tệp `CLAUDE_CODE_CONFIG_LOCK_WAIT_MS`), dự phòng gộp JSON nguyên tử vào `~/.claude.json`.
- **(b) Lịch chạy gốc & 0 token:**
  - **Có lịch gốc:** Có (`/loop` theo phiên tối đa 7 ngày, Desktop Scheduled Tasks tại `~/.claude/scheduled_tasks.json`, Cloud `/schedule` tối thiểu 1 giờ).
  - **Chạy script 0 token (`zeroTokenScriptCapable`):** **`false`** — cả ba cơ chế đều đánh thức lượt LLM (tốn token), không có chế độ chạy script xác định 0 token. Dùng OS scheduler (`routersync schedule install`) + `tick_if_due`.
- **(c) Danh sách Provider & Model (Hướng A):**
  - **Vị trí & định dạng:** `~/.claude/settings.json` (JSON).
  - **Phân tích:** Claude Code tập trung vào mô hình Claude (tài liệu chính thức nêu không hỗ trợ định tuyến sang model không phải Claude qua gateway). `settings.json` chỉ lưu `model`, `availableModels`, `modelPicker`, `modelOverrides`, `modelSettings` và biến `env` (`ANTHROPIC_BASE_URL`, `ANTHROPIC_DEFAULT_*_MODEL`) — không có danh sách model đa provider cho từng provider đã nhập key.
  - **Cần nạp lại:** Có (phiên mới cho thay đổi MCP/`env`).
  - **Chế độ Hướng A (`directionAMode`):** **`report-only`** (chỉ kiểm tra, cảnh báo các pin model Claude đã ngừng trong `settings.json` và hướng dẫn người dùng cập nhật).
- **(d) Agent chạy lệnh shell:** **`true`**.
- **(e) Bậc bằng chứng:** **`A`**
  - Quan sát chỉ đọc trên máy Windows 11: `~/.claude.json`, `~/.claude/settings.json`, `~/.claude/scheduled_tasks.json`, lệnh `claude` trong `PATH` và tiến trình `claude` (`2026-11-24`).
  - Tài liệu chính thức (`2026-11-24`):
    - https://code.claude.com/docs/en/mcp
    - https://code.claude.com/docs/en/settings
    - https://code.claude.com/docs/en/model-config
    - https://code.claude.com/docs/en/scheduled-tasks

---

### 3.3. `codex` — OpenAI Codex CLI (và Desktop / IDE Extension)
- **(a) Cấu hình MCP & Lệnh cài:**
  - **Đường dẫn (`win32` / `darwin` / `linux`):** `~/.codex/config.toml` (dưới `$CODEX_HOME`, mặc định `~/.codex`), dùng chung cho CLI, Desktop và IDE extension; dự án tin cậy dùng `<project>/.codex/config.toml`.
  - **Định dạng & Schema:** TOML, bảng `[mcp_servers.<name>]` gồm `command`, `args`, `env` / `[mcp_servers.<name>.env]`, `env_vars`, `enabled`, `required`, `startup_timeout_sec` (hoặc `url`, `oauth` cho Streamable HTTP).
  - **Lệnh cài gốc:** `codex mcp add <name> -- <command> <args...>`.
  - **Chiến lược `routersync mcp install --client codex`:** Ưu tiên `codex mcp add`; nếu ghi TOML trực tiếp, **bắt buộc nối bảng `[mcp_servers.<name>]` ở cuối tệp** để không làm hỏng các khóa cấp gốc (`model`, `model_provider`, `model_catalog_json`) phải nằm trước header `[table]` đầu tiên.
- **(b) Lịch chạy gốc & 0 token:**
  - **Có lịch gốc:** Có trên Codex Desktop / ChatGPT Work (`~/.codex/automations/<id>/automation.toml` dùng `rrule`/`cron`); riêng Codex CLI chưa có daemon cron gốc.
  - **Chạy script 0 token (`zeroTokenScriptCapable`):** **`false`** — mọi automation đều chạy phiên agent LLM (tốn token). Dùng OS scheduler (`routersync schedule install`) + `tick_if_due`.
- **(c) Danh sách Provider & Model (Hướng A):**
  - **Vị trí & định dạng:** `~/.codex/config.toml` (TOML).
  - **Phân tích:** `[model_providers.<id>]` định nghĩa endpoint (`name`, `base_url`, `wire_api = "responses"`, `env_key` / `auth`, `model_catalog_url`) nhưng **không chứa mảng `models[]` nội tuyến**. Danh mục model lấy từ máy chủ hoặc từ một tệp ngoài qua khóa tùy chọn `model_catalog_json` (mặc định không cấu hình; quan sát trên máy chủ không có `model_catalog_json`).
  - **Cần nạp lại:** Có (đọc khi khởi động CLI/Desktop/extension).
  - **Chế độ Hướng A (`directionAMode`):** **`report-only`** (không tự sửa slot mặc định `model`/`model_provider`; chỉ báo cáo model mới/ngừng và hướng dẫn người dùng).
- **(d) Agent chạy lệnh shell:** **`true`** (chạy trong sandbox cấu hình).
- **(e) Bậc bằng chứng:** **`A`**
  - Quan sát chỉ đọc trên máy Windows 11: `~/.codex/config.toml` (`model`, `openai_base_url`, `[mcp_servers.<name>]`), lệnh `codex` trong `PATH` và tiến trình `codex` (`2026-11-24`).
  - Tài liệu chính thức (`2026-11-24`):
    - https://developers.openai.com/codex/config-reference
    - https://developers.openai.com/codex/mcp

---

### 3.4. `antigravity` — Google Antigravity (App, IDE, CLI `agy`, SDK)
- **(a) Cấu hình MCP & Lệnh cài:**
  - **Đường dẫn (`win32` / `darwin` / `linux`):** Toàn cục `~/.gemini/config/mcp_config.json` (đường dẫn chuẩn mới cho App/IDE/CLI/SDK; đường dẫn cũ `~/.gemini/antigravity/mcp_config.json` đã lỗi thời theo tài liệu chính thức). Theo workspace: `<workspace>/.agents/mcp_config.json`.
  - **Định dạng & Schema:** JSON, khóa gốc `mcpServers.<name>`:
    - Stdio: `{ command, args?, env?, cwd? }` — **không thêm trường `"type"`** theo tài liệu chính thức; ưu tiên đường dẫn tuyệt đối của binary trên GUI.
    - Remote (Streamable HTTP): `{ serverUrl, headers?, timeoutSeconds? }` (`url` là bí danh; không hỗ trợ SSE cũ/`httpUrl`).
  - **Lệnh cài gốc:** Không có lệnh CLI standalone để thêm MCP server (quản lý qua UI hoặc `/mcp`).
  - **Chiến lược `routersync mcp install --client antigravity`:** Gộp JSON nguyên tử vào `~/.gemini/config/mcp_config.json` dưới `mcpServers.<name>` (không ghi `type` cho stdio).
- **(b) Lịch chạy gốc & 0 token:**
  - **Có lịch gốc:** Có — hệ thống **Sidecars** (`~/.gemini/config/sidecars/<id>/sidecar.json`, bật trong `~/.gemini/config/config.json` mục `sidecars.<id>.enabled = true`), bên cạnh `/schedule` trong hội thoại và `/automation` (gọi `agentapi new-conversation`).
  - **Chạy script 0 token (`zeroTokenScriptCapable`):** **`true`** — tài liệu chính thức `docs/sidecars#schedule-builtin` xác nhận `sidecar.json` dùng `"builtin": "schedule"` với `"args": ["CRON_TZ=<IANA> */15 * * * *", "<command>", "<arg1>"]` chạy trực tiếp lệnh định kỳ **không qua LLM (0 token)**. Yêu cầu bật sidecar trong `config.json` và Antigravity đang chạy (nên dự phòng thêm OS scheduler khi đóng app).
- **(c) Danh sách Provider & Model (Hướng A):**
  - **Vị trí & định dạng:** **`ui-only`** — danh mục model (Gemini & đối tác Claude) do Google quản lý theo gói tài khoản qua **Settings > Models**. Tệp `~/.gemini/config/config.json` chỉ lưu tùy chọn `userSettings.orchestratorModel` / `orchestratorExecutorModel` và bị app đang chạy ghi đè trạng thái. (Model cục bộ Ollama/LiteRT chỉ nằm trong Python SDK.)
  - **Cần nạp lại:** Có đối với MCP/sidecar (nút Restart MCP hoặc khởi động lại app).
  - **Chế độ Hướng A (`directionAMode`):** **`report-only`**.
- **(d) Agent chạy lệnh shell:** **`true`**.
- **(e) Bậc bằng chứng:** **`A`**
  - Quan sát chỉ đọc trên máy Windows 11: `~/.gemini/config/mcp_config.json` (17 server), `~/.gemini/config/config.json`, `~/.gemini/config/sidecars/`, `~/.gemini/antigravity-cli/settings.json`, tiến trình `Antigravity` (`2026-11-24`).
  - Tài liệu chính thức (`2026-11-24`):
    - https://antigravity.google/docs/mcp
    - https://antigravity.google/docs/sidecars
    - https://antigravity.google/docs/models

---

### 3.5. `opencode` — OpenCode
- **(a) Cấu hình MCP & Lệnh cài:**
  - **Đường dẫn (`win32` / `darwin` / `linux`):** Toàn cục `~/.config/opencode/opencode.json` (hoặc `opencode.jsonc`; hỗ trợ `OPENCODE_CONFIG`); dự án `<project>/opencode.json`.
  - **Định dạng & Schema:** JSON/JSONC (`$schema: "https://opencode.ai/config.json"`), khóa gốc là **`mcp`** (KHÔNG phải `mcpServers`):
    - Local: `{ type: "local", command: ["npx", "-y", "..."], environment?: {...}, enabled?: true, timeout?: 5000 }` (lưu ý `command` là **mảng chuỗi** và biến môi trường tên `environment`).
    - Remote: `{ type: "remote", url, headers?, oauth?, enabled?: true }`.
  - **Lệnh cài gốc:** `opencode mcp add` (tương tác).
  - **Chiến lược `routersync mcp install --client opencode`:** Gộp JSONC bảo toàn chú thích vào `mcp.<name>`.
- **(b) Lịch chạy gốc & 0 token:**
  - **Có lịch gốc:** **`false`** — OpenCode không có bộ lập lịch cục bộ trong lõi (tài liệu chỉ nêu GitHub Actions `on: schedule` và plugin cộng đồng `opencode-scheduler` bọc `launchd`/`systemd`).
  - **Chạy script 0 token (`zeroTokenScriptCapable`):** **`false`** → dùng OS scheduler (`routersync schedule install`) + `tick_if_due`.
- **(c) Danh sách Provider & Model (Hướng A):**
  - **Vị trí & định dạng:** `~/.config/opencode/opencode.json` (JSON/JSONC); thông tin đăng nhập `/connect` lưu tách riêng tại `~/.local/share/opencode/auth.json` (hoặc `{env:VAR}` trong `options.apiKey`).
  - **Cấu trúc:** `provider.<provider_id>.models.<model_id>` (chứa `name`, `limit: { context, output }`, `tool_call`, ...). Đã quan sát trực tiếp 3 provider có key/endpoint trên máy chủ với cấu trúc chuẩn xác.
  - **Sửa an toàn trên đĩa:** **Có** — tệp cấu hình người dùng. Bảo toàn chú thích JSONC, `options.apiKey`, `options.baseURL`, và không tự đổi `model` / `small_model` / `agent.<name>.model`.
  - **Cần nạp lại:** Có (khởi động lại TUI/phiên OpenCode).
  - **Chế độ Hướng A (`directionAMode`):** **`write-adapter`**.
- **(d) Agent chạy lệnh shell:** **`true`**.
- **(e) Bậc bằng chứng:** **`A`**
  - Quan sát chỉ đọc trên máy Windows 11: `~/.config/opencode/opencode.json` (`mcp`, `provider.<id>.models`), lệnh `opencode` trong `PATH` (`2026-11-24`).
  - Tài liệu chính thức (`2026-11-24`):
    - https://opencode.ai/docs/config/
    - https://opencode.ai/docs/mcp-servers/
    - https://opencode.ai/docs/providers/

---

### 3.6. `cursor` — Cursor IDE (và Cursor CLI `agent`)
- **(a) Cấu hình MCP & Lệnh cài:**
  - **Đường dẫn (`win32` / `darwin` / `linux`):** Toàn cục `~/.cursor/mcp.json`, dự án `<project>/.cursor/mcp.json` (dùng chung cho IDE và CLI `agent`).
  - **Định dạng & Schema:** JSON, khóa gốc `mcpServers.<name>`: stdio `{ command, args?, env? }` hoặc remote `{ url, headers? }`.
  - **Lệnh cài gốc:** `agent mcp add <name> -- <command> <args...>` (hoặc deeplink `cursor://anysphere.cursor-deeplink/mcp/install?...`).
  - **Chiến lược `routersync mcp install --client cursor`:** Gộp JSON nguyên tử vào `~/.cursor/mcp.json`.
- **(b) Lịch chạy gốc & 0 token:**
  - **Có lịch gốc:** Có trên đám mây/SDK (**Cursor Automations** tại `cursor.com/automations` cho Cloud Agents gói Premium+; **Agent SDK Schedules** cho bot triển khai), không có cron cục bộ trong IDE.
  - **Chạy script 0 token (`zeroTokenScriptCapable`):** **`false`** — không chạy được script cục bộ 0 token trên máy người dùng. Dùng OS scheduler (`routersync schedule install`) + `tick_if_due`.
- **(c) Danh sách Provider & Model (Hướng A):**
  - **Vị trí & định dạng:** **`ui-only`** — quản lý qua giao diện Cursor Settings → Models / Team Admin API, lưu trạng thái nội bộ trong SQLite `state.vscdb` (`%APPDATA%/Cursor/User/globalStorage/state.vscdb` trên Win32). Đã kiểm chứng trực tiếp `%APPDATA%/Cursor/User/settings.json` trên máy chủ chỉ chứa cấu hình editor VS Code, không có danh mục provider/model.
  - **Sửa an toàn trên đĩa:** **Không (`false`)** — ghi vào `state.vscdb` khi Electron đang chạy sẽ xung đột khóa SQLite và đồng bộ đám mây.
  - **Cần nạp lại:** Có đối với MCP (làm mới trong Settings > MCP hoặc reload cửa sổ).
  - **Chế độ Hướng A (`directionAMode`):** **`report-only`**.
- **(d) Agent chạy lệnh shell:** **`true`**.
- **(e) Bậc bằng chứng:** **`A`**
  - Quan sát chỉ đọc trên máy Windows 11: `~/.cursor/mcp.json` (13 server), `%APPDATA%/Cursor/User/settings.json`, lệnh `cursor` trong `PATH` (`2026-11-24`).
  - Tài liệu chính thức (`2026-11-24`):
    - https://cursor.com/docs/cli/mcp
    - https://cursor.com/docs/mcp
    - https://cursor.com/docs/models-and-pricing
    - https://cursor.com/docs/agent-sdk/reference/schedules

---

### 3.7. `grok-bot` — xAI Grok Bot (và ghi chú CLI đi kèm: Grok Build `grok`)
> **Phân biệt quan trọng từ tài liệu chính thức `docs.x.ai`:** xAI phát hành 2 sản phẩm tách biệt — **Grok Bot** (agent đám mây chủ động) và **Grok Build (`grok` CLI)** (agent dòng lệnh cục bộ). Mục `grok-bot` dưới đây phản ánh đúng **Grok Bot**, đồng thời ghi chú riêng `companionCli` cho `grok` CLI trong `harness-matrix.json`.
- **(a) Cấu hình MCP & Lệnh cài:**
  - **Grok Bot:** Chỉ hỗ trợ **Remote MCP qua HTTPS công khai** (Streamable HTTP / SSE + OAuth, cấu hình qua `grok.com/manage-connectors`, `console.x.ai` hoặc qua chat). Từ chối `localhost` / IP nội bộ trừ khi mở tunnel HTTPS công khai; **không có tệp cấu hình MCP stdio cục bộ trên đĩa**.
  - **Ghi chú Grok Build (`grok` CLI):** Hỗ trợ TOML cục bộ tại `~/.grok/config.toml` (`[mcp_servers.<name>]`) và lệnh `grok mcp add <name> -- <command> <args...>`.
- **(b) Lịch chạy gốc & 0 token:**
  - **Grok Bot:** Có **Routines** trên đám mây (lịch theo múi giờ Bot + sự kiện Slack/GitHub/Linear/Sentry/PagerDuty/email/webhook). Mọi lần chạy đều gọi lượt LLM trên đám mây → `zeroTokenScriptCapable: false`.
  - **Ghi chú Grok Build (`grok` CLI):** Không có cron gốc (`zeroTokenScriptCapable: false`), tài liệu khuyến nghị ghép OS `cron` + `grok -p`.
- **(c) Danh sách Provider & Model (Hướng A):**
  - **Grok Bot:** **`ui-only` / tự động chọn hoàn toàn** — tài liệu chính thức xác nhận Grok Bot không có bộ chọn model thủ công và không có tệp cấu hình model cục bộ.
  - **Chế độ Hướng A (`directionAMode`):** **`report-only`**. *(Ghi chú: Grok Build CLI có `[models]` và `[model."<id>"]` trong `~/.grok/config.toml`, nhưng chưa cài trên máy chủ — chỉ mới xác minh bậc B.)*
- **(d) Agent chạy lệnh shell:** **`true`** (chạy trên máy tính đám mây riêng của Grok Bot dưới cơ chế Auto Review).
- **(e) Bậc bằng chứng:** **`B`** *(trên máy chủ Windows 11 chỉ có thư mục rỗng `~/.grok/skills/`, chưa cài `grok` hay `config.toml`, nên không nâng lên bậc A)*.
  - Tài liệu chính thức (`2026-11-24`):
    - https://docs.x.ai/grok-bot/how-grok-bot-works
    - https://docs.x.ai/grok-bot/skills-routines-and-automations
    - https://docs.x.ai/grok-bot/computer-and-apps
    - https://docs.x.ai/build/features/mcp-servers
    - https://docs.x.ai/build/cli/headless-scripting

---

### 3.8. `openmausbot` — OpenMausBot
- **(a) Cấu hình MCP & Lệnh cài:**
  - **Đường dẫn (`win32` / `darwin` / `linux`):** `~/.openmausbot/config.json` (hoặc `$OMB_DATA_DIR/config.json`), khóa gốc `mcpServers.<name>`.
  - **Định dạng & Schema:** JSON — đã quan sát trực tiếp 13 server trên máy chủ: stdio `{ command, args, env, enabled }`, remote `{ type, url, headers, enabled }` (OAuth token lưu tách riêng tại `~/.openmausbot/mcp-oauth.json`).
  - **Lệnh cài gốc:** Không có lệnh CLI một dòng; người dùng có thể dán khối JSON `mcpServers` hoặc lệnh `claude mcp add` trong **Plugins → MCP servers → Add server**, hoặc gộp JSON vào `~/.openmausbot/config.json` khi dừng app.
  - **Chiến lược `routersync mcp install --client openmausbot`:** Gộp JSON nguyên tử vào `~/.openmausbot/config.json` dưới `mcpServers.<name>`, cảnh báo nếu tiến trình `OpenMausBot` đang chạy.
- **(b) Lịch chạy gốc & 0 token:**
  - **Có lịch gốc:** Có — bộ lập lịch Croner 5 trường + khoảng thời gian, lưu tại `~/.openmausbot/routines.json` (kèm `routines.ledger.jsonl`).
  - **Chạy script 0 token (`zeroTokenScriptCapable`):** **`false`** — tài liệu chính thức `docs/routine-schedules.md` quy định rõ: *"shell commands, and arbitrary code are not accepted."* Routine đánh thức lượt LLM của bot. Hơn nữa, `routines.json` thuộc quyền sở hữu của tiến trình đang chạy và **tuyệt đối không sửa tay trên đĩa** vì sẽ tranh chấp ghi (race condition). → Dùng OS scheduler (`routersync schedule install`) + `tick_if_due`.
- **(c) Danh sách Provider & Model (Hướng A):**
  - **Vị trí & định dạng:** `~/.openmausbot/config.json` (JSON), khóa `instances`.
  - **Kiểm chứng then chốt (tài liệu chính thức + quan sát máy chủ):**
    - `openmausbot-docs/SKILL.md` và `docs/custom-engines.md` xác nhận rõ: **`config.json` là tệp duy nhất được thiết kế để người dùng sửa bằng tay; `instances` được nạp lúc khởi động nên cần restart app sau khi sửa**, trong khi **`bots.json` và `routines.json` thuộc tiến trình đang chạy và tuyệt đối không sửa tay**.
    - Quan sát cấu trúc trên máy chủ xác nhận các instance tùy biến `driver: "openai-compat"` (`instances["openai-compat-<uuid>"]`) chứa `config.managedModels` (mảng chuỗi `string[]`) bên cạnh `url`, `key`, `model`. Các driver tích hợp sẵn (`openai`, `claudeApi`, `xaiApi`, `openrouter`) và `customAcp` chỉ lưu metadata ngắn và tự khám phá model động lúc chạy.
  - **Sửa an toàn trên đĩa:** **Có**, giới hạn nghiêm ngặt vào `instances.<id>.config.managedModels` của các instance `openai-compat` đã có key/endpoint trong `~/.openmausbot/config.json`. Không đụng `defaultModelSelection`, `automaticRecovery.backup`, `decider.openrouterModel`, `config.model`, `bots.json`, `routines.json`.
  - **Cần nạp lại:** **Có** (khởi động lại OpenMausBot).
  - **Chế độ Hướng A (`directionAMode`):** **`write-adapter`** (cho `openai-compat` `managedModels`; `report-only` cho driver tích hợp và phân bổ model trong `bots.json`).
- **(d) Agent chạy lệnh shell:** **`true`**.
- **(e) Bậc bằng chứng:** **`A`**
  - Quan sát chỉ đọc trên máy Windows 11: `~/.openmausbot/config.json`, `~/.openmausbot/bots.json`, `~/.openmausbot/routines.json`, tài liệu đi kèm cài đặt `openmausbot-docs/SKILL.md`, tiến trình `OpenMausBot` (`2026-11-24`).
  - Tài liệu chính thức (`2026-11-24`):
    - https://github.com/milind-soni/OpenMausBot/blob/main/docs/custom-engines.md
    - https://github.com/milind-soni/OpenMausBot/blob/main/docs/custom-mcp-servers.md
    - https://github.com/milind-soni/OpenMausBot/blob/main/docs/routine-schedules.md
    - https://github.com/milind-soni/OpenMausBot/blob/main/docs/mcp-server.md

---

### 3.9. `dsh` — DeepSeek Harness
- **(a) Cấu hình MCP & Lệnh cài:**
  - **Đường dẫn (`win32` / `darwin` / `linux`):** Theo profile `~/.dsh/profiles/desktop/cordis.patch.yml` (ưu tiên `$DSH_HOME`) hoặc phủ toàn cục `~/.dsh/cordis.patch.yml`.
  - **Định dạng & Schema:** YAML (mảng patch Cordis). Server MCP mới khai báo dưới `- insert:` với `name: '@deepseek-ai/dsh-mcp-client'` và `config: { serverName, transport: 'stdio' | 'streamable-http', command, args, env?, toolCallTimeoutMs?, failOnStartupError? }`. (Môi trường con tự lọc bí mật mặc định trừ khi khai báo tường minh.)
  - **Lệnh cài gốc:** Không có lệnh CLI một dòng cho MCP server; cài bằng patch YAML hoặc plugin manager.
  - **Chiến lược `routersync mcp install --client dsh`:** Giữ tương thích hiện có — gộp YAML bảo toàn chú thích dưới `- insert:` trong `~/.dsh/profiles/desktop/cordis.patch.yml`.
- **(b) Lịch chạy gốc & 0 token:**
  - **Có lịch gốc:** Có — plugin lõi `@deepseek-ai/dsh-schedule` (lưu tại `<DSH_HOME>/storages/schedule.json` hoặc SQLite `u_schedule_tasks`, hỗ trợ `after`/`at`/`every`/`daily`/`weekly`/`cron`/`rrule`).
  - **Chạy script 0 token (`zeroTokenScriptCapable`):** **`false`** — `@deepseek-ai/dsh-schedule` gửi `prompt` vào hội thoại để đánh thức agent LLM, không chạy script shell 0 token trong lõi. → Dùng OS scheduler (`routersync schedule install`) + `tick_if_due`.
- **(c) Danh sách Provider & Model (Hướng A):**
  - **Vị trí & định dạng:** `~/.dsh/profiles/desktop/cordis.patch.yml` (YAML); bí mật lưu tách riêng tại `~/.dsh/.credentials.yaml` và tham chiếu qua `apiKeyEnv`.
  - **Cấu trúc:** Hàng plugin `@deepseek-ai/dsh-llm-pi-ai` (`id: llm-pi-ai`) → `config.providers.<provider_id>` gồm `displayName`, `apiKeyEnv`, `api`, `baseURL`, và `models: [{ id, name?, contextWindow?, ... }]`.
  - **Quy tắc an toàn bắt buộc (xác minh từ tài liệu & sự cố gốc):**
    1. Một hàng patch Cordis **thay thế toàn bộ khối `config`** (không deep-merge) → adapter phải bảo toàn 100% các trường và provider khác trong cùng hàng.
    2. Một hàng YAML sai cú pháp sẽ **chặn DSH khởi động** (issue `#3473`) → bắt buộc kiểm lược schema, sao lưu, ghi nguyên tử, đọc lại và hoàn tác tự động.
    3. Sửa `profiles/desktop/cordis.patch.yml` khi có phiên đang chạy có thể ngắt ngang phiên đó (issue `#8857`) → kiểm tra tiến trình/trạng thái rảnh trước khi ghi.
  - **Cần nạp lại:** Model: **Không** (`llm-pi-ai` nạp profile theo từng request); MCP: có/HMR reload.
  - **Chế độ Hướng A (`directionAMode`):** **`write-adapter`**.
- **(d) Agent chạy lệnh shell:** **`true`** (chế độ sandbox `read-only` / `workspace-write` / `danger-full-access`).
- **(e) Bậc bằng chứng:** **`A`**
  - Quan sát chỉ đọc trên máy Windows 11: `~/.dsh/profiles/desktop/cordis.patch.yml`, `~/.dsh/cordis.patch.yml`, `~/.dsh/.credentials.yaml`, lệnh `dsh` trong `PATH` (`2026-11-24`).
  - Tài liệu chính thức (`2026-11-24`):
    - https://github.com/deepseek-ai/deepseek-harness
    - https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md
    - https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/llm/llm-pi-ai/README.md
    - https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/schedule/schedule/README.md
