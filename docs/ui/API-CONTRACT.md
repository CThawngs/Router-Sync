# RouterSync UI API Contract & View-Model Specification

- **Document Version:** 1.1.0
- **Status:** DRAFT / PHASE 3b FOUNDATION
- **Last Updated:** 2026-10-24
- **Reference:** SPEC.md (§24.2, §30.3, §33.3, §34), GOVERNANCE.md, ADR-UI-01

---

## 1. Overview & Principles

The RouterSync Web UI (`packages/ui`) communicates with data providers solely through the abstract `ApiClient` interface. In UI-0, this contract is fulfilled deterministically in-memory by `MockApi`. In Phase 3b/P4, it will be backed by `HttpApi` communicating with the background daemon over `http://127.0.0.1:<port>/api/v1/...`.

**Fundamental Invariants:**
1. **Zero Provider Secret Exposure vs. UI Session Tokens:** External provider credentials (raw API keys, provider secrets, passwords) NEVER travel across this interface — only provider names, key storage types (e.g. `os_keychain`, `env_var`), and masked hints are communicated. In contrast, local daemon-issued UI session tokens (`X-RouterSync-Session`) are planned for Phase 3b write-path hardening (not implemented in S1 read-only slice) to authenticate UI operations and prevent unauthorized browser requests.
2. **Deterministic & Isolated:** Browser code imports zero Node.js native modules. Types defined here are pure View-Models tailored for rendering, accessibility, and user feedback.
3. **Auditability & Provenance:** Every proposed change and plan includes source attribution (`proposed_by: human | agent | daemon`), plan hashes, and evidence references.
4. **Response Metadata Envelope:** Top-level object responses include `meta: { source: 'live' | 'sample' | 'unavailable', generatedAt: string, reason?: string }` (with router-level provenance in `/combos` as `meta.routers`). Endpoints returning top-level arrays (specifically `GET /api/v1/targets`) embed metadata envelopes at the item level under `item.db.meta` and `item.probe.meta`. This ensures the UI reliably communicates whether data is live, sample, or unavailable (D7 / B-1).
5. **Structured i18n Localization (D1):** Dynamic notification and event items are returned as structured code and params (`{ code: string, params?: Record<string, string | number> }`), enabling the UI to render localized messages via `translations.json` without hardcoding language-specific prose in API payloads.

---

## 2. View-Model to Core Domain Mapping

| UI View-Model (`src/api/types.ts`) | Core / Adapter Type (`packages/core`, `adapter-sdk`) | Description / Mapping Notes |
|---|---|---|
| `ResponseMeta` | Metadata Envelope | Source indicator (`'live' \| 'sample' \| 'unavailable'`), timestamp, and degradation reason. |
| `TodoItem` | Inbox / Action Item | Structured action with `code`, `params`, risk type, action key, and target navigation section. |
| `RecentEvent` | Audit / Event Log Item | Structured event with `code`, `params`, relative time, glyph type, and optional highlights. |
| `ProviderViewModel` | `ProviderConn` + `Offering[]` | Provider status (`active`, `auth_failed`, `no_list_api`), key source description, detected model count, last scan relative time. |
| `ModelViewModel` | `ModelInfo` (`CanonicalModel` + `Offering`) | Canonical ID, provider, pricing kind (`free_forever`, `free_tier`, `subscription`, `metered`, `unknown`), traits (vision, context), health status, quality score. |
| `ComboViewModel` | `ComboDefinition` + `ComboRule` | Ordered list of steps (`RouterModelRef`), fallback strategy, managed vs adopted status, cascade nesting, live desired vs actual status. |
| `TargetViewModel` | `Target` + `AdapterCapabilities` + `RouterFingerprint` | Sinks (OmniRoute, 9Router, OpenCode). Mode (`preview` vs `active`), integration tier (T1/T2/T3), combo support, read-back level, version gate status. |
| `PlanViewModel` / `ChangeItemViewModel` | `Plan` (`additions`, `modifications`, `deletions`) | List of human-readable atomic actions with risk levels (`low`, `medium`, `high`), plan hash, expiration, real config file unified diff. |
| `SnapshotViewModel` | `Snapshot` | Durable snapshot record (`id`, `target`, `timestamp`, `changedCount`, `size`), preview of logic rollback. |
| `HealthSummaryViewModel` | `HealthStatus` + `ProbeBudget` | Active vs degraded models, billable requests today (0 token guarantee), 3-tier budget meters, 24-check heartbeat history. |
| `InboxItemViewModel` | `InboxItem` | Unmatched model names, unknown traits, agent-submitted proposals awaiting review. |
| `DoctorItemViewModel` | Preflight Doctor Checklist (§22.7) | 9 stability conditions with pass/warn/fail indicators and actionable guidance. |

