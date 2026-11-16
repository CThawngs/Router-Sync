# 9Router Adapter Investigation (Phase 0 Discovery)

This document contains empirical discovery findings for 9Router (v0.5.99) executed under Governance v7.4. All observations adhere to R1–R12 (0 inference tokens, read-only inspection, secrets redacted).

---

## 1. Runtime, Stack & License (V-05, spec §5.1, §14)
- **Status:** `VERIFIED`
- **Evidence level:** `L2` (runtime inspection of local install)
- **Requirement:** `ASSUMPTION` -> `OBSERVED`
- **Command / action:** `node tools/phase0/doctor.mjs` and inspection of `%APPDATA%\npm\node_modules\9router\package.json`
- **Observed output:**
  - Version: `0.5.99`
  - License: `MIT`
  - Tech Stack: Node.js, Next.js (`.next-cli-build`), `custom-server.js`, SQLite (`better-sqlite3` / `sql.js`), Enquirer CLI.
  - Install Location: `%APPDATA%\npm\node_modules\9router\`
  - Running Process: Port 20128 (PID 17844 / 8512).
- **Conclusion:** 9Router v0.5.99 is an active, open-source MIT Node.js application running locally on port 20128.
- **Confidence:** `high`
- **Date, version, OS:** 2026-10-13, 9Router v0.5.99, Windows 11 (10.0.26300)
- **Spec delta:** none

---

## 2. Configuration & Database Storage (V-05, spec §4, §8.1)
- **Status:** `VERIFIED`
- **Evidence level:** `L2` (read-only SQLite schema inspection via Node `node:sqlite`)
- **Requirement:** `ASSUMPTION` -> `OBSERVED`
- **Command / action:** `node .phase0-scratch/inspect-sqlite-schema.mjs`
- **Observed output:**
  - Active DB File: `%APPDATA%\9router\db\data.sqlite` on Windows (~32.9 MB); `~/.9router/db/data.sqlite` on macOS/Linux (verified via 9Router `cli/hooks/sqliteRuntime.js` and `deepwiki.com/decolua/9router/2.1-installation`). Can be overridden with `ROUTERSYNC_9ROUTER_DB` or `DATA_DIR`.
  - Total tables: Exactly 12 tables (`_meta`, `apiKeys`, `combos`, `kv`, `providerConnections`, `providerNodes`, `proxyPools`, `requestDetails`, `settings`, `sqlite_sequence`, `usageDaily`, `usageHistory`).
  - Combos Table Schema:
    ```sql
    CREATE TABLE combos (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      kind TEXT,
      models TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    ```
  - Settings Table Schema:
    ```sql
    CREATE TABLE settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data TEXT NOT NULL
    );
    ```
  - Schema Characteristics: `combos.models` stores a JSON array of model identifier strings (e.g. `["oc/space-bunny-free", "gemini/gemini-flash-latest"]`). Strategies are stored separately in `settings.data` under property `comboStrategies`.
- **Conclusion:** 9Router uses a clean 12-table SQLite architecture where combos are split between `combos` and `settings`.
- **Confidence:** `high`
- **Date, version, OS:** 2026-10-13, 9Router v0.5.99, Windows 11
- **Spec delta:** none

---

## 3. API Authentication & Security Model (V-05, spec §8.1)
- **Status:** `VERIFIED`
- **Evidence level:** `L2` (HTTP probe via `safe-http.mjs`)
- **Requirement:** `ASSUMPTION` -> `OBSERVED`
- **Command / action:** `node .phase0-scratch/probe-9router.mjs`
- **Observed output:**
  - GET `/api/health` -> HTTP 200 (4ms): `{"ok":true}`.
  - GET `/api/models` -> HTTP 401.
  - GET `/api/combos` -> HTTP 401.
  - GET `/` -> HTTP 307 (redirect to login/dashboard).
  - GET `/v1/models` -> Timed out unauthenticated.
  - Settings attribute: `requireApiKey: false` exists in settings, but dashboard API routes enforce session cookies.
- **Conclusion:** `/api/health` provides zero-token liveness checking; administrative routes require authentication.
- **Confidence:** `high`
- **Date, version, OS:** 2026-10-13, 9Router v0.5.99, Windows 11
- **Spec delta:** none

---

## 4. Model Catalog Endpoint (V-05, spec §4, §8.1)
- **Status:** `VERIFIED`
- **Evidence level:** `L2` (read-only inspection of SQLite `kv` table)
- **Requirement:** `ASSUMPTION` -> `OBSERVED`
- **Command / action:** Inspected keys of `kv` table in `data.sqlite`
- **Observed output:**
  - Model catalog is locally cached in the `kv` table, with over 1,600 model keys stored in format `<provider>|<model_id>|llm`.
- **Conclusion:** 9Router maintains a massive local catalog of models in SQLite without requiring external network requests.
- **Confidence:** `high`
- **Date, version, OS:** 2026-10-13, 9Router v0.5.99, Windows 11
- **Spec delta:** none

---

## 5. Combo Representation & Routing Strategies (V-10, spec §9, §17)
- **Status:** `VERIFIED`
- **Evidence level:** `L2` (read-only query on active `data.sqlite`)
- **Requirement:** `ASSUMPTION` -> `OBSERVED`
- **Command / action:** `node .phase0-scratch/inspect-9router-db.mjs`
- **Observed output:**
  - 9 active combos discovered (`9Router-Agent`, `9Router-Dev`, `9Router-Coder-1..5`, `9Router-Agent-1..2`).
  - Model representation: `combos.models` contains JSON array of strings (e.g. `["oc/space-bunny-free", ...]`).
  - Strategy representation: `settings.data` -> `comboStrategies`:
    ```json
    {
      "9Router-Agent": { "fallbackStrategy": "round-robin" },
      "9Router-Coder-1": { "fallbackStrategy": "fallback" }
    }
    ```
  - Supported Strategies: `round-robin`, `fallback`.
- **Conclusion:** 9Router combos use a string-list model schema with strategies defined in global settings (`fallback` or `round-robin`).
- **Confidence:** `high`
- **Date, version, OS:** 2026-10-13, 9Router v0.5.99, Windows 11
- **Spec delta:** none

---

## 6. Write Path Options (V-06, spec §8.1, §14)
- **Status:** `VERIFIED`
- **Evidence level:** `L2` (CLI inspection + SQLite schema inspection)
- **Requirement:** `ASSUMPTION` -> `OBSERVED`
- **Command / action:** Inspected `src/cli/commands/` and `data.sqlite`
- **Observed output:**
  - CLI: 9Router CLI (`src/cli/commands/`) only supports connection and diagnostic commands (`connect`, `show`, `xaiVideo`). It has NO command to create or update combos.
  - REST API: Endpoints `/api/combos` exist but require active browser session authentication.
  - Direct SQLite: Table `combos` and `settings` can be updated directly via standard atomic transactions in `data.sqlite`.
- **Conclusion:** Direct SQLite Write (T3) is the primary, robust write path for 9Router.
- **Confidence:** `high`
- **Date, version, OS:** 2026-10-13, 9Router v0.5.99, Windows 11
- **Spec delta:** none

---

## 7. In-Memory Cache & Reload Mechanism (V-05, spec §8.1)
- **Status:** `PARTIAL-LIVE` (empirically observed during CHECKPOINT-LIVE CL-NINE)
- **Evidence level:** `L4` (live empirical measurement on running 9Router 0.5.99)
- **Requirement:** `ASSUMPTION` -> `OBSERVED`
- **Command / action:** Executed `node tools/phase2/checkpoint-live.mjs 9router` against live running instance on port 20128.
- **Observed output:**
  - Existing DB combos (all 9 rows) are visible in `GET /v1/models` under `owned_by: "combo"` with `id: <combo.name>`.
  - When a new combo was inserted directly into SQLite `combos` table, `GET /v1/models` did **not** reflect the new combo within 60,000ms (timed out).
  - **Empirical Observation (n=1):** không hiện sau 60 s; nguyên nhân chưa xác định (chưa loại trừ các khả năng: TTL thực tế dài hơn 60 s, hoặc hình dạng hàng ghi có `kind = 'custom'` khác với `kind = null` của toàn bộ 9 hàng sẵn có).
  - `readBackMode`: `db-only (degraded)` — degraded reason: `serving-reflection-timeout` (SQLite write succeeds and passes schema check, but serving-path reflection did not appear within 60s).
  - Post-test logical rollback achieved 100% hash fidelity (`bc838d87dd6c7df384fae72a8342458e6510db3d047b171e34aacfeca5b406a8`) with `PRAGMA quick_check; -> ok`.
- **Conclusion:** Direct SQLite writes are durable and structurally verified, but currently operate in `db-only (degraded)` mode because serving-path reflection was not observed within 60s.
- **Confidence:** `medium` (serving reflection cause unconfirmed)
- **Date, version, OS:** 2026-10-15, 9Router v0.5.99, Windows 11
- **Spec delta:** none

---

## 8. Cloud Sync Detection & Risk (V-03, spec §4.3)
- **Status:** `VERIFIED`
- **Evidence level:** `L2` (inspection of SQLite tables and settings keys)
- **Requirement:** `ASSUMPTION` -> `OBSERVED`
- **Command / action:** Checked table list and settings JSON keys in `data.sqlite`
- **Observed output:**
  - No cloud sync tables or sync settings exist in 9Router v0.5.99.
  - Settings keys: `password`, `requireApiKey`, `comboStrategies`, `capacityAdapter`, `providerStrategies`, `outboundProxyEnabled`, `ponytailEnabled`, `cavemanEnabled`, `providerOverrides`.
- **Conclusion:** 9Router does not have an active Cloud Sync mechanism; external overwrite risk from cloud sync is absent.
- **Confidence:** `high`
- **Date, version, OS:** 2026-10-13, 9Router v0.5.99, Windows 11
- **Spec delta:** none

---

## 9. Passive Health & Usage Telemetry (V-01, spec §2.2)
- **Status:** `VERIFIED`
- **Evidence level:** `L2` (read-only SQLite query on `sqlite_master` and `_meta`)
- **Requirement:** `ASSUMPTION` -> `OBSERVED`
- **Command / action:** Examined `usageHistory`, `usageDaily`, and `_meta`
- **Observed output:**
  - Table `usageHistory`: `(id, timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens, meta)`.
  - Table `usageDaily`: daily usage aggregates.
  - Table `_meta`: `totalRequestsLifetime` contains `61346` requests.
  - Zero Token Cost: Full usage and error history can be read passively from SQLite.
- **Conclusion:** 9Router records rich passive telemetry in SQLite, enabling 0-token health and reliability tracking.
- **Confidence:** `high`
- **Date, version, OS:** 2026-10-13, 9Router v0.5.99, Windows 11
- **Spec delta:** none

---

## 10. Read-Back Verification Path (V-05, spec §8.1)
- **Status:** `VERIFIED`
- **Evidence level:** `L2` (HTTP probe, `/v1/models` serving-path probe, and SQLite read-back)
- **Requirement:** `ASSUMPTION` -> `OBSERVED`
- **Command / action:** Probed `/api/health`, `/v1/models`, and verified SQLite read-back
- **Observed output:**
  - Liveness verification: GET `/api/health` returns HTTP 200 `{"ok":true}` in ~4ms.
  - Serving-path verification: GET `/v1/models` succeeds (either unauthenticated on loopback or with `NINEROUTER_CLIENT_KEY`) and exposes active combo names (readBackLevel: `existence-only`).
  - Fallback: If `/v1/models` requires credentials and no client key is supplied, adapter falls back to `db-only (degraded)` with explicit warning.
  - **Important Observation (Spec §31.9):** On this specific Windows host, `GET /v1/models` on loopback returned HTTP 200 without authentication. This is recorded as a **user-configuration-dependent or version-dependent observation (`REAL` on this machine only)** and NOT an immutable invariant of 9Router. When `/v1/models` enforces authentication (HTTP 401), clients must configure `NINEROUTER_CLIENT_KEY`.
- **Conclusion:** Dual verification: serving-path check via `/v1/models` (`existence-only`) + SQLite persistence check; `/api/health` verifies process health.
- **Confidence:** `high`
- **Date, version, OS:** 2026-10-14, 9Router v0.5.99, Windows 11
- **Spec delta:** none

---

## 11. External Overwrite & Concurrency Risk (V-05, spec §8.1)
- **Status:** `VERIFIED`
- **Evidence level:** `L2` (SQLite transaction inspection)
- **Requirement:** `ASSUMPTION` -> `OBSERVED`
- **Command / action:** Inspected `combos` table schema
- **Observed output:**
  - `combos` table includes `updatedAt TEXT NOT NULL`.
  - Concurrency control: Snapshot `updatedAt` before write; verify unchanged before transaction commit.
- **Conclusion:** Standard timestamp-based optimistic locking protects against external dashboard overwrites.
- **Confidence:** `high`
- **Date, version, OS:** 2026-10-13, 9Router v0.5.99, Windows 11
- **Spec delta:** none

---

## 12. Recommended Integration Tier (V-05, spec §8.1)
- **Status:** `VERIFIED`
- **Evidence level:** `L2` (empirical synthesis)
- **Requirement:** `ASSUMPTION` -> `OBSERVED`
- **Recommendation:**
  - **Tier 3 (Direct SQLite Write)**
    - Rationale: 9Router has no dedicated CLI for combo manipulation, and REST API requires browser session cookies. Direct SQLite write to `%APPDATA%\9router\db\data.sqlite` is atomic, local, robust, and requires zero credentials.
    - Safety protocol: Pre-write snapshot -> Atomic transaction updating `combos` and `settings` -> Read-back verification -> Rollback on error.
- **Confidence:** `high`
- **Date, version, OS:** 2026-10-13, 9Router v0.5.99, Windows 11
- **Spec delta:** none

---

## 13. Gate L — 9Router Lab on a DB Copy (Spec §33.3, 2026-10-15)

**Method (no writes to the live router):** The live DB was copied via the SQLite backup API into a temp directory; a second 9Router ran with `DATA_DIR` = that temp directory, `--port 20129 --host 127.0.0.1`, started by running `app/custom-server.js` directly (bypassing the wrapper's single-instance `killAllAppProcesses`, which kills any process whose command line matches `9router` + `cli.js`). After the experiment the lab copy (which contained real provider API keys) was securely deleted. **Source label: COPY; OS: Windows 11; 9Router v0.5.99.**

**Gate L status: PARTIAL** (2026-10-15). Q1–Q4 addressed; **Q1 resolved with n=3 by AT-111** (periodic ~30 s serving-path refresh, not per-request); Q5 UNVERIFIED (no dashboard login in the lab). Every timing below is a single-sample upper bound with noise — see §14 for the n=3 AT-111 re-measurement.

**Answers to the five questions (spec §33.3):**

1. **RAM cache TTL or refresh-on-restart?** There is a fast refresh mechanism: a combo written directly to the DB with `kind = null` appeared on `GET /v1/models` within ~20 s **without a restart** (n=1, COPY — noisy upper bound; exact TTL not isolated).
2. **After a restart, does the written combo appear?** Yes — the `kind = null` combo was still listed after restarting the lab server (n=1, COPY).
3. **Which column differs from existing rows?** Exactly the `kind` column: all 9 existing rows have `kind = null`; the test combo written with `kind = 'custom'` (the shape the RouterSync adapter wrote during CL-NINE) **never appeared**. `models` (JSON array), `createdAt` (ISO), `updatedAt` (`YYYY-MM-DD HH:MM:SS`) and `comboStrategies` matched the existing rows. Code confirmation (compiled chunk 4199.js): a combo is served only if `kind || "llm"` is in the allowed-kind list — `null` defaults to `"llm"` (served), `"custom"` is filtered out.
4. **Does the router write RAM back over the DB (clobbering direct DB updates)?** Not observed: direct DB writes survived both runtime and restart. Code-level (L2): all dashboard operations are row-level (`INSERT INTO combos`, `UPDATE combos ... WHERE id = ?`, `DELETE FROM combos WHERE id = ?` in compiled chunk 9100.js) and settings are merged per key (`hasOwnProperty` checks) — no whole-table rewrite from RAM. Label: COPY + code-level (L2), Windows.
5. **Reload endpoint or admin session login?** No reload/refresh route exists in the compiled build. Recovery options: restart (verified effective) or wait for the refresh observed in §14 (19.7–31.2 s, n=3) with `kind = null` rows. Dashboard config changes require a browser session cookie — **UNVERIFIED** (no dashboard login was performed in the lab). Whether the dashboard can open and edit combos whose id is not a UUID (e.g. `routersync-…` managed ids) is also **UNVERIFIED** — no dashboard login was performed.

**Applied result (spec §33.3):** the 9Router adapter (and every db-only router whose serving path is unconfirmed) returns `applyState = written-pending-reload`; `status`, CLI, MCP and `inbox` surface the state; the daemon must not count these applies as success; RouterSync never restarts the router itself; `policy.mode` for configs containing 9Router is capped at `manual`/`shadow` (D26) until the project owner confirms otherwise (AT-109).

**Decision & Implementation Status (2026-10-17 post-consolidation):** the adapter writes `kind = null` with the `routersync-` id prefix as the managed marker (the `rs-` prefix was dropped — user-name collisions; legacy `kind='custom'` rows are recognized only for cleanup/rollback at `packages/adapter-9router/src/index.ts`). Sổ id bền lưu trong thư mục trạng thái (`managed-ids.json`). Toàn bộ mã nguồn này đã được khôi phục, kiểm thử (AT-111, AT-112, AT-113) và gộp vào nhánh tích hợp `integrate/p3-ui` trong thư mục gốc duy nhất `Router-Sync`. Live writes vẫn cần lệnh "chạy" riêng biệt từ chủ dự án (D26).

### Lab hygiene rules (2026-10-15, after the live-kill incident)
- The lab copy contains REAL provider API keys. Before booting a lab from a copy, blur the key columns (`apiKeys`, `providerConnections`) if the router still boots; delete the copy immediately after use and verify no live process was affected.
- **NEVER start a 9Router lab via `cli.js` while the live router is running.** The wrapper's `killAllAppProcesses()` kills every process whose command line matches `9router` + `cli.js`/`next-server` (single-instance by design) — it already killed the live instance once (2026-10-15, no data loss, DB integrity verified). Always start `app/custom-server.js` directly with `DATA_DIR`/`PORT`/`HOSTNAME` env overrides.

---

## 14. AT-111 — Tách TTL khỏi per-request bằng adapter THẬT (2026-10-15)

**Method (no writes to the live router):** live DB copied via SQLite backup API into a temp lab dir; credential columns blurred BEFORE boot (`apiKeys.key`, `apiKeys.machineId` → `REDACTED_LAB_*`; `providerConnections.data` → `{}`, `email` → `lab@invalid`; `settings.password` → empty; verified 0 secret-pattern leaks in the copy); lab 9Router started via `app/custom-server.js` with `DATA_DIR`/`PORT=20129`/`HOSTNAME=127.0.0.1`. The REAL RouterSync adapter (`NineRouterAdapter`, `apiBaseUrl=http://127.0.0.1:20129`, no hand SQL) wrote the NULL-branch combos. Polling was by combo NAME (the serving path exposes the combo name as the model id). **Label: COPY, Windows 11; n=3 per branch.**

