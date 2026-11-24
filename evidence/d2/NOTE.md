# Audit Manifest & SHA Cross-Reference — `evidence/d2` (C45 Stage 2)

## Branch & Anchor Metadata
- **Repository:** `https://github.com/CThawngs/Router-Sync`
- **Stage:** C45 Stage 2 (`WP4`, `WP5`, `WP6`)
- **Serves:** `Phục vụ: S3, S4, S5, S9`
- **Prior Stage Anchor:** `origin/evidence/d1` @ `6e4ff69` (base `main` `cf88423`)
- **Branch:** `evidence/d2` (branched cleanly from `origin/main` at `58188dd746436ca5c3530e4cde156c1f03b705d7`)
- **CI Trigger Guard:** Commit includes `[skip ci]`; pushed directly to `origin/evidence/d2` with no Pull Request and no release tags.

## Stage 2 `main` Commit Chain (4 RACI Proofs)
1. `25574a9049cfe832ca300ab657c887b971c238a9` — PR #74 (`WP4`, HEAD `a146d8ddc05faa7c71cb450fb80c6a38a35f2e2b`, `Phục vụ: S3, S4, S9`) | PR CI `45488487062` (`18/18`, `attempt=1`) | Main CI `45491493082` (`18/18`, `attempt=1`) | QA `#issuecomment-7144908861` (`11/11` QA + `7/7` Engineer mutations killed)
2. `58188dd746436ca5c3530e4cde156c1f03b705d7` — PR #75 (`WP5 + WP6`, HEAD `90cd38a173479cc8d9f4b13176bfde5fcaf8539d`, `Phục vụ: S4, S5`) | PR CI `45494432631` (`18/18`, `attempt=1`) | Main CI `45500443928` (`18/18`, `attempt=1`) | QA `#issuecomment-7146033150` (`7/7` QA + `7/7` Engineer mutations killed)

## Captured Artifact Digests (`9` Files in `evidence/d2/`)
- `records.jsonl` — 3 valid records (`privateNamesLoaded=12` on every row, `2108` bytes)
- `full-test-and-e2e.out.txt` — `sha256: 5178bfc426929d02c39c5533a4ef20bf4811f8dc0879f72d70ffa508d8ea6894` (`139130` bytes)
- `full-test-and-e2e.err.txt` — `sha256: cba4d6a67e848a2d9cab4768ce308d7ace4b960d89b28945685f143f001b5358` (`14802` bytes)
- `stage2-consent-and-bootstrap.out.txt` — `sha256: dd515845d7ffe32ab858601ab7d41f31dcfb480189a2e46517561a348c02d8c4` (`94311` bytes)
- `stage2-consent-and-bootstrap.err.txt` — `sha256: 1c5f09192c2584375953dbcda2ffe012d0cee1059219bb0a769776976870d8c7` (`7142` bytes)
- `security-and-pack-audit.out.txt` — `sha256: 994f5446e39a61e5848bc234034e8572bcace0bd892a8e5c864462e7186af681` (`435` bytes)
- `security-and-pack-audit.err.txt` — `sha256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` (`0` bytes)
- `REPORT.md` — Stage 2 audit summary, RACI proofs, LiteLLM CST + consent/freeze summary, and 9-harness skill matrix
- `NOTE.md` — This manifest

## Mandatory Pre-Push Verifier Gate
1. `node tools/agent/verify-records.mjs evidence/d2/records.jsonl` — expected `SẠCH: 3 dòng` (`exit 0`)
2. `node tools/agent/verify-package.mjs evidence/d2` — expected `OK: evidence/d2 (9 tệp <= 10)` (`exit 0`)
3. `node tools/agent/scan-private-names.mjs evidence/d2` — expected `0` matches (`exit 0`)
4. `node tools/guard/no-personal-paths.mjs` — expected `0` matches (`exit 0`)

## Owner Pending Queue (Post-Stage 2)
1. Stage 3 (`WP7 + WP8`, `WP9`, and `evidence/d3`) proceeds next without blocking; real-target pilot execution (`LIVE-E2E-v2.md`) and `1.0.0-rc.1` / `1.0.0` release publishing remain strictly owner-only after `evidence/d3`.