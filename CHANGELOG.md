# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-17

First release candidate. Read-only surface is stable.

### Added
- **`routersync apps inspect`:** read-only view of provider/model configuration for Hermes Agent, DSH Desktop, OpenCode. No write flag by design.
- **`routersync apps drift`:** read-only drift detection between app agent model lists and router state (OK/DISABLED/MISSING/UNKNOWN/NOT-ROUTED). EXPERIMENTAL: OmniRoute read-back not yet verified; combo names not yet traced.
- **Agent app inspection contract:** `AgentAppInspection` type in `@routersync/adapter-sdk` with certainty tiers (A/B/C), boolean-only secret exposure (`baseUrlPresent`/`keyPresent`), and error codes (`ENOENT`/`PARSE`/`TOO_LARGE`/`UNSUPPORTED`).
- **Adapter for Hermes Agent, DSH Desktop, OpenCode:** synthetic fixtures (`<KEY>`, `https://example.invalid`), 21 contract tests including fake-key leak protection.
- **BOM handling:** UTF-8 BOM stripped before JSON/YAML/TOML parse (fixes Cursor `mcp.json` parse error).

### Changed
- All package versions: `0.0.1-prealpha` → `0.1.0`.

## [0.0.1-prealpha] - 2026-11-13

The first published shape of RouterSync. Pre-alpha: the read-only surface is
the stable part.

### Added
- **End-to-end suite (`pnpm e2e`):** packs every workspace package, installs
  the tarballs with npm into an empty project and drives the installed
  binaries - `--version`, `--help`, `scan`, `tick` twice (the second run makes
  0 requests thanks to the 15-minute gate), `verify`, `inbox list|ack|snooze`,
  `research submit`, `rank` preview, `sync`/`undo` plan-only, and the refusal
  of `sync --apply`, `undo --apply` and `rank --apply` when stdin is a pipe.
  The MCP server is driven over stdio with the SDK client (24 read-only tools,
  no write tool, five read-only calls). The daemon is started on a random port
  and a health endpoint is called. The fake router databases are hashed
  before and after and must be byte-identical.
- **Fake provider host** (`test/e2e/fake-provider-server.cjs`): a local
  `GET /models` server with the scenarios 200, a new model, a lost model, 401,
  429 and 500. It runs in its own process because a synchronous CLI call
  blocks the event loop of the process that makes it.
- **Registry files:** `registry/providers.yaml` (public provider table),
  `registry/gateways.yaml` (providers without a single-model GET endpoint) and
  `registry/dead-models.yaml` (data for the dead-model scan). No private
  provider name is hardcoded in the source any more.
- **Schedule samples** (`examples/schedule/`): Windows Task Scheduler, macOS
  launchd, Linux systemd timer and a cron line. Every sample calls
  `routersync tick`, which costs 0 tokens.
- **`THIRD-PARTY-NOTICES.md`:** the licence table of the 102 production
  dependencies. No GPL, AGPL, LGPL or unknown-licence package is used.
- **`.nvmrc`**, `engines` (Node >= 22.12), `license`, `repository`, `bugs` and
  `homepage` in every `package.json`.
- **README** with an English part and a Vietnamese part, per-OS installation,
  the flow diagram, the safety model, the CLI table, the MCP client sample,
  troubleshooting and the disclaimer.

### Fixed
- The installed MCP server never started: the entry-point check only matched
  the source-tree path. It now compares the resolved paths.
- `routersync --version` printed a hardcoded `0.1.0`; it now reads the
  package manifest.
- A gateway without a single-model GET endpoint was detected by a hardcoded
  name in the source. It now comes from `registry/gateways.yaml`.
- The ranking preview called a provider endpoint over the network on every
  run. The preview never calls the network any more.
- The confirmation word was compared literally, so one of the two spellings
  was rejected. The comparison now folds the accents and the case.
- The refusal message of a blocked write was printed twice.
- `tick` printed the "missing ranking policy" banner on every run. The banner
  is now printed only where a write path needs it.
- The 7-day health of 9Router was always `UNKNOWN`. It now reads the
  `usageHistory` table.
- A model could be labelled "confirmed alive" right after a failed (401 or
  5xx) scan, using the stale list. A failed scan now leaves the model
  unverified.
- A missing router database printed only the library message. The error now
  names the file, the standard paths and the environment overrides.
- The database path helpers assumed Windows. They now take `env` and
  `platform` and are unit-tested for win32, darwin and linux.

