# Hướng Dẫn Chạy Thử UI Với Dữ Liệu Thật — Lát Cắt S1 (Read-Only)

> Tài liệu hướng dẫn Chủ dự án tự chạy thử nghiệm giao diện Web UI kết nối với background daemon chỉ-đọc (S1) trên máy cục bộ với các router thật (OmniRoute, 9Router).  
> **Lưu ý an toàn:** Agent AI KHÔNG tự ý khởi chạy tương tác router sống khi chưa có lệnh trực tiếp từ Chủ dự án (DECISIONS `2026-10-14-04`). Daemon S1 là thuần chỉ-đọc, không cần API key và không thực hiện bất kỳ thao tác ghi nào vào cơ sở dữ liệu router.

---

## 0. Bước 0: Sao Lưu An Toàn Trước Khi Thử Nghiệm

Mặc dù daemon S1 là thuần chỉ-đọc và sử dụng driver `@routersync/core/readonly` ép cứng cờ `readonly: true`, để đảm bảo an toàn theo chuẩn Governance, bạn nên tạo một bản sao lưu nhanh:

```powershell
# 1. Sao lưu cấu hình RouterSync (nếu có):
Copy-Item routersync.yaml routersync.yaml.bak -ErrorAction SilentlyContinue

# 2. Sao lưu database SQLite của router (nếu muốn):
# OmniRoute:
Copy-Item "$HOME\.omniroute\storage.sqlite" "$HOME\.omniroute\storage.sqlite.bak" -ErrorAction SilentlyContinue
# 9Router:
Copy-Item "$env:APPDATA\9router\db\data.sqlite" "$env:APPDATA\9router\db\data.sqlite.bak" -ErrorAction SilentlyContinue
```

---

## 1. Thiết Lập Biến Môi Trường (PowerShell)

Mở cửa sổ PowerShell (Terminal 1) tại thư mục gốc dự án `Router-Sync`.

Trong chế độ read-only của S1, **không cần cung cấp API key** hay mật khẩu router. Nếu router của bạn sử dụng cổng hoặc đường dẫn tùy biến, bạn có thể thiết lập:

```powershell
# Tùy chọn: chỉ định đường dẫn cấu hình cụ thể
# $env:ROUTERSYNC_CONFIG = "C:\path\to\routersync.yaml"

# Tùy chọn: ghi đè URL cổng probe của router (mặc định: OmniRoute 30128, 9Router 20128)
# $env:OMNIROUTE_URL = "http://127.0.0.1:30128"
# $env:NINEROUTER_URL = "http://127.0.0.1:20128"

# Tùy chọn: cho phép Origin tùy biến nếu UI chạy ở cổng khác 3100
# $env:ROUTERSYNC_UI_ORIGIN = "http://localhost:3100"
```

---

## 2. Biên Dịch Mã Nguồn

Trước khi chạy lần đầu, đảm bảo toàn bộ workspace đã được biên dịch sạch sẽ:

```powershell
pnpm build
```

---

## 3. Khởi Chạy Background Daemon (Terminal 1)

Chạy background daemon thuần chỉ-đọc trên loopback `127.0.0.1:3128`:

```powershell
# Cách 1: Sử dụng lệnh CLI routersync daemon (hỗ trợ tùy chọn -p và -c)
node packages/cli/dist/index.js daemon

# Hoặc kèm cấu hình:
# node packages/cli/dist/index.js daemon -c ./routersync.yaml -p 3128

# Hoặc Cách 2: Chạy trực tiếp qua gói daemon
node packages/daemon/dist/index.js
```

**Dấu hiệu thành công:**
```text
[routersync-daemon] Listening on http://127.0.0.1:3128 (read-only slice S1)
[routersync-daemon] Press Ctrl+C to terminate.
```

---

## 4. Khởi Chạy Giao Diện Web UI (Terminal 2)

Mở một cửa sổ PowerShell mới (Terminal 2) tại thư mục gốc `Router-Sync`:

```powershell
# Đặt biến môi trường để UI kết nối vào daemon cục bộ (thay vì MockApi in-memory)
$env:VITE_API = "http"

# Khởi chạy Vite dev server
pnpm ui:dev
```

**Dấu hiệu thành công:**
```text
  VITE v5.x  ready in ... ms

  ➜  Local:   http://localhost:3100/
  ➜  Network: use --host to expose
```