---

## 3. Endpoints Contract (Target for Phase 3b Daemon)

All responses return `application/json; charset=utf-8`.
In the S1 Read-Only Slice, the daemon serves `GET` requests on `/api/v1/health`, `/overview`, `/targets`, `/combos`, `/doctor`, `/settings`, `/heartbeat`, `/providers`, `/models`, `/changes/pending`, `/changes/history`, and `POST` on `/api/v1/changes/approve`. All other methods/routes return `405 Method Not Allowed` with `{ error: 'read_only_slice' }`. GET endpoints do not accept a request body.

### 3.0 Response Envelopes Summary

Across the 12 endpoints served by the daemon, the response envelopes follow strict top-level structures:

1. `GET /api/v1/health` → Top-level Object: `{ meta: ResponseMeta, daemon: 'ok', status: string, version?: string, readOnly: boolean, uptime: number, routers: Record<string, RouterHealth> }`
2. `GET /api/v1/overview` → Top-level Object: `{ meta: ResponseMeta, routers: { probedCount: number, upCount: number }, trackedModels: { count: number }, billableRequestsToday: { code: string }, lastCheck: { code: string, lastCheckAt: string } }`
3. `GET /api/v1/targets` → Top-level Array: `TargetViewModel[]` (`[ { id, name, type, addressOrPath, supportsCombos, readBackLevel, derivedFrom, db: { meta, combosManaged, combosAdopted }, probe: { meta, reachability } }, ... ]`). Target list returns an array directly; metadata envelopes are embedded per-target under `target.db.meta` and `target.probe.meta`.
4. `GET /api/v1/combos` → Top-level Object: `{ meta: { source: string, generatedAt: string, routers: Record<string, { source: string, reason?: string }> }, combos: ComboViewModel[] }`
5. `GET /api/v1/doctor` → Top-level Object: `{ meta: ResponseMeta, overallStatus: string, conditions: DoctorItemViewModel[] }`
6. `GET /api/v1/settings` → Top-level Object: `{ meta: ResponseMeta, policyMode: string, policyModeSource: string }`
7. `GET /api/v1/heartbeat` → Top-level Object: `{ meta: ResponseMeta, code: string, resource: string, data: unknown }`
8. `GET /api/v1/providers` → Top-level Object: `{ meta: ResponseMeta, data: ProviderViewModel[] }`
9. `GET /api/v1/models` → Top-level Object: `{ meta: ResponseMeta, data: ModelViewModel[] }`
10. `GET /api/v1/changes/pending` → Top-level Object: `{ meta: ResponseMeta, id: string, proposalCode: string, planHash: string, computedTimeAgo: string, impactPercent: number, maxImpactPercent: number, billableRequestsCount: number, targetsSummary: string, hasRollbackBackup: boolean, sourceSummary: string, sourceDetail: string, actions: ActionItem[], deliberateExclusions: ActionItem[], unifiedDiff: string }`
11. `GET /api/v1/changes/history` → Top-level Object: `{ meta: ResponseMeta, snapshots: SnapshotViewModel[] }`
12. `POST /api/v1/changes/approve` → Top-level Object: `{ meta: ResponseMeta, approved: boolean, planHash?: string, message?: string, error?: string }` (Rejections return HTTP 401 with `{ meta, error, approved: false }` or HTTP 403 with `{ meta, error, approved: false }`)

