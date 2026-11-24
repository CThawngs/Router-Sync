# Audit Manifest & SHA Cross-Reference — `evidence/d1` (C45 Stage 1)

## Branch & Anchor Metadata
- **Repository:** `https://github.com/CThawngs/Router-Sync`
- **Stage:** C45 Stage 1 (`WP0`, `WP1`, `WP2`, `WP3`)
- **Serves:** `Phục vụ: S1, S2, S3, S6, S7, S10`
- **Branch:** `evidence/d1` (branched cleanly from `origin/main` at `cf88423d6f70fd682ee5c121b8bb32bd04a469e7`)
- **CI Trigger Guard:** Commit includes `[skip ci]`; pushed directly to `origin/evidence/d1` with no Pull Request.

## Stage 1 `main` Commit Chain
1. `a22a48d490760a68441a86e69c8fd4e1ddb8c3ff` — PR #70 (`WP0`, `Phục vụ: S10`) | PR CI `45325224073` (`18/18`) | Main CI `45338891630` (`18/18`, `attempt=1`)
2. `1ce5bbde75fb7909fa03280bc7c0006fa17eeda8` — PR #71 (`WP1+WP2`, `Phục vụ: S2, S3, S6`) | PR CI `45370088843` (`18/18`) | Main CI `45396026567` (`18/18`, `attempt=1`) | QA `#issuecomment-7128685453`
3. `7bd0160a10dc04971676e6b2eb8d0adedd1fce48` — PR #72 (`WP3`, `Phục vụ: S1, S3, S7`) | PR CI `45398100573` (`18/18`) | QA `#issuecomment-7132658363`
4. `cf88423d6f70fd682ee5c121b8bb32bd04a469e7` — PR #73 (`WP3` arm64 test-timing fix, `Phục vụ: S1, S3, S7`) | PR CI `45445558524` (`18/18`) | Main CI `45465646777` (`18/18`, `attempt=1`) | QA `#issuecomment-7140311112`

## Captured Artifact Digests (`9` Files in `evidence/d1/`)
- `records.jsonl` — 3 valid records (`privateNamesLoaded=12` on every row)
- `full-test-and-e2e.out.txt` — `sha256: dc0ea79d983815638e390bf66e6208953652c32a834c32a668e8074d841dbb9d` (`135879` bytes)
- `full-test-and-e2e.err.txt` — `sha256: 83020efb6be08b5b727dde1f7ea5b460fa630920edffd7313cd8b6275be391cc` (`10684` bytes)
- `stage1-harness-and-research.out.txt` — `sha256: 1ae61da910ef6dfffd132e49e09add8bf96eac20880ad63a94680e42e5b860de` (`5051` bytes)
- `stage1-harness-and-research.err.txt` — `sha256: 40dcff7c6f8ac9e78720d1dcd9384e291f4daf5aaa67212455031266fe50846c` (`262` bytes)
- `security-and-pack-audit.out.txt` — `sha256: 67f4dcb11f9fe97b61407389196ee6653238a62f42c174dece68ae9898c7a77e` (`434` bytes)
- `security-and-pack-audit.err.txt` — `sha256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` (`0` bytes)
- `REPORT.md` — Stage 1 summary, CI proofs, and 9-harness matrix
- `NOTE.md` — This manifest

## Owner Pending Queue (Post-Stage 1)
1. Stage 2 (`WP4`, `WP5`, `WP6`) and Stage 3 (`WP7`, `WP8`, `WP9`) proceed automatically without blocking; real-target pilot execution (`LIVE-E2E-v2.md`) and `1.0.0-rc.1` / `1.0.0` release publishing remain strictly owner-only after `evidence/d3`.