### Changed
- The CI workflow is now a matrix of ubuntu, macos and windows with Node 22
  and 24, with a separate job for the user-interface tests.
- `.gitignore`, `.gitattributes` and `.editorconfig` were rewritten.
- The repository was cleaned: the agent working state, the internal tooling
  and the internal reports were removed. See `CLEANUP-PLAN.md` in the round
  report.

## [Unreleased]

> Note: `0.1.0` will be the first public npm release, planned for Phase 5. All current work is pre-alpha internal development.

### C11 — Doctor tier labels and guard provider registry
- **Changed:** `routersync doctor` now labels tier A explicitly as "A (models referenced by combos)" and adds `basis: combo-members` to each router in `--json`. This count is the number of models referenced by combos, not the number of enabled models.
- **Added:** 9Router diagnostics include `available` from `readRouterModelState` labelled "available in router"; OmniRoute reports `available: UNKNOWN (reader not implemented)` instead of a misleading zero.
- **Added:** both security guards read the owner's local provider registry and treat non-public names as forbidden patterns with word-boundary matching; public provider codes in `registry/providers.yaml` and the 9Router model snapshot are excluded.

### UI-0 — Local Web UI Slice (ADR-UI-01, ACCEPTED 2026-10-15)
- **New private package `@routersync/ui`:** React 18.3.1 + Vite 5.4.11 + TypeScript strict, pure-CSS design tokens (`src/styles/tokens.css`), self-hosted fonts (`@fontsource/plus-jakarta-sans`, `@fontsource/jetbrains-mono` — no CDN), strict CSP in `index.html` (`default-src 'self'`, no Google Fonts). Isolated vertical slice per ADR-UI-01: no Node built-ins, no Core/Adapter cross-imports; all data flows through the `ApiClient` interface (`MockApi` deterministic in-memory default with the `DỮ LIỆU MẪU` chip; `HttpApi` scaffold targeting `127.0.0.1` for the P3b daemon).
- **Overview screen (concept v5):** light/dark/auto themes via CSS variables, VI/EN i18n with dictionary-key switching, Simple/Detail view modes, emergency-pause banner, agent drawer, first-run checklist state, metric tiles and pipeline view with dashed styling for stale/unverified data.
- **Verification:** `packages/ui/test` covers token contrast, i18n key parity + untranslated-string scan, security/no-external-leakage (CSP, no eval/`dangerouslySetInnerHTML`, MockApi in-memory), honest-state/D26-cap assertions, overview rendering, and screen-to-spec traceability (AT-81). Vitest workspace gained a jsdom `ui` project; root scripts `ui:dev|ui:build|ui:test|ui:preview` and `verify:ui` (ADR-UI-01 §4.4); `tools/ui/at-table.mjs` prints the UI-0 AT matrix. Verified chain on Windows: typecheck PASS, test PASS (15/15 UI test files, 73/73 tests; 42/42 test files repo-wide, 197 passed, 1 skipped [symlink capability check on Windows]), vite build PASS (516.66 kB / 125.43 kB gzip js, 56.02 kB / 29.73 kB gzip css), secret guard clean. Evidence labels: FIXTURE/MOCK, L2, Windows only — CI for macOS/Linux pending (Gate X).
- **Docs:** `docs/adr/ADR-UI-01-stack.md` (stack decision with dependency/license table), `docs/ui/API-CONTRACT.md` (view-model ↔ core domain mapping and target `/api/v1/...` endpoints for the P3b daemon).

