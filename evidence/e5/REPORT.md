# C49 Evidence Package Report

## Status
`READY_FOR_OWNER_FIELD_TEST`. C49 T1–T5, independent QA on PR #86 and PR #87, both squash merges into `main`, first-attempt green `main` CI on the final head, and this `evidence/e5` package are verified. No live router DB/API, live harness config, or real owner state directory was written.

## Scope (T1–T5)
- **T1 (`routersync field-report`)**: Strictly read-only CLI command (`0` network calls; zero mutation / unchanged `mtime` on `<stateDir>` and config), canonical `--out <dir>` safety guard outside `<stateDir>`, bundle capped at `<= 8` files (`summary.json`, `timeline.jsonl`, `providers.json`, `models.json`, `anomalies.json`, `resources.json`, `config-shape.json`, `README.md`), and mandatory 2-stage sanitization (Stage-1 Scrubber + Stage-2 Independent Pre-Write Scanner with all-or-nothing refusal).
- **T2 (`anomalies.json`)**: Purely data-measured detector implementing all 8 canonical codes (`MODEL_FLAPPING`, `PROVIDER_ERROR_OR_UNVERIFIABLE_HIGH`, `SCAN_COUNT_INTERVAL_DRIFT`, `TICK_DURATION_SLOW`, `COMBO_SHRINK_CAP_BLOCKED`, `VACUOUS_DETECTION`, `PROVIDER_ROUTER_LIST_MISMATCH`, `COMBO_MODEL_MISSING_FROM_CATALOGS`), each referencing measured `metrics`, `timeline.jsonl` event IDs (`evidence`), and `sourceFile`.
- **T3 (`docs/runbook/FIELD-TEST-LADDER.md`)**: Vietnamese owner runbook (`70` lines `<= 100`), 4 owner-controlled rungs (Rung 0 Observe -> Rung 1 `rs-pilot` -> Rung 2 per-combo `propose` -> Rung 3 `auto-safe` with `routersync freeze`), PowerShell & Bash blocks verified by `c46-f3-doc-cli-sync`.
- **T4 (`docs/runbook/FIELD-FINDINGS.md`)**: Vietnamese triage runbook (`58` lines), 3 anomaly classification buckets (`ROUTERSYNC_BUG`, `UPSTREAM_PROVIDER_OR_ROUTER`, `UNDOCUMENTED_VALID_BEHAVIOR`), Red-First reproduction ticket template, and findings summary table.
- **T5 (7-Day Rehearsal & 10-Secret Suite)**: Hermetic `os.tmpdir()` rehearsal (`28` ticks, `4`/day across Days 1–7) plus 10 distinct secret/PII patterns tested against Stage-1 scrubbing and Stage-2 pre-write blocking.

## T5 Seven-Day Rehearsal & 10-Secret Verification
All 5 planted anomalies across Days 2–6 were detected with valid `timeline.jsonl` references and `sourceFile` provenance; normal Days 1 and 7 reported `0` false positives. All `10/10` secret/PII classes (provider API keys, PATs, Bearer JWT, password hashes, credentialed URLs, Windows/POSIX personal paths, OS username, and machine hostname) yielded `0` leaks across all 8 files in Stage-1 and triggered Stage-2 refusal (`exitCode = 1`, `0` files written) when Stage-1 was bypassed.

| Day | Planted condition | Detected `anomalies.json` code | `timeline.jsonl` & `sourceFile` |
| --- | --- | --- | --- |
| Day 1 & Day 7 | Healthy baseline ticks | `0` anomalies (zero false positives) | Normal ticks only |
| Day 2 | Model absent then present | `MODEL_FLAPPING` | `evt-0001..evt-0003` (`tick-catalog.json`) |
| Day 3 | Provider HTTP `429` burst | `PROVIDER_ERROR_OR_UNVERIFIABLE_HIGH` (`429`) | `evt-0002..evt-0003` (`tick-catalog.json`) |
| Day 4 | Sustained provider HTTP `405` | `PROVIDER_ERROR_OR_UNVERIFIABLE_HIGH` (`405: 4`) | `evt-0001..evt-0004` (`tick-catalog.json`) |
| Day 5 | Slow tick (`45000 ms`) | `TICK_DURATION_SLOW` | `evt-0003` (`tick.log`) |
| Day 6 | 10% shrink cap blocks removal (`2/10`) | `COMBO_SHRINK_CAP_BLOCKED` | `evt-0001..evt-0004` (`plans/tick-plan.json`) |

