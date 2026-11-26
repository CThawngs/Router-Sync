# C47 Evidence Report — `evidence/e3` (`Serves: S9`)

## 1. Scope, Anchors & Gate Posture

- **Repository:** `https://github.com/CThawngs/Router-Sync`
- **Branch:** `origin/evidence/e3` (branched from `origin/main` @ `0ce85d980b58e44942d1769a12da39f6ec017a00`)
- **PR #84 (`C47`):** [`#84`](https://github.com/CThawngs/Router-Sync/pull/84) (`fix(pilot): verify rollback and detection evidence for C47 (S9)`), PR head `381700feff1cb4070b61e2af240ee427589e5585`, squash-merged to `main` @ `0ce85d980b58e44942d1769a12da39f6ec017a00`.
- **5-OS CI Proof (`attempt=1`, zero retries):**
  - PR CI Run [`45745773361`](https://github.com/CThawngs/Router-Sync/actions/runs/45745773361): `18/18 SUCCESS` (`attempt=1`, head `381700feff1cb4070b61e2af240ee427589e5585`).
  - Post-merge `main` CI Run [`45746982126`](https://github.com/CThawngs/Router-Sync/actions/runs/45746982126): `18/18 SUCCESS` (`attempt=1`, SHA `0ce85d980b58e44942d1769a12da39f6ec017a00`).
- **Independent QA Sign-Off (P2 on PR head `381700fe`):** `https://app.notion.com/p/4243c98ee3238146bd14e4fd91ea2311`.
- **Prior Baseline & Tracking:** `origin/evidence/e2` (`710a7a90eecaec87ff5bb4aef77a7b9181926592`); C47 Notion task `https://app.notion.com/p/4243c98ee32381fa96b9eacab06a14e7` (CEO updates post-closure).
- **Hard Guardrails & Non-Readiness Disclaimer:** `0` real router/harness writes, `0` `npm publish`, `0` tags beyond `v0.1.0`, `0` `PATCH_V3`, `0` code/threshold edits, `0` pushes to `main`, `0` PRs on `evidence/e3`, `[skip ci]`. Ops does **not** assert owner live-pilot readiness on behalf of CEO; CEO must separately review whether the absence-only G2 path still blocks under project-owner requirements.

---

## 2. G1 — Verified Rollback & Honest Incident/Latency Reporting

Verified in `Record 1` (`packages/cli/test/c46-f6-pilot-report.test.ts`, `15/15` passed):

- **Rollback Required:** Apply receipts alone (`rolledBack: false`) leave `rollbackByteExactMatch.matched=false` -> `INCOMPLETE` (`exitCode=1`); `PASS` requires `rollbackVerified === true` (digest match) on every scoped target.
- **Three Distinct Reporting States (No Silent Pass):**
  1. **`VACUOUS` (`measuredCount=0, maxMs=null`):** Returns `INCOMPLETE` (`exitCode=1`, detail contains `VACUOUS`). Only passes if `--accept-vacuous-detection` is explicitly supplied (`acceptedVacuous=true`, warning printed in report `warnings[]`).
  2. **Missing Owner Counts (`source: "missing"`):** Omitting `--false-removals` or `--unplanned-interventions` (without derived removal/incident evidence) yields `count: null, manualReportedCount: null, source: "missing"` -> `INCOMPLETE` (`exitCode=1`).
  3. **Explicit Zero (`source: "owner-attested"`) vs Derived (`source: "derived"`):** Passing `--false-removals 0 --unplanned-interventions 0` sets `source: "owner-attested", manualReportedCount: 0` (`PASS`). Successful `auto-safe` removals persist `removedModels[].inProviderCatalog`; `inProviderCatalog: false` yields derived `falseRemovals=0`, while `inProviderCatalog: true` yields derived `falseRemovals=1` -> `FAIL`.

---

## 3. G2 — 10-Model Rehearsal Matrix (Simulated Clock, Zero Threshold Changes)

Captured verbatim from `C47_PILOT` stdout lines in `Record 1` (`comboSize=10`, `rs-pilot`, `1/10 = 10%` shrink cap, `simulatedClock=true`, `0` code/threshold changes):

| Scenario | Ticks | Removal Timing | `removedModelCount` / `falseRemovals` | `measuredCount` / `maxMs` | `verifiedReceiptsCount` (Targets vs Receipts) | Verdict (`exitCode`) |
|---|---:|---|---|---|---|---|
| **`steady`** | `2` | Unchanged catalog (`0` removals) | `0` / `0` (`owner-attested`) | `0` / `null` (`VACUOUS`) | `2` receipts (`1` router + `1` harness) / `2` targets | **`INCOMPLETE`** (`1`) |
| **`absence-only`** | `5` | Tick 1 pending (`graceAbsent`); tick 2 = `0` removals; tick 3 at `+24h` removes `1` model | `1` / `0` (`derived`, `0` false) | `1` / `86400000` ms (`> 60000`) | `3` receipts (`2` router [propose+auto-safe] + `1` harness [propose]) / `2` targets | **`FAIL`** (`1`) |
| **`official-notice`** | `4` | Separate synthetic official deprecation notice (`-50 ms`): tick 1 pending; tick 2 removes `1` model | `1` / `0` (`derived`, `0` healthy removed) | `1` / `50` ms (`<= 60000`) | `3` receipts (`2` router [propose+auto-safe] + `1` harness [propose]) / `2` targets | **`PASS`** (`0`) |

- **Rollback Proof (All 3 Scenarios):** Router `rs-pilot` combo rows restored to pre-apply snapshot and harness YAML matched pre-apply SHA-256 (`harnessShaMatched=true`). Receipt counts strictly distinguish `criteria.rollbackByteExactMatch.verifiedReceiptsCount` (`2` in `steady`; `3` in `absence-only` & `official-notice` because router rollback verifies both the `propose` and `auto-safe` receipts on `router:nine/rs-pilot` alongside `1` `propose` receipt on `harness:hermes`) from the `2` pilot targets (`router:nine/rs-pilot`, `harness:hermes`).

---

## 4. G3 & G4 — Checklist Syntax & Approval-Gate Provenance

- **G3 (`docs/runbook/OWNER-CHECKLIST.md`):** `120` content lines (`121` split lines `<= 130` ceiling). `Record 2` (`test/docs/c46-f3-doc-cli-sync.test.ts`, `5/5` passed) validates doc-CLI sync, paired PowerShell/Bash steps, 10-model `rs-pilot`, `>=15m` scan spacing, `>=24h` absence rule, snapshot combo-row check, and harness SHA-256 check. Independent shell parser check on this checkout: PowerShell AST (`24/24` commands, `0` errors) and Git Bash `bash -n` (`24/24` commands, `0` errors).
- **G4 — Automated Non-TTY & Guard Regressions (`Record 2`):** `packages/cli/test/c46-f2-live-gate-hint.test.ts` (`4/4` passed) spawns built `packages/cli/dist/index.js` with piped stdin on an isolated outside-`os.tmpdir()` fixture (`ROUTERSYNC_ALLOW_LIVE_HOME_WRITE=1`) and verifies fail-closed refusal (`exit 1`, `0` byte mutations, no `.routersync.bak`) for non-TTY (`TTY_REQUIRED`), missing consent (`CONSENT_REQUIRED`), and protected runtime files `bots.json` & `routines.json` (`OpenMausBot safety guard`).
- **G4 — Real Windows TTY Provenance (Explicit Source Note):** CEO separately witnessed real Windows interactive TTY execution on a synthetic fixture confirming that a wrong reply aborts with `0` writes and the exact confirmation word writes & emits an `interactive-tty` receipt. **Disclosure:** the original Windows TTY terminal transcript from CEO's interactive run is **not** attached in `evidence/e3/` (not replayed or fabricated in this non-TTY checkout).

---

## 5. Captured Artifacts & Full 5-Surface Security Audit (`evidence/e3/records.jsonl`)

Built sequentially (`pnpm -r --workspace-concurrency=1 build`, `CI` & `RS_FORCE_HEAVY` unset) and captured via `tools/agent/capture-evidence.mjs` (`privateNamesLoaded=12`, `0` post-capture byte edits):

| # | Record ID | Command (`SAFE_VERBS`) | Exit | Duration | Verified Outcome | `stdout` SHA-256 (12) | `stderr` SHA-256 (12) |
|---:|---|---|---:|---:|---|---|---|
| 1 | `c47-g1-g2-pilot-report-and-loop` | `pnpm test:file packages/cli/test/c46-f6-pilot-report.test.ts packages/cli/test/wp3-research-loop.test.ts` | `0` | `44458 ms` | `2/2` files, `21/21` tests (`15` pilot-report G1/G2 + `6` wp3 loop) | `10800573604b` | `6cd035decdec` |
| 2 | `c47-g3-g4-checklist-and-approval` | `pnpm test:file packages/cli/test/c46-f2-live-gate-hint.test.ts test/docs/c46-f3-doc-cli-sync.test.ts` | `0` | `28896 ms` | `2/2` files, `9/9` tests (`4` F2/G4 child CLI + `5` G3 doc-CLI sync) | `9c6b1a22c5f9` | `83b6a4c2cac6` |
| 3 | `c47-security-audit-networked` | `node tools/agent/security-audit.mjs --with-ci-logs --json` | `0` | `225653 ms` | Full `5/5` surfaces (`0` skipped): `ok=true`, `0/0/0`, `repoFiles=737`, `evidenceRefs=29` (`1208` blobs), `tarballs=8`, `ciLogs=10` `main` runs (incl. `45746982126`), `writeGates 5/5, 5/5, 2/2` | `36e01ad7ac89` | `e3b0c44298fc` |

---

## 6. Pre-Push Verification Gate (`9` Files `<= 10`, `REPORT.md <= 120`, `NOTE.md <= 40`)

1. `node tools/agent/verify-records.mjs evidence/e3/records.jsonl evidence/e3` -> `SẠCH: 3 dòng` (`exit 0`)
2. `node tools/agent/verify-package.mjs evidence/e3` -> `OK` (`3` records, `privateNamesLoaded >= 4`, `0` personal identifiers)
3. `node tools/guard/no-secrets.mjs` -> `0` findings (`exit 0`)
4. `node tools/guard/no-personal-paths.mjs` -> `0` findings (`exit 0`)
5. Per-file `node tools/agent/scan-private-names.mjs --file <each file in evidence/e3/*>` (`9/9` files = `0`) & `scan-private-names.mjs origin/main HEAD` (`0` delta).