### Ranking - Human-chosen tiers, exact-match blacklist, safer interleave default (2026-11-11)
- **Changed:** `isBlacklisted()` now treats a pattern prefixed with `=` as a full-ID equality match (case-insensitive) instead of a substring. Patterns without `=` keep the old substring behaviour, so existing configs are unaffected. Motivation: a substring entry such as `mistral-large` also matched `mistral-large-2-instruct` (a live model), silently removing it from every combo. The 49 exact IDs retired in the 2026-11-10 ranking round use the `=` form (`packages/cli/src/rank/filters.ts`).
- **Changed:** default `interleaving.applyToTiers` is now `[99]` (was `[6, 99]`) in `packages/cli/src/rank/config.ts` (schema default and object default) and in the `applyRankingInterleave()` parameter default (`packages/cli/src/rank/interleave.ts`). With the old default, tier 6 (the human-chosen GLM 5.3 block) was round-robin scrambled by provider on any run that fell back to the built-in config. Only the unrated tail (tier 99) is interleaved now; tiers 1-8 keep the operator-chosen order verbatim. Repo `ranking.yaml` and both `docs/ranking.example*.yaml` were already pinned to `[99]` and remain so.
- **Changed:** `tierRules` is the single source of ranking order - 8 operator-chosen tiers (T1 Claude Sonnet/Haiku 5.5, T2 Claude 4.6, T3 Gemini 4 Argon, T4 Gemini 3.8 Flash, T5 DeepSeek v4.1 Flash, T6 GLM 5.3, T7 Node-B flagships, T8 fallback; unmatched = 99). AI-inferred `modelScores` are no longer the basis for ordering: two live-ordering inversions were found in the previous AI-chosen order (T2 above T1 on 9Router, T5 above T4 on OmniRoute).
- **Verification:** `pnpm typecheck` PASS; `pnpm test --filter @routersync/cli` 42 files / 342 tests pass (2 new regression tests pin the tier-99-only interleave default and tier-6 order preservation; the existing D1 interleave test now declares `applyToTiers: [6, 99]` explicitly instead of relying on the default); `pnpm lint` secret guard clean; `pnpm build` PASS; post-build `rank --router all --dry-run` is 16/16 combos idempotent (steps unchanged, `moved=0`), so the default change does not shift the already-applied live results.

### Phase 3 — Gate L (PARTIAL) & Gate R: 9Router Lab, written-pending-reload, Durable Rollback (In Progress)

#### Gate L (PARTIAL — 4/5 questions answered; Q5 UNVERIFIED)
- **9Router Lab (Spec §33.3, AT-110):** Lab experiment on a DB copy (`DATA_DIR` + second instance on 127.0.0.1, started via the server entry — never the CLI wrapper) answered 4 of the 5 open questions (Q5 dashboard login UNVERIFIED). Root cause of the CL-NINE serving-path failure identified: combos written with `kind='custom'` are filtered out of `GET /v1/models` (served kinds default to `"llm"` for `kind=null`). Label: COPY, Windows 11. See `docs/adapters/9router.md` §13.
- **written-pending-reload (Spec §33.3, AT-109):** `ApplyResult.applyState` added to the adapter SDK. Applies on db-only routers with unconfirmed serving paths return `written-pending-reload` (never `verified`); surfaced in `status`, CLI, MCP `status`, and the MCP `inbox` (system-sourced event). The daemon (P3b) must not count these as success.
- **D26 policy cap:** configs containing a 9Router are capped at `policy.mode` `manual`/`shadow` until the project owner confirms (schema validation, AT-109).
- **kind=NULL write shape + `routersync-` managed marker (AT-111, committed on `integrate/p3-ui`):** the 9Router adapter writes `kind=NULL` (serving-visible), recognizes managed rows via the `routersync-` id prefix, an in-memory session set, and a durable id ledger in the state directory (`managed-ids.json`); the `rs-` prefix was dropped (user-name collisions); legacy `kind='custom'` rows are recognized only for cleanup/rollback. AT-111 verified on lab copy: `kind=NULL` reflects at 19.7–31.2 s (n=3), `kind='custom'` never reflects (0/3 in 90 s). Live writes await owner AT-114 signal under D26.

#### Gate R (In Progress)
- **Durable snapshot store (AT-112):** `packages/core/src/snapshots/store.ts` persists snapshots to the OS state directory (`%LOCALAPPDATA%\routersync` / `$XDG_STATE_HOME` or `~/.local/state/routersync`, `ROUTERSYNC_STATE_DIR` override), refuses secret-looking content, path-traversal-safe ids. `routersync apply --write` persists pre-write snapshots; `routersync rollback <id>` performs a REAL logical row-level restore (T2-28 reopened PARTIAL — the old command only created a snapshot). Missing snapshot id = hard error, never silent success.
- **Explicit isolation flag (AT-113):** `dbPath` no longer disables `/v1/models` probing (silent degradation for Linux/Docker users). Probing is disabled only by the explicit `isolated: true` flag (config or adapter option); both branches tested.
- **no-secrets line-level exemptions:** the guard replaced whole-FILE exemptions (which let real secrets slip) with per-line `no-secrets:allow: <reason>` markers; a marker without a reason is itself a violation.
- **Live-DB safety rail fix:** `getLiveRouterDbs` now parses the nested `db: -> path:` form of `routersync.yaml` (previously only flat `db_path`/`dbPath` — routersync.yaml-declared live DB paths were silently unprotected). Unit tests cover realpath, case, 8.3 names, junction/symlink, hardlink (dev/ino), env vars, routersync.yaml, and the adapter-only write flag.
- **Lab hygiene:** docs/adapters/9router.md §13 carries explicit rules (blur key columns in copies, delete copies immediately, never start via `cli.js` while live runs); skill `local-service-lab-testing` updated with the incident lesson.