## Captured Verification Records
`capture-evidence.mjs` created these real records on `34190c9fbd290b6e76cbde154176b946046ab5cc` after `pnpm build` (`9/9` packages) and masked output before SHA-256 hashing:

| Record | Command scope | Result | Duration |
| --- | --- | --- | ---: |
| `c49-t1-t2-field-report-anomalies` | `c49-t1-t2-field-report.test.ts` + `wp9-live-check.test.ts` | Exit 0, 2 files, 18/18 tests | 35.0 s |
| `c49-t3-t4-t5-rehearsal-and-runbooks` | `c49-t5-rehearsal-and-secrets.test.ts`, `c49-field-runbooks.test.ts`, `c46-f3-doc-cli-sync.test.ts`, `agent-docs.test.ts` | Exit 0, 4 files, 34/34 tests | 39.2 s |

Each record loaded `12` effective private-name/path patterns (`guard=4`, `effective=12`). `records.jsonl` stores exact output digests and byte counts; paired `.out.txt`/`.err.txt` captures are included (`7` files total `<= 10`).

## Independent QA & Mutation Gates
- **PR #86 (C49 T1–T5)**: Engineer Red-First `3/3` test files -> `16/16` green, `11/11` Engineer mutations (`M1..M11`) KILLED. Independent QA clean clone (`2887f619c44fdd82d9e159f27d4e0357cb0d3e27`): build `9/9`, typecheck `0` errors, `pnpm lint` `748` files clean, `scan-private-names.mjs --file` `0` across all 15 C49 files, `102/102` tests + `17/17` security-audit PASS, `6/6` adversarial probes (`P1..P6`) PASS, `9/9` QA mutations (`QA-M1..QA-M9`) KILLED (`0 P0`, `0 P1`).
- **PR #87 (Surgical `wp9-live-check.test.ts` Race Fix)**: Engineer Red-First (`exit 1` -> `12/12` `exit 0`), `2/2` Engineer mutations (`M1..M2`) KILLED, `pnpm prepush` PASS. Independent QA clean clone (`0bcde653c84714b38144ea95d236f516ddcdff24`): `89/89` parallel CLI tests PASS, 12x concurrency stress probe PASS, `5/5` QA mutations (`QA-M1..QA-M5`) KILLED (`0 P0`, `0 P1`, `0 P2`).

## GitHub CI and Merge History
- **PR #86**: https://github.com/CThawngs/Router-Sync/pull/86 (`feat/c49-field-report`, head `2887f619c44fdd82d9e159f27d4e0357cb0d3e27`)
  - PR CI run `45964971223`: `attempt=1`, `ci-watch.mjs` exit 0 (`8/8` required checks pass; `windows-11-arm, node 22` masked `continue-on-error`).
  - Squash-merged as `d74b7b121be781fec5f27261c581184d14a88e48`.
  - Post-merge `main` CI run `45983429811`: `attempt=1` failed `verify (windows-latest, node 22)` (`17/18` passed) due to a pre-existing global `os.tmpdir()/rs-livecheck-*` race in `packages/cli/test/wp9-live-check.test.ts:318`. Per C49 §4 hard gate, no CI rerun was triggered; owner authorized surgical fix PR #87.
- **PR #87**: https://github.com/CThawngs/Router-Sync/pull/87 (`fix/c49-livecheck-tmpdir-race`, head `0bcde653c84714b38144ea95d236f516ddcdff24`)
  - PR CI run `45994407439`: `attempt=1`, `18/18` checks SUCCESS (`ci-watch.mjs` exit 0).
  - Squash-merged as `34190c9fbd290b6e76cbde154176b946046ab5cc`.
  - Post-merge `main` CI run `45997626193`: `attempt=1`, **`18/18` checks SUCCESS** (`ci-watch.mjs` exit 0, zero reruns).

## Limits
No live router/harness write, real owner data export, consent change, git tag, `npm publish`, or force-push was performed. Live field testing on real project data begins at Owner Rung 0 per `docs/runbook/FIELD-TEST-LADDER.md`.
