# RouterSync — Sổ tay Vận hành Thí điểm Chạy thật & Cắt bản Phát hành v2 (`LIVE-E2E-v2.md`)

- **Phục vụ: S9** (`docs/SPEC.md` điều khoản `S9` & Mục 3 — Kiểm thử end-to-end thật trên dữ liệu thật của chủ dự án sau khi toàn bộ `WP0`–`WP9` hoàn tất)
- **Tài liệu liên quan:** `docs/SPEC.md`, `docs/RELEASE-CANDIDATE.md`, `docs/schedule-ladder.md`, `docs/runbook/LIVE-E2E.md` *(lịch sử tiền-C45 giữ nguyên chỉ đọc)*
- **Ranh giới thực thi cứng:** Đội bot dừng tuyệt đối ở trạng thái **`"sẵn sàng chạy thật"`** (`READY_FOR_OWNER_LIVE_PILOT`). **Chỉ chủ dự án** trực tiếp chạy các lệnh ghi thật và lệnh phát hành trong sổ tay này.

---

## 1. Phạm vi & Ranh giới An toàn (`Scope & Safety Boundary`)

1. **Điều kiện mở khóa:** Sổ tay này chỉ được chủ dự án thực thi sau khi toàn bộ các gói việc `WP0`–`WP9` và bản vá đồng bộ `C46` đã hợp nhất vào `main` với CI 5 hệ điều hành xanh ở lần chạy đầu (`attempt=1`) và gói bằng chứng `evidence/d3` đạt kiểm định `SẠCH: 3 dòng`.
2. **Chọn đúng 2 mục tiêu thí điểm ban đầu (1 Combo Router + 1 Cấu hình Harness):**
   - **Hướng B — 1 Combo trên Router thật (`--router-target`):** Chọn một combo thí điểm tường minh theo cú pháp `router:<routerId>/<comboName>`, ví dụ `router:omniroute/coding-main` hoặc `router:9router/coding-main`.
     - *Lưu ý kỹ thuật D26 đối với 9Router:* Các hàng combo ghi với `kind=null` trên SQLite của 9Router cần khoảng `20–31 giây` (trần chờ mặc định `servingWaitMs = 60000` ms) để phản ánh đầy đủ lên đường phục vụ HTTP `GET /v1/models`. Không hạ trần chờ xuống thấp hơn 60 giây.
   - **Hướng A — 1 Tệp cấu hình Harness bậc `write-adapter` (`--harness-target`):** Chọn một harness đã xác minh adapter ghi bảo toàn định dạng (`harness:hermes`, `harness:opencode`, `harness:openmausbot`, hoặc `harness:dsh`):
     - Hermes: `<HERMES_HOME>/config.yaml`
     - OpenCode: `~/.config/opencode/opencode.json` *(hoặc `.jsonc`)*
     - OpenMausBot: tệp `config.json` trong thư mục dữ liệu OpenMausBot (**tuyệt đối không bao giờ** trỏ vào `routines.json` hoặc `bots.json`, vì hai tệp đó thuộc tiến trình ứng dụng đang chạy; `routersync live-check` và adapter đều chặn cứng).
3. **Khóa an toàn đường dẫn thật ngoài `os.tmpdir()`:** Mọi lệnh ghi có kiểm soát (`routersync apply --write`, `routersync apps apply --write`, `routersync tick --mode auto-safe`, `routersync rollback --write`, `routersync apps rollback`) đều chặn cứng đường dẫn ngoài `os.tmpdir()` với mã lỗi `SANDBOX_OUTSIDE_TMPDIR` trừ khi chủ dự án tự đặt cờ môi trường phiên shell (`ROUTERSYNC_ALLOW_LIVE_ROUTER_WRITE=1` và `ROUTERSYNC_ALLOW_LIVE_HOME_WRITE=1`) ngay trước Mục 3. Đội bot và cấu hình trong kho mã **tuyệt đối không bao giờ** đặt sẵn hai cờ này.
4. **Bảo toàn lịch sử:** Sổ tay cũ `docs/runbook/LIVE-E2E.md` (thử nghiệm `test-1..3` tiền-C45) được giữ nguyên để đối chiếu lịch sử. Mọi đợt thí điểm từ C45 trở đi tuân theo `docs/runbook/LIVE-E2E-v2.md`.

---

## 2. Cổng Kiểm tra Tiền điều kiện Tự động Chỉ đọc (`0` Writes)

Trước khi cấp bất kỳ quyền ghi hay đặt cờ ghi thật nào, chủ dự án chạy bộ chẩn đoán chỉ đọc và lưu bản sao lưu + mã băm SHA-256 gốc của hai tệp mục tiêu thật:

```sh
# 2.1 Chẩn đoán tổng thể cấu hình, thang lịch 4 tầng và phụ thuộc vòng
routersync doctor --json

# 2.2 Chạy một chu kỳ quét chỉ đọc để làm mới <stateDir>/status.json và <stateDir>/tick-catalog.json
routersync tick --mode observe --json

# 2.3 Chạy 7 phép kiểm tiền điều kiện chỉ đọc + diễn tập sao lưu/hoàn tác trong os.tmpdir()
routersync live-check \
  --router-target router:omniroute/coding-main \
  --harness-target harness:hermes \
  --harness-config-path "<DUONG_DAN_CONFIG_HARNESS_THAT>" \
  --json
```

**Yêu cầu đạt ở Mục 2:**
- `routersync live-check` trả về mã thoát `0`, `status: "READY_FOR_OWNER_LIVE_PILOT"`, `vietnameseGateStatus: "sẵn sàng chạy thật"`, và cả **7 mục kiểm** (`freeze_clear`, `config_and_doctor_health`, `pilot_targets_readable`, `tmpdir_backup_rollback_rehearsal`, `consent_and_promotion_state`, `cost_and_release_hygiene`, `live_gate_hint`) đều báo `passed: true`.
- Ở thời điểm Mục 2, mục kiểm thứ 7 `live_gate_hint` báo hai tệp mục tiêu thật nằm ngoài `os.tmpdir()` và hai biến môi trường ghi thật đang ở trạng thái `chưa đặt` (`passed: true` để xác nhận tiền điều kiện trước khi mở cổng ghi).
- Tạo bản sao lưu gốc trước thí điểm và ghi lại mã băm SHA-256 trước thí điểm của cơ sở dữ liệu router thật và tệp cấu hình harness thật:
  - Trên Linux/macOS (`bash`/`zsh`):
    ```sh
    cp "<DUONG_DAN_ROUTER_DB>" "<DUONG_DAN_ROUTER_DB>.pre-pilot.bak"
    cp "<DUONG_DAN_CONFIG_HARNESS_THAT>" "<DUONG_DAN_CONFIG_HARNESS_THAT>.pre-pilot.bak"
    sha256sum "<DUONG_DAN_ROUTER_DB>" "<DUONG_DAN_CONFIG_HARNESS_THAT>"
    ```
  - Trên Windows PowerShell:
    ```powershell
    Copy-Item "<DUONG_DAN_ROUTER_DB>" "<DUONG_DAN_ROUTER_DB>.pre-pilot.bak"
    Copy-Item "<DUONG_DAN_CONFIG_HARNESS_THAT>" "<DUONG_DAN_CONFIG_HARNESS_THAT>.pre-pilot.bak"
    Get-FileHash -Algorithm SHA256 "<DUONG_DAN_ROUTER_DB>", "<DUONG_DAN_CONFIG_HARNESS_THAT>"
    ```

---

## 3. Quy trình Thí điểm Có Kiểm soát (`propose` -> `auto-safe` -> `freeze` & Hoàn tác Khớp Từng Byte)

### Bước 3.0 — Đặt Cờ Môi trường Cho phép Ghi Thật Trong Phiên Shell Của Chủ dự án

Chỉ đặt trong phiên thiết bị đầu cuối tương tác hiện tại của chủ dự án (không ghi vào `.bashrc`, `.zshrc`, PowerShell `$PROFILE`, hoặc tệp `.env`):

```sh
# Linux / macOS (bash / zsh)
export ROUTERSYNC_ALLOW_LIVE_ROUTER_WRITE=1
export ROUTERSYNC_ALLOW_LIVE_HOME_WRITE=1
```

```powershell
# Windows PowerShell
$env:ROUTERSYNC_ALLOW_LIVE_ROUTER_WRITE="1"
$env:ROUTERSYNC_ALLOW_LIVE_HOME_WRITE="1"
```

Chạy lại `routersync live-check` để xác nhận `live_gate_hint` hiển thị `đã đặt` cho cả hai biến trước khi sang Bước 3.1.

### Bước 3.1 — Cấp sự đồng ý đứng bậc `propose` & Lập kế hoạch khô cho CẢ Router lẫn Harness

Chạy trên thiết bị đầu cuối tương tác (TTY) để tạo chính sách đồng ý đứng có ký HMAC-SHA256 (mặc định hạn 30 ngày, từ chối cứng cờ `--yes` với lỗi `CONSENT_BYPASS_FORBIDDEN`) và xem trước kế hoạch khô cho cả hai mục tiêu:

```sh
routersync consent grant --target router:omniroute/coding-main --level propose
routersync consent grant --target harness:hermes --level propose
routersync consent status --json

# Xem trước kế hoạch tất định cho Router combo và Harness config (0 ghi đĩa mục tiêu)
routersync plan --json
routersync sync --router omniroute --json
routersync apps plan --app hermes -c "<DUONG_DAN_CONFIG_HARNESS_THAT>" --json
```

*(Khi không truyền `--catalog`, `routersync apps plan` và `routersync apps apply` tự động nạp danh mục model đã xác minh từ `<stateDir>/tick-catalog.json`.)*

### Bước 3.2 — Áp dụng có kiểm soát ở bậc `propose` & Kiểm chứng Đọc lại (`I4` Zero-Diff)

Thực hiện áp dụng kế hoạch đầu tiên ở bậc `propose` cho **cả Router combo lẫn Harness config** (mỗi lệnh yêu cầu chủ dự án gõ `chay` trên TTY tương tác, tự động tạo bản sao lưu trước khi ghi, ghi nguyên tử, kiểm chứng đọc lại ngay lập tức, và lưu biên nhận `ApplyHistoryReceipt` có ký HMAC vào `<stateDir>/apply-history.json`):

```sh
# 3.2a Áp dụng kế hoạch cho Router combo thí điểm (xác nhận TTY 'chay' -> ghi biên nhận router:omniroute/coding-main)
routersync apply --write

# 3.2b Áp dụng kế hoạch cho Harness config thí điểm (xác nhận TTY 'chay' -> ghi biên nhận harness:hermes)
routersync apps apply \
  --app hermes \
  -c "<DUONG_DAN_CONFIG_HARNESS_THAT>" \
  --backup "<DUONG_DAN_CONFIG_HARNESS_THAT>.pre-pilot.bak" \
  --write \
  --json

routersync status --json
routersync diff
```

**Kiểm tra ngay sau Bước 3.2:**
- `routersync status --json` và `<stateDir>/apply-history.json` xác nhận **cả hai mục tiêu** (`router:omniroute/coding-main` và `harness:hermes`) đều có biên nhận áp dụng bậc `propose` hợp lệ (`appliedAtLevel: "propose"`, `readBackVerified: true`, `rolledBack: false`).
- Tệp cấu hình harness giữ nguyên 100% chú thích (`#`, `//`), khóa API, `baseURL`, và các ô model mặc định; chỉ danh sách model của provider đã có khóa được cập nhật.
- Đường phục vụ HTTP `/v1/models` của router phản hồi bình thường.

### Bước 3.3 — Nâng bậc lên `auto-safe` & Chạy `tick --mode auto-safe` Tất định (`0` Token LLM)

Sau khi cả hai mục tiêu thí điểm đều đã có biên nhận áp dụng bậc `propose` thành công và khớp đọc lại (điều kiện bắt buộc theo C45 §3.2 — nếu thiếu biên nhận `harness:hermes`, lệnh `consent grant --level auto-safe` sẽ từ chối với `AUTO_SAFE_PROMOTION_DENIED`), nâng phạm vi thí điểm lên `auto-safe` và chạy một chu kỳ `tick --mode auto-safe`:

```sh
routersync consent grant --target router:omniroute/coding-main --level auto-safe
routersync consent grant --target harness:hermes --level auto-safe

# Chạy một chu kỳ tick tự động an toàn (0 token LLM) và kiểm tra lại cổng sẵn sàng
routersync tick --mode auto-safe --json
routersync live-check \
  --router-target router:omniroute/coding-main \
  --harness-target harness:hermes \
  --harness-config-path "<DUONG_DAN_CONFIG_HARNESS_THAT>" \
  --require-consent \
  --json
```

Kiểm tra `<stateDir>/cost-ledger.json` (hoặc gọi công cụ MCP `cost_report`): xác nhận `tier0Tokens === 0`, `tier0LlmCalls === 0`, `tier0PaidRequests === 0`, và `pilotPhase === "AUTO_SAFE_ACTIVE"`.

### Bước 3.4 — Diễn tập Cầu dao Khẩn cấp `freeze` / `unfreeze`

Xác minh cầu dao ngắt mạch khẩn cấp chặn tức thì mọi đường ghi (`apply --write`, `apps apply --write`, `tick --mode auto-safe`, và MCP `apply_plan`) khi cần:

```sh
# Kích hoạt khóa ghi khẩn cấp ngay lập tức (không cần chờ xác nhận)
routersync freeze --reason "live-pilot-drill"

# Xác nhận live-check chuyển sang BLOCKED ngay tức thì (mã thoát 1)
routersync live-check \
  --router-target router:omniroute/coding-main \
  --harness-target harness:hermes \
  --harness-config-path "<DUONG_DAN_CONFIG_HARNESS_THAT>" \
  --json

# Mở khóa trở lại qua TTY tương tác (gõ 'unfreeze')
routersync unfreeze
```

### Bước 3.5 — Diễn tập Hoàn tác Khớp Từng Byte (`Byte-Exact Rollback Rehearsal`)

Thực hiện hoàn tác cho cả Router combo lẫn Harness config về bản sao lưu trước thí điểm và đối chiếu mã băm SHA-256:

```sh
# 3.5a Liệt kê các snapshot đã lưu và hoàn tác trạng thái combo router về snapshot trước khi áp dụng
routersync rollback
routersync rollback "<SNAPSHOT_ID>" --write

# 3.5b Hoàn tác nguyên tử tệp cấu hình harness từ bản sao lưu trước thí điểm và đánh dấu rolledBack=true trong apply-history.json
routersync apps rollback \
  --app hermes \
  -c "<DUONG_DAN_CONFIG_HARNESS_THAT>" \
  --backup "<DUONG_DAN_CONFIG_HARNESS_THAT>.pre-pilot.bak" \
  --json
```

Tính lại SHA-256 trên tệp cấu hình harness đã khôi phục (và đối chiếu các hàng combo SQLite hoặc khôi phục `<DUONG_DAN_ROUTER_DB>.pre-pilot.bak` khi tiến trình router đã dừng) để xác nhận khớp tuyệt đối từng byte (`sha256_after_rollback === sha256_before_apply`). Sau khi hoàn tất diễn tập hoặc khi kết thúc phiên thí điểm, xóa hai biến môi trường ghi thật khỏi phiên shell (`unset ROUTERSYNC_ALLOW_LIVE_ROUTER_WRITE ROUTERSYNC_ALLOW_LIVE_HOME_WRITE` hoặc `Remove-Item Env:ROUTERSYNC_ALLOW_LIVE_ROUTER_WRITE, Env:ROUTERSYNC_ALLOW_LIVE_HOME_WRITE`). Nếu mọi tiêu chí ở Mục 4 đều đạt và chủ dự án muốn duy trì vận hành tự động, áp lại cấu hình mong muốn cho hai mục tiêu thí điểm.

---

## 4. Năm Tiêu chí Đạt Đo được Bắt buộc (`S9` Sign-Off Table)

Đợt thí điểm `WP9` chỉ được ký nghiệm thu khi **cả 5 chỉ số định lượng** dưới đây đạt ngưỡng cứng:

| # | Tiêu chí (`docs/SPEC.md#S9`) | Phương pháp Đo lường Chính xác | Ngưỡng Đạt Cứng (`Hard Pass`) |
|---:|---|---|---|
| **1** | **Số model khỏe bị loại nhầm (`falseRemovals`)** | Đối chiếu danh sách bước combo sau khi áp dụng với `/v1/models` trực tiếp của provider và bất biến `I1..I6` (`routersync dead-models` & `apply-history.json`). | **`0` model khỏe bị loại sai** (`falseRemovals === 0`). |
| **2** | **Độ trung thực hoàn tác (`rollbackByteExactMatch`)** | So sánh `sha256sum` / `Get-FileHash -Algorithm SHA256` giữa bản sao lưu trước khi ghi và tệp cấu hình / các hàng SQLite sau khi chạy hoàn tác. | **Khớp `100%` từng byte** (`sha256(restored) === sha256(preApplyBackup)`). |
| **3** | **Độ trễ phát hiện thay đổi nguồn (`detectionLatencyMs`)** | Đo thời gian thực thi từ lúc bắt đầu một lệnh `routersync tick` tới khi cập nhật `status.json` / `inbox.jsonl` (`durationMs` trong JSON đầu ra). | **Một chu kỳ tick tất định hoàn tất `<= 60_000 ms`** (cộng tối đa `<= 60_000 ms` phản ánh `/v1/models` trên router). |
| **4** | **Chi phí token & gọi LLM định kỳ (`tier0Tokens`)** | Kiểm tra `<stateDir>/cost-ledger.json` và công cụ MCP `cost_report` xuyên suốt toàn bộ các chu kỳ tick của đợt thí điểm. | **`tier0Tokens === 0`**, **`tier0LlmCalls === 0`**, **`tier0PaidRequests === 0`**, và số phiên nghiên cứu Tầng 1 `<= maxWeeklyResearchSessions` (`5`). |
| **5** | **Số lần can thiệp thủ công ngoài kịch bản (`unplannedManualInterventions`)** | Đếm mọi thao tác sửa tay DB/JSON, cứu hộ treo tiến trình, hoặc xóa khóa thủ công ngoài bước `consent grant` và `unfreeze` theo kịch bản. | **`0` lần can thiệp thủ công ngoài dự kiến** (`unplannedManualInterventions === 0`). |

