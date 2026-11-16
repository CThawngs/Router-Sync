# RouterSync Compatibility Matrix (Phase 2 / Phase 3 Gate 0)

This matrix summarizes verified router adapter tiers, serving-path read-back levels, agent harness support, and cross-platform operating system verification under Governance v7.4 (Spec §31.9 & §32.1).

---

## 1. Routers & Adapters

| Router | Version Tested | Tier | Write Path | Serving-Path Read-Back Level | Cache Invalidation / TTL | Degraded Reason |
|---|---|---|---|---|---|---|
| **OmniRoute** | `3.8.50` | T3 (SQLite) | `storage.sqlite` (`combos` table, optional cols: `tool_filter_regex`, `context_cache_protection`) | `full` (via `GET /api/combos` envelope `{ combos, total }`, reconciled by `id`) / `existence-only` (via `GET /v1/models`) / `db-only (degraded)` | Real measured reload TTL ~3.1s (polling up to 12s) | None if key set; unauthenticated API returns 401 |
| **9Router** | `0.5.99` | T3 (SQLite) | `data.sqlite` (`combos` & `settings` tables) | `db-only (degraded)` (SQLite writes durable; serving reflection on `/v1/models` unconfirmed) / `existence-only` (existing combos visible under `owned_by: "combo"`) | Gate L, COPY, Windows (AT-111, n=3): `kind=NULL` phản ánh sau 19.7 s, 30.7 s, 31.2 s (chu kỳ làm mới ≈30 s); `kind='custom'` không bao giờ phản ánh (0/3 trong 90s). Đã tách TTL khỏi per-request. Q5 UNVERIFIED. Mã `kind=NULL` + marker `routersync-` đã commit trên `integrate/p3-ui`; ghi live chờ AT-114. | Serving path reflection unconfirmed; admin API requires browser session cookie. `applyState = written-pending-reload` (spec §33.3 / AT-109); `policy.mode` capped at manual/shadow (D26) |

---

## 2. Agent Harnesses

| Harness | Version Tested | Protocol | Config File Target | Merge Strategy | Verification Level |
|---|---|---|---|---|---|
| **Hermes Agent** | v0.4.x | MCP (stdio) | `~/.hermes/mcp_config.json` | JSON key merge under `mcpServers.routersync` (non-destructive) | `L4` (AT-94) |
| **DSH Desktop** | Cordis desktop | MCP (stdio) | `~/.dsh/profiles/desktop/cordis.patch.yml` | YAML patch append under `mcpServers.routersync` (non-destructive) | `L4` (AT-94) |

---

## 3. Read-Back Verification Definitions (Condition A5 / AT-98 / AT-101)

1. **`full`:** Verified directly through the HTTP serving path endpoint used by clients to fetch combos/models (e.g. `GET /api/combos` with Bearer auth). If the router caches in-memory, RouterSync waits for cache expiry (TTL) before read-back assertion.
2. **`existence-only`:** Verified through a public serving endpoint (e.g. `GET /v1/models` with client API key) confirming entity visibility, without full combo schema metadata.
3. **`db-only (degraded)`:** Verified by re-reading the SQLite database state directly because no HTTP serving endpoint credentials exist. Clearly flagged with a degraded warning in `status`, `scan`, and `ApplyResult`. Applies in this state carry `applyState = written-pending-reload` (spec §33.3 / AT-109): the write persisted but serving-path reflection is unconfirmed — the combo becomes visible on the router only after reload/refresh, and the daemon must not count these applies as success.

---

## 4. Operating System Support Matrix (Spec §32.1)

| Operating System | Support Level | CLI & Core | OmniRoute Adapter | 9Router Adapter | Harness MCP Installer | Status Note |
|---|---|---|---|---|---|---|
| **Windows** | **Supported** | PASS (L4, REAL) | PASS (L4, REAL) | PARTIAL (L4, REAL) | PASS (L4, REAL) | Verified on host machine (Node 24, PowerShell, local SQLite); 9Router adapter PARTIAL vì T2-41 và AT-114 chưa chạy live. |
| **Linux (Ubuntu / WSL2)** | **Untested** | Untested | Untested | Untested | Untested | Scheduled for verification in CI matrix / WSL2. |
| **macOS (Darwin)** | **Untested** | Untested | Untested | Untested | Untested | Awaits community / CI verification; no claim of support until tested. |
