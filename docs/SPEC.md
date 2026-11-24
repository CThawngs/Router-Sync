# RouterSync — Đặc tả Chuẩn C45 (`SPEC.md`)

- **Phục vụ:** `S10` (nguồn sự thật duy nhất và nền tảng truy xuất cho `S1`–`S9`)
- **Nền mã nguồn đối chiếu:** `main` @ `2ea12c4` (sau khi hoàn tất C44: PR `#66`–`#69`, `evidence/c44` `ec4b4804`, `evidence/m3` `9d82fec`, `evidence/m4` `75d0e13`)
- **Mục tiêu phát hành:** `1.0.0` đầy đủ đặc tả (tùy chọn `1.0.0-rc.1` trên dist-tag `next` sau WP9); bản `0.1.0` hiện tại được định danh lại là **bản chẩn đoán chỉ đọc (không phát hành lên npm)**.

---

## 1. Đặc tả của chủ dự án — Nguồn sự thật duy nhất

*(Trích giữ nguyên văn mục 1 chỉ thị C45; không diễn giải thêm, không lược bớt.)*

- **S1.** Mục đích tối cao: người dùng không còn tự cấu hình, tự cập nhật, tự tìm model bằng tay. Mức tự động cao nhất, nhanh nhất, chính xác nhất. Thành bại do hai thứ: tìm kiếm web thời gian thực và lịch chạy định kỳ.
- **S2.** Hình thức: một MCP server gắn vào các harness có sẵn (Hermes, Claude Code, Codex, Antigravity, OpenCode, Cursor, Grok bot, OpenMausBot và các harness tương tự). Không tự xây agent riêng; tận dụng agent của các hãng lớn.
- **S3.** Hướng A, với harness: sau khi kết nối MCP, agent lấy dữ liệu model mới nhất từ nguồn chính chủ của từng provider, đối chiếu với model đã cấu hình trong harness (provider đã nhập key thành công), loại model hết hạn hoặc không còn tồn tại, thêm model mới.
- **S4.** Hướng B, với router (9Router, OmniRoute, LiteLLM và các router khác): cập nhật combo theo cùng cơ chế, có chiến lược routing (khi một model hay provider bị rate limit thì chuyển sang model hay provider khác). Chiến lược khác nhau theo từng app, chọn cho phù hợp, tối ưu và cá nhân hóa theo từng người dùng.
- **S5.** Agent phải hỏi kỹ người dùng để biết nhu cầu. Người dùng mơ hồ hoặc không rành kỹ thuật thì hỏi chung chung hoặc gợi ý, rồi agent tự quyết định cho phù hợp nhất.
- **S6.** Tận dụng cron có sẵn của harness. Harness không có cron thì phải có phương án thay thế do đội tự tính và giải quyết.
- **S7.** Gần như không tốn token. Tác vụ lặp lại chạy bằng mã xác định, 0 token. LLM chỉ dùng khi thật sự cần ra quyết định. Nếu cách làm tốn nhiều tiền thật thì người dùng tự làm tay còn hơn.
- **S8.** Giao việc cho đội bot theo gói lớn, hoàn chỉnh, không sa vào từng tính năng nhỏ.
- **S9.** Giai đoạn cuối: kiểm thử end-to-end thật, dữ liệu thật, ghi database thật, không chỉ kiểm thử an toàn.
- **S10.** Không lan man, không lệch mục tiêu. Mỗi PR và mỗi vé ghi rõ phục vụ điều khoản nào (S1 đến S9); PM từ chối vé không ghi được.

---

## 2. Bảng khoảng trống hiện trạng trên `main` (`2ea12c4`) so với đặc tả `S1`–`S10`

### 2.1. Năng lực nền tảng đã xác nhận tồn tại trên `main` (`2ea12c4`)

Các thành phần sau đã được kiểm chứng trực tiếp trên mã nguồn `main` (`2ea12c4`) và được kế thừa làm nền cho chương trình C45:

| Nhóm năng lực | Bằng chứng mã nguồn (`file:line`) | Ghi chú xác minh |
|---|---|---|
| Bộ quét xác định 3 tầng (L1 / L2 / L3) | `packages/sources/src/discovery/provider-scanner.ts:32`, `packages/cli/src/verify/l2-scanner.ts:33,64`, `packages/cli/src/verify/l3-scanner.ts:30,252` | L1 liệt kê model từ provider (`GET /models`, 0 inference); L2 đối chiếu catalog thứ cấp TTL 1h; L3 đọc thông báo ngừng TTL 24h |
| Bộ lập kế hoạch tất định & bất biến `I1`–`I8` | `packages/core/src/planner/index.ts:25` | Tính diff và kế hoạch combo 0 token, giữ bất biến `I1`–`I8` |
| Adapter 9Router & OmniRoute | `packages/adapter-9router/src/index.ts:56,167,363`, `packages/adapter-omniroute/src/index.ts:51,133` | Đọc/ghi SQLite có schema fingerprint (`NINEROUTER_SCHEMA`, `OMNIROUTE_SCHEMA`), 9Router ghi `kind = NULL` để phản ánh qua `/v1/models` |
| MCP server chỉ đọc 24 công cụ | `packages/mcp-server/src/server.ts:4-5,91,209-1282` | 24 công cụ đọc trạng thái, catalog, inbox, chẩn đoán; hiện có `0` công cụ ghi hoặc nộp bằng chứng |
| Daemon, `schedule install`, `tick` cổng 15 phút | `packages/daemon/src/server.ts:83,218`, `packages/cli/src/commands/schedule.ts:1-45`, `packages/cli/src/commands/tick.ts:523-524,541` | Daemon cục bộ `127.0.0.1`, sinh artifact lập lịch Windows/macOS/Linux, cổng `minScanIntervalMs = 15 * 60 * 1000` (`MIN_INTERVAL_SKIPPED`) |
| Vòng đời Grant, Approval Token & Read-Back | `packages/cli/src/maintain/grant.ts:1-45`, `packages/daemon/src/security/approval-token.ts:44,165,177`, `packages/cli/src/commands/maintain.ts:845-864,1062-1098` | Scrypt + HMAC-SHA256 `GrantFile`, `ApprovalTokenManager` dùng một lần gắn `planHash`, xác minh đọc lại đường phục vụ (`live-api` vs `db-only`) |
| Công cụ độ ổn định combo | `packages/cli/src/commands/combos-reliability.ts:124-163` | Chấm nhãn bước combo (`RELIABLE_OK_MIN = 5`, `SLOW_P90_MS = 5000`, `STEP_TIMEOUT_MS = 30000`) |

### 2.2. Bảng đối chiếu khoảng trống theo từng điều khoản (`S1`–`S10`)