> **Lưu ý cho Chủ dự án:** nếu bạn mở UI với `VITE_API=http` nhưng **chưa bật daemon** (Terminal 1 chưa chạy), giao diện sẽ hiển thị trạng thái **"không khả dụng"** (unavailable) — đó là hành vi trung thực của UI, **không phải lỗi**. Bật daemon ở Terminal 1 rồi tải lại trang là dữ liệu hiện bình thường.

---

## 5. Truy Cập Giao Diện Trình Duyệt

1. Mở trình duyệt web tại địa chỉ:  
   👉 **`http://localhost:3100`**
2. Quan sát giao diện: UI gửi yêu cầu qua proxy tương đối `/api/v1/...` tới background daemon `http://127.0.0.1:3128`.

---

## 6. Kiểm Chứng Bằng Test Nghiệm Thu AT-122 (Tùy Chọn Dành Cho Chủ Dự Án)

Nếu bạn muốn kiểm chứng độc lập rằng daemon đọc database thật mà không làm thay đổi dù chỉ 1 byte hay sinh file tạm `.wal` / `.shm`:

```powershell
# Bật cờ ROUTERSYNC_LIVE_RO=1 và chạy test nghiệm thu AT-122:
$env:ROUTERSYNC_LIVE_RO = "1"
pnpm vitest run test/acceptance/at-122-live.test.ts --reporter=verbose
Remove-Item Env:\ROUTERSYNC_LIVE_RO
```

---

## 7. Bảng Phân Định Màn Hình: Dữ Liệu Thật vs. Chờ P3a / P3b

Do lát cắt S1 là bản tích hợp thuần chỉ-đọc (Read-Only Slice) trước thềm Phase 3a và Phase 3b, các màn hình được phản ánh trung thực như sau:

| Màn hình / Thành phần | Nguồn dữ liệu trong S1 | Trạng thái hiển thị trên giao diện | Ghi chú kỹ thuật |
|---|---|---|---|
| **Targets (`/targets`)** | **DỮ LIỆU THẬT** | Mỗi thẻ target được dựng từ phần tử `targets[]` của payload; mọi số chưa đo hiện "—" | Đọc từ SQLite DB của OmniRoute (`storage.sqlite`) và 9Router (`data.sqlite`); payload tách **hai khối riêng `db`** (SQLite) và **`probe`** (mạng) với metadata nguồn độc lập. `combosManaged` và `combosAdopted` được đo thật từ DB (`managed === true` vs `managed === false`), bỏ bản sao ở cấp top-level (chỉ nằm trong khối `db`); khi DB lỗi thì lược bỏ trường (không điền 0 giả). Thử nghiệm sống qua probe cổng `30128` và `20128` (phân loại truthful: up/down/unknown). Daemon S1 **không phát `applyState`** (S1 không ghi gì — R11-3), nên chip trạng thái áp dụng hiện "—" kèm nhãn "chưa đo ở S1". R14-1: màn hình là hàm thuần của view-model — không có chip tier, không có hàng "4 / 4" hay "3 / 4", không có công tắc preview/live (S1 không có thao tác ghi), và thẻ OpenCode chỉ hiện khi `targets[]` thật sự có `id: 'opencode'`. |
| **Combos (`/combos`)** | **DỮ LIỆU THẬT** | Danh sách combo thật từ DB; trả về rỗng nếu DB chưa có | Truy vấn trực tiếp từ bảng `combos` trong database SQLite của các router cục bộ. Không có combo giả trong payload: `claude-3-5-sonnet` và `gpt-4o-mini` không xuất hiện (kiểm tra tĩnh AT-139 + `git grep` trên `packages/ui/src/screens`). Phân loại trung thực: thuần `managed` hoặc `adopted` (loại bỏ nhãn suy đoán `free_only` theo tên). Không gộp mù: chỉ gộp bản ghi cùng id khi `strategy` và `models` giống hệt; nếu khác, phát hai phần tử riêng biệt. **R18-1:** route luôn trả đối tượng `{ meta, combos }` (không còn mảng trần) để UI phân biệt rõ "không khả dụng" với "không có combo nào"; `meta.routers` nói từng router đọc được hay không, nên khi một DB lỗi màn hình vẫn vẽ combo của DB đọc được kèm cảnh báo "Combo của <router> chưa đọc được". R14-2: bộ chọn combo và thang ưu tiên dựng từ `combosList` của view-model; tab "Tạo hoặc sửa" hiện khung nét đứt xám "Tạo/sửa combo cần P3b" khi dữ liệu là thật. **R18-2:** chiến lược của combo OmniRoute lấy từ `strategy` trong cột `data`; router không lưu thì daemon lược bỏ trường và màn hình hiện "—", không điền `priority` hộ. Chip quyền sở hữu chỉ còn một nhãn dịch (R18-5). |
| **Doctor (`/doctor`)** | **DỮ LIỆU THẬT + NÉT ĐỨT** | c1..c6: Đạt/Không đạt thật; c7..c9: Nét đứt xám (`Chưa chạy trong lát S1`) | c1 (Node: so `process.version` với ngưỡng đọc từ `engines` trong package.json), c2 (Config: **thiếu file `routersync.yaml` là trạng thái bình thường của S1** → `not_checked` với `code: 'config_missing'` và `reason: 'using_defaults'`; file tồn tại nhưng không đọc được → `fail` với `code: 'config_unreadable'`; file tồn tại nhưng sai cấu trúc → `fail` với `code: 'config_invalid'`; `overallStatus` chỉ là `error` khi có ít nhất một điều kiện `fail`, còn `not_checked` thì là `warning`), c3 (DB readable), c4 (**schema fingerprint** — kiểm bảng SQLite cần có, không phải "Integrity check"), c5 (Snapshot dir: daemon S1 mở DB với cờ chỉ-đọc và không tạo thư mục, nên thư mục snapshot chưa tồn tại ở máy chưa từng áp dụng là bình thường: c5 báo `not_checked` với `reason: 'no_snapshot_dir_yet'` và mã `snapshot_dir_missing`, cũng `not_checked` với `snapshot_none_yet` khi thư mục có nhưng còn 0 snapshot, `fail` khi `snapshot_dir_unwritable`, `pass` với `snapshot_dir_writable` khi có ≥1 snapshot hoặc không có DB), c6 (Loopback probe) đo thật; thông báo trả về dạng `{code, params}`. c7..c9 là tính năng của P3a nên hiển thị nét đứt xám kèm tooltip. |
| **Settings (`/settings`)** | **DỮ LIỆU THẬT** | Trả về `policyMode` thật từ config | Các trường không đo (`scanSchedule`, `maxDailyRequests`, `mcpClients`) được lược bỏ thay vì trả số giả. **R16-4:** `/settings` trả thêm `policyModeSource`: `'config'` khi đọc được từ `routersync.yaml`, `'default'` khi không có file (khi đó `policyMode` giữ nguyên `manual`).  **R17-2:** UI in `policyMode` thật; khi `policyModeSource === 'default'` in thêm "mặc định (chưa có routersync.yaml)"; `scanSchedule`, `maxDailyRequests`, `mcpClients` chưa đo nên hiện "—"; địa chỉ cục bộ lấy từ view-model thay vì hằng số trong mã |
| **Overview (`/overview`)** | **DỮ LIỆU THẬT + TỔNG HỢP** | Trạng thái hệ thống, bộ đếm targets, combos thật | Không có request tính phí nào được gửi: daemon chỉ đọc danh sách model và probe loopback. Bỏ trường `activeProviders` (S1 chưa đo provider; UI hiển thị "—" / "Chưa đo ở S1"), thay bằng `routers: { upCount, probedCount }`. `trackedModels.count` đo số model id duy nhất từ các combo trong DB đọc được (độc lập với probe). `lastCheck.code` trả `daemon_running` hoặc `router_disconnected`. S1 **không còn mảng `todoItems`/`recentEvents` kiểu cũ** và **không trả câu tiếng Việt tự do từ API** (D1: mọi thông báo là `{code, params}`, UI tự bản địa hóa qua `translations.json`). R14-3: ô "nhà cung cấp" cũ được thay bằng ô "router phản hồi" đọc từ `routers`; mọi ô khác hiện "—" khi view-model không có dữ liệu. **R16-2:** banner, ô số và 5 bước "RouterSync hoạt động thế nào" đều lấy từ view-model; nhãn "Chưa đo ở S1" chỉ hiện khi giá trị ngay trên nó là "—"; câu "RouterSync chưa ghi gì vào cấu hình của bạn" chỉ hiện khi daemon báo `readOnly: true`; nút "Review proposed changes" bị ẩn khi daemon chưa có kế hoạch để duyệt. |
| **Changes / Kế hoạch (`/changes`)** | *Nét đứt xám* | Viền nét đứt (dashed border), thông báo chờ P3b | Kế hoạch duyệt và ghi đè an toàn sẽ kích hoạt ở Phase 3b. |
| **Models (`/models`)** | *Nét đứt xám khi chưa đo* | Danh mục model đọc từ view-model. `/models` không khả dụng hoặc rỗng-vì-chưa-đo: khung nét đứt "Cần P3a" và ô đếm hiện "—", không hiện "0" | Cơ chế quét và chuẩn hóa danh mục model thời gian thực thuộc Phase 3a. Số "0" chỉ hiện khi view-model thật sự báo 0 |
| **Providers (`/providers`)** | **DỮ LIỆU THẬT + NÉT ĐỨT** | `meta.source === 'unavailable'`: khung nét đứt xám "Cần P3a", không thẻ, không số. `meta.source === 'sample'`: thẻ mẫu kèm nhãn "Dữ liệu mẫu". Nguồn thật nhưng rỗng: trạng thái rỗng riêng, không thẻ mẫu | **R17-1:** màn hình là hàm thuần của view-model; nội dung mẫu (tên provider, số model, hạn mức, thời điểm quét) chỉ nằm ở `packages/ui/src/api/mock.ts`. `HttpApi.getProviders()` giữ `meta` cấp collection giống `getCombos()`. Daemon S1 chưa đo provider (P3a) |
| **SetupWizard (`/setup`)** | *Nét đứt xám khi chưa có view-model* | Số model / combo và các dòng "đã phát hiện" đọc từ `SetupPreviewViewModel`; không có view-model thì khung nét đứt "Cần P3a" | **R17-2:** hằng số mẫu cũ (86 / 2 / 0 / 0, `localhost:30128`, `localhost:20128`, đường dẫn `opencode.json`) đã ra khỏi màn hình. Daemon S1 trả `slice_s1_deferred_to_p3a` cho `/api/v1/setup-preview`. **R18-4:** kịch bản minh họa ("đã tìm thấy 3 nơi", dấu ✓, "Đã quét xong lần đầu", "Khóa hợp lệ") chỉ hiện khi `meta.source === 'sample'`; với dữ liệu `live`/`unavailable` mọi bước nói đúng những gì đã đo — tức là không có gì — và không nơi áp dụng nào được tích sẵn. AT-154 phủ 4 bước × VI/EN |