### 3.1 Overview & System
- `GET /api/v1/overview`: Returns system status (`running` vs `first_run`), mode chips, 4 primary metrics, active todo count, recent activity event log.
- `GET /api/v1/health`: Returns daemon health and live reachability of configured routers.
- `GET /api/v1/heartbeat`: Returns last 24 daemon sweep ticks (healthy, warning, missed) with timestamp.
- `POST /api/v1/emergency-pause`: Activates or deactivates emergency stop. In S1, returns 405 ("read_only_slice").

### 3.2 Changes & Approval
- `GET /api/v1/changes/pending`: Current pending plan (`#a41f`), actions list, risk tiers, exclusions ("deliberately NOT done"), and file diff.
- `POST /api/v1/changes/approve`: Submits human approval token bound to `plan_hash`.
  - **Current Implementation State (Phase 3b / AT-165):**
    - Verifies a 64-hex cryptographically random approval token generated in-memory via `createApprovalToken(planHash)`.
    - Token has a strict 5-minute TTL (`DEFAULT_TTL_MS = 300_000`) and is single-use: atomically marked consumed upon first valid check.
    - Token is strictly bound to `planHash`. A mismatched `planHash` is rejected with HTTP 403 `plan_hash_mismatch`.
    - **Zero Disk Writes:** The approve handler (`packages/daemon/src/handlers/approval.ts`) executes purely in memory; it performs zero writes to SQLite DBs or router configs.
  - **Security Gaps in Current Implementation (Documented per Audit R30 Item D):**
    1. *No Session Token:* The endpoint does NOT yet validate `X-RouterSync-Session` header (planned for full P3b interactive UI hardening).
    2. *No Pairing Code:* One-time pairing code mechanism for initial browser connection is not yet implemented.
    3. *No Rate Limiting:* In-memory token verification does not currently enforce brute-force request throttling/rate-limiting.
    4. *No Durable Audit Log:* Token consumption events are not persisted to an append-only audit log on disk.
- `POST /api/v1/changes/reject`: Rejects the current plan and records preference.
- `GET /api/v1/changes/history`: List of durable snapshots and execution history.
- `POST /api/v1/changes/rollback`: Dry-run or executes logic rollback to a designated snapshot ID.

#### Daemon Security & Threat Model (S1: `docs/security/daemon-threat-model.md` PENDING_REVIEW; biện pháp cho endpoint ghi (session token, plan-hash) vẫn BLOCKING cho P3b):
- **127.0.0.1 Bind Only:** Daemon HTTP server listens strictly on loopback `127.0.0.1`, never `0.0.0.0` or external interfaces.
- **Host & Origin Validation:** Rejects any request with unexpected `Host` header (must match `127.0.0.1:<port>` or `localhost:<port>`) or third-party `Origin` / `Referer` headers, mitigating cross-site request forgery (CSRF) and browser-origin exploitation.
- **Session Token (Planned for P3b / Not implemented in S1):** Target specification requires every mutating endpoint (`/approve`, `/rollback`, `/emergency-pause`) to validate a daemon-issued session token (`X-RouterSync-Session`) generated upon local daemon startup or UI initial handshake. In current S1 read-only slice, session token validation is not yet implemented.
- **Plan Hash Binding:** Approval requests must supply both `approval_token` AND `plan_hash`. If the current plan has mutated or drifted since presentation, approval is rejected with `409 Conflict`.
- **Formal Threat Model (Chi tiết tại `docs/security/daemon-threat-model.md` — Trạng thái: `PENDING_REVIEW`):**
  - **Protected Boundaries:**
    1. *External Web Pages:* Malicious web pages loaded in user browsers are mitigated by strict loopback bind, host validation, Origin checking, and CORS preflight denial (mitigating CSRF and DNS rebinding attacks).
    2. *Pure MCP Clients (stdio protocol level):* The RouterSync MCP server exposes exclusively read-only tools without write primitives or access to mutate HTTP endpoints over stdio.
  - **Explicit Non-Boundary (Out of Scope / Same-User Privilege Class):**
    - The local HTTP API does NOT protect against other untrusted processes or agents executing under the same OS user account with local shell access (an agent with shell access belongs to the same privilege class and can inspect process memory, read session tokens, or invoke the CLI directly).
    - *Mitigations for Local User Surface:* One-time pairing code upon initial browser connection, strict ephemeral plan hash binding, immutable append-only local audit log, and aggressive rate limiting on mutating endpoints.