| Điều khoản | Hiện trạng đã kiểm chứng trên `main` (`2ea12c4`) & đính chính so với C45 §2 | Khoảng trống cần đóng để đạt `1.0.0` | Gói việc xử lý |
|---|---|---|---|
| **S1** (Tự động hóa tối cao: tìm web thời gian thực + lịch chạy định kỳ) | `tick` chạy quét L1/L2/L3 định kỳ với cổng 15 phút (`packages/cli/src/commands/tick.ts:523-524,1014`), nhưng chưa có vòng nghiên cứu 2 tầng kết hợp tìm web thời gian thực của agent harness, chưa có sổ bằng chứng nguồn chính chủ có kiểm miền và chưa đo độ trễ phát hiện. | Xây vòng nghiên cứu 2 tầng (Tầng 0 lịch 0-token + Tầng 1 agent tìm web nộp qua `submit_research` có kiểm miền nguồn chính chủ, giữ trần co 10%, không coi `UNVERIFIABLE` là vắng, ghi độ trễ phát hiện vào nhật ký) kết hợp thang lịch chạy 4 bậc. | `WP3`, `WP7` |
| **S2** (MCP server gắn đa harness, không tự xây agent riêng) | `mcp install` (`packages/cli/src/commands/mcp-install.ts:23,74,90,151-154`) chỉ hỗ trợ ghi/trộn trực tiếp cho `hermes` và `dsh`; chỉ in cấu hình mẫu (`--print`) cho `claude-code`, `cursor`, `codex`, `antigravity`, `opencode`; hoàn toàn chưa có mục `openmausbot` và `grok`. MCP server (`packages/mcp-server/src/server.ts:4-5,91,209-1282`) chỉ có 24 công cụ đọc, thiếu công cụ nộp nghiên cứu, áp kế hoạch có cổng, tick khi quá hạn và báo cáo chi phí. | Lập ma trận năng lực harness có kiểm chứng (bậc A/B/C) cho toàn bộ danh sách S2, nối `mcp install` đọc từ ma trận; bổ sung công cụ MCP chuẩn (`submit_research`, `apply_plan`, `tick_if_due`, `cost_report`). | `WP1`, `WP3`, `WP4`, `WP7`, `WP8` |
| **S3** (Hướng A — đối chiếu & cập nhật danh sách model của harness) | **Đính chính kiểm chứng so với C45 §2:** `packages/cli/src/apps/inspect.ts:35` (`AGENT_APP_IDS`) thực tế kiểm tra chỉ đọc **4** app (`hermes`, `dsh`, `opencode`, `openmausbot`, với module `packages/cli/src/apps/openmausbot.ts:1-114`), mặc dù chú thích đầu tệp tại `packages/cli/src/apps/inspect.ts:5` vẫn ghi 3 app (`Hermes Agent, DSH Desktop, OpenCode`). Khẳng định đúng phần thiếu: `packages/cli/src/apps/inspect.ts:8` chỉ đọc tuyệt đối, **chưa có** đường `plan`, `apply`, `rollback` hay `read-back` cho bất kỳ tệp cấu hình harness nào; `docs/adapters/opencode.md:10` vẫn ghi `DEFERRED / EXAMPLE ONLY` và `docs/adapters/openclaw.md:10` ghi `DEFERRED / NOT INSTALLED`. | Xây ma trận vị trí/định dạng tệp model của từng harness (WP1) và adapter ghi đầy đủ (`inspect`, `plan`, `apply`, `rollback`, `read-back`) cho các harness có tệp cấu hình sửa được ở bậc A/B (chỉ sửa danh sách model của provider đã có key, không đụng key/base URL/default slot, bảo toàn chú thích & định dạng YAML/TOML/JSONC, test khứ hồi bảo toàn byte). Harness chỉ chỉnh qua UI thì ghi rõ chế độ báo cáo & hướng dẫn. | `WP1`, `WP2` |
| **S4** (Hướng B — router combo, chiến lược routing cá nhân hóa, LiteLLM) | Đường ghi router trong `maintain` khóa cứng tên combo khớp `^test-\d+$` (`packages/cli/src/maintain/grant.ts:26`, `packages/cli/src/commands/maintain.ts:105,650`) và giới hạn grant tối đa 8h cho `hermes`/`dsh` (`packages/cli/src/maintain/grant.ts:27-28`); ghi thật đòi hỏi TTY tương tác và gõ từ xác nhận `'chay'` mỗi lần (`packages/cli/src/commands/apply.ts:7,35,96,121`, `packages/cli/src/commands/maintain.ts:499-515,696-723,946-1004`). Chế độ `auto-safe` bị gỡ ở A8 (`packages/cli/src/commands/tick.ts:34,47-51`) và từng bị xếp vào "Hoãn sau v1" trong `docs/ROADMAP.md`. LiteLLM mới có đánh giá khả thi (`docs/adapters/litellm-feasibility.md:1-85`) và trình xuất YAML chỉ đọc (`packages/cli/src/export/litellm.ts:52,149`), chưa có adapter đọc/kế hoạch/ghi/hoàn tác. | Thêm sự đồng ý đứng (`standing consent`, mặc định 30 ngày) thay giới hạn cứng `^test-\d+$` bằng phạm vi lấy từ chính sách (mặc định rỗng); triển khai chế độ 3 bậc (`propose`, `auto-safe`, `off`), lệnh khẩn cấp `freeze` và `status` hiển thị bậc mục tiêu; xây bộ chọn chiến lược routing cá nhân hóa theo hồ sơ & độ ổn định combo (trần 12–15 bước, loại HANG/DEAD, xen kẽ provider); hoàn thiện adapter LiteLLM (hoặc ghi bằng chứng giới hạn nếu không khả thi). | `WP4`, `WP5` |
| **S5** (Phỏng vấn nhu cầu người dùng thích ứng) | `profile_interview` (`packages/core/src/profile/questions.ts:15-28`, `packages/cli/src/profile/interview.ts:16-56`) dùng danh sách cố định 12 câu hỏi phẳng, thuật ngữ kỹ thuật cứng (`allowList`, `denyList`, `keepHead`), chưa rẽ nhánh thích ứng theo câu trả lời mơ hồ, chưa có ví dụ đời thường, chưa ghi giả định tường minh vào `profile.yaml` và chưa đóng gói thành prompt/skill theo từng harness. | Xây kịch bản phỏng vấn thích ứng tối đa 12 câu (phát hành dạng MCP prompt/skill + tệp hướng dẫn cho từng harness), tự áp mặc định và ghi rõ giả định vào `profile.yaml` khi người dùng trả lời mơ hồ, dùng ví dụ đời thường cho người không rành kỹ thuật, tuyệt đối không bịa dữ liệu hồ sơ. | `WP6` |
| **S6** (Tận dụng cron của harness + phương án thay thế) | Khảo sát cron harness (`docs/harness-cron.md:1-74`, toàn tệp `1-125`) chỉ mới bao phủ `hermes` (`L11-44`) và `dsh` (`L45-73`). `packages/cli/src/commands/schedule.ts:1-45` đã sinh artifact OS scheduler, nhưng chưa có thang lịch 4 bậc thống nhất cho toàn bộ harness, chưa có công cụ MCP `tick_if_due` (chạy nền khi quá hạn qua cổng 15 phút + khóa tệp), và `doctor` chưa báo bậc lịch từng harness hoặc cảnh báo khi tuổi tick vượt 2× chu kỳ. | Khảo sát cron gốc của mọi harness S2 (WP1) và triển khai thang lịch 4 bậc (1. cron gốc không qua LLM → 2. OS scheduler qua `schedule install` có kiểm thử chạy khô CI 5 OS → 3. `tick_if_due` theo yêu cầu → 4. daemon), nâng cấp `doctor` báo bậc và độ trễ tick + tài liệu quyết định cho người dùng. | `WP1`, `WP7` |
| **S7** (Gần như không tốn token — mã xác định 0 token) | `packages/cli/src/commands/tick.ts:11` in dòng kế toán `tokens=0`, nhưng chưa có sổ cái token bền vững phân biệt `tick` 0-token (kèm số request mạng theo miền) với phiên nghiên cứu agent (số lần gọi công cụ, lượng văn bản trả về), chưa có công cụ MCP `cost_report` tóm tắt tuần, chưa có trần số phiên nghiên cứu/tuần và chưa có test chứng minh mã sản phẩm không gọi endpoint LLM. | Xây sổ cái token tách bạch `tick` (`tokens=0` + request theo miền) và phiên nghiên cứu agent, bổ sung MCP `cost_report`, cấu hình trần phiên nghiên cứu/tuần (mặc định thấp) và bộ test chứng minh mã sản phẩm 0 lời gọi LLM, chỉ gọi miền trong allowlist. | `WP8` |
| **S8** (Giao việc theo gói lớn hoàn chỉnh) | C44 kết thúc các mốc nền M1–M4 + Track W nhưng chưa cấu trúc backlog theo chuỗi gói việc lớn bám sát S1–S9. | Chia chương trình C45 thành 10 gói việc lớn tuần tự `WP0`–`WP9` gom vào 3 nhánh bằng chứng (`evidence/d1`, `evidence/d2`, `evidence/d3`), không sa vào tính năng lẻ. | `WP0`–`WP9` |
| **S9** (Kiểm thử E2E thật, dữ liệu thật, ghi DB thật ở giai đoạn cuối) | Đã có đường kiểm thử ghi trên bản sao DB trong `os.tmpdir()` (`packages/cli/src/commands/maintain.ts:707,958`), nhưng chưa có runbook thí điểm chạy thật đầy đủ (`LIVE-E2E-v2`), chưa có công cụ kiểm tra tiền điều kiện chạy thật (`live-check`) và bộ tiêu chí đo lượng hóa cho giai đoạn chủ dự án thí điểm. | Viết runbook thí điểm chạy thật + công cụ `live-check` kiểm tra tiền điều kiện, quy trình chọn mục tiêu thí điểm (1 combo + 1 tệp harness), thăng bậc `propose` → `auto-safe` và 5 chỉ số đạt đo được (0 model loại sai, hoàn tác khớp từng byte, độ trễ phát hiện, token đã dùng, số lần can thiệp tay). Đội dừng ở trạng thái "sẵn sàng chạy thật" chờ chủ dự án tự chạy. | `WP9` |
| **S10** (Không lan man, không lệch mục tiêu; truy xuất `Phục vụ: S#`) | Trước C45 chưa có tệp đặc tả nguồn sự thật duy nhất `docs/SPEC.md` và chưa có cổng bắt buộc `Phục vụ: S#` trên mọi vé và PR. | Ban hành `docs/SPEC.md`, cập nhật `docs/ROADMAP.md`, `docs/RELEASE-CANDIDATE.md`, `CHANGELOG.md`, `docs/BACKLOG.md` với trường `Phục vụ: S#` bắt buộc và test hợp đồng tự động `test/docs/c45-wp0-spec.test.ts`; PM từ chối mọi vé/PR thiếu `Phục vụ: S#`. | `WP0` |

