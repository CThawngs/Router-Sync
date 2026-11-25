# Audit Manifest & SHA Cross-Reference — `evidence/e2` (C46 Stage-2 Pilot Readiness & Networked Security Audit)

## Branch & Anchor Metadata
- **Repository:** `https://github.com/CThawngs/Router-Sync`
- **Branch:** `evidence/e2` (branched cleanly from `origin/main` at `19a18ea7135b0f3b11d5a3212085ec19b162f59e`)
- **Serves:** `Phục vụ: S9, I4, I5`
- **Stage-1 Baseline Anchor:** `origin/evidence/e1` (`a30b5764533f7570133bd1a81a29292332a483c8`, base `main` `8e3dc3a81310a2a4481d9485b2b250e25d57194d`)
- **Hard-Stop State:** `READY_FOR_OWNER_LIVE_PILOT` (`0` live router DB/config touches, `0` `npm publish`, `0` tags beyond `v0.1.0`, `0` `PATCH_V3`)
- **CI Trigger Guard:** Commit includes `[skip ci]`; pushed directly to `origin/evidence/e2` with no Pull Request and no git tags.

## Merged `main` Commit Chain Covered by `evidence/e2`
1. `a6aa4e82e42910a5d1cd4c6711f4661a777f4fcf` — PR #80 (`C46-F4`, `P4`)
   - PR 5-OS CI Run `45586599564`: `18/18 SUCCESS` (`attempt=1`)
   - Post-merge `main` 5-OS CI Run `45588079512`: `18/18 SUCCESS` (`attempt=1`)
   - QA Sign-Off: `https://github.com/CThawngs/Router-Sync/pull/80#issuecomment-7156437325` (`6/6` Eng + `13/13` QA mutations KILLED)
2. `650c7aa50ad2947e869c7528bd2a28876a640fd2` — PR #81 (`C46-F2` `P1` + `C46-F3` `P3`)
   - PR 5-OS CI Run `45610790041`: `18/18 SUCCESS` (`attempt=1`)
   - Post-merge `main` 5-OS CI Run `45614734761`: `18/18 SUCCESS` (`attempt=1`)
   - QA Sign-Off: `https://github.com/CThawngs/Router-Sync/pull/81#issuecomment-7162424398` (`20/20` Eng + `16/16` QA mutations KILLED)
3. `ad83fe8be8d99acfc383b09a14111f849b151623` — PR #82 (`C46-F6`)
   - PR 5-OS CI Run `45633906222`: `18/18 SUCCESS` (`attempt=1`)
   - Post-merge `main` 5-OS CI Run `45644456985`: `18/18 SUCCESS` (`attempt=2` — `attempt=1` reached `17/18` + `1` GitHub runner capacity cancel `0` steps on `verify (macos-latest, node 24)` `job/139311550104`, `ci-watch.mjs exit=10` INFRA ONLY; record: `https://github.com/CThawngs/Router-Sync/pull/82#issuecomment-7167208816`)
   - QA Sign-Off: `https://github.com/CThawngs/Router-Sync/pull/82#issuecomment-7166588970` (`14/14` Eng + `15/15` QA mutations KILLED; `docs/runbook/OWNER-CHECKLIST.md` `<= 120` lines)
4. `19a18ea7135b0f3b11d5a3212085ec19b162f59e` — PR #83 (`C46-F4B`)
   - PR 5-OS CI Run `45654029758`: `18/18 SUCCESS` (`attempt=2` — `attempt=1` reached `15/18` + `3` `macos-latest` runner capacity cancels `0` steps, `ci-watch.mjs exit=10` INFRA ONLY; record: `https://github.com/CThawngs/Router-Sync/pull/83#issuecomment-7168703356`)
   - Post-merge `main` 5-OS CI Run `45661135435`: `18/18 SUCCESS` (`attempt=1`)
   - QA Sign-Off: `https://github.com/CThawngs/Router-Sync/pull/83#issuecomment-7168703356` (`5/5` Eng + `8/8` QA mutations KILLED)

