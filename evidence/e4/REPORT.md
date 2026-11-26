# C48 Evidence Package Report

## Status
`READY_FOR_OWNER_LIVE_PILOT`. C48 H1–H4, independent QA, the merged PR, first-attempt main CI, and this evidence package are verified. The owner-only live pilot was not run; no live router or harness state was written.

## Scope
- Measurement: `detectionLatencyMs` records detection latency from the first qualifying scan. `removalSettleMs` independently records time to verified removal settlement.
- Safety: synthetic or unverifiable evidence cannot produce live sign-off; removal eligibility is checked per model, provider, target, and episode; default-slot and shrink-cap protections fail closed.
- Lifecycle: unresolved episodes retain their anchors; official evidence lineage survives updates and verified rollbacks; multi-target episodes close only after all targets settle.
- Retention: terminal history follows the 30-day policy and 500-record hard cap; unresolved evidence is preserved.
- Operations: `--pilot-started-at` supports a separate pilot window when state directories are shared.

## H2 Five-Case Fixture Results
All five cases are covered by `packages/cli/test/c48-h1-h2-latency-settle.test.ts`; the captured suite passed 38/38 tests.

| Case | Expected outcome | Verified assertion |
| --- | --- | --- |
| 1. Three valid absence scans over 48 hours | PASS | `detectionLatencyMs = 180 ms`; one removal; zero false removals; `removalSettleMs` is within `[172,800,000, 172,805,000)` ms; fixture rollback verified. |
| 2. Removal 1 ms before the 24-hour floor | FAIL | The injected fixture is `86,399,999 ms`; the early removal evidence fails the gate. |
| 3. Synthetic official notice | Live sign-off FAIL | Isolated rehearsal removes only the fixture model; report contains `SYNTHETIC_OFFICIAL_NOTICE`, with detection measured at `90 ms`. |
| 4. No detection samples | INCOMPLETE / VACUOUS | Exit 1; measured count is `0`, `maxMs` is `null`, and the report blocks on `VACUOUS`. |
| 5. Detection above the 60-second limit | FAIL | `detectionLatencyMs = 65,000 ms`; Criterion 3 fails. |

## Captured Verification Records
`capture-evidence.mjs` created these records and masked output before hashing:

| Record | Command scope | Result | Duration |
| --- | --- | --- | ---: |
| `c48-h1-h2-latency-and-lifecycle` | C48 H1/H2/lifecycle suite | Exit 0, 38/38 tests | 157.6 s |
| `c48-loop-automation-and-docs` | WP3, WP4, C46-F3 doc sync, agent docs | Exit 0, 4 files, 34/34 tests | 60.8 s |

Each record loaded 12 effective private-name patterns. `records.jsonl` stores output digests and byte counts; paired stdout/stderr captures are included.

## Independent QA
QA V3 returned `PASS` on a clean scratch clone of the exact 16-file diff. All 14 adversarial probes passed. The exact baseline mutation sweep killed 15/16; the remaining Step-2 mutation was shown equivalent under defense-in-depth and killed by QA's custom-gateway probe. All 6 new-code mutation guards were killed. Scratch and primary hashes had zero mismatches.

## GitHub CI and Merge
- PR #85: https://github.com/CThawngs/Router-Sync/pull/85
- PR head: `6f82dd215c064d769a20e1c05be52651698bcc4f`
- Merge commit: `057ba882fc7e71b3f6c4c5b2b02dfd8ea66d3f6c` (squash merge)
- PR CI run `45896168200`: attempt 1, 18/18 checks successful.
- Main CI run `45897162185`: attempt 1, 18/18 checks successful.
- Infrastructure failures and reruns: none; first-attempt green rate was 100% for both runs.

## Local Verification
- `pnpm verify:release`: PASS; 208 test files, 1,683 passed, 1 skipped; E2E 13/13; typecheck, lint, and build passed.
- `pnpm prepush` on the PR head: PASS; 149 related test files, 1,233 passed, 1 skipped; lint, changed-package typechecks, and workflow validation passed.

## Limits
No live router/harness apply, consent change, npm publish, or tag creation was performed. The owner-only live pilot remains pending.