### Phase 2 — Multi-Router, CLI & Read-Only MCP (Completed — Gate 0 closed 2026-10-15)
- **Engines & SQLite Driver (Condition A7, AT-100):** Node >= 22.12.0 enforcement (matching commander@15 requirement) and `better-sqlite3@13.0.3` under `SqliteDriver` interface in `@routersync/core`.
- **Structural Schema Fingerprinter (Condition A3, AT-97):** `PRAGMA table_info` allowlist validation preventing writes on unexpected or altered schemas.
- **Safe SQLite Write Protocol (Condition A4):** `BEGIN IMMEDIATE`, `busy_timeout` (5000ms), and WAL concurrency support without lock contention.
- **Serving-Path Read-Back (Condition A5, AT-98):** Support for `full`, `existence-only` (via `/v1/models`), and `db-only (degraded)` read-back tiers with TTL wait.
- **Contract Tests on Real DB Copies (Condition A6, AT-99):** Tests run on isolated copies in `os.tmpdir()`; live DB integrity verified via identical pre/post **logical hash** (canonical JSON of `combos`, timestamps excluded — D25), not a raw file SHA-256.
- **Multi-Router Parallel Apply (Condition B1, AT-4):** Parallel execution via `Promise.allSettled` ensuring individual router failures do not abort or roll back successful peers.
- **Adopt Guard (Condition B2, AT-8):** Preservation of unmanaged manual combos; adopt guard mode exclusively prunes confirmed dead models while strictly preserving manual model order.
- **CLI Commands (Condition A1):** `init`, `scan`, `plan`, `apply`, `rollback`, `status`, `doctor`, and `mcp install`. Default dry-run mode; `--yes` strictly prohibited; `--write` blocks non-TTY execution.
- **Read-Only MCP Server (Condition C1):** `@routersync/mcp-server` exposing 17 read-only inspection and query tools over stdio with ZERO write tools.
- **Cursor-Based Pagination (AT-89):** Default 50, maximum 200 items per page with `next_cursor` tokens.
- **Untrusted String Sanitizer (AT-90):** Strips prompt injection tokens (`<system>`, `[INST]`), redacts secrets, and caps excessive string lengths.
- **Non-Destructive Harness Installer (Condition C2, AT-94):** `routersync mcp install --client hermes|dsh` with dry-run default, non-destructive JSON/YAML patch merging, and rollback support.
- **Doctor Diagnostic (Condition C4, AT-95):** Detects circular dependencies when harness upstreams point to managed routers.
- **Skill Pack (Condition C3, AT-96):** `docs/ai/skill-routersync.md` verified against live MCP tool catalog and CLI commands.
- **Client Key Serving Read-Back (Condition G0-5, AT-101):** Existence-only read-back via `/v1/models` using client credentials, zero secret leakage in logs/snapshots, degraded fallback.
- **Engine Hierarchy Matrix (Condition G0-4, AT-102):** Root engines.node >= all runtime dependency requirements verified across monorepo workspace packages.
- **Targeted Logical Rollback (Condition 2.2, AT-108):** In-place transaction rollback restoring managed combos while strictly preserving concurrent external usage telemetry and unmanaged user combos without database file replacement.

### Phase 1 — Core Sync & Adapters
- Monorepo packages `@routersync/adapter-sdk`, `@routersync/core`, `@routersync/adapter-omniroute`, `@routersync/adapter-9router`, `@routersync/sources`.
- Invariants I1–I8 pure validators, deterministic planner, and Safe Write Protocol.
- Tier 3 SQLite adapters for OmniRoute and 9Router with 0-token health probes.
- OpenRouter and LiteLLM catalog source ingestors.
- Automated acceptance tests AT-1, AT-3, AT-5.


### Phase 0 — Discovery
- Governance layer under `.agent/` implementing Autonomous Project Governance Agent v7.4.
- Core specification import (`.agent/SPEC.md`).
- Repository skeleton, dev tooling, safe HTTP investigation utilities, and no-secrets guard.
- Empirical adapter discovery and compatibility matrix (`docs/compat-matrix.md`).
