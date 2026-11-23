# Milestone M2 Closure Report — `evidence/m2` (GitHub-First cho Planner từ xa)

- **Kho mã:** https://github.com/CThawngs/Router-Sync (`<REPO>`)
- **Nhánh bằng chứng:** `evidence/m2` (tạo trực tiếp từ `main` tại `bc614368b2becbbb4309265d8822f8dee813003f`, commit `[skip ci]`, không mở PR, không merge vào `main`, `0` workflow CI chạy trên nhánh)
- **Ngày khóa gói:** `2026-11-24` (UTC `2026-11-23 20:29Z–20:32Z`)
- **Phạm vi đóng mốc:** Toàn bộ `3/3` vé Milestone **M2** (`M2-01`, `M2-02`, `M2-03`) đã hoàn tất tuần tự theo quy trình `CTO → Engineer (Red-First + Mutation) → CI 5 OS → QA (Checkout sạch + Mutation độc lập) → Ops (Squash-Merge) → main Push CI`.
- **Tác động lên router thật:** `0` request HTTP tới 9Router (`127.0.0.1:20128`), OmniRoute (`127.0.0.1:30128`), hoặc cổng `3128`; `0` thao tác ghi vào DB/cấu hình router thật (`100%` thư mục tạm/SQLite tạm và `FakeRouter` / HTTP server giả lập `127.0.0.1:0`).

---

## (a) Tổng hợp kết quả hoàn tất `3/3` vé Milestone M2 trên `main`

### 1. Bảng chuỗi PR, Commit Merge, CI `5` Hệ điều hành & Biên bản QA Độc lập

