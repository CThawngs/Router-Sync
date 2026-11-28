# C50 Evidence Package Report

## Status
`READY_FOR_OWNER_FIELD_TEST`. C50 tickets K1–K3, independent QA Strike-2 (`GO`), squash-merge of PR #88 into `main`, first-attempt `18/18` green `main` CI, and this `evidence/e6` package are verified. No live router DB/API, live harness config, or real owner state directory was touched.

## Scope & Architectural Decision (Option B vs Option A)
- **Evaluated Option A**: Strip all free-text diagnostic strings from `field-report`, keeping only counters, status codes, and enums. Rejected because dropping local `inbox.json` bodies, `tick.log` notes, `freeze.json` reasons, and `config-shape.json` labels blinds Tier-0/Tier-1 triage (`S9`/`S10`).
- **Chosen Option B**: `providers.json` already persists `0` raw upstream HTTP error bodies (structured telemetry only). Local triage diagnostics across `inbox.json`, `tick.log`, `freeze.json`, and `config-shape.json` are retained and protected by **2 strictly independent stages**:
  - **Stage 1 (`field-report-scrubber.ts`)**: Sensitive key-name scrubbing (with array parent-key propagation), literal env/config-referenced secret scrubbing (raw, `encodeURIComponent`, and RFC-3986 `%21%40` forms), expanded built-in + custom config prefixes (`fieldReport.extraSecretPrefixes`), and high-entropy token redaction.
  - **Stage 2 (`field-report-scanner.ts`)**: All-or-nothing pre-write refusal (`0` files written, `exitCode = 1`) with **`0` shared imports** from Stage 1 and **`0` vendor prefix literals**, enforcing independent literal secret, Shannon entropy, sensitive field/array, and structural PII/auth/PEM checks.
- **Line-Count Hygiene**: All three C50 security modules (`field-report-scrubber.ts`, `field-report-scanner.ts`, `field-report-secrets-context.ts`) stay strictly `<= 340` lines.

## K1 — Independent Two-Stage Secret Filtering Verification
- **Positive Matrix**: `28` secret/key formats (prefixed provider keys, prefixless high-entropy hex/alphanumeric keys, JWT, custom config prefix, `*KEY*`/`*SECRET*` env vars raw + `encodeURIComponent` + RFC-3986, config-referenced `*Env`/`${VAR}` env vars, Bearer header, credentialed URL) planted across all `4` free-text sources (`inbox.json`, `tick.log` -> `timeline.jsonl`, `freeze.json`, `config-shape.json`) plus sensitive arrays (`apiKeys`) and harmless keys (`note`) -> **`0` leaks** in Stage 1 and **`0` escapes** past Stage 2.
- **Negative Controls (`0` False Positives)**: `sha256`, `planHash`, `stdoutSha12`, `stderrSha12`, `receiptId`, `snapshotId`, `snapshotOrBackupRef`, standard UUIDs, bare/long slash-delimited model IDs, and `camelCase` identifiers preserved `100%` intact (`redactedCount = 0`, Stage 2 `clean = true`).
- **Mutation & Adversarial Gates**:
  - Engineer: `5/5` mandatory mutations (`M1..M5`) KILLED.
  - Independent QA Strike-2 (`GO`, `0` P0/P1/P2): `5/5` adversarial probes (`A–E`) PASS and `5/5` independent mutations (`QM1..QM5`) KILLED.

## K2 — Runbook Hardening (`docs/runbook/FIELD-TEST-LADDER.md`)
- Length: **`77` lines** (`<= 100`), PowerShell + Bash blocks verified by `c46-f3-doc-cli-sync.test.ts` (`verifyDocCliSync` `0` issues) and `c49-field-runbooks.test.ts` (`9/9` tests PASS).
- Removed absolute zero-leak overclaim; replaced with measured `28` formats × `4` free-text sources rehearsal facts and 2-stage independent architecture.
- Added mandatory **first-export visual eye-check rule** requiring the Owner to inspect every file in `field-report` before sharing.
- **Tier-0 (`Bậc 0`)**: Documented real background scheduling via `routersync schedule install` (`--mode observe --interval-minutes 15`, `>= 15` min), `schedule status --json`, and `schedule uninstall`.
- **Tier-1 (`Bậc 1`)**: Removed pre-filled `--false-removals 0 --unplanned-interventions 0` from `pilot-report` examples; marked both flags as Owner-observed inputs only.

## K3 — Isolated `os.tmpdir()` Rehearsal Metrics
| Run | Mode | Exit Code | Written Files | Key Measured Result |
| --- | --- | ---: | ---: | --- |
| **Run A** | Normal 2-stage export (`28` formats × `4` sources) | `0` | `8` | `redactedCount = 141`; external byte-level scan across all `8` files = **`0` leaks** (raw + URL/RFC-3986 encoded); valid hashes/UUIDs/model IDs intact |
| **Run B** | Stage-1 bypassed (`_unsafeSkipStage1ScrubberForScannerTest`) | `1` | `0` | Refused all-or-nothing (`0` files on disk); `rejectedViolationsCount = 98` (`summary.json = 34`, `timeline.jsonl = 34`, `config-shape.json = 30`); `0` secret values echoed |

## Captured Verification Records
`capture-evidence.mjs` created these real records on merged `main` `0239c42458efded2749cf8bf02e330f9d4c66ad2` after `pnpm install --frozen-lockfile` and `pnpm --filter @routersync/cli... build`, masking output before SHA-256 hashing:

| Record | Command Scope | Result | Duration |
| --- | --- | --- | ---: |
| `c50-k1-k3-secrets-and-rehearsal` | `c50-k1-secret-matrix.test.ts`, `c50-k1-k3-rehearsal.test.ts`, `c49-t1-t2-field-report.test.ts`, `c49-t5-rehearsal-and-secrets.test.ts` | Exit `0`, `4` files, `18/18` tests | `25.0 s` |
| `c50-k2-runbooks-and-cli-sync` | `c49-field-runbooks.test.ts`, `c46-f3-doc-cli-sync.test.ts`, `agent-docs.test.ts` | Exit `0`, `3` files, `33/33` tests | `33.9 s` |

Each record loaded `12` effective private-name/path patterns (`guard=4`, `effective=12`). Package contains `7` files total (`<= 10`).

## GitHub CI and Merge History
- **Base `origin/main` before merge**: `34190c9fbd290b6e76cbde154176b946046ab5cc` (`34190c9`).
- **PR #88**: https://github.com/CThawngs/Router-Sync/pull/88 (`fix/c50-field-report-secrets`, head `275b6ba74fb1b098a3431275b101203183e0620c`)
  - PR CI run [`46094676709`](https://github.com/CThawngs/Router-Sync/actions/runs/46094676709): `attempt=1`, `18/18` checks `SUCCESS`.
  - Squash-merged into `main` as `0239c42458efded2749cf8bf02e330f9d4c66ad2` (feature branch deleted).
- **Post-Merge `main` CI**: Run [`46096418131`](https://github.com/CThawngs/Router-Sync/actions/runs/46096418131) on `0239c42458efded2749cf8bf02e330f9d4c66ad2`: `attempt=1`, **`18/18` jobs `SUCCESS`** (zero reruns).

## Limits
No live router DB/API write, live harness config edit, `RS_FORCE_HEAVY=1`, force-push, PR on `evidence/e6`, or `evidence/*` commit on `main` was performed. Owner real-data field testing begins at Rung 0 per `docs/runbook/FIELD-TEST-LADDER.md`.
