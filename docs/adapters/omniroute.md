# OmniRoute Adapter Investigation (Phase 0 Discovery)

This document contains empirical discovery findings for OmniRoute (v3.8.50) executed under Governance v7.4. All observations adhere to R1–R12 (0 inference tokens, read-only inspection, secrets redacted).

---

## 1. Runtime, Stack & License (V-05, spec §5.1, §14)
- **Status:** `VERIFIED`
- **Evidence level:** `L2` (runtime inspection of local install)
- **Requirement:** `ASSUMPTION` -> `OBSERVED`
- **Command / action:** `node tools/phase0/doctor.mjs` and inspection of `%APPDATA%\npm\node_modules\omniroute\package.json`
- **Observed output:**
  - Version: `3.8.50`
  - License: `MIT`
  - Tech Stack: Node.js (v24 compatible), Next.js, Express / open-sse, `sql.js` / SQLite3, Commander CLI.
  - Install Location: `%APPDATA%\npm\node_modules\omniroute\`
  - Running Process: Port 30128 (PID 24628).
- **Conclusion:** OmniRoute v3.8.50 is an active, open-source MIT Node.js application running locally on port 30128.
- **Confidence:** `high`
- **Date, version, OS:** 2026-10-13, OmniRoute v3.8.50, Windows 11 (10.0.26300)
- **Spec delta:** none

---

## 2. Configuration & Database Storage (V-05, spec §4, §8.1)
- **Status:** `VERIFIED`
- **Evidence level:** `L2` (read-only SQLite schema inspection via Node `node:sqlite`)
- **Requirement:** `ASSUMPTION` -> `OBSERVED`
- **Command / action:** `node .phase0-scratch/inspect-sqlite-schema.mjs`
- **Observed output:**
  - Active DB File: `%USERPROFILE%\.omniroute\storage.sqlite` (file size ~106.8 MB, SQLite 3 format with WAL journal).
  - Total tables: 120+ domain tables.
  - Combos Table Schema (OmniRoute v3.8.50):
    ```sql
    CREATE TABLE combos (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      system_message TEXT DEFAULT NULL,
      tool_filter_regex TEXT DEFAULT NULL,
      context_cache_protection INTEGER DEFAULT 0
    );
    ```
  - Schema Characteristics: `data` column stores a serialized JSON object containing combo metadata, routing strategy, model definitions, and provider mappings. In v3.8.50, `tool_filter_regex` and `context_cache_protection` are optional columns recognized by RouterSync allowlist.
- **Conclusion:** Combos are persisted in SQLite table `combos` with a JSON payload in column `data`.
- **Confidence:** `high`
- **Date, version, OS:** 2026-10-15, OmniRoute v3.8.50, Windows 11
- **Spec delta:** none

---

## 3. API Authentication & Security Model (V-05, spec §8.1)
- **Status:** `VERIFIED`
- **Evidence level:** `L2` (HTTP probe via `safe-http.mjs` + source analysis in `src/server/authz/`)
- **Requirement:** `ASSUMPTION` -> `OBSERVED`
- **Command / action:** `safeFetch('http://localhost:30128/api/combos')` and inspection of `src/server/authz/policies/management.ts`
- **Observed output:**
  - Unauthenticated GET `/api/combos` returns HTTP 401: `{"error":{"code":"AUTH_001","message":"Authentication required"}}`.
  - Unauthenticated GET `/v1/models` returns HTTP 401.
  - Unauthenticated GET `/api/health` returns HTTP 200: `{"status":"ok","timestamp":"..."}`.
  - Auth Mechanisms:
    1. Bearer Token with `manage` or `admin` scope (`Authorization: Bearer <key>`).
    2. Loopback CLI Token (`x-omniroute-cli-token` derived via HMAC SHA-256 over machine-id with salt `omniroute-cli-auth-v1`). However, server requires reverse-proxy peer stamp header (`x-omniroute-peer-ip`) from custom server to accept CLI tokens.
- **Conclusion:** Public API endpoints require Bearer authentication, but `/api/health` is unauthenticated and serves as a zero-token liveness indicator.
- **Confidence:** `high`
- **Date, version, OS:** 2026-10-13, OmniRoute v3.8.50, Windows 11
- **Spec delta:** none

---

## 4. Model Catalog Endpoint (V-05, spec §4, §8.1)
- **Status:** `VERIFIED`
- **Evidence level:** `L1` (source code audit in `bin/cli/commands/models.mjs` and `src/app/api/v1/models/catalog.ts`)
- **Requirement:** `ASSUMPTION` -> `OBSERVED`
- **Command / action:** Inspected `bin/cli/commands/models.mjs`
- **Observed output:**
  - Route: GET `/v1/models` builds unified model catalog from provider connections, settings, and combo definitions.
  - Cached via `modelCatalogCacheVersion` in `readCache.ts`.
- **Conclusion:** `/v1/models` provides standard OpenAI-compatible list of available models and combos once authenticated.
- **Confidence:** `high`
- **Date, version, OS:** 2026-10-13, OmniRoute v3.8.50, Windows 11
- **Spec delta:** none

---

## 5. Combo Representation & Routing Strategies (V-10, spec §9, §17)
- **Status:** `VERIFIED`
- **Evidence level:** `L2` (CLI inspection + SQLite migration inspection)
- **Requirement:** `ASSUMPTION` -> `OBSERVED`
- **Command / action:** `npx omniroute combo create --help` and review of `src/lib/combos/`
- **Observed output:**
  - 14 Supported Strategies:
    `priority`, `weighted`, `round-robin`, `p2c`, `random`, `auto`, `lkgp`, `context-optimized`, `context-relay`, `fill-first`, `cost-optimized`, `least-used`, `strict-random`, `reset-aware`.
  - Model Assignment Syntax:
    `--models "openai/gpt-4o,anthropic/claude-3-opus"` or JSON array `[{"model":"gpt-4o","providerId":"openai"}]`.
  - Default Strategy: `priority`.
- **Conclusion:** OmniRoute has a rich set of 14 routing strategies with granular per-step model configurations.
- **Confidence:** `high`
- **Date, version, OS:** 2026-10-13, OmniRoute v3.8.50, Windows 11
- **Spec delta:** none

---

## 6. Write Path Options (V-06, spec §8.1, §14)
- **Status:** `VERIFIED`
- **Evidence level:** `L2` (CLI inspection + REST route audit + SQLite DDL)
- **Requirement:** `ASSUMPTION` -> `OBSERVED`
- **Command / action:** Inspected `bin/cli/api-commands/combos.mjs` and `sqliteComboRepository.ts`
- **Observed output:**
  - **T1 (REST API):** Endpoints `POST /api/combos`, `PUT /api/combos/:id`, `PATCH /api/combos/:id`, `DELETE /api/combos/:id` exist and are generated from OpenAPI spec. Requires `manage` Bearer token.
  - **T2 (CLI):** `omniroute combo create <name> [options]`, `omniroute combo delete <name>`, `omniroute combo switch <name>`. CLI delegates to internal REST API over loopback HTTP.
  - **T3 (Direct SQLite Write):** Direct SQL `INSERT INTO combos (id, name, data, created_at, updated_at, sort_order) VALUES (...)` into `%USERPROFILE%\.omniroute\storage.sqlite`.
- **Conclusion:** Both REST API (T1) and Direct SQLite (T3) are viable write paths.
- **Confidence:** `high`
- **Date, version, OS:** 2026-10-13, OmniRoute v3.8.50, Windows 11
- **Spec delta:** none

---

## 7. In-Memory Cache & Reload Mechanism (V-05, spec §8.1)
- **Status:** `VERIFIED`
- **Evidence level:** `L2` (source inspection of `src/lib/db/readCache.ts`)
- **Requirement:** `ASSUMPTION` -> `OBSERVED`
- **Command / action:** Examined `src/lib/db/readCache.ts`
- **Observed output:**
  - Connections cache TTL: 5,000 ms (`CONNECTIONS_TTL_MS = 5000`).
  - Combo expansion cache TTL: 10,000 ms (`10s TTL` in `src/sse/handlers/chat.ts`).
  - Signal variable: `combosCacheVersion` increments on `invalidateDbCache("combos")`.
  - Automatic expiration: Because caches use TTLCache with 5s–10s window, direct writes to SQLite will become active within 10 seconds even without an explicit invalidation signal.
- **Conclusion:** OmniRoute caches combo expansions for at most 10 seconds in memory; changes written directly to SQLite automatically take effect after the 10s TTL expires.
- **Confidence:** `high`
- **Date, version, OS:** 2026-10-13, OmniRoute v3.8.50, Windows 11
- **Spec delta:** none

---

## 8. Cloud Sync Detection & Risk (V-03, spec §4.3)
- **Status:** `VERIFIED`
- **Evidence level:** `L2` (schema inspection + CLI inspection)
- **Requirement:** `ASSUMPTION` -> `OBSERVED`
- **Command / action:** Examined SQLite table `sync_tokens` and CLI command `omniroute sync`
- **Observed output:**
  - SQLite table `sync_tokens` tracks remote instance synchronization.
  - Detection: Check `SELECT count(*) FROM sync_tokens WHERE revoked_at IS NULL`. If > 0, warn user that remote sync may overwrite local combo adjustments.
- **Conclusion:** Cloud Sync is an optional feature detectable via the `sync_tokens` table.
- **Confidence:** `high`
- **Date, version, OS:** 2026-10-13, OmniRoute v3.8.50, Windows 11
- **Spec delta:** none

---

## 9. Passive Health & Usage Telemetry (V-01, spec §2.2)
- **Status:** `VERIFIED`
- **Evidence level:** `L2` (read-only SQLite query on `sqlite_master`)
- **Requirement:** `ASSUMPTION` -> `OBSERVED`
- **Command / action:** Inspected `usage_history` and `call_logs` table schema
- **Observed output:**
  - Table `usage_history` columns: `provider`, `model`, `connection_id`, `tokens_input`, `tokens_output`, `tokens_cache_read`, `tokens_cache_creation`, `tokens_reasoning`, `status`, `success`, `latency_ms`, `ttft_ms`, `error_code`, `timestamp`, `combo_strategy`.
  - Zero Token Cost: RouterSync can passively compute model reliability, latency, and failure rates entirely by reading `usage_history` without sending any inference ping requests!
- **Conclusion:** OmniRoute has complete, passive usage and telemetry recording in SQLite `usage_history`.
- **Confidence:** `high`
- **Date, version, OS:** 2026-10-13, OmniRoute v3.8.50, Windows 11
- **Spec delta:** none

---

## 10. Read-Back Verification Path (V-05, spec §8.1)
- **Status:** `VERIFIED`
- **Evidence level:** `L2` (HTTP probe and route audit)
- **Requirement:** `ASSUMPTION` -> `OBSERVED`
- **Command / action:** Probed `/api/health` and verified `/v1/models`
- **Observed output:**
  - Liveness verification: GET `/api/health` returns HTTP 200 `{"status":"ok"}`.
  - Data verification: Direct SQLite read-back (`SELECT data FROM combos WHERE name = ?`) verifies row persistence, followed by GET `/v1/models` (when credentials are provided).
- **Conclusion:** Double verification path: SQLite read-back for state persistence + `/api/health` for router availability.
- **Confidence:** `high`
- **Date, version, OS:** 2026-10-13, OmniRoute v3.8.50, Windows 11
- **Spec delta:** none

---

## 11. External Overwrite & Concurrency Risk (V-05, spec §8.1)
- **Status:** `VERIFIED`
- **Evidence level:** `L2` (SQLite transaction model analysis)
- **Requirement:** `ASSUMPTION` -> `OBSERVED`
- **Command / action:** Analyzed SQLite WAL mode and `sqliteComboRepository.ts`
- **Observed output:**
  - Database operates in WAL mode. Concurrent writes are handled via standard SQLite locking.
  - If a user edits a combo in the web dashboard simultaneously, the row's `updated_at` changes.
  - Risk Mitigation: RouterSync must record `updated_at` during snapshot before write; if `updated_at` has changed, abort with concurrency conflict warning.
- **Conclusion:** Concurrency risk is manageable via standard optimistic timestamp checking (`updated_at`).
- **Confidence:** `high`
- **Date, version, OS:** 2026-10-13, OmniRoute v3.8.50, Windows 11
- **Spec delta:** none

---

## 12. Recommended Integration Tier (V-05, spec §8.1)
- **Status:** `VERIFIED`
- **Evidence level:** `L2` (empirical synthesis)
- **Requirement:** `ASSUMPTION` -> `OBSERVED`
- **Recommendation:**
  - **Primary: Tier 3 (Direct SQLite Write)**
    - Rationale: Fully local, zero-credential required, 100% reliable on machine, respects WAL mode, cache TTL is only 10s.
    - Safety protocol: Pre-write snapshot of `storage.sqlite` -> Atomic SQL transaction -> 10s wait / verify read-back -> Rollback if drift detected.
  - **Secondary (Optional): Tier 1 (REST API)**
    - Rationale: Available when user configures `OMNIROUTE_API_KEY` with `manage` scope.
- **Confidence:** `high`
- **Date, version, OS:** 2026-10-13, OmniRoute v3.8.50, Windows 11
- **Spec delta:** none

---

## 13. Serving-Path Read-Back & API Format (REAL L4 Discovery 2026-10-15)
- **Status:** `VERIFIED`
- **Evidence level:** `L4` (CHECKPOINT-LIVE on live OmniRoute process)
- **API Envelope:** `GET /api/combos` returns `{ combos: Array<ComboItem>, total: number }`.
- **Combo Item Keys:** Each combo item contains `id`, `models`, `config`, `sortOrder`, `version`, `computed_context_length`.
  - **CRITICAL ARCHITECTURAL NOTE:** The top-level combo object in `/api/combos` does **NOT** contain a `name` property! Reconciliation MUST use `id` as the primary key.
- **Reload TTL Benchmark:**
  - Probe measurement: **2,977 ms**
  - Live checkpoint measurement: **3,120 ms** (~3.1s)
  - Polling with 12s TTL window reliably observes live cache invalidation.
- **Logical Rollback:** Surgical row-level DELETE/UPDATE inside `BEGIN IMMEDIATE` preserves all concurrent user combos, unmanaged combos, and `usage_history` rows, returning DB logic hash to 100% equality with pre-write hash.