### 3.3 Combos
- `GET /api/v1/combos`: List of all combos with targets, strategy, steps, desired vs actual drift status.
- `POST /api/v1/combos/preview`: Given draft `ComboSpec` filter & ordering rules, calculates live candidate ladder and validation checks (I1-I8).
- `POST /api/v1/combos/save-draft`: Converts draft combo into a pending change proposal.

### 3.4 Providers & Models
- `GET /api/v1/providers`: List of configured providers with health state, key type, free quotas.
- `POST /api/v1/providers/verify`: Tests provider credentials without token spend (P-0 `/v1/models` list call).
  - **Payload Requirement:** Accepts ONLY key source references (`{ provider: string, key_ref: { source: 'env' | 'os_keychain', ref_name: string } }`).
  - **Zero Raw Key Transmission:** Transmitting raw API keys (`key_value`) is strictly prohibited across the API boundary (Spec §23.2). Credentials are resolved locally by the daemon via Credential Broker. Key onboarding stores to the local keychain or environment file via separate local workflows.
- `GET /api/v1/models`: Paginated catalog of models with search, filter by pricing, vision, review queues.

### 3.5 Targets
- `GET /api/v1/targets`: List of detected local targets, preview vs active switch, combo capability, Cloud Sync warnings.
- `PATCH /api/v1/targets/:id`: Toggles mode (`preview` vs `active`) or adopt settings.

### 3.6 Settings & Doctor
- `GET /api/v1/settings`: Current policy mode (`manual`, `auto-low-risk`), scan schedules, safety thresholds, MCP client statuses.
- `GET /api/v1/doctor`: Preflight run of 9 stability criteria with diagnostics.

---

## 4. S1 Daemon Payload Field Provenance (R10-1 Truthfulness Guarantee)

In slice S1 (Read-Only Daemon), every payload field returned across the daemon API boundary is strictly classified into one of four provenance categories:
1. **measured**: Directly measured in real-time during the request (e.g. dynamic process uptime, live socket reachability probe, SQLite row count).
2. **derived**: Derived from verified underlying state with deterministic rationale (e.g. `derivedFrom: 'no_key_in_s1'`, `readBackLevel: 'db-only'`, `code: 'by_design_zero_inference'`).
3. **static-capability**: Static structural capability of the router adapter or engine (e.g. `supportsCombos: true`, `type: 'router'`).
4. **omitted**: Excluded from S1 daemon payloads because daemon does not measure it (UI falls back to default representation or suppresses display; zero hardcoded/synthetic values).

Default Web UI origin is unified to `http://localhost:3100` and `http://127.0.0.1:3100`.

### 4.1 Provenance Classification by Endpoint