> **Ghi chú R17 (trạng thái bằng chứng):** R17-1..R17-3 chuyển Providers, Settings, SetupWizard và phần Overview lần chạy đầu sang view-model: màn hình không còn số / tên mẫu cứng, nội dung mẫu chỉ nằm trong `packages/ui/src/api/mock.ts` và chỉ hiện khi `meta.source === 'sample'`. Điều này chưa chứng minh các màn hình đúng với dữ liệu thật trên mọi cấu hình: chưa ai chạy bộ kiểm tra trên máy có router thật, và ảnh chụp màn hình vẫn không phải bằng chứng vì ảnh không cho biết dữ liệu đến từ đâu. Bằng chứng hiện có là test màn hình và render audit: `.agent/evidence/r17-ui.txt`, `.agent/evidence/r17-render-audit.txt`. Phần chưa được audit cùng mức: màn **Guide** (chỉ là văn bản tĩnh) và mọi chuỗi trong `packages/ui/src/i18n/translations.json` (chỉ được kiểm gián tiếp qua render audit).

### 7.1. Render Audit Tương Tác Của ROUND19 (AT-155)

Render audit là **cổng nghiệm thu UI**: nó render thật từng màn hình, đọc DOM đã render, rồi đối chiếu với lưới poison và từ vựng khẳng định trạng thái. ROUND19 (AT-155) nâng nó từ **trạng thái mở đầu** (AT-148) lên **trạng thái tương tác**: mỗi màn hình được đi qua một bảng kịch bản tương tác viết tay, mỗi control được quét, và DOM được chụp lại sau **từng** bước.

