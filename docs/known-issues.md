# Known Issues

The following known issues in RouterSync are tracked for users and developers, along with their resolution status and verification suites.

## 1. OmniRoute: `readRouterModelState` returns `availableModels=0` — **Resolved (`M1-02`)**

**Status:** Resolved (`M1-02`)

Previously, `readRouterModelState` in `packages/core/src/domain/model-state.ts` returned an empty `availableModels` set for OmniRoute when `syncedAvailableModels` was empty, causing OmniRoute entries in `routersync apps drift` to be classified as `MISSING` even when `routersync doctor` counted active models from `combos.data.models`.

**Resolution:** `readRouterModelState` merges active OmniRoute `comboModels` into `availableModels` by default while excluding disabled or hidden models (`radar_local_model_state` and `customModels`) and preserving `excludeComboModelsFromAvailability: true` for `routersync combos stale` so combo steps never self-validate. `classifyModelDrift` in `packages/cli/src/apps/drift.ts` aligns OmniRoute `OK`, `DISABLED`, `MISSING`, and `UNKNOWN` verdicts with `availableIds`, `disabledIds`, and `comboIds`.

**Verified in:** `packages/core/test/model-state-omniroute.test.ts`, `packages/cli/test/combos-stale-omniroute.test.ts`, `packages/cli/test/drift.test.ts`.

## 2. Combo names (`9Router-Coder-1`, `OmniRoute-Coder-1`) not found in any read set — **Resolved (`M1-03`)**

**Status:** Resolved (`M1-03`)

Previously, `comboModels` in router state contained only provider model IDs inside combos rather than combo names themselves. When an agent application referenced a bare or router-prefixed combo name (for example `9Router-Coder-1`, `9router/9Router-Coder-1`, `OmniRoute-Coder-1`, or `omniroute/OmniRoute-Coder-1`), `routersync apps drift` did not find it in `availableModels`, `comboModels`, or `customModels` and classified it as `MISSING`.

**Resolution:** `readRouterModelState` in `packages/core/src/domain/model-state.ts` populates `comboNames` on `RouterModelState` from `combos` rows (`name`, non-array JSON `name`, or fallback `id`). `buildRouterView`, `driftKindOf`, `classifyModelDrift`, and `checkIdFormatMismatch` in `packages/cli/src/apps/drift.ts` merge `state.comboNames` into `view.comboNames` and classify matching bare and router-prefixed combo names as `status: 'OK'` with `kind: 'combo'` ahead of single-model `disabledIds` checks, while keeping non-existent combo references as `MISSING`.

**Verified in:** `packages/core/test/model-state-omniroute.test.ts`, `packages/core/test/model-tiers.test.ts`, `packages/cli/test/drift.test.ts`.

## 3. 9Router `0.5.123`: `stream=true` requests omit `usageHistory` rows — **Mitigated Client-Side (`W2`)**

