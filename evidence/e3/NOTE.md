# Handover & Audit Manifest — `evidence/e3` (C47 Router-Sync, `Serves: S9`)

- **Branch / Base:** `evidence/e3` from `origin/main` @ `0ce85d980b58e44942d1769a12da39f6ec017a00` (PR #84 head `381700feff1cb4070b61e2af240ee427589e5585`; baseline `origin/evidence/e2` `710a7a90`).
- **5-OS CI (`attempt=1`):** PR Run `45745773361` `18/18 SUCCESS`; post-merge `main` Run `45746982126` `18/18 SUCCESS`.
- **QA P2 Sign-Off:** `https://app.notion.com/p/4243c98ee3238146bd14e4fd91ea2311` (PR head `381700fe`); C47 task `https://app.notion.com/p/4243c98ee32381fa96b9eacab06a14e7` (CEO updates).
- **Guardrails & Gate Posture:** `0` real router/harness writes, `0` publish/tag/`PATCH_V3`, `0` code/threshold changes, `[skip ci]`, `0` PRs. Ops does **not** claim owner live-pilot readiness; CEO reviews separately whether absence-only G2 still blocks.

## Handover Summary (G1–G4 & Full 5-Surface Security)
- **G1:** Verified rollback required (`apply`-only -> `INCOMPLETE`); distinguishes `VACUOUS` (`0` samples -> `INCOMPLETE` vs `--accept-vacuous-detection` printed waiver), missing owner counts (`source="missing"` -> `INCOMPLETE`), explicit `0` (`source="owner-attested"`), and derived catalog false-removal (`source="derived"`).
- **G2 (`10`-model fixture, simulated clock):**
  - `steady`: `2` ticks, `0` removals, `maxMs=null` (`VACUOUS`), `verifiedReceiptsCount=2` (`1` router + `1` harness / `2` targets) -> `INCOMPLETE`.
  - `absence-only`: `2` ticks `0` removals; tick `3` at `+24h` (`86400000 ms > 60000`) removes `1` model (`0` false), `verifiedReceiptsCount=3` (`2` router [propose+auto-safe] + `1` harness / `2` targets) -> **`FAIL`**.
  - `official-notice` (separate synthetic official notice): tick `2` removes `1` model (`0` false), `1` sample `50 ms`, router combo rows & harness SHA-256 verified, `verifiedReceiptsCount=3` (`2` router + `1` harness / `2` targets) -> **`PASS`**.
- **G3:** `docs/runbook/OWNER-CHECKLIST.md` `120` content / `121` split lines (`<= 130`); doc-CLI sync `5/5`; PS AST `24/24` (`0` err) & Git Bash `bash -n` `24/24` (`0` err).
- **G4:** Built CLI child on isolated outside-`os.tmpdir()` fixture refuses non-TTY (`TTY_REQUIRED`), missing consent (`CONSENT_REQUIRED`), and `bots.json`/`routines.json` (`OpenMausBot safety guard`). Real Windows TTY (wrong word aborts; exact word emits `interactive-tty` receipt) was witnessed separately by CEO; original Windows TTY log is **not** attached in `evidence/e3/`.
- **Security Audit (`5/5` surfaces, unscoped):** `ok=true`, `0/0/0`, `repoFiles=737`, `evidenceRefs=29` (`1208` blobs), `tarballs=8`, `ciLogs=10` `main` runs (incl. `45746982126`), `writeGates 5/5, 5/5, 2/2`.

## Captured Artifacts (`9` Files `<= 10`, Unmodified Post-Capture)
- `REPORT.md` (`<= 120` lines) | `NOTE.md` (`<= 40` lines) | `records.jsonl` (`3` rows, `privateNamesLoaded=12`)
- `c47-g1-g2-pilot-report-and-loop.{out,err}.txt` — `10800573604b` (`59407 B`) / `6cd035decdec` (`4427 B`)
- `c47-g3-g4-checklist-and-approval.{out,err}.txt` — `9c6b1a22c5f9` (`9528 B`) / `83b6a4c2cac6` (`1416 B`)
- `c47-security-audit-networked.{out,err}.txt` — `36e01ad7ac89` (`2202 B`) / `e3b0c44298fc` (`0 B`)

## Pre-Push Verifiers (All `exit 0` on Committed `HEAD`)
1. `verify-records.mjs`: `SẠCH: 3 dòng` | 2. `verify-package.mjs`: `OK` (`privateNamesLoaded >= 4`)
3. `no-secrets.mjs`: `0` findings | 4. `no-personal-paths.mjs`: `0` findings
5. `scan-private-names.mjs`: `0` hits across all `9/9` files (`--file`) and `0` delta `origin/main..HEAD`.