---

## 3. Quy tắc vận hành & bất biến an toàn C45

### 3.1. Năm quy tắc bổ sung bắt buộc của C45 (C45 §3)

1. **Truy xuất mục tiêu (`Phục vụ: S#`):** Mọi vé trong `docs/BACKLOG.md` và mọi Pull Request đều phải ghi rõ `Phục vụ: S#` (`S1`–`S10`). Product Manager từ chối vé không ghi được điều khoản phục vụ. Việc không nằm trực tiếp trong `S1`–`S9` (bao gồm sự cố treo của 9Router, hạ tầng CI, đóng gói) chỉ được thực hiện khi chặn trực tiếp một WP và phải ghi rõ lý do chặn.
2. **Chế độ thật ba bậc theo từng mục tiêu ghi:** Áp dụng độc lập cho từng mục tiêu ghi (một combo router hoặc một tệp cấu hình harness):
   - `propose` *(mặc định)*: hệ thống lập kế hoạch và chờ người dùng duyệt từng kế hoạch trước khi áp.
   - `auto-safe`: tự động áp dụng trong phạm vi luật an toàn (loại model có bằng chứng ngừng, thêm model đã xác minh theo chiến lược, giữ nguyên bất biến `I1`–`I8`, thông báo sau khi áp qua hộp thư và webhook).
   - `off`: khóa hoàn toàn đường ghi cho mục tiêu đó.
   - **Cổng thăng bậc bắt buộc:** Một mục tiêu chỉ được phép nâng từ `propose` lên `auto-safe` sau khi đã có **ít nhất 1 lần áp ở bậc `propose` thành công và xác minh `read-back` khớp**.
