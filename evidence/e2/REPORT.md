# C46 Stage-2 Evidence Report — `evidence/e2` (`Phục vụ: S9, I4, I5`)

## 1. Scope, Hard-Stop Status & Stage-1 Cross-Reference

- **Repository:** `https://github.com/CThawngs/Router-Sync`
- **Branch:** `origin/evidence/e2` (branched cleanly from `origin/main` @ `19a18ea7135b0f3b11d5a3212085ec19b162f59e`)
- **Hard-Stop Gate:** **`READY_FOR_OWNER_LIVE_PILOT`** — `0` live router DB/harness config writes, `0` `npm publish`, `0` new git tags beyond `v0.1.0`, `0` `PATCH_V3`.
- **Stage-1 Baseline Anchor:** `origin/evidence/e1` (`a30b5764533f7570133bd1a81a29292332a483c8`) covering:
  - `C46-F1` ([PR #78](https://github.com/CThawngs/Router-Sync/pull/78) @ `d2c8e821`, PR CI `45540441441` / `main` CI `45543669347` `18/18` `attempt=1`, QA [`#issuecomment-7152244167`](https://github.com/CThawngs/Router-Sync/pull/78#issuecomment-7152244167))
  - `C46-F5` ([PR #79](https://github.com/CThawngs/Router-Sync/pull/79) @ `8e3dc3a8`, PR CI `45559546370` / `main` CI `45567507968` `18/18` `attempt=1`, QA [`#issuecomment-7155254302`](https://github.com/CThawngs/Router-Sync/pull/79#issuecomment-7155254302))
- **Isolation Guarantee:** Built & captured inside a fresh `os.tmpdir()` clone (`CI` and `RS_FORCE_HEAVY` unset); commit guarded with `[skip ci]`, no PR, no tags.

---

## 2. Stage-2 Four-Gate RACI Proofs (`F4`, `F2+F3`, `F6`, `F4B`)

Per `AGENTS.md` §7.4 & §7.8, every CI `attempt` count and infra-only cancellation is recorded verbatim:

| Ticket | PR | Merged `main` SHA | PR 5-OS CI | Post-Merge `main` 5-OS CI | QA Independent Sign-Off & Mutation Kill |
|---|---|---|---|---|---|
| **`C46-F4`** (`P4`) | [#80](https://github.com/CThawngs/Router-Sync/pull/80) | `a6aa4e82e42910a5d1cd4c6711f4661a777f4fcf` | Run [`45586599564`](https://github.com/CThawngs/Router-Sync/actions/runs/45586599564) (`18/18`, `attempt=1`) | Run [`45588079512`](https://github.com/CThawngs/Router-Sync/actions/runs/45588079512) (`18/18`, `attempt=1`) | [`#issuecomment-7156437325`](https://github.com/CThawngs/Router-Sync/pull/80#issuecomment-7156437325) — `6/6` Eng + `13/13` QA **KILLED** |
| **`C46-F2`** (`P1`) + **`C46-F3`** (`P3`) | [#81](https://github.com/CThawngs/Router-Sync/pull/81) | `650c7aa50ad2947e869c7528bd2a28876a640fd2` | Run [`45610790041`](https://github.com/CThawngs/Router-Sync/actions/runs/45610790041) (`18/18`, `attempt=1`) | Run [`45614734761`](https://github.com/CThawngs/Router-Sync/actions/runs/45614734761) (`18/18`, `attempt=1`) | [`#issuecomment-7162424398`](https://github.com/CThawngs/Router-Sync/pull/81#issuecomment-7162424398) — `20/20` Eng + `16/16` QA **KILLED** |
| **`C46-F6`** | [#82](https://github.com/CThawngs/Router-Sync/pull/82) | `ad83fe8be8d99acfc383b09a14111f849b151623` | Run [`45633906222`](https://github.com/CThawngs/Router-Sync/actions/runs/45633906222) (`18/18`, `attempt=1`) | Run [`45644456985`](https://github.com/CThawngs/Router-Sync/actions/runs/45644456985) (`18/18`, **`attempt=2`** — see note) | [`#issuecomment-7166588970`](https://github.com/CThawngs/Router-Sync/pull/82#issuecomment-7166588970) — `14/14` Eng + `15/15` QA **KILLED**; `OWNER-CHECKLIST.md` `<= 120` lines |
| **`C46-F4B`** | [#83](https://github.com/CThawngs/Router-Sync/pull/83) | `19a18ea7135b0f3b11d5a3212085ec19b162f59e` | Run [`45654029758`](https://github.com/CThawngs/Router-Sync/actions/runs/45654029758) (`18/18`, **`attempt=2`** — see note) | Run [`45661135435`](https://github.com/CThawngs/Router-Sync/actions/runs/45661135435) (`18/18`, **`attempt=1`**) | [`#issuecomment-7168703356`](https://github.com/CThawngs/Router-Sync/pull/83#issuecomment-7168703356) — `5/5` Eng + `8/8` QA **KILLED** |

- **Honest CI Retry Disclosures (INFRA ONLY, `ci-watch.mjs exit=10`):**
  - `PR #82` post-merge `main` Run `45644456985`: `attempt=1` hit `17/18` + `1` GitHub runner capacity cancel (`0` steps on `verify (macos-latest, node 24)`, `job/139311550104`); `attempt=2` passed `18/18` (record: [`#issuecomment-7167208816`](https://github.com/CThawngs/Router-Sync/pull/82#issuecomment-7167208816)).
  - `PR #83` PR Run `45654029758`: `attempt=1` hit `15/18` + `3` `macos-latest` runner capacity cancels (`0` steps); `attempt=2` passed `18/18` (record: [`#issuecomment-7168703356`](https://github.com/CThawngs/Router-Sync/pull/83#issuecomment-7168703356)), and post-merge `main` Run `45661135435` passed `18/18` on `attempt=1`.

---

## 3. Controlled `S9` E2E Rehearsal & Networked Security Audit

### A. `S9` Rehearsal Metrics (`os.tmpdir()` — Router SQLite + Hermes YAML + OpenCode JSONC)
- **Byte-Exact Rollback:** `shaMatch = true` (`byteIdenticalToPreApply: true` on router DB, Hermes YAML, and OpenCode JSONC with comments preserved).
- **Detection Latency:** `detectionLatencyMs = 0` (`<= 60000` ms ceiling; serving reflection tracked separately via `--serving-reflection-ms`).
- **Zero Tier-0 Cost:** `tier0Tokens = 0`, `tier0LlmCalls = 0`, `tier0PaidRequests = 0`.

### B. Networked Security Audit (`Record 3`: `node tools/agent/security-audit.mjs --with-ci-logs --json`)
- **Verdict:** `ok: true`, `highCount: 0`, `mediumCount: 0`, `lowCount: 0`, `findings: []` (zero false positives after `C46-F4B` POSIX root-boundary anchor fix).
- **CI Logs Surface:** `status: "scanned"`, `branch: "main"`, `runsScanned: 10` — `runIds`: `45661135435, 45644456985, 45614734761, 45588079512, 45567507968, 45543669347, 45517172191, 45509893353, 45500443928, 45491493082`.
- **Evidence Refs Surface:** `refsScanned: 27` (`1162` blobs, `0` findings, including `origin/evidence/e1`).
- **Repo Files, Tarballs & Write Gates:** `repoFiles: 737`, `tarballs: 8` packed workspace packages, `writeGates`: `grant 5/5`, `approvalToken 5/5`, `yesWriteRouter 2/2`.

---

## 4. Isolated Execution Captures (`evidence/e2/records.jsonl`)

Built sequentially (`pnpm -r --workspace-concurrency=1 build`) and captured via `tools/agent/capture-evidence.mjs` (`privateNamesLoaded=12` on all 3 rows):

| # | Record ID | Command (`SAFE_VERBS`) | Exit | Duration | Verified Outcome | `stdout` SHA-256 (12) | `stderr` SHA-256 (12) |
|---:|---|---|---:|---:|---|---|---|
| 1 | `f2-f3-rehearsal-and-doc-sync` | `pnpm test:file packages/cli/test/c46-f2-live-gate-hint.test.ts packages/cli/test/c46-f3-pilot-workflow-rehearsal.test.ts test/docs/c46-f3-doc-cli-sync.test.ts` | `0` | `11449 ms` | `3/3` files, `14/14` tests passed (`3` F2 + `6` F3 rehearsal + `5` doc-CLI sync) | `99c14a2a5a73` | `d2247736bc95` |
| 2 | `f6-pilot-report-and-readiness` | `pnpm test:file packages/cli/test/c46-f6-pilot-report.test.ts test/docs/c45-wp9-live-readiness.test.ts test/docs/agent-docs.test.ts` | `0` | `31911 ms` | `3/3` files, `32/32` tests passed (`9` F6 pilot-report + `4` WP9 readiness + `19` agent-docs) | `30d5848c30bc` | `1f9c98757c67` |
| 3 | `f4-security-audit-networked` | `node tools/agent/security-audit.mjs --with-ci-logs --json` | `0` | `89923 ms` | `ok=true`, `0/0/0`, `10` `main` CI runs, `27` `origin/evidence/*` refs (`1162` blobs), `8` tarballs, `writeGates 5/5, 5/5, 2/2` | `8b742cc2d67b` | `e3b0c44298fc` |

---

## 5. Owner Handover Toolkit & Pre-Push 5-Verifier Gate

- **Owner Toolkit on `main` (`19a18ea7`):** `docs/runbook/OWNER-CHECKLIST.md` (`118` content lines / `119` split lines `<= 120`), `docs/runbook/LIVE-E2E-v2.md`, and read-only CLI aggregator `routersync pilot-report`.
- **Hard Stop:** Bot fleet stops at **`READY_FOR_OWNER_LIVE_PILOT`**. Only the project owner executes the live pilot on host DBs/harnesses and decides npm publish/tagging.
- **5 Mandatory Verifiers (`exit 0` on committed `HEAD`, `9` files `<= 10`, `REPORT.md <= 120` lines, `[skip ci]`, `0` PRs, `0` tags):**
  1. `node tools/agent/verify-records.mjs evidence/e2/records.jsonl evidence/e2` -> `SẠCH: 3 dòng`
  2. `node tools/agent/verify-package.mjs evidence/e2` -> `OK` (`3` records, `privateNamesLoaded=12 >= 4`)
  3. `node tools/guard/no-secrets.mjs` -> `0` findings
  4. `node tools/guard/no-personal-paths.mjs` -> `0` findings
  5. `node tools/agent/scan-private-names.mjs origin/main HEAD` -> `0` delta (`0` hits in `evidence/e2/*`)