| Endpoint | Field | Classification | Origin / Rationale |
|---|---|---|---|
| `GET /api/v1/health` | `daemon` | measured | `'ok'` (confirms daemon process loop is alive) |
| | `status` | measured | `'healthy'` if all probed routers are up; `'routers_down'` otherwise |
| | `uptime` | measured | Dynamic `Math.floor(process.uptime())` in seconds |
| | `version` | static-capability | Package version read dynamically from `packages/daemon/package.json` at runtime; omitted if reading fails (zero hardcoded fallback) |
| | `readOnly` | static-capability | `true` (enforced S1 read-only guard) |
| | `routers.*.reachability` | measured | Probed socket state (`'up' \| 'down' \| 'unknown'`) |
| | `routers.*.httpStatus` | measured | HTTP status code returned by probe |
| | `routers.*.lastChecked` | measured | ISO-8601 timestamp of probe attempt |
| `GET /api/v1/overview` | `activeProviders` | omitted | Omitted in S1; S1 does not meter providers (providers belong to P3a). UI renders "—" |
| | `routers.probedCount` | measured | Number of routers probed in this request (length of probe list) |
| | `routers.upCount` | measured | Number of probed routers currently `up` |
| | `trackedModels.count` | measured | Number of distinct model IDs referenced across combos in readable DBs (independent of probe) |
| | `billableRequestsToday.code` | derived | `'by_design_zero_inference'` (daemon never calls billable endpoints) |
| | `billableRequestsToday.count`| omitted | Excluded; daemon S1 does not meter token inference |
| | `lastCheck.code` | derived | `'daemon_running'` \| `'router_disconnected'` |
| | `lastCheck.lastCheckAt` | measured | ISO-8601 timestamp of most recent probe check |
| | `todoItems` | omitted | Empty/omitted in S1; no synthetic Vietnamese items |
| | `recentEvents` | omitted | Empty/omitted in S1; no synthetic event log |
| `GET /api/v1/targets` | `*.db.combosManaged` | measured | Exact count queried from target SQLite database where `managed === true` (omitted if DB read fails) |
| | `*.db.combosAdopted` | measured | Query count of non-managed combos in target SQLite where `managed === false` (omitted if DB read fails) |
| | `*.db.meta.source` | derived | `'live'` when SQLite file is readable; `'unavailable'` with `reason` (`'db_not_found'`, `'db_busy'`, `'db_unreadable'`, `'schema_mismatch'`) otherwise |
| | `*.probe.reachability` | measured | Live socket probe status (`'up' \| 'down' \| 'unknown'`) |
| | `*.probe.httpStatus` | measured | HTTP status returned by health endpoint (e.g. 200, 404, 500) |
| | `*.probe.meta.source` | derived | `'live'` when probe is `up`; `'unavailable'` when unreachable |
| | `*.readBackLevel` | derived | `'db-only'` in S1 (direct SQLite reading); `'full'` in P3a |
| | `*.derivedFrom` | derived | `'no_key_in_s1'` (explains why readBackLevel is restricted) |
| | `*.combosManaged`, `*.combosAdopted` | omitted | Omitted at top level; kept exclusively under `*.db` block |
| | `*.applyState` | omitted | NEVER emitted by daemon S1 (R11-3): S1 performs no writes and does not read the write-evidence state, so it publishes none of the three values — not even when the probe is `up`. The field returns with the P3b applier slice; UI renders "—". Enum-gap review: DECISIONS 2026-10-18-01; value semantics and the evidence rule: §4.2 |
| | `*.supportsCombos` | static-capability | Adapter capability (`true` for 9Router & OmniRoute) |
| | `*.breakerState` | omitted | Excluded; daemon S1 has no circuit breaker state machine |
| | `*.integrationNotes` | omitted | Excluded; no hardcoded static markdown strings in S1 |
| `GET /api/v1/combos` | `*.id`, `*.name` | measured | Extracted directly from combo row in SQLite database |
| | `*.type` | derived | Strictly `managed` or `adopted` (`managed === true` -> `managed`, else `adopted`). Omitted: `free_only`, `custom`, `isFreeOnly` (no pricing checks in S1) |
| | `*.strategy` | derived | **R17-0:** a STRING, present ONLY when the router row actually stores a usable value. 9Router stores `settings.comboStrategies` in two shapes (a plain string for old combos, an object `{ fallbackStrategy }` for new ones); the daemon normalizes both with the same ladder as `adapter-9router` (`normalizeComboStrategyValue`). A missing or unusable value is OMITTED instead of filled with a guessed default: `round-robin` is a constant inside the adapter and this daemon reader, and no repo evidence proves it is what the router uses when the field is absent. UI renders "—"; AT-143 compares only the measured combos. **R18-2 (OmniRoute):** the daemon reads `combos.data` -> `parsed.strategy`, which is the SAME place `adapter-omniroute` reads. `adapter-omniroute` declares `strategy: z.string().default('priority')` (`packages/adapter-omniroute/src/index.ts:85`) and substitutes `{ strategy: 'priority', ... }` when a payload fails its Zod schema (`:307`), so it can report a value the router never stored; the daemon does not. Whether a real OmniRoute row omits the key when its strategy equals OmniRoute's own `priority` default is NOT decidable from the code or from the committed fixtures — every committed row fixture stores the key — so the question stays open (REPORT-ROUND18). An empty string stopped counting as a measured value in R18-2. AT-143 covers both routers |
| | `*.steps[].modelId` | measured | Extracted from JSON/text model array in SQLite |
| | `*.targets` | measured | Only merges identical records across routers when `strategy` and `models` are identical; diverging configs emit separate elements with a single target |
| | Partial/Total DB Failure | derived | **R18-1:** the route answers `{ meta, combos }` on EVERY 200. A bare array no longer exists: it carried no `meta`, so the client could not tell "readable database, zero combos" from "nothing could be read". `meta.source` is `'live'` when at least one database was read, `'unavailable'` (with `reason`) when both failed. `meta.routers` reports `{ source, reason? }` per router, so the screen warns "Combo của <router> chưa đọc được" while still painting the combos of the router that WAS readable, without a second request. A readable database with zero combos is `{ source: 'live', combos: [] }` and paints as the empty state, never as unavailable |
| | `*.actualVsDesired` | omitted | Excluded; daemon S1 does not evaluate drift vs desired state |
| | `*.isFreeOnly` | omitted | Excluded; no pricing inspection in S1 |
| | `*.steps[].description` | omitted | Excluded; no fabricated descriptions in S1 |
| `GET /api/v1/doctor` | `conditions[c1]` (node) | measured | Compares runtime `process.version` against package requirement |
| | `conditions[c2]` (config) | measured | Accessibility of `routersync.yaml`. **R16-4 states:** a MISSING file is a normal S1 state -> `state: 'not_checked'`, `code: 'config_missing'`, `reason: 'using_defaults'`; a file that exists but cannot be read -> `fail` with `code: 'config_unreadable'`; a file that exists but does not match the schema -> `fail` with `code: 'config_invalid'`. `overallStatus` stays `error` only when at least one condition is `fail`; a `not_checked` condition makes it `warning` |
| | `conditions[c3]` (db) | measured | Checks SQLite database file size and read accessibility |
| | `conditions[c4]` (schema) | measured | Validates SQLite schema tables presence (`schema_mismatch` on missing tables) |
| | `conditions[c5]` (snapshot)| measured | Zero-write guarantee: daemon S1 NEVER creates directory. States: `snapshot_dir_missing` (not_checked with `reason: 'no_snapshot_dir_yet'`, dir absent — a machine that never applied a plan legitimately has no snapshot dir), `snapshot_dir_unwritable` (fail, cannot write), `snapshot_none_yet` (not_checked with `{ snapshots: 0 }`, writable + DB present + 0 snapshots), `snapshot_dir_writable` (pass with `{ snapshots: N }`, writable + >=1 snapshot or no DB) |
| | `conditions[c6]` (network) | measured | Reflects probe reachability of all configured routers |
| | `conditions[c7..c9]` | derived | `state: 'not_checked'`, `reason: 'needs_p3a'`, `code: 'deferred_to_p3a'` |
| | `resultText` | omitted | Excluded; replaced everywhere with structured `{ code, params }` |
| `GET /api/v1/settings` | `policyMode` | derived | Read from `routersync.yaml` config (`policy.mode`); stays `manual` when there is no config file |
| | `policyModeSource` | derived | **R16-4:** `'config'` when the value was read from `routersync.yaml`, `'default'` when no config file exists. The UI prints "mặc định (chưa có routersync.yaml)" next to the value when the source is `default`, and "—" for `scanSchedule` / `maxDailyRequests` / `mcpClients` (unmeasured in S1) |
| | `scanSchedule`, `maxRequests` | omitted | Excluded; daemon S1 does not configure daemon fast loop |
| `GET /api/v1/heartbeat` | `meta` | derived | `source: 'unavailable'`, `reason: 'needs_p3a'`, `generatedAt: string` |
| | `code`, `resource`, `data` | derived | Structured response deferred to Phase 3a (`code: 'slice_s1_deferred_to_p3a'`, `resource: 'heartbeat'`) |
| `GET /api/v1/providers` | `meta` | derived | `source: 'live' \| 'unavailable'`, `generatedAt: string` |
| | `data[].id` | measured | Discovered provider identifier from catalog SQLite store |
| | `data[].name` | derived | Human-readable provider label derived from provider ID |
| | `data[].status` | measured | Provider status (`active`, `key_error`) |
| | `data[].modelsCount` | measured | Active model count computed from catalog store rows |
| | `data[].keySource`, `data[].keySourceLabel` | derived | Credential source metadata (`env_var`, `Environment Variable`) |
| | `data[].lastScan` | measured | Timestamp of last sync (`lastSyncAt` or fallback to generatedAt) |
| `GET /api/v1/models` | `meta` | derived | `source: 'live' \| 'unavailable'`, `generatedAt: string` |
| | `data[].id` | measured | Model identifier in format `<provider>/<model>` |
| | `data[].canonicalId` | measured | Canonical model identifier stored in catalog SQLite |
| | `data[].provider` | measured | Associated provider identifier from catalog entry |
| | `data[].status` | measured | Lifecycle status (`healthy`, `new`, `due_removal`, `paused`, `degraded`) |
| | `data[].context` | static-capability | Context window representation from catalog entry (e.g. `128k`) |
| | `data[].priceKind`, `data[].priceText` | static-capability | Pricing kind and display text (`unknown`, `N/A` in S1) |
| `GET /api/v1/changes/pending` | `meta` | derived | `source: 'live'`, `generatedAt: string` |
| | `id`, `proposalCode`, `planHash` | derived | Pending plan identifiers (`plan-none` and empty hash when no plan active) |
| | `computedTimeAgo` | derived | Relative time display string (e.g. `'Chưa có kế hoạch thay đổi'` when empty). *Known issue (R33):* Free-form Vietnamese text returned in machine payload violates §1 Invariant 5 (Structured i18n Localization). Tracked for refactoring to structured code in Phase 3b write-loop. |
| | `impactPercent`, `maxImpactPercent` | derived | Change impact indicators (`0` and `50` default when empty) |
| | `billableRequestsCount` | derived | Always 0 by design (zero inference guarantee) |
| | `targetsSummary`, `hasRollbackBackup` | derived | Target summary string and backup state |
| | `sourceSummary`, `sourceDetail` | derived | Source summary counts and detail string (`'0'`, `'0 hành động'`). *Known issue (R33):* Contains free-form Vietnamese text; tracked for refactoring. |
| | `actions[]` | derived | List of pending change items (`id`, `type`, `modelId`, `risk`, `source`, etc.) |
| | `deliberateExclusions[]` | derived | Explicitly excluded actions |
| | `unifiedDiff` | derived | Formatted configuration diff text |
| `GET /api/v1/changes/history` | `meta` | derived | `source: 'live'`, `generatedAt: string` |
| | `snapshots[]` | measured | Durable snapshot metadata read from state directory |
| | `snapshots[].id`, `snapshots[].target` | measured | Unique snapshot identifier and target router |
| | `snapshots[].timestamp`, `snapshots[].changedCount`, `snapshots[].size` | measured | Snapshot creation timestamp, number of changed items, and file size in bytes |
| `POST /api/v1/changes/approve` | `meta` | derived | `source: 'live' \| 'unavailable'`, `reason?: string` |
| | `approved`, `planHash`, `message` | derived | In-memory token verification result; single-use 64-hex token bound to planHash (5-min TTL); zero disk/router writes executed. `createApprovalToken` is test-only with no UI/CLI issuance path. |
| | `error`, `approved: false` | derived | Rejection payload returned on HTTP 401 when token is missing, expired, or invalid |
| | `audit_log` | omitted | Omitted in S1/Phase 3b memory slice; append-only durable audit trail deferred to full write-loop |
| | `latencyMs` | omitted | Omitted across all endpoints; S1 daemon does not meter upstream network round-trip latencies |
| | `tokenPricing` | omitted | Dynamic live pricing queries omitted; baseline token pricing comes from static reference catalog |