**Chạy audit (chủ dự án tự chạy được):**

```powershell
pnpm --filter @routersync/ui test
```

Lệnh trên chạy cả bộ test UI, gồm AT-148 (trạng thái mở đầu) và AT-155 (trạng thái tương tác).

**Báo cáo của AT-155:** `test/ui/render-audit-interactive-report.txt`. Mỗi dòng có dạng:

```text
route | state | lang | scenario | step | text node(s) that contain a digit
```

- `state` là một trong bốn trạng thái daemon: `daemon_down`, `all_unavailable`, `live_fixture`, `live_fixture_up`.
- `lang` là `vi` hoặc `en`.
- `scenario` là tên chuyến đi của người dùng; `step` là hành động cụ thể trong chuyến đi đó.
- Cột cuối là các text node có chứa chữ số; `-` nghĩa là không có.

Báo cáo có phần **totals** ở cuối (số DOM đã quét, số control đã bấm, số control bị bỏ qua, số bước tùy chọn bị thiếu, số poison token, số vi phạm an toàn mạng), kèm danh sách control chưa bấm và danh sách UI bắt buộc nhưng không tồn tại. AT-148 giữ nguyên định dạng trạng thái mở đầu trong `test/ui/render-audit-report.txt`.

**Các file bảng và danh sách miễn trừ:**

| File | Vai trò |
|---|---|
| `test/ui/render-audit-scenarios.ts` | Bảng kịch bản tương tác: mỗi bước là một thao tác thật của người dùng; bước tùy chọn phải ghi rõ lý do có thể vắng. |
| `test/ui/render-audit-interactions-skip.json` | Danh sách bỏ qua viết tay của lượt quét control: `{route, control, reason}`. |
| `test/ui/render-audit-allow.json` | Allow list của lưới poison: `{route, token, reason}`. |
| `test/ui/status-claim-lexicon.json` | Từ vựng khẳng định trạng thái (dấu ✓, `đã tìm thấy`, `đã quét`, `đã xác minh`, `đã phát hiện` và bản EN `found` / `scanned` / `verified` / `detected`), cùng ngoại lệ `{route, token, reason}`. |

Mỗi ngoại lệ chỉ miễn trừ **một route**; không có miễn trừ ở phạm vi toàn cục. Lý do phải viết tay, và tên của từng ngoại lệ phải được nêu trong báo cáo.

**Lưới poison và hai trạng thái "chưa đo được gì":**

- Ở hai trạng thái `daemon_down` và `all_unavailable` (chưa đo được gì), lưới poison chạy **đầy đủ**.
- Ở hai trạng thái có số đo thật (`live_fixture`, `live_fixture_up`), lưới **bỏ** các token mà chính phép đo sinh ra (mọi con số, id/tên router, từ trạng thái của doctor) vì một số đo được có thể trùng số mẫu.
- Ngoại lệ còn lại được miễn trừ bằng allow list viết tay và phải được nêu tên trong báo cáo.

**Lưới an toàn mạng:** lát S1 là chỉ-đọc, nên mọi request mà app gửi đi phải là `GET /api/v1/...`. Phương thức khác hoặc URL khác là vi phạm: audit đỏ và in ra control đã gây ra nó.

> **Ghi chú R19 (trạng thái bằng chứng):** hai lỗi thật do AT-155 phát hiện đã được **sửa** chứ không giấu vào allow list — thẻ "Safety breaker" ở màn Changes (nay chỉ nói trạng thái cầu dao chưa đo được) và dòng đếm pass/fail ở màn Health (nay nói rõ máy chưa có điều kiện nào để kiểm tra). Bằng chứng vòng: `.agent/evidence/r19-render-audit.txt`, `.agent/evidence/r19-assert-diff.txt`.

### 7.1.1. Công Cụ Đếm Bằng AST (AT-158) và "Số Có Nguồn Gốc" (AT-159) Ở ROUND20

ROUND20 hoàn thiện lưới kiểm tra tính trung thực với hai cải tiến kỹ thuật quan trọng:

1. **Đếm assertion bằng cú pháp (AST) thay vì regex (AT-158):**
   - Công cụ `tools/agent/assert-counts.mjs` chuyển sang duyệt cây cú pháp TypeScript.
   - Định danh `expect(...)` là assertion; các lời gọi `it`/`test`, các modifier `.skip|.only|.todo|.concurrent`, hoặc `it.each([...])` (tính 1 case ở nguồn) là test case.
   - `RegExp#test(...)` và mọi lời gọi `.test(` trên đối tượng khác hoàn toàn bị loại trừ, không còn sinh ra test case ảo làm che giấu case thật bị mất.

2. **Số có nguồn gốc ở trạng thái live (AT-159):**
   - Ở hai trạng thái live (`live_fixture` và `live_fixture_up`), thay vì bỏ qua mọi con số như R19, AT-159 siết chặt quy tắc: **mỗi chuỗi số xuất hiện trên DOM bắt buộc phải chứng minh được nguồn gốc** từ 1 trong 3 nguồn:
     - **Nguồn (i) - Payload JSON:** Giá trị số xuất hiện trong payload thực tế của 6 route daemon (`/overview`, `/health`, `/targets`, `/combos`, `/providers`, `/models`, `/doctor`).
     - **Nguồn (ii) - Catalog dịch thuật:** Số tĩnh trong catalog `translations.json` ở đúng ngôn ngữ đang audit (loại trừ các khóa mẫu walkthrough như `w_1ok` chứa số bịa "86").
     - **Nguồn (iii) - Các hàm dẫn xuất tường minh (`test/ui/number-provenance.ts`):**
       - `derivedTimes`: Định dạng giờ cục bộ `hh:mm:ss` và `hh:mm` từ các trường ISO timestamp (`lastChecked`, `generatedAt`, `lastProbeAt`) qua `formatClock`.
       - `derivedUptimes`: Dung sai thời gian chạy của daemon trong khoảng `[uptime - 5, uptime + 60]` giây so với payload.
       - `derivedRatios`: Tỉ số router up/probed, unreachable/probed (`1/2`, `2/2`), và tỉ số bước combo (`0/0`).
       - `derivedModuleIndices`: Chỉ mục số thứ tự pipeline module `01` .. `08` ở Overview detail view.
       - `derivedStepPreviewLimit`: Hạn mức phân trang xem trước 10 bước của combo ladder (`10`).
       - `derivedHttpCodes`: Mã HTTP status 200 từ các lần probe thành công.
   - **Ngoại lệ viết tay (`test/ui/number-provenance-allow.json`):**
     - `guide`: Port `3100` trong đoạn code mẫu docker run tĩnh.
     - `settings`: Chip `4,000` trong tab AI/MCP mô tả giới hạn token tĩnh.

3. **Câu phủ định về máy cũng là khẳng định (R20-3):**
   - Câu phủ định về máy ("không phát hiện nơi áp dụng nào trên máy này" / "No target was detected on this machine") là một khẳng định đo đạc ("đã tìm và không thấy"), bị cấm khi chưa có phép đo thực sự đứng sau.
   - Câu phủ định chỉ được phép khi `meta.source === 'live'` và danh sách đo được thực sự rỗng.
   - Khi chưa đo hoặc tính năng thuộc lát sau, giao diện dùng câu trung thực "chưa đo": `"Lát S1 chưa dò được nơi áp dụng nào; phần này thuộc P3a."` (VI) và `"The S1 slice does not detect targets yet; that part belongs to P3a."` (EN).
   - `test/ui/status-claim-lexicon.json` mở rộng thêm 8 cụm từ phủ định (`không tìm thấy`, `chưa tìm thấy`, `không phát hiện`, `không có nơi áp dụng`, `no router found`, `no target was detected`, `nothing found`, `none found`) và được kiểm tra nghiêm ngặt trên cả 4 trạng thái daemon.

---

## 7b. Kỳ Vọng Khi Một Router Tắt

Mô tả này khớp với những gì code hiện tại vẽ ra, không phải mong muốn:

- **Banner Tổng quan:** dòng tiêu đề đếm số router KHÔNG phản hồi (`probedCount − upCount`), dòng phụ ngay dưới nêu tên router chưa phản hồi khi `/api/v1/health` đo được tên (`<router> chưa phản hồi. Kiểm tra kết nối của router đó rồi tải lại trang.`); không đo được tên thì câu trung tính "Kiểm tra router chưa phản hồi". Câu "Chưa có việc nào cần bạn xem" chỉ còn khi mọi router đã probe đều lên (AT-151).
- **Ô số:** vẫn hiện cặp đo được (`up/probed`, ví dụ `1/2`); ô **Trạng thái daemon** chỉ nói về daemon (`daemon_running` / `router_disconnected`), không đọc thành "mọi thứ bình thường" (R18-3).
- **Targets:** thẻ của router tắt hiện nhãn dịch "Không phản hồi", không phải enum `down` (R18-5).
- **Combos:** combo của DB còn đọc được vẫn hiện; một dải cảnh báo nêu tên router có combo chưa đọc được. Cả hai DB lỗi thì hiện khung "Không khả dụng", KHÔNG hiện "Chưa có combo nào" (R18-1).
- **SetupWizard:** không có dấu ✓, không có câu "đã tìm thấy N nơi"; mỗi bước hiện khung "Cần P3a" (R18-4).
- **Doctor:** trạng thái tổng thể hiện nhãn dịch ("Có cảnh báo" / "Có lỗi"), không phải `warning` / `error` (R18-5).

### 7b.1. Quy Tắc Chung Khi Router Tắt (R19)

- **Không khẳng định trạng thái chưa đo được.** Màn hình không bao giờ nói một trạng thái mà chưa có phép đo nào đứng sau. Khi router tắt, cách diễn đạt "chưa đo được gì" là cách diễn đạt **bình thường** của màn hình đó, không phải lỗi và không phải điều cần sửa.
- **Tên router trong banner.** Banner hiện **tên sản phẩm** `OmniRoute` và `9Router`, không phải id lowercase (`omniroute`, `9router`) — id là token của máy, không phải tên. Một id không có trong danh mục được in **nguyên văn**, không được bịa tên thay thế.
- **Không có phán quyết ghi ở lát S1.** Daemon S1 không phát `applyState` (S1 không ghi gì), nên màn Targets ở trạng thái này không có phán quyết ghi nào: trường vắng mặt, hiển thị "—" kèm nhãn "chưa đo ở S1".
- **Doctor không có gì để kiểm tra thì nói thẳng.** Khi doctor không tìm được điều kiện nào để kiểm tra, app nói rõ điều đó ("Máy chưa có điều kiện nào để kiểm tra (chưa đo được gì)") thay vì in một đếm pass/fail. Tương tự, màn Health không in "0 pass · 0 fail · 0 not evaluated" — đếm những phép kiểm tra chưa từng chạy là một phép đo bịa.

**Hai lỗi thật do AT-155 phát hiện và đã sửa ở ROUND19** (đã sửa theo nguyên tắc "màn hình là hàm thuần của view-model", không giấu vào allow list):

| Màn | Trước | Sau |
|---|---|---|
| **Changes** — thẻ "Safety breaker" | In trạng thái cầu dao và số bịa: `state: closed · consecutive failures: 0/3 · max_change_ratio: 12%/50%`, kèm dòng "Normal. RouterSync is allowed to write." dù không có gì được đo | Chỉ nói trạng thái cầu dao chưa đo được ("Trạng thái cầu dao: lát S1 chưa đo được.") |
| **Health** — dòng tóm tắt doctor | In "0 pass · 0 fail · 0 not evaluated" khi doctor chưa kiểm tra gì | Nói rõ máy chưa có điều kiện nào để kiểm tra |

Ảnh chụp màn hình không phải bằng chứng về nguồn dữ liệu: nó cho biết màn hình vẽ gì, không cho biết con số đến từ DB nào. Bằng chứng nằm ở test + payload.

## 7c. Các Giá Trị `applyState` Mà CLI / MCP / UI Có Thể In

Enum `applyState` có đúng ba giá trị:

| Giá trị | Khi nào được in |
|---|---|
| `verified` | Có bằng chứng đã ghi **và** đường phục vụ đọc lại được (read-back qua chính đường router dùng để phục vụ). |
| `written-pending-reload` | Có bằng chứng đã ghi, nhưng đường phục vụ chỉ đọc lại được ở mức `db-only` — combo mới chỉ hiện sau khi router reload. |
| `unwritten` | **Không có bằng chứng đã ghi.** |