**Results:**
- **NULL branch (adapter writes `kind=NULL`, n=3):** combos appeared on `GET /v1/models` at **31,229 ms / 30,745 ms / 19,653 ms** (median ~30.7 s). Reflection is periodic (~30 s refresh cycle), never immediate — this separates Q1: it is NOT a per-request DB read; the router refreshes its in-memory combo list on a timer.
- **CUSTOM branch (control rows `kind='custom'`, n=3):** **0 of 3 appeared within 90 s.** Confirms the Gate L finding: `kind='custom'` rows are filtered by shape, not delayed.
- **Rollback:** `adapter.rollback(snapshot)` succeeded — combos back to the exact 9 baseline rows; **raw strings of all surviving rows (`id|name|kind|models|createdAt|updatedAt`) identical pre/post**; zero leftovers.

**Conclusion for Q1 (spec §33.3):** the serving path reflects `kind=NULL` writes on a ~30 s periodic refresh (observed 19.7–31.2 s, n=3). `written-pending-reload` remains the honest apply state; the exact refresh interval is an implementation detail of 9Router, not something RouterSync controls.

**Status on `integrate/p3-ui`:** Mã nguồn `kind=NULL` + marker `routersync-` (prefix id + sổ id `managed-ids.json`, bỏ `rs-`) đã được commit trên nhánh `integrate/p3-ui` (chủ dự án đã duyệt hình dạng commit ngày 2026-10-15); chưa merge vào `master`, chưa ghi lên router thật (ghi thật chờ lệnh chạy AT-114).