## Captured Artifact Digests (`9` Files in `evidence/e2/`)
- `records.jsonl` — 3 real execution records (`privateNamesLoaded=12` on every row)
- `f2-f3-rehearsal-and-doc-sync.out.txt` — `sha256: 99c14a2a5a73ef3eaebaaf6990caae3bdb8ea845f6b529d54ee89e9ae0c8b7b9` (`35370` bytes, `800` lines)
- `f2-f3-rehearsal-and-doc-sync.err.txt` — `sha256: d2247736bc95a7b159a2a7b326ebaf20f2d5f487415f46bda72b52752ed944cb` (`5778` bytes, `56` lines)
- `f6-pilot-report-and-readiness.out.txt` — `sha256: 30d5848c30bc53604881626ba1ec0e859c8cad177d212061b76787f86d600fa6` (`26647` bytes, `683` lines)
- `f6-pilot-report-and-readiness.err.txt` — `sha256: 1f9c98757c6756a6a7cf255fc22edec26d29c467c98fb1e63fce593b6b7a0c3a` (`1970` bytes, `20` lines)
- `f4-security-audit-networked.out.txt` — `sha256: 8b742cc2d67b33e96499f3dc4aa99f8335ef1945c0cd5d8284f47723714d71cf` (`2149` bytes, `96` lines)
- `f4-security-audit-networked.err.txt` — `sha256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` (`0` bytes, `0` lines)
- `REPORT.md` — Self-contained C46 Stage-2 report (`<= 120` lines)
- `NOTE.md` — This audit manifest

## Networked Security Audit Full Inventory (`f4-security-audit-networked.out.txt`)
- Overall: `ok=true`, `highCount=0`, `mediumCount=0`, `lowCount=0`, `findings=[]`
- `repoFiles`: `737` files scanned, `0` findings
- `tarballs`: `8` workspace packages packed & scanned (`packed_workspace_packages`), `0` findings
- `writeGates`: `grant` `5/5`, `approvalToken` `5/5`, `yesWriteRouter` `2/2`, `0` findings
- `ciLogs`: `status="scanned"`, `branch="main"`, `runsScanned=10`, `0` findings
  - `runIds`: `45661135435`, `45644456985`, `45614734761`, `45588079512`, `45567507968`, `45543669347`, `45517172191`, `45509893353`, `45500443928`, `45491493082`
- `evidenceRefs`: `refsScanned=27`, `blobsScanned=1162`, `0` findings
  - `refs`: `origin/evidence/c25`, `origin/evidence/c26`, `origin/evidence/c27`, `origin/evidence/c30`, `origin/evidence/c31`, `origin/evidence/c32`, `origin/evidence/c33`, `origin/evidence/c34`, `origin/evidence/c36`, `origin/evidence/c37`, `origin/evidence/c37-apply`, `origin/evidence/c37-e2e`, `origin/evidence/c38`, `origin/evidence/c39`, `origin/evidence/c40`, `origin/evidence/c41`, `origin/evidence/c42`, `origin/evidence/c43`, `origin/evidence/c44`, `origin/evidence/d1`, `origin/evidence/d2`, `origin/evidence/d3`, `origin/evidence/e1`, `origin/evidence/m1`, `origin/evidence/m2`, `origin/evidence/m3`, `origin/evidence/m4`

## Note on Capture Command Path Verification
- Record 2 executes `test/docs/c45-wp9-live-readiness.test.ts` (actual repository path of the C45-WP9 live-readiness suite) alongside `packages/cli/test/c46-f6-pilot-report.test.ts` and `test/docs/agent-docs.test.ts`, verifying all `3/3` files (`32/32` tests passed).

## Mandatory 5-Verifier Pre-Push Gate
1. `node tools/agent/verify-records.mjs evidence/e2/records.jsonl evidence/e2` -> `SẠCH: 3 dòng` (`exit 0`)
2. `node tools/agent/verify-package.mjs evidence/e2` -> `OK` (`exit 0`)
3. `node tools/guard/no-secrets.mjs` -> `exit 0`
4. `node tools/guard/no-personal-paths.mjs` -> `exit 0`
5. `node tools/agent/scan-private-names.mjs origin/main HEAD` -> `0` delta (`exit 0`)