**Status:** Mitigated Client-Side (`W2`, PR #67 `dd3407b`)

On `9router@0.5.123` with `ponytailEnabled=true` (observed in C43 `R1` and C44 `W1`/`W3`; see `docs/9router-combo-findings.md`), streaming `POST /v1/chat/completions` (`stream: true`) responses return `HTTP 200 OK` while frequently writing `0` rows to 9Router's `usageHistory` SQLite table (`W3`: `sent=3`, `usageHistory=0`; `W1`: `sent=3`, `usageHistory=1`). Any budget or quota guard that relied solely on `usageHistory` row counts could therefore undercount free-tier consumption during streaming probes.

**Resolution:** `RequestBudget`, `recentQuotaSteps`, and `reconcileSentVsUsage` in `packages/cli/src/commands/combos-budget.ts` and `packages/cli/src/commands/combos-probe.ts` enforce `--budget <n>` and 30-minute `SKIPPED-QUOTA` cooldowns (`#<attempt>` suffix stripping and combo-mode `http=429` + `quota=1` matching) strictly from client-sent HTTP requests, guard empty-key regex replacement in `packages/cli/src/commands/combos-reliability.ts`, and print explicit reconciliation at run end (`đối chiếu usage: sent=<N> usageHistory=<M> lệch=<N-M>`).

**Verified in:** `packages/cli/test/combos-budget.test.ts`, `test/agent/c44-track-w.node.test.mjs`.

## 4. External-CWD Tier-0 `tick` / `tick_if_due` Handoff, Custom-Node Alias Catalog Lookup & Unverifiable Provider Telemetry — **Resolved (`RS-FIELD-01..03`)**

**Status:** Resolved (`RS-FIELD-01`, `RS-FIELD-02`, `RS-FIELD-03`)

During external-scheduler Tier-0 `observe` runs outside the repository working directory, three interactions affected telemetry and freshness gating: (1) `tick_if_due` acquired `<stateDir>/tick.lock` in the parent process and spawned a detached `routersync tick --mode observe` child that rejected its own inherited lock under non-reentrant lock checks (`RS-FIELD-01`); (2) `findProviderRegistryFile`, `findGatewaysFile`, and `readRegistrySources` searched only relative to `process.cwd()`, missing shipped `registry/*.yaml` files when invoked from an external directory (`RS-FIELD-02`); and (3) `readDirectRouterModelsFor` checked only `getProviderAliases(prefix)`, omitting `ProviderTarget.id` custom-node connection identifiers and `canonicalPrefix(prefix)` aliases so router-only models triggered false `COMBO_MODEL_MISSING_FROM_CATALOGS` (`high`) alerts instead of `PROVIDER_ROUTER_LIST_MISMATCH` (`warn`) (`RS-FIELD-03`).

**Resolution:** `tryAcquireTickLock` accepts an optional positive-integer `handoffParentPid` (passed via `ROUTERSYNC_LOCK_HANDOFF_PARENT_PID` from `tick_if_due` to `runTickCommand`) to adopt alive non-stale parent/child handoff locks while keeping strict in-process non-reentrancy when `handoffParentPid` is omitted. `findProviderRegistryFile`, `findGatewaysFile`, and `readRegistrySources` walk up from `cwd` first (preserving synthetic test fixtures) and fall back to `import.meta.url` for shipped `registry/{providers,gateways,sources}.yaml` while `findLocalProviderRegistryFile` never walks up (preserving Security Condition Z1). `readDirectRouterModelsFor` unions lowercased aliases across `prefix`, `canonicalPrefix(prefix)`, and `ProviderTarget.id` across all call sites. Separately, during read-only `observe` runs, providers with unconfigured, OAuth-managed, or encrypted upstream credentials (`no-key`, `oauth-router-managed`, `key-encrypted`) are expected to report `PROVIDER_ERROR_OR_UNVERIFIABLE_HIGH` in `field-report` while remaining protected by the `UNVERIFIABLE != ABSENT` invariant (zero model removals proposed).

**Verified in:** `packages/core/test/c51-rs-field-01-lock-handoff.test.ts`, `packages/mcp-server/test/c51-rs-field-01-tick-if-due-real-spawn.test.ts`, `packages/cli/test/c51-rs-field-02-03.test.ts`.

## 5. Two host-only test failures on the project owner's machine (C52-R3) — **Documented, not a regression**

**Status:** Documented (`C52-R3`); CI `main` stays green (18/18 checks on PR #89).

A full local `pnpm test` on the project owner's Windows host reported `Test Files 2 failed | 255 passed (257)` and `Tests 2 failed | 2022 passed | 1 skipped (2025)`. The same suite is green in CI. Both failures are properties of that host, not of the code:

1. `test/agent/security-audit.node.test.mjs:264:3` — "real repository repo-files and evidence-refs pass with 0 HIGH findings", invoked by `test/docs/agent-docs.test.ts:506`. Assertion error: `Unexpected findings on real repo` with four HIGH findings (`SEC-0001`..`SEC-0004`, rules `personal-windows-path` + `os-username`) at `evidence/router-patch:evidence/C37/NOTE.md:7` and `evidence/router-patch:evidence/C37/REPORT.md:6`. Cause: a stale local `evidence/router-patch` git ref from an older campaign still contains an unredacted host path and OS username; CI checks out only clean refs, so CI passes. Decision: document here and redact or prune that stale **local** evidence ref on the host; do not weaken the audit or commit the old evidence into `main`.

2. `packages/cli/test/c49-t5-rehearsal-and-secrets.test.ts:126:3` — "simulates 7 days of scheduled ticks, catches all 5 planted anomalies on Days 2-6, and emits 0 anomalies on normal Days 1 & 7". Error: `Test timed out in 60000ms`. Cause: host free RAM was measured at 0.5-1.17 GiB; running the whole suite with a reduced worker count stretched this 7-day simulated rehearsal past its 60 s default timeout. Re-running only that file on the same host passed `2/2` in ~48 s with no code change. Decision: document here; CI runners have sufficient memory. No production code or timeout constant was changed.

**Verified in:** local full-suite run on the host (2026-11-28), isolated re-run of `c49-t5-rehearsal-and-secrets.test.ts` (`EXITCODE=0`, 2/2), and CI check runs for PR #89 (18/18 `success`).
