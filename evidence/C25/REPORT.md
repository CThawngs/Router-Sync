# REPORT — C25 + Phụ lục P0–P3

**Date:** 2026-11-20 **Status:** B0/B1/B2 + P1.1 XONG; P1.2 MỘT PHẦN (diagnostic added); B3/B4/B5 CHƯA LÀM; B6 gói XONG.
**Main tip:** 4308465 (PR #31 squash-merged). Code changes for this round are in the working tree, not yet committed to main.

## Record IDs (all from capture.mjs; see records.jsonl)
- `c25-b0-1` exit 0 — real ci-watch on run 44699916948 (ARM node 24 masked).
- `c25-b1-tests` exit 0 — 3/3 prepush e2e tests pass.
- `c25-b1-mutation` exit 1 — mutant (base diff = HEAD) makes 2/3 e2e tests red; sha256 of mutant `tools/ci/related-tests.mjs` = `32c539507d69417676d564461b4104e8127b8cdb3065817b67a8f1ab492415e9`.
- `c25-b2-tests` exit 0 — 5/5 ci-stats pure tests pass.
- `c25-b2-stats` exit 0 — real stats, fixed window 2026-11-17+.
- `c25-p11-tests` exit 0 — 2/2 ARM regex guard tests pass.

## B0 — ci-watch masked unconditional, no cross-job log fallback — XONG
- `summarize`: masked regardless of run conclusion; unknown when no job log; `exitCodeFor` unknown → 12.
- `watch`: dropped `failedStepLog` fallback; jobs API has no `continue_on_error`, mask by `^verify \(windows-11-arm, node \d+\)$` derived from ci.yml.
- Real run 44699916948: exit 0, `failure masked verify (windows-11-arm, node 24)` + MASKED line.
- Mutation (revert to `runConclusion !== 'success'`): sha `6dfc7141b976b0428fb085c31b62b18d25a236ec04e2273e71a6dde73dc27423`, test (a) red.

## B0.5 / P1.2 — ARM node 24 red — MỘT PHẦN
- Run 44699916948: `AssertionError: expected true to be false` at `test/acceptance/at-98.test.ts:309` (`res.success` true, expected false), Test Files 1 failed | 153 passed.
- 11 red ARM24 runs from 2026-11-17: 44699916948, 44667946979, 44653292341, 44583793409, 44459910287, 44451261077, 44304344459, 44303476138, 44299640069, 44297272360, 44294930936. Failing steps: Run Tests (4), Build (3), Product smoke (3), Typecheck (1), Guard (1).
- Second assertion family: `expected [ 'combos', 'combos stale' ] to deeply equal []` — not in the current `test/` tree (older run 44304344459/44303476138).
- Diagnosis at line 309: adapter writes combo into DB then reads back via `verifyApiReadBack` (admin key present) or degraded db-only path. When read-back verifies the written id, `res.success` is true; expected false requires the API fixture to lack `unmatched-combo-id-999`. Flakiness is consistent with a read-back level that differs by environment (env keys present/absent), not proven. **Did not weaken assertion**; added a diagnostic message printing `readBackLevel`, `staleDetected`, `error`, `degradedReason`, fixture ids.

## P1.1 — regex guard — XONG
- `validate-workflows.mjs`: reads `MASKED_JOB_NAME_RE` from ci-watch.mjs, expands every `continue-on-error` matrix job from ci.yml and checks the regex matches exactly the ARM jobs. Test + mutation covered (`c25-p11-tests`).

## B1 — prepush e2e — XONG
- New `test/agent/prepush-e2e.node.test.mjs`: throwaway git repos with `refs/remotes/origin/main` one commit behind HEAD; red test commit → `related-tests` exits non-zero; docs-only → exits 0; source diff → `--list` selects `src/calc.ts`.
- Mutation: base diff → HEAD (no selection) → 2/3 red (`c25-b1-mutation`). Reverted.
- `pnpm lint` clean (559 files).

## B2 — ci-stats with honest labels — XONG
- New pure `tools/agent/ci-stats-core.mjs` + 5 tests; Dependabot separated by event AND branch; CI workflow wins per commit; pending runs excluded and counted; UNKNOWN STEP no longer labelled infra; fixed window 2026-11-17 + from-C20 column.
- Real numbers (`c25-b2-stats`): window since 2026-11-17, runs=125, uniqueSha=80; push CI green first attempt 21/25; our commits 43/80 (54%); pending 0; dependabot separated 44; red classified code=12 infra=2 **unknown=17**; from C20 (d8233ba) 22/32. No target-comparison text.

## B3 — old red main runs — CHƯA LÀM
- 8363c5b run 44505928291 (CI push failure, job `verify (macos-latest, node 22)`, step Run Tests, log shows UNKNOWN STEP → no reliable evidence → UNKNOWN).
- 6f8163b run 44142540329 (CI push failure, C24 recorded empty evidence → UNKNOWN).
- 84bb148 run 44194025479 (dynamic/Dependabot, excluded from our stats; UNKNOWN STEP).

## B4 — CLI startup measurement — CHƯA LÀM
- RAM history from C24 records: freeStart 1892–2699 MB, freeMin 1892–2114 MB. Preflight at C25 start: 1.39 GiB (LIGHT-DEV, below 1536 MB gate) → heavy build/suite forbidden. Later preflight: 3.64 GiB FULL, but the six scratch builds × 20 samples each were not run within this round; no p50/p95 claimed.

## B5 — official catalog for `combos stale --source official` — CHƯA LÀM
- Read-only step: 9Router DB path is not configured in this checkout (no config.yaml; `ROUTERSYNC_9ROUTER_DB` unset). Cannot enumerate provider rows without touching the real router; stopped as instructed. No product code written.

## B6 — package — XONG
- 10 files in `evidence/C25/`: REPORT.md, records.jsonl, records/ (6 *.out.txt), verify-records.out.txt, ci-summary.json.
- `verify-records.mjs` canonical: **SẠCH: 6 dòng** (UTF-8 output written by Node, not PowerShell `>`).
- `tools/agent/verify-package.mjs`: 6 records, no fake records, no personal identifiers.
- Guard scan of package: 7 private names, **0 matches**. `command` fields mask `C:\Users\<name>` → `<USER_DIR>`.

## PR / CI
- PR #31 (head `44406afa52157b680536bfba33aa0265f80d8ef7`) squash-merged → `430846591393634dc51d4f7b74382ded6d4f731a`.
- CI on head: run 44699916948 conclusion `success` (17/18 checks pass; `verify (windows-11-arm, node 24)` allowed fail).
- Evidence branch: `evidence/c25` (no PR, no merge to main).

## UNKNOWN / not done
- B3 log-expired classification; B4 startup p50/p95; B5 public catalog; OmniRoute reader; apps drift; Notion; node:sqlite adapter.
