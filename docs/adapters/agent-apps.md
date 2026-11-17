# Hợp đồng adapter chỉ đọc cho app agent

Tài liệu này mô tả hợp đồng `inspect` cho các app agent (harness) tự lưu danh sách
provider/model của riêng chúng. Hợp đồng **chỉ đọc**: không có `write`, `apply`,
`patch` hay bất kỳ thành viên nào ghi vào cấu hình của app.

Kiểu TypeScript: `packages/adapter-sdk/src/agent-app.ts`
Cài đặt: `packages/cli/src/apps/inspect.ts`
CLI: `routersync apps inspect [--app <tên>] [--json] [--home <dir>] [--config <tệp>]`

## 1. Đầu ra chuẩn hóa

```ts
AgentAppInspection {
  app: string;                 // 'hermes' | 'dsh' | 'opencode'
  configPath: string;          // đường dẫn thật; che bằng maskHomePath trước khi ghi log
  format: 'json' | 'yaml' | 'toml' | 'sqlite' | 'unknown';
  readOnly: true;              // luôn true, không có nhánh ghi
  providers: AgentAppProvider[];   // { id, kind, baseUrlPresent, keyPresent }
  models: AgentAppModel[];         // { provider, id, enabled }
  activeModel: string | 'UNKNOWN'; // 'provider/model' hoặc UNKNOWN
  routerRef: '9router' | 'omniroute' | 'UNKNOWN';
  certainty: 'A' | 'B' | 'C';
  warnings: string[];
}
```

Bất biến:

- `keyPresent` và `baseUrlPresent` là **boolean**. Giá trị khóa và URL không bao giờ
  đi qua hợp đồng, kể cả trong `warnings` hay log.
- `enabled` là ba trạng thái (`true` / `false` / `'UNKNOWN'`). Vắng mặt trường bật/tắt
  nghĩa là `'UNKNOWN'`, không phải `false`.
- `configPath` là đường dẫn thật; chỉ che khi in ra. `maskHomePath(path, homeDir)`
  thay thư mục người dùng bằng `<HOME>` cho cả hai kiểu dấu phân cách.

## 2. Tầng bằng chứng

| Tầng | Nghĩa | Ví dụ |
|---|---|---|
| A | Đọc từ trường tường minh trong cấu hình | `model.provider`, `agent-default-model.config.model` |
| B | Suy ra từ trường liên quan (khóa, map provider) | provider có `base_url` ⇒ `kind='direct'` |
| C | Không xác minh được, báo `UNKNOWN` | OpenCode không có trường model đang dùng |

`certainty` trong kết quả là tầng **yếu nhất** của các giá trị đã báo. Quy ước này
nối tiếp mô hình tầng A/B/C đã dùng ở `docs/harness-cron.md` và `docs/model-tiers.md`.

## 3. Lỗi

| Mã | Khi nào |
|---|---|
| `ENOENT` | Không có tệp, hoặc đường dẫn không phải tệp |
| `PARSE` | JSON/YAML không hợp lệ (YAML: `doc.errors` khác rỗng) |
| `TOO_LARGE` | Tệp lớn hơn `maxBytes` (mặc định 4 MiB) — từ chối thay vì nạp |
| `UNSUPPORTED` | Tên app không nằm trong danh sách hỗ trợ |

Lỗi ném ra là `AgentAppInspectError` với `code` ở trên; thông báo không chứa giá trị
cấu hình.

## 4. App hỗ trợ

| App | Tệp mặc định | Định dạng | Provider | Model | Model đang dùng |
|---|---|---|---|---|---|
| hermes | `~/.hermes/config.yaml` | yaml | `model.provider`, `custom_providers[]` | `model.models[]` | `model.default` |
| dsh | `~/.dsh/profiles/desktop/cordis.patch.yml` (dự phòng `~/.dsh/cordis.patch.yml`) | yaml | `llm-pi-ai.config.providers` | `providers[].models[]` | `agent-default-model.config.{provider,model}` |
| opencode | `~/.config/opencode/opencode.json` | json | `provider` map | `provider[].models` | trường `model` cấp 1 nếu có, ngược lại UNKNOWN |

DSH chấp nhận cả hai hình dạng tệp patch: mảng `{id,name,config}` và mảng
`{insert:[{id,name,config}]}`. Tag tùy biến `!!js` chỉ sinh cảnh báo YAML, không phải lỗi.

## 5. CLI

```
routersync apps inspect
routersync apps inspect --app hermes --json
routersync apps inspect --app opencode --config <tệp>
```

Bảng in bốn cột: `app`, `provider`, `model`, `trạng thái`; sau bảng là cấu hình đã che,
model đang dùng, router, độ chắc chắn và cảnh báo. `--json` in nguyên cấu trúc đã che.
Không có cờ ghi.

## 6. Kiểm thử

`packages/cli/test/apps.test.ts` — mỗi adapter có: cấu hình hợp lệ, thiếu trường,
tệp hỏng, tệp rất lớn, đường dẫn không tồn tại, khóa giả không rò vào kết quả/log/đầu ra CLI.
Fixture tổng hợp: `test/fixtures/agent-apps/` (khóa là `<KEY>`, URL là `https://example.invalid`).