| Vé | PR GitHub & Nhánh nguồn | Head SHA trước Merge | PR CI `5` OS (`attempt=1`) | Biên bản QA Độc lập | Squash-Merge Commit trên `main` | `main` Push CI | Ghi chú chuỗi xanh `main` |
|---|---|---|---|---|---|---|---|
| **M2-01** | [PR #62](https://github.com/CThawngs/Router-Sync/pull/62) (`feat/m2-01-grant-approval`) | `435d688d57da7270061b8ad02c59e213e7e231b9` (`435d688`) | [Run 45178905910](https://github.com/CThawngs/Router-Sync/actions/runs/45178905910) — `18/18` GREEN (`attempt=1`) | [Comment 7102377750](https://github.com/CThawngs/Router-Sync/pull/62#issuecomment-7102377750) — **SIGNED OFF** (`QA-M1..M4`) | [`7abfd74`](https://github.com/CThawngs/Router-Sync/commit/7abfd7402edb5c5a5cf6ea0dfe264415534a1b02) (`8` tệp) | [Run 45183419433](https://github.com/CThawngs/Router-Sync/actions/runs/45183419433) — `18/18` GREEN (`attempt=1`) | Streak `23` (`5b39320` Track R `24`) |
| **M2-02** | [PR #64](https://github.com/CThawngs/Router-Sync/pull/64) (`feat/m2-02-webhook-alerts`) | `1a3e940ea91ec462767ac76f7775bcd5046d1b19` (`1a3e940`) | [Run 45198922953](https://github.com/CThawngs/Router-Sync/actions/runs/45198922953) — `18/18` GREEN (`attempt=1`) | [Comment 7105458584](https://github.com/CThawngs/Router-Sync/pull/64#issuecomment-7105458584) — **SIGNED OFF** (`QA-M1..M4`) | [`8ca92f8`](https://github.com/CThawngs/Router-Sync/commit/8ca92f8110585d251618b5ff33b4e5cd951bcec0) (`9` tệp) | [Run 45205533592](https://github.com/CThawngs/Router-Sync/actions/runs/45205533592) — `Attempt #1`: `17/18` (lỗi hạ tầng `macos-latest`), `Attempt #2`: `18/18` GREEN | Reset streak `attempt=1` tại `8ca92f8` (sự cố runner GitHub) |
| **M2-03** | [PR #65](https://github.com/CThawngs/Router-Sync/pull/65) (`feat/m2-03-serving-readback`) | `719472c15820243d668dfd08489386a591a42869` (`719472c`) | [Run 45252281400](https://github.com/CThawngs/Router-Sync/actions/runs/45252281400) — `18/18` GREEN (`attempt=1`) | [Comment 7112628198](https://github.com/CThawngs/Router-Sync/pull/65#issuecomment-7112628198) — **SIGNED OFF** (`QA-M1`) | [`bc61436`](https://github.com/CThawngs/Router-Sync/commit/bc614368b2becbbb4309265d8822f8dee813003f) (`16` tệp) | [Run 45257738274](https://github.com/CThawngs/Router-Sync/actions/runs/45257738274) — `18/18` GREEN (`attempt=1`) | **`1`** (`firstSha=bc61436 lastSha=bc61436` — `đo được (evidence/m2:m2-ci-stats)`) |

> **Công bố minh bạch về CI `main` của `M2-02` ([Run 45205533592](https://github.com/CThawngs/Router-Sync/actions/runs/45205533592)):**
> - `5/6` lượt chạy CI trong Milestone M2 (`3/3` PR CI + `main` Push CI của `M2-01` & `M2-03`) đạt `18/18` GREEN ngay ở **`attempt=1`**.
> - Riêng `main` Push CI của `M2-02` (`8ca92f8`, [Run 45205533592](https://github.com/CThawngs/Router-Sync/actions/runs/45205533592)): `Attempt #1` đạt `17/18` GREEN và fail duy nhất job `verify (macos-latest, node 22)` (`conclusion=cancelled`, `steps=[]`, `runner_id=0`) do không cấp phát được hosted runner GitHub (*"The job was not acquired by Runner of type hosted even after multiple attempts"*); khi chạy lại **`Attempt #2` đạt `18/18` GREEN** (`0` lỗi mã nguồn). Theo luật `ci-stats-core.mjs` (chỉ tính `run_attempt === 1` cho `pushMainStreak`), sự kiện rerun hạ tầng này đã đặt lại chuỗi `push on main consecutive green first attempt` tại `8ca92f8`, trước khi `M2-03` (`bc61436`) mở lại chuỗi **`1`** (`đo được (evidence/m2:m2-ci-stats)`).

---

### 2. Chi tiết kỹ thuật, Bằng chứng Red-First & Kiểm thử Đột biến (Engineer + QA Độc lập)

#### 2.1 `M2-01` (Slice `P3.1` — Grant Lifecycle & HMAC Approval Tokens) — [PR #62](https://github.com/CThawngs/Router-Sync/pull/62) → [`7abfd74`](https://github.com/CThawngs/Router-Sync/commit/7abfd7402edb5c5a5cf6ea0dfe264415534a1b02) (`8` tệp)
- **Phạm vi hoàn thành (`M2-01-G1..G6`):**
  - `packages/cli/src/commands/maintain.ts`: Siết chặt phân tích `--only` (`/^test-\d+(,test-\d+)*$/` → `only-pattern`, loại bỏ `.filter(Boolean)` dễ dãi), siết `--agents` (`/^(hermes|dsh)$/` → `agents-invalid` kể cả khi rỗng `""` hoặc dư dấu phẩy), thêm các seam nội bộ `isTTY`/`promptFn`/`secretResolver` cho kiểm thử không cần PTY (giữ nguyên hành vi `reason=no-tty`), và triển khai `maintain grant-status --json` trả `{ active: true, id, combos, agents, createdAt, expiresAt, remainingMin }` hoặc `{ active: false }` với **`0` rò rỉ** `secret`/`secretHash`/`salt`/`mac`.
  - `packages/cli/src/maintain/grant.ts`: Chặn JSON array `[]` (`!Array.isArray(raw)`) và kiểm tra định dạng hex nghiêm ngặt (`salt`: `32` hex, `secretHash`: `128` hex, `mac`: `64` hex) trước `Buffer.from(..., 'hex')`, `scryptSync` và `timingSafeEqual`, phân tách rõ `grant-secret-missing`, `grant-invalid`, `grant-secret-wrong`, `grant-mac-invalid`.
  - `packages/daemon/src/security/approval-token.ts` & `packages/daemon/src/handlers/approval.ts`: `ApprovalTokenManager` sử dụng `#signingKey` riêng tư (`crypto.randomBytes(32)`), phát hành token ký HMAC-SHA256 dạng `<nonceHex>.<sigHex>` gắn chặt `${nonceHex}:${planHash}:${createdAt}:${expiresAt}`, giữ nguyên chuẩn `AT-165` (`401 token_not_found` cho token không có dấu chấm), cân bằng thời gian kiểm thử nonce lạ qua dummy HMAC + `timingSafeEqual`, xác minh chữ ký **trước** khi đánh dấu `record.consumed` (`403 invalid_signature`), và cưỡng chế single-use replay (`403`), expiry (`401`), `planHash` binding (`403`).
  - `docs/adr/ADR-MAINTAIN-02-apply-grant-lifecycle.md` & `test/docs/agent-docs.test.ts`: Cập nhật tham chiếu test thực tế, giữ nguyên văn mô tả giới hạn PTY ở §4 (`L90`), cập nhật đúng `7` neo dòng hàm §4 và đưa `ADR-MAINTAIN-02` vào diện kiểm tra `K8.6`.
- **Red-First → Green-After (PR #62):** Trên `main` @ `f0e8534` + test mới: `3/3` tệp lỗi (`25 failed | 26 passed (51)` ở `maintain-grant-lifecycle.test.ts`, `at-165-daemon-threat-model-approval.test.ts`, `agent-docs.test.ts`) → sau triển khai: `3/3` tệp (`51/51` test) xanh.
- **Đột biến Engineer (`M1..M4`, `4/4` RED → khôi phục SHA256):** `M1` (bỏ `STRICT_ONLY_LIST_RE` trong `maintain.ts`: `8` fail), `M2` (bỏ `timingSafeEqual` trong `approval-token.ts`: `200` thay vì `403`), `M3` (khôi phục đường dẫn cũ `tools/maintain/test-apply-grant.mjs` trong `ADR-MAINTAIN-02`), `M4` (rò `mac` trong `grant-status --json`).
- **Đột biến độc lập QA (`QA-M1..QA-M4`, `4/4` RED → khôi phục SHA256 — [Comment 7102377750](https://github.com/CThawngs/Router-Sync/pull/62#issuecomment-7102377750)):**
  - `QA-M1`: Bỏ `combos` khỏi `grantCanonical()` trong `packages/cli/src/maintain/grant.ts` → `exit=1` (`maintain-grant-lifecycle.test.ts:464`) → khôi phục `sha256` `5f0fdd22...57b31f7`.
  - `QA-M2`: Nới lỏng `SALT_HEX_RE` thành `raw.salt.length > 0` trong `grant.ts` → `exit=1` (`maintain-grant-lifecycle.test.ts:565`) → khôi phục `sha256` khớp.
  - `QA-M3`: Đánh dấu `record.consumed = true` ngay trong nhánh sai chữ ký của `verifyAndConsume()` (`approval-token.ts`) → `exit=1` (`at-165:233`, DoS probe làm hỏng token thật) → khôi phục `sha256` `a82925f9...4f84897`.
  - `QA-M4`: Bỏ kiểm tra `record.planHash !== planHash` trong `verifyAndConsume()` (`approval-token.ts`) → `exit=1` (`at-165:98`) → khôi phục `sha256` khớp; re-verify `4/4` tệp (`59/59` test) GREEN.

#### 2.2 `M2-02` (Slice `P3.2` — Validated Redacted Outbound Webhook Alerts) — [PR #64](https://github.com/CThawngs/Router-Sync/pull/64) → [`8ca92f8`](https://github.com/CThawngs/Router-Sync/commit/8ca92f8110585d251618b5ff33b4e5cd951bcec0) (`9` tệp)
- **Phạm vi hoàn thành:**
  - `packages/core/src/notify/webhook.ts`, `index.ts`, `readonly.ts`: Xây dựng `validateWebhookUrl`, `redactWebhookPayload`, `sendActionableWebhook` dùng chung với envelope phiên bản `'1.0'`, cổng zero-noise (không gửi khi `alerts.length === 0`), allowlist giao thức `'http:' | 'https:'` (chặn `file:`, `javascript:`, `ftp:`, `data:`, `ws:`, `wss:`, thông tin `user:pass@`, và cổng loopback router `20128`/`30128`/`3128` trước khi mở socket), timeout giới hạn `[50, 15_000]` ms (mặc định `5_000` ms) qua `AbortSignal.timeout`, `redirect: 'error'`, hủy stream an toàn và ẩn danh đệ quy mọi khóa nhạy cảm/PII (`sk-...`, `Bearer ...`, JWT, `ghp_...`, `AIza...`, PEM, đường dẫn `<USER_DIR>`/`<APPDATA>`, email, username/hostname).
  - `packages/cli/src/config/schema.ts` & `packages/cli/src/commands/tick.ts`: Thêm `webhook?: { enabled?: boolean; url?: string; timeoutMs?: number }`; phân giải URL theo thứ tự `options.webhookUrl` → `ROUTERSYNC_WEBHOOK_URL` → `config.webhook.url`; ghi metadata `webhookDelivery` sạch (không chứa URL/query token) vào `TickRunSummary` / `status.json`.
  - `packages/daemon/src/loop/fast-loop.ts` & `test/harness/daemon-fixture.ts`: Import thuần từ `'@routersync/core/readonly'` (`AT-118`), chống spam qua fingerprint drift đã sắp xếp (`duplicate_drift_suppressed`, reset về `null` khi `driftCount === 0`); cách ly/khôi phục `ROUTERSYNC_WEBHOOK_URL` trong fixture (`AT-127`).
- **Red-First → Green-After (PR #64):** Trên `main` @ `5b39320` + test mới: `2/2` tệp lỗi (`7 failed | 9 passed (16)` tại `webhook-notify.test.ts` & `daemon.test.ts`) → sau triển khai: `6/6` tệp (`36/36` test) và regression sweep `13/13` tệp (`124/124` test) GREEN (`100%` đích giả `127.0.0.1:0`, `paidRequests=0`, `tokens=0`, `llmCalls=0`).
- **Đột biến Engineer (`M1..M4`, `4/4` RED → khôi phục):** `M1` (bỏ cổng `alerts.length === 0` trong `webhook.ts`), `M2` (trả payload chưa redact trong `redactWebhookPayload`), `M3` (bỏ chặn protocol/port `20128`/`30128`/`3128` trong `validateWebhookUrl`), `M4` (đổi import sang root `'@routersync/core'` trong `fast-loop.ts` → `AT-118` bắt lỗi).
- **Đột biến độc lập QA (`QA-M1..QA-M4`, `4/4` RED → khôi phục SHA256 — [Comment 7105458584](https://github.com/CThawngs/Router-Sync/pull/64#issuecomment-7105458584)):**
  - `QA-M1`: Vô hiệu hóa kiểm tra trùng `lastDriftFingerprint` trong `fast-loop.ts` → `exit=1` (`daemon.test.ts` gửi trùng webhook ở Tick 3) → khôi phục `sha256` `237B2AAC...7049E511`.
  - `QA-M2`: Đổi `redirect: 'error'` → `'follow'` trong `webhook.ts` → `exit=1` (`M2-02-T3` HTTP `302` bị follow thay vì chặn) → khôi phục `sha256` `C9AF2623...866D86F3`.
  - `QA-M3`: Đảo thứ tự ưu tiên `configWebhookUrl ?? envWebhookUrl` trong `tick.ts` → `exit=1` (`M2-02-T1`) → khôi phục `sha256` `3EA54CF1...278B072`.
  - `QA-M4`: Tắt kiểm tra `username`/`password` nhúng trong URL ở `validateWebhookUrl` (`webhook.ts`) → `exit=1` (`M2-02-T4`) → khôi phục `sha256` khớp; re-verify `6/6` tệp (`36/36` test) GREEN.

#### 2.3 `M2-03` (Slice `P3.3` — Serving-Path HTTP Read-Back Across 9Router & OmniRoute) — [PR #65](https://github.com/CThawngs/Router-Sync/pull/65) → [`bc61436`](https://github.com/CThawngs/Router-Sync/commit/bc614368b2becbbb4309265d8822f8dee813003f) (`16` tệp)
- **Phạm vi hoàn thành (`M2-03-G1..G6`):**
  - `packages/cli/src/commands/maintain.ts`: Trung thực hóa thông điệp `READBACK`: chỉ in `READBACK ok=yes level=<canonical>` khi non-dry-run xác minh HTTP serving-path thành công (`api-verified` hoặc `existence-only` với `readBackVerified === true`); fallback DB-only in `READBACK db-only reason=<degradedReason>`; `--dry-run` in `READBACK dry-run`; timeout serving-path thoát mã `1` với `READBACK stale=yes rollback=<yes|no>`.
  - `packages/core/src/applier/index.ts`: Tự động gọi `await adapter.rollback(snapshot)` khi `adapter.applyPlan(plan)` trả `{ success: false, staleDetected: true }` và truyền trạng thái `rollbackExecuted`.
  - `packages/adapter-9router/src/index.ts`, `packages/adapter-omniroute/src/index.ts`, `packages/cli/src/adapters.ts`: Xác minh đầy đủ `plan.modifications` (ngoài `additions` và `deletions`) trên `/v1/models`, `/api/combos` (khớp đúng chuỗi `models`) và SQLite fallback; bổ sung `isolated`, `servingWaitMs` polling và nối `router.auth?.apiKeyEnv` cho OmniRoute; phân loại chính xác `degradedReason` (`serving-path-http-<status>` / `no-api-path` thay vì gán cứng `no-serving-path-credentials` khi gặp HTTP `503`).
  - `packages/adapter-sdk/src/types.ts`, `packages/core/src/{index,readonly}.ts`, `packages/cli/src/commands/status.ts`, `packages/daemon/src/{types.ts,handlers/targets.ts}`: Bổ sung `CanonicalReadBackLevel` (`'api-verified' | 'existence-only' | 'db-only'`) và `normalizeReadBackLevel()` (daemon import qua `@routersync/core/readonly` chuẩn `AT-118`), giữ tương thích ngược `AT-98`, `AT-101`, `AT-109`, `AT-113`, `AT-121`, `AT-125`, `AT-157`.
  - `test/harness/fake-router.ts` & `docs/ROADMAP.md`: Nâng cấp `FakeRouter` (`127.0.0.1:0`) mô phỏng `reflectAfterPolls`, `staleServingPath`, `servingStatusOverride`, `requireAuthForCombos`; đánh dấu `[x]` hoàn tất **S2 Slice** tại `docs/ROADMAP.md:46`.
- **Red-First → Green-After (PR #65):** Trên `main` @ `8ca92f8` + test `M2-03-T1..T5` mới: `3/3` tệp lỗi (`14 failed | 8 passed (22)` tại `ninerouter.test.ts`, `omniroute.test.ts`, `maintain-readback.test.ts`) → sau triển khai: `15/15` tệp (`119/119` test) GREEN.
- **Đột biến Engineer (`M1..M4`, `4/4` RED → khôi phục):** `M1` (đổi banner `READBACK db-only` thành `ok=yes` trong `maintain.ts`), `M2` (bỏ `adapter.rollback(snapshot)` trong `applier/index.ts`), `M3` (bỏ kiểm tra `plan.modifications` trong `adapter-omniroute/src/index.ts`), `M4` (gán cứng `'no-serving-path-credentials'` khi HTTP `503` trong `adapter-omniroute`).
- **Đột biến độc lập QA (`QA-M1` — [Comment 7112628198](https://github.com/CThawngs/Router-Sync/pull/65#issuecomment-7112628198)):** Đổi `staleDetected: true` → `false` khi timeout `/v1/models` trong `packages/adapter-9router/src/index.ts` → `exit=1` (`M2-03-T4` fail) → khôi phục khớp `sha256` `748C4370608AD99EC58F956FCF73CAF5B128DE4092709043782C623B498CC830` → `8/8` (`ninerouter.test.ts`) và `15/15` (`119/119` test) GREEN.

---

### 3. Bằng chứng đo thực tế tại `main` @ `bc61436` (`3` bản ghi trong `evidence/M2/records.jsonl`)

Toàn bộ `3` bản ghi được chụp trực tiếp trên nhánh `evidence/m2` tại `main` @ `bc614368b2becbbb4309265d8822f8dee813003f` trong clean clone riêng sau khi cài `pnpm install --frozen-lockfile` (`0` junction) và build sạch `8/8` gói TypeScript (`@routersync/adapter-sdk`, `core`, `adapter-9router`, `adapter-omniroute`, `daemon`, `sources`, `cli`, `mcp-server`, `exit=0`), qua `RS_EVIDENCE_DIR=evidence/M2 node tools/agent/capture-evidence.mjs` (không sửa tay `records.jsonl` hay `.out.txt`/`.err.txt`, không bật `RS_FORCE_HEAVY` hay `CI=true`).

| ID Bản ghi | Lệnh chạy thật | Exit / Thời lượng | `stdout` (`dòng` / `byte` / `sha256` đầu 12) | `stderr` (`dòng` / `byte`) | Tài nguyên `sys` & Ẩn danh `masked` | Kết quả chính (`đo được`) |
|---|---|---|---|---|---|---|
| `m2-ci-stats` | `node tools/agent/ci-stats.mjs` | `0` / `82 882 ms` | `17` dòng / `1 445` B / `87960af40f37` | `0` dòng / **`0` B** | `freeMemStart=1 474 MB`, `min=1 290 MB`, `privateNamesLoaded=12`, `masked.privateName=0` | `window since 2026-11-17: runs=100 uniqueSha=75`; `push on main: 29/33`; `push on main consecutive green first attempt: 1 (firstSha=bc61436 lastSha=bc61436)`; `our commits: 65/75 (87%)`; `pending=0`; `dependabot=13`; `red runs: code=5 infra=0 unknown=3`; `from C20: 65/75` — `đo được (evidence/m2:m2-ci-stats)` |
| `m2-01-02-suites` | `pnpm test:file packages/cli/test/maintain-grant-lifecycle.test.ts test/acceptance/at-165-daemon-threat-model-approval.test.ts test/docs/agent-docs.test.ts packages/cli/test/webhook-notify.test.ts packages/daemon/test/daemon.test.ts test/acceptance/at-118-daemon-isolation.test.ts test/acceptance/at-127-hermetic-guard.test.ts test/acceptance/at-164-sync-worker-fast-loop.test.ts test/acceptance/at-170-hermetic-daemon-network.test.ts` | `0` / `11 505 ms` | `63` dòng / `6 804` B / `8572014a0112` | `2` dòng / `67` B | `freeMemStart=1 419 MB`, `min=979 MB`, `privateNamesLoaded=12`, `masked.privateName=1`, `homePath=2` | `Test Files 9 passed (9)`, `Tests 87 passed (87)` (`maintain-grant-lifecycle`: `32`, `webhook-notify`: `5`, `daemon`: `11`, `at-165`: `7`, `agent-docs`: `12`, `at-127`: `6`, `at-118`: `8`, `at-164`: `5`, `at-170`: `1`; Vitest `8.93s`) — `đo được (evidence/m2:m2-01-02-suites)` |
| `m2-03-readback` | `pnpm test:file packages/adapter-9router/test/ninerouter.test.ts packages/adapter-omniroute/test/omniroute.test.ts packages/cli/test/maintain-readback.test.ts packages/cli/test/status-down.test.ts test/acceptance/at-98.test.ts test/acceptance/at-101.test.ts test/acceptance/at-109.test.ts test/acceptance/at-113.test.ts test/acceptance/at-121-daemon-honesty.test.ts test/acceptance/at-125-daemon-probe-up.test.ts test/acceptance/at-157-status-unwritten.test.ts` | `0` / `12 352 ms` | `39` dòng / `4 397` B / `680309470aed` | `22` dòng / `4 902` B | `freeMemStart=1 424 MB`, `min=995 MB`, `privateNamesLoaded=12`, `masked.privateName=1`, `homePath=3` | `Test Files 11 passed (11)`, `Tests 62 passed (62)` (`ninerouter`: `8`, `omniroute`: `7`, `maintain-readback`: `8`, `status-down`: `4`, `at-98`: `8`, `at-157`: `6`, `at-101`: `6`, `at-109`: `4`, `at-113`: `3`, `at-125`: `6`, `at-121`: `2`; Vitest `10.76s`) — `đo được (evidence/m2:m2-03-readback)` |

- **Tổng hợp kiểm thử M2 trên `main` @ `bc61436`:** `20/20` tệp test, **`149/149` test xanh** (`87 + 62`), `exitCode=0` trên cả `3/3` bản ghi (`đo được (evidence/m2:m2-01-02-suites)`, `đo được (evidence/m2:m2-03-readback)`).
- **Diễn biến chỉ số CI so với mốc M1 (`evidence/m1:m1-01-ci-stats` → `evidence/m2:m2-ci-stats`):**
  - `push on main (CI workflow) green first attempt`: `25/28` → **`29/33`** (`đo được (evidence/m2:m2-ci-stats)`)
  - `push on main consecutive green first attempt`: `20` (`618c233`) → tăng lên `24` tại `5b39320` → reset về `0` tại `8ca92f8` (lỗi hạ tầng runner `macos-latest` ở `Attempt #1`, `Attempt #2` xanh `18/18`) → khôi phục **`1`** tại `bc61436` (`đo được (evidence/m2:m2-ci-stats)`)
  - `our commits green first attempt`: `56/65 (86%)` → **`65/75 (87%)`** (`đo được (evidence/m2:m2-ci-stats)`)

---

### 4. Danh sách đầy đủ `9` tệp trong `evidence/M2/` (`9 <= 10` tệp — đạt trần gói)

| STT | Tệp trong `evidence/M2/` | Vai trò |
|---:|---|---|
| `1` | `REPORT.md` | Báo cáo đóng mốc M2 tự đủ cho Planner đọc từ xa trên GitHub |
| `2` | `NOTE.md` | Bản tóm tắt điều hành ngắn gọn cho mốc M2 & trạng thái cổng dừng trước M3 |
| `3` | `records.jsonl` | `3` dòng bản ghi kiểm chứng chuẩn `capture.mjs` v3 kèm `sha256`, `sys`, `masked` |
| `4` | `m2-ci-stats.out.txt` | Đầu ra chuẩn `node tools/agent/ci-stats.mjs` (`17` dòng, `1 445` byte — `đo được (evidence/m2:m2-ci-stats)`) |
| `5` | `m2-ci-stats.err.txt` | `stderr` rỗng `0` byte (`đo được (evidence/m2:m2-ci-stats)`) |
| `6` | `m2-01-02-suites.out.txt` | Đầu ra chuẩn Vitest `M2-01` & `M2-02` (`9/9` tệp, `87/87` test — `đo được (evidence/m2:m2-01-02-suites)`) |
| `7` | `m2-01-02-suites.err.txt` | `stderr` `2` dòng / `67` byte (`low-resource mode` < 2 GiB — `đo được (evidence/m2:m2-01-02-suites)`) |
| `8` | `m2-03-readback.out.txt` | Đầu ra chuẩn Vitest `M2-03` & read-back (`11/11` tệp, `62/62` test — `đo được (evidence/m2:m2-03-readback)`) |
| `9` | `m2-03-readback.err.txt` | `stderr` `22` dòng / `4 902` byte (cảnh báo `db-only` hợp lệ trong các ca kiểm thử offline — `đo được (evidence/m2:m2-03-readback)`) |

---

## (b) Ghi chú minh bạch, môi trường đo & điều chưa kiểm

1. **Sự cố hạ tầng CI ở `M2-02` ([Run 45205533592](https://github.com/CThawngs/Router-Sync/actions/runs/45205533592)):** `Attempt #1` bị hủy duy nhất job `verify (macos-latest, node 22)` do GitHub Actions không cấp phát được hosted runner sau nhiều lần thử (`0` step chạy, `runner_id=0`); `Attempt #2` đạt `18/18` GREEN. Toàn bộ `5` lượt CI còn lại của M2 (`M2-01` PR/main, `M2-02` PR, `M2-03` PR/main) đều đạt `18/18` GREEN ngay ở `attempt=1`.
2. **Môi trường máy chạy local (Windows 11):** RAM trống khi preflight dưới ngưỡng `1.5 GiB` nên `pnpm build` gốc bị `heavy.mjs` chặn; gói TypeScript đã được build sạch từng gói theo thứ tự phụ thuộc (`8/8` gói không gồm `@routersync/ui` `vite build`, `exit=0`), trong khi kiểm thử full suite + `ui` + `e2e` trên đủ `5` OS đã được kiểm chứng trên GitHub Actions CI (`18/18` GREEN trên `main` @ `bc61436`, [Run 45257738274](https://github.com/CThawngs/Router-Sync/actions/runs/45257738274)). Kiểm thử máy vật lý macOS/Linux tiếp tục giữ ngoài phạm vi đến M3+ theo `evidence/C43/PLAN.md`.
3. **Nội dung `stderr` ở 2 suite test:** `m2-01-02-suites.err.txt` (`67` B) ghi nhận thông báo tự động `low-resource mode: auto: availableMem 1.0 GiB < 2 GiB`; `m2-03-readback.err.txt` (`4 902` B) ghi nhận các cảnh báo `db-only (degraded)` phát ra có chủ đích khi các test offline/degraded (`AT-98`, `AT-101`, `AT-109`, `AT-113`, `status-down`) chạy không có router live.

---

## (c) Xác nhận Trạng thái Cổng C43 §4.2 — DỪNG TẠM THỜI TRƯỚC `M3`

Đối chiếu toàn bộ tiêu chí đóng mốc M2 và quy tắc cổng tại `evidence/C43/PLAN.md` mục `3` & `4` (C43 §2, §3.4, §3.5, §4.2):

- [x] Hoàn tất tuần tự `3/3` vé `M2-01` (#62), `M2-02` (#64), `M2-03` (#65) vào `main` (`bc61436`), mỗi lúc chỉ `1` PR mở; `docs/ROADMAP.md:46` đã đánh dấu `[x]` hoàn tất **S2 Slice**.
- [x] Mọi PR đều có biên bản **QA độc lập** trên checkout sạch kèm đột biến riêng (`QA-M1..M4` cho `M2-01` & `M2-02`, `QA-M1` cho `M2-03`) và xác minh `sha256` khôi phục trùng khớp.
- [x] Đã khóa đủ `3` gói bằng chứng GitHub-First: `origin/evidence/m1` + `origin/evidence/c43` + `origin/evidence/m2` (`9` tệp `<= 10`, `verify-records.mjs` = `SẠCH: 3 dòng`, `verify-package.mjs` = `OK`, `scan-private-names.mjs` = `0` khớp trên `9/9` tệp, commit `[skip ci]`, `0` CI run trên nhánh `evidence/m2`).
- [ ] **Cổng chuyển tiếp sang Milestone M3 (`P4` + `P5`):** **DỪNG TẠM THỜI TRƯỚC `M3`** theo đúng C43 §4.2 — chờ người duyệt độc lập xem xét 3 gói `evidence/m1`, `evidence/m2`, `evidence/c43` trên GitHub trước khi mở khóa `M3`.