### 4.2 `applyState` Values, Evidence Rule, and Publishers

`applyState` describes a **write**, not an intention. The enum has three values (R19-2, DECISIONS 2026-10-18-01 — the third value is **additive**; `verified` and `written-pending-reload` keep their existing meaning):

| Value | Exact meaning |
|---|---|
| `verified` | The write is evidenced AND the router reads the written state back on the serving path (read-back level `full` or `existence-only`). |
| `written-pending-reload` | The write is evidenced and the router is healthy, but the serving path only reads `db-only (degraded)`: the written combo becomes visible on the router only after it reloads/refreshes. The daemon must NOT count this as success. |
| `unwritten` | There is **no evidence** that this target was ever written — the honest state for a target that was never applied. |

**Evidence rule.** "Evidence of a write" for a target means:

- at least one **snapshot of that target** in the snapshot directory (a snapshot carries an exact `target` field, so this half is exact), **OR**
- at least one entry of that target in the `managed-ids.json` ledger — **for the `9router` target only**.

**Known mismatch (deliberate).** The `managed-ids.json` ledger on disk is a flat array of ids with **no target column** (`["routersync-fast", ...]`), and only the 9Router adapter writes to it. A ledger entry therefore cannot be attributed to a router by reading the file, so it counts as evidence **for the `9router` target only**. A snapshot carries an exact `target` and counts for that target. The asymmetry is deliberate: counting a ledger entry for every target would report one router's write as another router's write.

**Read-only guarantee.** Reading the evidence is strictly READ-ONLY: no file and no directory may be created by a read. A missing ledger or a missing snapshot directory means "no evidence", not "an empty ledger". The `status` command therefore never creates a file or a directory.

**Publishers.**

| Surface | Rule |
|---|---|
| CLI `routersync status` (per router) | Router not healthy → the field is **omitted** (no value at all). Router healthy and no evidence → `unwritten`. Router healthy, evidence present, read-back level `full` or `existence-only` → `verified`. Router healthy, evidence present, read-back level `db-only (degraded)` → `written-pending-reload`. The CLI never prints `written-pending-reload` without evidence of a write. |
| MCP `status` tool (`applyStates`) | Evidence-gated per router: `omniroute` → `verified`, `9router` → `written-pending-reload`; without evidence both are `unwritten` and `pendingReloadRouters` is empty. |
| Adapter apply result (`ApplyResult.applyState`) | The adapter reports the state of the apply it just performed (`verified` or `written-pending-reload`); the evidence rule governs the read-only status surfaces. |
| Daemon S1 (`GET /api/v1/targets`) | **Omits the field entirely.** S1 performs no writes and does not read the write-evidence state, so it can publish none of the three values; the UI renders "—". |