3. **Bất biến đường ghi ở mọi bậc (`backup → atomic write → read-back → auto-rollback`):** Dù mục tiêu đang ở `propose` hay `auto-safe`, mọi thao tác ghi bắt buộc phải thực hiện đủ 4 bước liên hoàn:
   1. Tạo **bản sao lưu** (backup) trước khi ghi;
   2. **Ghi nguyên tử** (atomic write / transaction);
   3. **Đọc lại** (`read-back`) xác minh trạng thái thực tế sau ghi;
   4. **Hoàn tác tự động** (`auto-rollback`) ngay lập tức nếu phát hiện bất kỳ sai lệch nào.
   Tuyệt đối không bỏ bất kỳ bước nào trong chuỗi này dưới lý do "thử thật".
4. **Ranh giới kiểm thử bản sao tạm & quyền hạn chạy thật:** Toàn bộ mã ghi của đội chỉ được chạy thử trên bản sao trong thư mục tạm (`os.tmpdir()`). Đội tuyệt đối **không** ghi vào router thật (các cổng thật của người dùng) hay tệp cấu hình harness thật của chủ dự án; chỉ chủ dự án trực tiếp chạy chế độ thật ở `WP9`. Đội **không** chạy `npm publish` và **không** tạo hoặc đẩy tag phát hành.
5. **Kỷ luật 0 token cho mã sản phẩm:** LLM của đội bot chỉ được dùng cho tác vụ cần phán đoán kỹ thuật trong quá trình xây dựng (nghiên cứu nguồn chính thức ở WP1, thiết kế, viết mã). **Mã sản phẩm RouterSync tuyệt đối không gọi bất kỳ endpoint LLM nào.**