**"Bằng chứng đã ghi" là gì:** với một target, bằng chứng là **một mục của target đó trong `managed-ids.json`** HOẶC **một snapshot của target đó trong thư mục snapshot**. Thiếu cả hai (hoặc thiếu cả sổ lẫn thư mục snapshot) thì trạng thái là `unwritten` — không có bằng chứng không phải là "sổ rỗng".

CLI `status` chỉ in `written-pending-reload` khi có bằng chứng; kiểm tra bằng chứng là **chỉ-đọc**, lệnh `status` không tạo file hay thư mục nào.

Giá trị `'not-applicable'` **không tồn tại**: nó đã bị bác khi quyết định `2026-10-18-01` được phán quyết. Enum chỉ được **thêm** (additive), hai giá trị cũ không đổi.

Daemon S1 **không phát** `applyState` (S1 không ghi gì). Vì vậy màn Targets ở lát S1 không có phán quyết ghi nào — xem §7b.1.

## 8. Cách Dừng Dịch Vụ

Khi kết thúc phiên trải nghiệm:
1. Tại **Terminal 2** (UI): Nhấn `Ctrl + C` để dừng Vite dev server.
2. Tại **Terminal 1** (Daemon): Nhấn `Ctrl + C` để dừng background daemon.
3. Nếu muốn xóa các biến môi trường phiên làm việc:
   ```powershell
   Remove-Item Env:\VITE_API -ErrorAction SilentlyContinue
   Remove-Item Env:\ROUTERSYNC_CONFIG -ErrorAction SilentlyContinue
   Remove-Item Env:\ROUTERSYNC_UI_ORIGIN -ErrorAction SilentlyContinue
   ```

---

## 9. Xử Lý Sự Cố Và Hai Lỗi Đã Sửa Ở ROUND16

### 9.1 Nhãn "Dữ liệu mẫu" xuất hiện dù đã đặt `VITE_API=http`

Nhãn **"Dữ liệu mẫu"** ở thanh dữ liệu nghĩa là **UI chưa nối được tới daemon** — nó đang chạy bằng bộ dữ liệu mẫu trong bộ nhớ, không phải dữ liệu từ router của bạn. Kiểm tra theo thứ tự:

1. Mở **Terminal 1**: daemon đã lên chưa? Dò `[routersync-daemon] Listening on http://127.0.0.1:3128`.
2. Mở tab Network của trình duyệt: có request `/api/v1/overview` không? Nếu không có request nào, UI chưa chọn đúng client.
3. `VITE_API` chỉ được đọc **lúc Vite khởi động**. Nếu bạn đặt biến sau đó, hãy dừng `pnpm ui:dev` (Ctrl+C) rồi chạy lại.

Nhãn **"Không kết nối được daemon"** nghĩa là UI đã dùng đúng client HTTP nhưng daemon không trả lời — hãy bật daemon ở Terminal 1 rồi tải lại trang.

### 9.2 Lỗi đã sửa: `comboStrategies` của 9Router là object → màn Combos trắng

- **Hiện tượng:** mở màn Combos → trang trắng hoặc lỗi "Objects are not valid as a React child".
- **Nguyên nhân:** 9Router lưu `settings.comboStrategies` không đồng nhất — combo cũ lưu chuỗi, combo mới lưu object `{ fallbackStrategy: "..." }`. Daemon gán thẳng giá trị đó vào trường `strategy` (khai báo là `string`), nên payload `/api/v1/combos` vi phạm chính contract của nó và React không render được object.
- **Đã sửa (R16-1):** daemon chuẩn hoá `strategy` thành chuỗi theo đúng luật của `adapter-9router` (`normalizeComboStrategyValue`), và AT-143 + AT-145 khóa lại hành vi này.

### 9.3 Lỗi đã sửa: `import.meta?.env` khiến UI luôn dùng dữ liệu mẫu

- **Hiện tượng:** đã đặt `VITE_API=http`, daemon đang chạy, nhưng UI vẫn hiện dữ liệu mẫu (xem 9.1).
- **Nguyên nhân:** dùng `import.meta?.env` (optional chaining) khiến Vite **không thay thế biến lúc build**, nên `VITE_API` không bao giờ tới được UI và client luôn là `MockApi`.
- **Đã sửa (R16-1):** đọc biến bằng `import.meta.env` đúng cách; AT-144 quét mọi file trong `packages/ui/src` để chặn `import.meta?.` quay lại.