---

## 5. Lệnh Cắt bản `1.0.0-rc.1` (`next`) & `1.0.0` (`latest`) Dành riêng Chủ dự án

Sau khi ký nghiệm thu Mục 4, chủ dự án thực hiện quy trình cắt bản đồng bộ với `docs/RELEASE-CANDIDATE.md`:

### Bước 5.1 — Xem trước nâng phiên bản ở chế độ chỉ đọc (`--dry-run`)

```sh
node tools/release/prepare-v1-release.mjs --target 1.0.0-rc.1 --dry-run
node tools/release/prepare-v1-release.mjs --target 1.0.0 --dry-run
```

### Bước 5.2 — Ghi phiên bản mới, cập nhật kiểm thử đóng gói & Chạy cổng kiểm định

```sh
# Tùy chọn A (ứng viên xem trước trên dist-tag next):
node tools/release/prepare-v1-release.mjs --target 1.0.0-rc.1 --write

# Hoặc Tùy chọn B (phát hành thẳng bản chính thức trên dist-tag latest):
node tools/release/prepare-v1-release.mjs --target 1.0.0 --write
```

Trong cùng commit cắt bản của chủ dự án, cập nhật chuỗi phiên bản kỳ vọng tương ứng trong `test/acceptance/at-167-release-packaging.test.ts` và ngày phát hành trong `CHANGELOG.md`, sau đó chạy trọn bộ cổng kiểm định:

```sh
pnpm build
pnpm verify:release
node tools/agent/pack-verify.mjs
node tools/agent/security-audit.mjs
node tools/agent/scan-private-names.mjs origin/main HEAD
```

### Bước 5.3 — Gắn một tag phát hành đơn lẻ tường minh & Xuất bản 8 gói `@routersync/*`

> **Quy tắc git an toàn:** Chỉ gắn và đẩy đúng **một tag phát hành đơn lẻ tường minh** cho phiên bản đang cắt; tuyệt đối không dùng cờ đẩy hàng loạt toàn bộ tag, không đẩy toàn bộ nhánh cùng lúc, và không đẩy lên tên nhánh mặc định đời cũ.

#### Lộ trình A — Xuất bản `1.0.0-rc.1` lên dist-tag `next`

```sh
git tag -a v1.0.0-rc.1 -m "Release v1.0.0-rc.1"
git push origin v1.0.0-rc.1

for pkg in adapter-sdk core sources adapter-9router adapter-omniroute daemon cli mcp-server; do
  pnpm --filter "./packages/${pkg}" publish --access public --tag next --no-git-checks
done
```

#### Lộ trình B — Xuất bản chính thức `1.0.0` lên dist-tag `latest`

```sh
git tag -a v1.0.0 -m "Release v1.0.0"
git push origin v1.0.0

for pkg in adapter-sdk core sources adapter-9router adapter-omniroute daemon cli mcp-server; do
  pnpm --filter "./packages/${pkg}" publish --access public --no-git-checks
done
```

---

## 6. Biểu mẫu Ký duyệt Sau Thí điểm của Chủ dự án (`Owner Sign-Off Record`)

```markdown
### Biên bản Nghiệm thu Thí điểm Chạy thật C45-WP9 (Chỉ Chủ dự án Điền)
- Ngày giờ thực hiện: YYYY-MM-DD HH:MM (UTC+07:00)
- Mục tiêu Router thí điểm (`Hướng B`): router:<id>/<combo> (SHA-256 gốc: __________)
- Mục tiêu Harness thí điểm (`Hướng A`): harness:<id> (SHA-256 gốc: __________)
- [ ] Tiêu chí 1 — `falseRemovals`: 0
- [ ] Tiêu chí 2 — `rollbackByteExactMatch`: true (SHA-256 sau hoàn tác khớp 100%)
- [ ] Tiêu chí 3 — `detectionLatencyMs`: ______ ms (<= 60000 ms)
- [ ] Tiêu chí 4 — `tier0Tokens` / `tier0LlmCalls` / `tier0PaidRequests`: 0 / 0 / 0
- [ ] Tiêu chí 5 — `unplannedManualInterventions`: 0
- Quyết định phát hành của chủ dự án: [ ] `1.0.0-rc.1` (`next`) | [ ] `1.0.0` (`latest`)
```