### 3.2. Quy tắc kế thừa từ C44 (giữ nguyên hiệu lực)

- **Luồng giao mã:** Nhánh riêng → Pull Request → CI xanh đủ **5 hệ điều hành** (`ubuntu-latest`, `ubuntu-24.04-arm`, `macos-latest`, `windows-latest`, `windows-11-arm`) → **QA** ký xác minh độc lập → **Ops** `gh pr merge --squash` → CI `main` xanh ở `attempt=1`.
- **Kiểm chứng chất lượng:** Giữ **Red-First**; mọi mã chạm bảo mật, đường ghi, token, cấu hình hoặc cổng kiểm soát phải qua kiểm thử đột biến của **Engineer** và kiểm thử đột biến riêng của **QA** (PR `docs-only` được QA rà soát diff và chạy verifier).
- **Gói bằng chứng & vệ sinh bảo mật:** Ba nhánh `evidence/d1` (`WP0`–`WP3`), `evidence/d2` (`WP4`–`WP6`), `evidence/d3` (`WP7`–`WP9`), tối đa `10` tệp mỗi nhánh, commit `[skip ci]`, không mở PR, thu thập qua `tools/agent/capture-evidence.mjs`, đạt verifier chuẩn SẠCH (`verify-records.mjs`, `verify-package.mjs`), quét tên riêng và mẫu cá nhân bằng `0` khớp; tuyệt đối không in key, token, hash bí mật, tên riêng hoặc đường dẫn máy cá nhân; tuyệt đối không track thư mục `evidence/` trên `main`.
- **Song song & điều kiện dừng:** Gom vé vào PR, tối đa `2` PR mở cùng lúc khi hoàn toàn không chung tệp; tuân thủ đầy đủ điều kiện dừng của C44 §3; việc cần chủ dự án quyết định được xếp vào hàng đợi `chờ chủ dự án` và đội tiếp tục các gói việc độc lập.
